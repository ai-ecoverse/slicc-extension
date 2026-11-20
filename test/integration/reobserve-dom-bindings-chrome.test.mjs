import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

test('seven: client nodeId survives a child commit reobserve without DOM documentUpdated or setChildNodes', async (t) => {
  const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
  const url = 'https://ordinary.test/doc?reobserve-dom-survive-seven';
  const target = await chrome.visit(t, url);
  await target.evaluate(() => {
    const mark = document.createElement('div');
    mark.id = 'reobserve-mark';
    mark.textContent = 'mark';
    document.body.append(mark);
  });
  const result = await page.evaluate(async (pageUrl) => {
    const listed = await sliccExtension.cdp.send('Target.getTargets');
    const info = listed.targetInfos.find((entry) => entry.url === pageUrl);
    if (!info) throw new Error('ordinary fixture target was not listed');
    const attached = await sliccExtension.cdp.send('Target.attachToTarget', {
      targetId: info.targetId,
      flatten: true,
    });
    if (!attached.sessionId) throw new Error('ordinary fixture target was not attached');
    const sessionId = attached.sessionId;
    const doc = await sliccExtension.cdp.send('DOM.getDocument', { depth: 0 }, sessionId);
    const selected = await sliccExtension.cdp.send(
      'DOM.querySelector',
      { nodeId: doc.root.nodeId, selector: '#reobserve-mark' },
      sessionId
    );
    if (!selected.nodeId) throw new Error('fixture mark was not found');
    await sliccExtension.cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const iframe = document.createElement('iframe');
          iframe.src = 'https://other.test/doc?REOBSERVE_DOM_SIBLING';
          document.body.append(iframe);
          return new Promise((resolve) => {
            iframe.onload = () => {
              iframe.src = 'https://other.test/doc?REOBSERVE_DOM_SIBLING_COMMIT';
              iframe.onload = () => resolve(true);
            };
          });
        })()`,
        awaitPromise: true,
      },
      sessionId
    );
    const seen = [];
    const off = sliccExtension.cdp.on((message) => {
      if (message?.method === 'DOM.documentUpdated' || message?.method === 'DOM.setChildNodes') {
        seen.push(message.method);
      }
    });
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          await sliccExtension.frames(Number(info.targetId));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      let described;
      try {
        described = await sliccExtension.cdp.send(
          'DOM.describeNode',
          { nodeId: selected.nodeId },
          sessionId
        );
      } catch (error) {
        described = { error: error.message };
      }
      return { described, seen, nodeId: selected.nodeId };
    } finally {
      off();
    }
  }, url);
  assert.equal(result.described.error, undefined, JSON.stringify(result.described));
  assert.equal(result.described.node?.nodeName, 'DIV');
  assert.deepEqual(result.seen, []);
});
