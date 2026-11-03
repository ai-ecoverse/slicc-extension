import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { launch } from './chrome.mjs';
import { extId, openExtensionPage } from './extension-page.mjs';

test('six handoff messages use the resolved tab state', async (t) => {
  const chrome = await launch({
    prepare: async (paths) => {
      await appendFile(
        join(paths[0], 'six-sw.js'),
        '\nglobalThis.handoffTest = { headers: onHandoffHeaders, post: postLickToWelcomedLeaderPorts };\n'
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
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const worker = targetInfos.find(
      (info) =>
        info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
    );
    assert.ok(worker);
    const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
      targetId: worker.targetId,
      flatten: true,
    });
    const url = 'https://ordinary.test/linked?n=title';
    const rows = [
      ['current vault', { url: 'https://vault.sliccy.ai/private', title: 'Vault title' }, false],
      [
        'navigation while lookup waits',
        { navigateTo: 'https://vault.sliccy.ai/private' },
        false,
        undefined,
        'https://ordinary.test/marker',
      ],
      ['current seven', { url: 'https://seven.sliccy.ai/', title: 'Seven title' }, false],
      [
        'pending vault',
        { url, pendingUrl: 'https://vault.sliccy.ai/private', title: 'Page title' },
        false,
      ],
      ['same page', { url, title: 'Page title' }, true, 'Page title'],
      ['fragment', { url: `${url}#section`, title: 'Page title' }, true, 'Page title'],
      [
        'ordinary navigation',
        { url: 'https://ordinary.test/elsewhere', title: 'Other title' },
        true,
      ],
      ['lookup failure', null, true],
      [
        'www handoff',
        { url: 'https://www.sliccy.ai/handoff#part', title: 'Handoff title' },
        true,
        'Handoff title',
        'https://www.sliccy.ai/handoff',
      ],
    ];
    for (const [name, tab, sent, title, responseUrl = url] of rows) {
      await t.test(name, async () => {
        const marker = `https://upstream.test/done-${encodeURIComponent(name)}`;
        const result = await chrome.cdp.send(
          'Runtime.evaluate',
          {
            expression: `(${async function (tab, responseUrl, marker) {
              const original = chrome.tabs.get;
              const moving = tab?.navigateTo
                ? await chrome.tabs.create({ url: responseUrl })
                : undefined;
              const tabId = moving?.id ?? 987654;
              let resolve;
              let reject;
              const pending = new Promise((yes, no) => {
                resolve = yes;
                reject = no;
              });
              chrome.tabs.get = (id) => (id === tabId ? pending : original.call(chrome.tabs, id));
              try {
                handoffTest.headers({
                  url: responseUrl,
                  tabId,
                  responseHeaders: [
                    {
                      name: 'Link',
                      value:
                        '<https://upstream.test/title-target>; rel="https://www.sliccy.ai/rel/handoff"',
                    },
                  ],
                });
                if (moving) {
                  await new Promise((done) => {
                    const listener = (id, change) => {
                      if (id === tabId && change.status === 'complete') {
                        chrome.tabs.onUpdated.removeListener(listener);
                        done();
                      }
                    };
                    chrome.tabs.onUpdated.addListener(listener);
                    chrome.tabs.update(tabId, { url: tab.navigateTo });
                  });
                  resolve(await original.call(chrome.tabs, tabId));
                } else if (tab) resolve(tab);
                else reject(new Error('Tab closed'));
                await pending.catch(() => {});
                await Promise.resolve();
                await Promise.resolve();
                const payload = { kind: 'extension.lick', type: 'navigate-lick', target: marker };
                handoffTest.post(payload);
                await chrome.runtime
                  .sendMessage({ source: 'service-worker', payload })
                  .catch(() => {});
              } finally {
                chrome.tabs.get = original;
                if (moving) await chrome.tabs.remove(tabId);
              }
            }})(${JSON.stringify(tab)}, ${JSON.stringify(responseUrl)}, ${JSON.stringify(marker)})`,
            awaitPromise: true,
            returnByValue: true,
          },
          sessionId
        );
        assert.equal(result.exceptionDetails, undefined);
        await leader.until(
          (marker) => window.handoffMessages.some((m) => m.target === marker),
          marker
        );
        await panel.until(
          `globalThis.handoffMessages.some((m) => m.target === ${JSON.stringify(marker)})`
        );
        const portMessages = await leader.evaluate(() => window.handoffMessages.splice(0));
        const runtimeMessages = await panel.evaluate('globalThis.handoffMessages.splice(0)');
        for (const messages of [portMessages, runtimeMessages]) {
          const licks = messages.filter(
            (message) => message.target === 'https://upstream.test/title-target'
          );
          assert.equal(licks.length, sent ? 1 : 0);
          if (sent) {
            assert.equal(licks[0].title, title);
            assert.equal(licks[0].url, responseUrl);
            assert.equal(licks[0].verb, 'handoff');
          }
        }
      });
    }
  } finally {
    await chrome.close();
  }
});
