import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { launch } from './chrome.mjs';
import { extId, openExtensionPage } from './extension-page.mjs';

test('six handoffs send response metadata without a tab title', async (t) => {
  const chrome = await launch({
    prepare: async (paths) => {
      await appendFile(
        join(paths[0], 'six-sw.js'),
        '\nglobalThis.handoffTest = { headers: onHandoffHeaders };\n'
      );
    },
  });
  try {
    const leader = await chrome.visit(t, 'https://www.sliccy.ai/?slicc=leader');
    await leader.evaluate(async (id) => {
      window.handoffMessages = [];
      const port = chrome.runtime.connect(id, { name: 'slicc.cdp-bridge' });
      window.handoffPort = port;
      const channelId = crypto.randomUUID();
      await new Promise((resolve) => {
        port.onMessage.addListener((message) => {
          if (message.kind === 'handshake.welcome') resolve();
          if (message.kind === 'extension.lick') window.handoffMessages.push(message);
        });
        port.postMessage({ bridge: 1, channelId, kind: 'handshake.hello' });
      });
    }, extId);
    const panel = await openExtensionPage(leader, 'secrets.html');
    await panel.evaluate(`globalThis.handoffMessages = []; chrome.runtime.onMessage.addListener((message) => {
      if (message.source === 'service-worker') globalThis.handoffMessages.push(message.payload);
    }); true`);
    const received = async (target, url, instruction) => {
      assert.equal(
        await leader.until(
          (target) => window.handoffMessages.some((m) => m.target === target),
          target
        ),
        true
      );
      assert.equal(
        await panel.until(
          `globalThis.handoffMessages.some((m) => m.target === ${JSON.stringify(target)})`
        ),
        true
      );
      const messages = [
        await leader.evaluate(
          (target) => window.handoffMessages.filter((m) => m.target === target),
          target
        ),
        await panel.evaluate(
          `globalThis.handoffMessages.filter((m) => m.target === ${JSON.stringify(target)})`
        ),
      ];
      for (const licks of messages) {
        assert.equal(licks.length, 1);
        assert.equal(Object.hasOwn(licks[0], 'title'), false);
        assert.equal(licks[0].url, url);
        assert.equal(licks[0].verb, 'handoff');
        assert.equal(licks[0].instruction, instruction);
      }
    };
    for (const [name, source, destination] of [
      ['ordinary', 'https://ordinary.test/', 'https://ordinary.test/linked'],
      ['seven', 'https://seven.sliccy.ai/', 'https://ordinary.test/linked'],
      ['www', 'https://www.sliccy.ai/', 'https://ordinary.test/linked'],
      ['vault', 'https://vault.sliccy.ai/', 'https://ordinary.test/linked'],
      ['www handoff', 'https://www.sliccy.ai/', 'https://www.sliccy.ai/handoff'],
    ]) {
      await t.test(name, async () => {
        const page = await chrome.visit(t, source);
        await page.evaluate(() => {
          document.title = 'Source page title';
        });
        const stamp = `${Date.now()}-${name.replaceAll(' ', '-')}`;
        const url = `${destination}?n=${stamp}`;
        await page.evaluate((url) => {
          location.href = url;
        }, url);
        await page.until((url) => location.href === url && document.readyState === 'complete', url);
        await received(`https://upstream.test/handoff-${stamp}`, url, `handoff ${stamp}`);
      });
    }
    await t.test(
      'delivery does not wait for a tab lookup or depend on later navigation',
      async () => {
        const page = await chrome.visit(t, 'https://ordinary.test/marker');
        const { targetInfos } = await chrome.cdp.send('Target.getTargets');
        const worker = targetInfos.find(
          (info) =>
            info.type === 'service_worker' &&
            info.url === `chrome-extension://${extId}/background.js`
        );
        assert.ok(worker);
        const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
          targetId: worker.targetId,
          flatten: true,
        });
        const result = await chrome.cdp.send(
          'Runtime.evaluate',
          {
            expression: `(() => {
          const original = chrome.tabs.get;
          let lookups = 0;
          chrome.tabs.get = (id) => {
            if (id !== 987654) return original.call(chrome.tabs, id);
            lookups += 1;
            return new Promise(() => {});
          };
          try {
            handoffTest.headers({
              url: 'https://ordinary.test/marker',
              tabId: 987654,
              responseHeaders: [{ name: 'Link', value: '<https://upstream.test/without-lookup>; rel="https://www.sliccy.ai/rel/handoff"' }],
            });
            return lookups;
          } finally {
            chrome.tabs.get = original;
          }
        })()`,
            returnByValue: true,
          },
          sessionId
        );
        assert.equal(result.exceptionDetails, undefined);
        assert.equal(result.result.value, 0);
        await page.goto('https://vault.sliccy.ai/');
        await received(
          'https://upstream.test/without-lookup',
          'https://ordinary.test/marker',
          undefined
        );
      }
    );
  } finally {
    await chrome.close();
  }
});
