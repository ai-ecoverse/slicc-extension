import { listen, trusted } from './cdp.js';

const dnr = chrome.declarativeNetRequest;
const restored = new Set(['cookie', 'origin', 'referer', 'user-agent']);
const ready = dnr
  .getSessionRules()
  .then((rules) => dnr.updateSessionRules({ removeRuleIds: rules.map(({ id }) => id) }));
let nextRule = 1;
const ims = {
  prod: 'https://ims-na1.adobelogin.com',
  stg1: 'https://ims-na1-stg1.adobelogin.com',
};

function forbidden(headers) {
  const requestHeaders = headers
    .filter(([name]) => restored.has(name.toLowerCase()))
    .map(([name, value]) => ({ header: name.toLowerCase(), operation: 'set', value }));
  if (!requestHeaders.some(({ header }) => header === 'origin')) {
    requestHeaders.push({ header: 'origin', operation: 'remove' });
  }
  return requestHeaders;
}

async function tag(url, headers) {
  const fragment = `slicc-${crypto.randomUUID()}`;
  const id = nextRule++;
  await ready;
  await dnr.updateSessionRules({
    addRules: [
      {
        id,
        priority: 1,
        condition: { urlFilter: `#${fragment}`, resourceTypes: ['xmlhttprequest'] },
        action: { type: 'modifyHeaders', requestHeaders: forbidden(headers) },
      },
    ],
  });
  return {
    url: `${url.split('#')[0]}#${fragment}`,
    untag: () => dnr.updateSessionRules({ removeRuleIds: [id] }),
  };
}

async function send(request, signal) {
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`slicc-extension: cannot fetch ${url.protocol} URLs`);
  }
  const tagged = await tag(url.href, request.headers);
  try {
    return await fetch(tagged.url, {
      method: request.method,
      headers: request.headers,
      body: request.body === undefined ? undefined : Uint8Array.fromBase64(request.body),
      credentials: 'omit',
      redirect: 'follow',
      signal,
    });
  } finally {
    await tagged.untag();
  }
}

async function relay(port, request, signal) {
  const response = await send(request, signal);
  const headers = [];
  response.headers.forEach((value, name) => {
    headers.push([name, value]);
  });
  port.postMessage({ status: response.status, statusText: response.statusText, headers });
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
