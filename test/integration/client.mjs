export async function install(kind = 'seven', extId = '') {
  async function bridge(extId) {
    const port = chrome.runtime.connect(extId, { name: 'slicc.cdp-bridge' });
    const channelId = crypto.randomUUID();
    const listeners = new Set();
    const pending = new Map();
    let next = 0;
    port.onMessage.addListener((msg) => {
      if (msg.kind === 'cdp.response') {
        const done = pending.get(msg.id);
        pending.delete(msg.id);
        if (!done) return;
        if (msg.error) done.reject(new Error(String(msg.error?.message ?? msg.error)));
        else done.resolve(msg.result ?? {});
        return;
      }
      if (msg.kind === 'cdp.event') {
        const event = { method: msg.method, params: msg.params ?? {} };
        if (msg.sessionId !== undefined) event.sessionId = msg.sessionId;
        for (const listener of listeners) listener(event);
      }
    });
    const welcomed = new Promise((resolve) => {
      const wait = (msg) => {
        if (msg.kind !== 'handshake.welcome') return;
        port.onMessage.removeListener(wait);
        resolve();
      };
      port.onMessage.addListener(wait);
    });
    port.postMessage({ bridge: 1, channelId, kind: 'handshake.hello' });
    await welcomed;
    return {
      send(method, params, sessionId) {
        const id = ++next;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          const msg = {
            bridge: 1,
            channelId,
            kind: 'cdp.request',
            id,
            method,
            params: params ?? {},
          };
          if (sessionId !== undefined) msg.sessionId = sessionId;
          port.postMessage(msg);
        });
      },
      on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  const cdp = kind === 'six-bridge' ? await bridge(extId) : globalThis.sliccExtension.cdp;
  const events = [];
  cdp.on((event) => events.push(event));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const attempt = (method, params, sessionId) =>
    cdp.send(method, params, sessionId).then(
      (result) => ({ result }),
      (error) => ({ error: String(error?.message ?? error) })
    );
  async function evaluate(sessionId, expression) {
    let last;
    for (let i = 0; i < 80; i++) {
      last = await attempt(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true, userGesture: true },
        sessionId
      );
      if (last.result && !last.result.exceptionDetails) return last.result.result?.value;
      if (last.error && !last.error.includes('context')) return { error: last.error };
      await sleep(100);
    }
    return { error: JSON.stringify(last) };
  }
  async function until(fn, ms = 10000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value) return value;
      await sleep(100);
    }
    return undefined;
  }
  async function open(url) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    if (url) await land(sessionId, url);
    return { targetId, sessionId };
  }
  async function land(sessionId, url) {
    await cdp.send('Page.navigate', { url }, sessionId);
    return until(async () => {
      const href = await evaluate(
        sessionId,
        'document.readyState === "complete" ? location.href : ""'
      );
      return typeof href === 'string' && href.startsWith(url) ? href : undefined;
    });
  }
  function detached(sessionId) {
    return events.some(
      (event) =>
        event.method === 'Target.detachedFromTarget' && event.params?.sessionId === sessionId
    );
  }
  function beaconSource(tag) {
    return `fetch("https://upstream.test/beacon/" + ${JSON.stringify(tag)} + "?at=" + encodeURIComponent(location.href), { mode: "no-cors" }).catch(() => undefined); window.__slicc = ${JSON.stringify(tag)};`;
  }
  async function close(targetId) {
    await attempt('Target.closeTarget', { targetId });
  }
  const signals = new Set([
    'Page.frameRequestedNavigation',
    'Page.frameStartedNavigating',
    'Page.frameScheduledNavigation',
    'Target.detachedFromTarget',
  ]);
  function content(list) {
    return list.filter(
      (event) =>
        !signals.has(event.method) &&
        !event.method.startsWith('Target.') &&
        !(event.method === 'Network.requestWillBeSent' && event.params?.type === 'Document')
    );
  }
  globalThis.h = {
    content,
    cdp,
    events,
    sleep,
    attempt,
    evaluate,
    until,
    open,
    land,
    detached,
    beaconSource,
    close,
  };
  return true;
}
