import assert from 'node:assert/strict';
import { extId } from './extension-page.mjs';

export const receiver = 'https://upstream.test/hello';

export function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function eventually(probe, ms = 10000) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    last = await probe();
    if (last.done) return last.value;
    if (Date.now() > deadline) assert.fail(`document row did not settle: ${JSON.stringify(last)}`);
    await pause(100);
  }
}

export function read(page, url = receiver, init) {
  return page.evaluate(
    async (url, init) => {
      try {
        const response = await fetch(url, init);
        return { ok: true, status: response.status, text: await response.text() };
      } catch (error) {
        return { ok: false, name: error.name };
      }
    },
    url,
    init
  );
}

export function readable(result) {
  return result.ok === true && result.status === 200;
}

export function lens(chrome) {
  const panels = new WeakMap();

  async function workerTargets() {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    return targetInfos.filter(
      (info) =>
        info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
    );
  }

  async function inWorker(expression) {
    const [target] = await workerTargets();
    if (!target) return { missing: true };
    const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    try {
      const answer = await chrome.cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      );
      if (answer.exceptionDetails) return { error: answer.exceptionDetails.text };
      return { value: answer.result.value };
    } finally {
      await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    }
  }

  async function extension(t) {
    const known = panels.get(t);
    if (known) {
      const alive = await known
        .evaluate(() => typeof chrome?.declarativeNetRequest?.getSessionRules === 'function')
        .catch(() => false);
      if (alive) return known;
    }
    const page = await chrome.visit(t, 'https://other.test/panel', { expectExtension: false });
    await page.send('Page.navigate', { url: `chrome-extension://${extId}/secrets.html` });
    await page.until(
      () =>
        location.href.startsWith('chrome-extension://') &&
        typeof chrome?.declarativeNetRequest?.getSessionRules === 'function'
    );
    panels.set(t, page);
    return page;
  }

  async function running(page) {
    await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'document-row' }).catch(() => null)
    );
    await eventually(async () => {
      const count = (await workerTargets()).length;
      return { done: count > 0, value: count };
    });
    assert.deepEqual(await inWorker('true'), { value: true });
    assert.ok((await workerTargets()).length > 0);
  }

  async function stop(page) {
    await page.send('ServiceWorker.enable');
    await page.send('ServiceWorker.stopAllWorkers');
    await page.send('ServiceWorker.disable');
    await eventually(async () => ({ done: (await workerTargets()).length === 0, value: true }));
    assert.equal((await workerTargets()).length, 0);
  }

  return { inWorker, workerTargets, extension, running, stop };
}

export const plainFlags = [
  '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForTypicallySecureUsers,HttpsFirstBalancedMode,HttpsFirstModeIncognito',
];
