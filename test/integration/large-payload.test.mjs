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

const transports = ['seven', 'six-bridge'];
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const BUDGET = 8000;
let serial = 0;

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

const NOISE = `(() => {
  const c = document.createElement('canvas');
  c.width = 1600;
  c.height = 1600;
  const x = c.getContext('2d');
  const img = x.createImageData(c.width, c.height);
  crypto.getRandomValues(img.data.subarray(0, 65536));
  for (let i = 65536; i < img.data.length; i += 65536) {
    crypto.getRandomValues(img.data.subarray(i, Math.min(i + 65536, img.data.length)));
  }
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  x.putImageData(img, 0, 0);
  c.style.position = 'fixed';
  c.style.left = '0';
  c.style.top = '0';
  document.body.append(c);
  return true;
})()`;

for (const transport of transports) {
  test(`${transport}: a large noisy PNG screenshot reaches the client within ${BUDGET} ms`, async (t) => {
    const page = await client(t, transport);
    const n = `shot${++serial}${Date.now()}`;
    const run = await page.evaluate(
      async ({ n, NOISE }) => {
        const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=${n}`);
        await h.attempt(
          'Emulation.setDeviceMetricsOverride',
          { width: 1600, height: 1600, deviceScaleFactor: 1, mobile: false },
          sessionId
        );
        await h.evaluate(sessionId, NOISE);
        const started = performance.now();
        const shot = await h.attempt('Page.captureScreenshot', { format: 'png' }, sessionId);
        const ms = performance.now() - started;
        await h.close(targetId);
        return { ms, size: shot.result?.data?.length ?? 0, error: shot.error };
      },
      { n, NOISE }
    );
    t.diagnostic(`${transport} screenshot ${run.size} chars in ${Math.round(run.ms)} ms`);
    assert.equal(run.error, undefined);
    assert.ok(run.size > 4_000_000, `the screenshot is large: ${run.size}`);
    assert.ok(run.ms < BUDGET, `the screenshot took ${Math.round(run.ms)} ms`);
  });

  test(`${transport}: a large binary response body reaches the client within ${BUDGET} ms`, async (t) => {
    const page = await client(t, transport);
    const n = `body${++serial}${Date.now()}`;
    const run = await page.evaluate(async (n) => {
      const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=${n}`);
      await h.attempt('Network.enable', {}, sessionId);
      const from = h.events.length;
      const url = `https://ordinary.test/noise?size=${4 * 1024 * 1024}&n=${n}`;
      await h.evaluate(
        sessionId,
        `fetch(${JSON.stringify(url)}).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`
      );
      const done = await h.until(() =>
        h.events
          .slice(from)
          .find(
            (e) =>
              e.method === 'Network.loadingFinished' &&
              h.events
                .slice(from)
                .some(
                  (s) =>
                    s.method === 'Network.requestWillBeSent' &&
                    s.params.requestId === e.params.requestId &&
                    s.params.request.url === url
                )
          )
      );
      const started = performance.now();
      const body = await h.attempt(
        'Network.getResponseBody',
        { requestId: done?.params.requestId },
        sessionId
      );
      const ms = performance.now() - started;
      await h.close(targetId);
      return {
        ms,
        size: body.result?.body?.length ?? 0,
        base64: body.result?.base64Encoded,
        error: body.error,
      };
    }, n);
    t.diagnostic(`${transport} body ${run.size} chars in ${Math.round(run.ms)} ms`);
    assert.equal(run.error, undefined);
    assert.equal(run.base64, true);
    assert.ok(run.size > 5_000_000, `the body is large: ${run.size}`);
    assert.ok(run.ms < BUDGET, `the body read took ${Math.round(run.ms)} ms`);
  });

  for (const unit of ['=//a', 'https:']) {
    test(`${transport}: a large evaluate value of repeated ${unit} ending in a protected url reaches the client within ${BUDGET} ms, as its origin only`, async (t) => {
      const page = await client(t, transport);
      const n = `rep${++serial}${Date.now()}`;
      const run = await page.evaluate(
        async ({ n, unit, budget }) => {
          const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=${n}`);
          const tail = ' https://vault.sliccy.ai/oauth/mcp-callback?code=S3CR3T';
          const expression = `${JSON.stringify(unit)}.repeat(1 << 20) + ${JSON.stringify(tail)}`;
          const started = performance.now();
          const answer = await Promise.race([
            h.attempt('Runtime.evaluate', { expression, returnByValue: true }, sessionId),
            h.sleep(budget * 2).then(() => ({ error: 'no answer' })),
          ]);
          const ms = performance.now() - started;
          const value = String(answer.result?.result?.value ?? '');
          await h.close(targetId);
          return {
            ms,
            error: answer.error,
            size: value.length,
            leaked: value.includes('S3CR3T'),
            ends: value.endsWith(' https://vault.sliccy.ai'),
          };
        },
        { n, unit, budget: BUDGET }
      );
      t.diagnostic(`${transport} ${unit} value ${run.size} chars in ${Math.round(run.ms)} ms`);
      assert.equal(run.error, undefined);
      assert.ok(run.ms < BUDGET, `the value took ${Math.round(run.ms)} ms`);
      assert.equal(run.leaked, false, 'the token reaches the client');
      assert.equal(run.ends, true, 'the protected url is reduced to its origin');
    });
  }
}
