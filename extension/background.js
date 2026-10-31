if (typeof URL.canParse !== 'function') {
  URL.canParse = function (url, base) {
    try {
      new URL(url, base);
      return true;
    } catch {
      return false;
    }
  };
}
if (typeof Uint8Array.prototype.toBase64 !== 'function') {
  Uint8Array.prototype.toBase64 = function () {
    let s = '';
    for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]);
    return btoa(s);
  };
}
if (typeof Uint8Array.fromBase64 !== 'function') {
  Uint8Array.fromBase64 = function (b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  };
}

import { listen, trusted } from './cdp.js';
import './six-sw.js';

try {
  chrome.storage?.local
    ?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
    ?.catch?.(() => undefined);
} catch {}

const dnr = chrome.declarativeNetRequest;
const restored = new Set(['cookie', 'origin', 'referer', 'user-agent']);
const redirects = new Set([301, 302, 303, 307, 308]);
const unexposed = new Set(['set-cookie', 'set-cookie2']);
const hopWait = 5000;
const watched = new Map();
const ready = dnr
  .getSessionRules()
  .then((rules) => dnr.updateSessionRules({ removeRuleIds: rules.map(({ id }) => id) }));
let nextRule = 1;
const ims = {
  prod: 'https://ims-na1.adobelogin.com',
  stg1: 'https://ims-na1-stg1.adobelogin.com',
};

function forbidden(headers) {
  return headers
    .filter(([name]) => restored.has(name.toLowerCase()))
    .map(([name, value]) => ({ header: name.toLowerCase(), operation: 'set', value }));
}

function rule(id, priority, urlFilter, requestHeaders) {
  return {
    id,
    priority,
    condition: { urlFilter, resourceTypes: ['xmlhttprequest'] },
    action: { type: 'modifyHeaders', requestHeaders },
  };
}

async function tag(url, headers) {
  const fragment = `slicc-${crypto.randomUUID()}`;
  const ids = [nextRule++, nextRule++];
  const client = forbidden(headers);
  const addRules = [rule(ids[0], 1, `#${fragment}`, [{ header: 'origin', operation: 'remove' }])];
  if (client.length > 0) {
    addRules.push(rule(ids[1], 2, `|${new URL(url).origin}/*#${fragment}`, client));
  }
  await ready;
  await dnr.updateSessionRules({ addRules });
  return {
    url: `${url.split('#')[0]}#${fragment}`,
    untag: () => dnr.updateSessionRules({ removeRuleIds: ids }),
  };
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => watched.get(details.url)?.(details),
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'], tabId: -1 },
  ['responseHeaders', 'extraHeaders']
);

function watch(url) {
  const heads = [];
  let wake;
  const arrived = new Promise((resolve) => {
    wake = resolve;
  });
  watched.set(url, (details) => {
    heads.push(details);
    wake();
  });
  return { heads, arrived };
}

function expired(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener('abort', resolve, { once: true });
  });
}

function byteString({ value, binaryValue }) {
  const bytes = binaryValue ?? new TextEncoder().encode(value);
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
}

async function hop({ heads, arrived }, signal) {
  await Promise.race([arrived, expired(AbortSignal.any([signal, AbortSignal.timeout(hopWait)]))]);
  signal.throwIfAborted();
  const [head] = heads;
  const headers = (head?.responseHeaders ?? [])
    .filter(({ name }) => !unexposed.has(name.toLowerCase()))
    .map((header) => [header.name.toLowerCase(), byteString(header)]);
  const locations = headers.filter(([name]) => name === 'location');
  if (heads.length !== 1 || !redirects.has(head.statusCode) || locations.length > 1) {
    throw new TypeError('slicc-extension: the redirect could not be observed');
  }
  return {
    status: head.statusCode,
    statusText: /^HTTP\/\S+\s+\d{3}\s*(.*)$/.exec(head.statusLine)?.[1].trim() ?? '',
    headers,
  };
}

function exposed(response) {
  const headers = [];
  response.headers.forEach((value, name) => {
    headers.push([name, value]);
  });
  return { status: response.status, statusText: response.statusText, headers };
}

async function send(request, signal) {
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`slicc-extension: cannot fetch ${url.protocol} URLs`);
  }
  const tagged = await tag(url.href, request.headers);
  const seen = watch(tagged.url);
  try {
    const response = await fetch(tagged.url, {
      method: request.method,
      headers: request.headers,
      body: request.body === undefined ? undefined : Uint8Array.fromBase64(request.body),
      credentials: 'omit',
      redirect: request.redirect,
      signal,
    });
    const opaque = response.type === 'opaqueredirect';
    return { response, head: opaque ? await hop(seen, signal) : exposed(response) };
  } finally {
    watched.delete(tagged.url);
    await tagged.untag();
  }
}

async function relay(port, request, signal) {
  const { response, head } = await send(request, signal);
  port.postMessage({ ...head, url: response.url, redirected: response.redirected });
  return response.body?.getReader();
}

async function read(port, reader) {
  const next = reader ? await reader.read() : { done: true };
  port.postMessage(next.done ? { end: true } : { chunk: next.value.toBase64() });
}

chrome.runtime.onConnect.addListener((port) => {
  const cdp = listen(port, chrome.runtime.id, chrome);
  if (!cdp) return;
  const abort = new AbortController();
  let reader;
  let queue = Promise.resolve();
  const fail = (error) => {
    if (!abort.signal.aborted) port.postMessage({ error: String(error?.message ?? error) });
    abort.abort();
  };
  port.onDisconnect.addListener(() => abort.abort());
  port.onMessage.addListener((message) => {
    if (cdp.handle(message)) return;
    const step = message.read
      ? () => read(port, reader)
      : async () => {
          reader = await relay(port, message, abort.signal);
        };
    queue = queue.then(() => (abort.signal.aborted ? undefined : step())).catch(fail);
  });
});

async function signIn({ clientId, scopes, imsEnvironment } = {}) {
  if (typeof clientId !== 'string' || typeof scopes !== 'string') {
    throw new TypeError('slicc-extension: a sign-in needs a client id and scopes');
  }
  const state = crypto.randomUUID();
  const redirect = chrome.identity.getRedirectURL('adobe');
  const url = new URL('/ims/authorize/v2', ims[imsEnvironment] ?? ims.prod);
  url.search = new URLSearchParams({
    client_id: clientId,
    scope: scopes,
    response_type: 'token',
    redirect_uri: redirect,
    state,
  }).toString();
  const answer = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  const back = URL.canParse(answer) ? new URL(answer) : null;
  if (!back || back.origin + back.pathname !== redirect) {
    throw new Error('slicc-extension: the sign-in came back elsewhere');
  }
  const fragment = new URLSearchParams(back.hash.slice(1));
  if (fragment.get('state') !== state) {
    throw new Error('slicc-extension: the sign-in answered another request');
  }
  const error = fragment.get('error');
  if (error) throw new Error(fragment.get('error_description') ?? error);
  const token = fragment.get('access_token');
  if (!token) throw new Error('slicc-extension: the sign-in returned no token');
  return token;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'slicc-sign-in' || !trusted(sender, chrome.runtime.id)) return false;
  signIn(message.options).then(
    (token) => reply({ token }),
    (error) => reply({ error: String(error?.message ?? error) })
  );
  return true;
});
