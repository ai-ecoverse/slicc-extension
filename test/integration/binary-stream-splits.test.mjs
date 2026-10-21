import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const entries = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
let serial = 0;

for (const transport of Object.keys(entries)) {
  for (const split of ['buffered', 'chunks']) {
    for (const to of ['protected', 'ordinary']) {
      test(`${transport}: ${split} boundary ${to} binary marker`, async (t) => {
        const page = await chrome.visit(t, entries[transport]);
        await page.evaluate(install, transport, extId);
        const n = `${++serial}${Date.now()}`;
        const run = await page.evaluate(
          async ({ n, split, to }) => {
            const { targetId, sessionId } = await h.open('https://ordinary.test/doc');
            await h.cdp.send('Network.enable', {}, sessionId);
            const from = h.events.length;
            const url = `https://ordinary.test/binary-stream?to=${to}&n=${n}&split=${split}`;
            await h.cdp.send(
              'Runtime.evaluate',
              {
                expression: `globalThis.binaryDone = fetch(${JSON.stringify(url)}).then(r => r.arrayBuffer()).then(b => b.byteLength); 1`,
              },
              sessionId
            );
            const response = await h.until(() =>
              h.events
                .slice(from)
                .find(
                  (e) => e.method === 'Network.responseReceived' && e.params.response.url === url
                )
            );
            const requestId = response?.params.requestId;
            const buffered = await h.attempt(
              'Network.streamResourceContent',
              { requestId },
              sessionId
            );
            const size = await h.evaluate(sessionId, 'binaryDone');
            await h.until(() =>
              h.events
                .slice(from)
                .find(
                  (e) => e.method === 'Network.loadingFinished' && e.params.requestId === requestId
                )
            );
            const chunks = h.events
              .slice(from)
              .filter(
                (e) =>
                  e.method === 'Network.dataReceived' &&
                  e.params.requestId === requestId &&
                  e.params.data
              );
            const text =
              atob(buffered.result?.bufferedData ?? '') +
              chunks.map((e) => atob(e.params.data)).join('');
            await h.close(targetId);
            return { buffered, chunks, text, size };
          },
          { n, split, to }
        );
        assert.equal(run.buffered.error, undefined);
        const host = to === 'protected' ? 'vault.sliccy.ai' : 'ordinary.test';
        const expected = `\xff\xfe\0start https://${host}/landing?code=BINARY${n} end`;
        assert.equal(run.size, expected.length);
        if (to === 'protected') {
          assert.equal(run.text.includes(`BINARY${n}`), false);
          assert.equal(run.chunks.length, split === 'buffered' ? 0 : 1);
        } else {
          assert.equal(run.text, expected);
          assert.equal(run.chunks.length, split === 'buffered' ? 1 : 2);
        }
      });
    }
  }
}
