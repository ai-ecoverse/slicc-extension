export const extId = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';

function send(page, method, params, sessionId) {
  return page.evaluate(
    async (opts) => globalThis.sliccExtension.cdp.send(opts.method, opts.params, opts.sessionId),
    { method, params, sessionId }
  );
}

export async function openExtensionPage(page, path) {
  const { targetId } = await send(page, 'Target.createTarget', {
    url: `chrome-extension://${extId}/${path}`,
  });
  const { sessionId } = await send(page, 'Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expression) => {
    const answer = await send(
      page,
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (answer.exceptionDetails) {
      throw new Error(
        `${path}: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`
      );
    }
    return answer.result.value;
  };
  for (let i = 0; i < 100; i++) {
    const ready = await evaluate('document.readyState === "complete"').catch(() => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    evaluate,
    until: async (expression, ms = 10000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const value = await evaluate(expression);
        if (value || Date.now() > deadline) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    close: () => send(page, 'Target.closeTarget', { targetId }).catch(() => undefined),
  };
}

export function portCall(page, name, message) {
  return page.evaluate(
    async (opts) => {
      const port = chrome.runtime.connect(opts.extId, { name: opts.name });
      const answer = await new Promise((resolve) => {
        port.onMessage.addListener((m) => {
          if (m?.id === opts.message.id) resolve(m.response);
        });
        port.onDisconnect.addListener(() => resolve({ disconnected: true }));
        port.postMessage(opts.message);
      });
      port.disconnect();
      return answer;
    },
    { extId, name, message }
  );
}
