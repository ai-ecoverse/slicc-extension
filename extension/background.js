const dnr = chrome.declarativeNetRequest;
const restored = new Set(['cookie', 'origin', 'referer', 'user-agent']);
const ready = dnr
  .getSessionRules()
  .then((rules) => dnr.updateSessionRules({ removeRuleIds: rules.map(({ id }) => id) }));
let nextRule = 1;

function trusted(sender) {
  if (sender.id !== chrome.runtime.id || !URL.canParse(sender.url)) return false;
  const { protocol, hostname } = new URL(sender.url);
  return protocol === 'https:' && (hostname === 'sliccy.ai' || hostname.endsWith('.sliccy.ai'));
}

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
  if (response.body) {
    for await (const chunk of response.body) port.postMessage({ chunk: chunk.toBase64() });
  }
  port.postMessage({ end: true });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'slicc-fetch' || !trusted(port.sender)) {
    port.disconnect();
    return;
  }
  const abort = new AbortController();
  port.onDisconnect.addListener(() => abort.abort());
  port.onMessage.addListener((request) => {
    relay(port, request, abort.signal).catch((error) => {
      if (!abort.signal.aborted) port.postMessage({ error: String(error?.message ?? error) });
    });
  });
});
