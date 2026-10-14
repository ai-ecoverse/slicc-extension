export function install() {
  const cdp = globalThis.sliccExtension.cdp;
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
  globalThis.h = {
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
