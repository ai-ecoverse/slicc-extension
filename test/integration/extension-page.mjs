export const extId = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';

export async function openExtensionPage(page, path) {
  const tab = await page.tab();
  const url = `chrome-extension://${extId}/${path}`;
  await tab.send('Page.navigate', { url });
  await tab.until((href) => location.href === href && document.readyState === 'complete', url);
  const raw = (expression) =>
    tab.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const evaluate = async (expression) => {
    const answer = await raw(expression);
    if (answer.exceptionDetails) {
      throw new Error(
        `${path}: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text}`
      );
    }
    return answer.result.value;
  };
  return {
    raw,
    evaluate,
    until: async (expression, ms = 10000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const value = await evaluate(expression);
        if (value || Date.now() > deadline) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    close: () => tab.close().catch(() => undefined),
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
