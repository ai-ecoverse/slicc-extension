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

const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const colour = { seven: [20, 180, 60], 'six-bridge': [200, 40, 160] };
const BUDGET = 10000;
let serial = 0;

const shots = [
  ['png', { format: 'png' }, '800x600'],
  ['clip', { format: 'png', clip: { x: 10, y: 20, width: 300, height: 200, scale: 2 } }, '600x400'],
  ['jpeg', { format: 'jpeg', quality: 80 }, '800x600'],
  ['png again', { format: 'png' }, '800x600'],
  ['png once more', { format: 'png' }, '800x600'],
  ['jpeg again', { format: 'jpeg', quality: 80 }, '800x600'],
];

async function capture(page, params) {
  return page.evaluate(
    async ({ params, BUDGET }) => {
      const { sessionId } = globalThis.__shot;
      await h.sleep(1000);
      const started = performance.now();
      const shot = await Promise.race([
        h.attempt('Page.captureScreenshot', params, sessionId),
        h.sleep(BUDGET).then(() => ({ error: `no answer in ${BUDGET} ms` })),
      ]);
      const ms = Math.round(performance.now() - started);
      if (!shot.result?.data) return { ms, error: shot.error ?? 'no data' };
      const bytes = Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0));
      const type = params.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const bitmap = await createImageBitmap(new Blob([bytes], { type }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const pixel = [
        ...context.getImageData(bitmap.width >> 1, bitmap.height >> 1, 1, 1).data.slice(0, 3),
      ];
      return { ms, size: `${bitmap.width}x${bitmap.height}`, pixel };
    },
    { params, BUDGET }
  );
}

for (const transport of Object.keys(entry)) {
  test(`${transport}: repeated screenshots of a background tab answer at the requested size, of that tab, behind seven's tab`, async (t) => {
    const page = await chrome.visit(t, entry[transport]);
    await page.evaluate(install, transport, extId);
    const [r, g, b] = colour[transport];
    const opened = await page.evaluate(
      async ({ url, fill }) => {
        const { targetId, sessionId } = await h.open(url);
        globalThis.__shot = { targetId, sessionId };
        await h.attempt(
          'Emulation.setDeviceMetricsOverride',
          { width: 800, height: 600, deviceScaleFactor: 1, mobile: false },
          sessionId
        );
        const painted = await h.evaluate(
          sessionId,
          `(() => { document.documentElement.style.background = ${JSON.stringify(fill)}; document.body.style.background = ${JSON.stringify(fill)}; return document.visibilityState; })()`
        );
        return { painted, mark: h.events.length };
      },
      {
        url: `https://ordinary.test/doc?n=shot${++serial}${Date.now()}`,
        fill: `rgb(${r}, ${g}, ${b})`,
      }
    );
    assert.equal(opened.painted, 'hidden', 'the driven tab is a hidden background tab');
    for (const [label, params, size] of shots) {
      const shot = await capture(page, params);
      t.diagnostic(`${transport} ${label}: ${JSON.stringify(shot)}`);
      assert.equal(shot.error, undefined, `${transport} ${label} answered within ${BUDGET} ms`);
      assert.equal(shot.size, size, `${transport} ${label} has the requested size`);
      const near = shot.pixel.every((value, i) => Math.abs(value - colour[transport][i]) <= 12);
      assert.ok(
        near,
        `${transport} ${label} shows the driven tab: ${shot.pixel} vs ${colour[transport]}`
      );
    }
    const after = await page.evaluate(
      async ({ mark }) => ({
        cast: h.events.slice(mark).filter((event) => event.method.startsWith('Page.screencast'))
          .length,
        seven: document.visibilityState,
        driven: await h.evaluate(globalThis.__shot.sessionId, 'document.visibilityState'),
      }),
      opened
    );
    assert.equal(after.cast, 0, `${transport}: no screencast events reach the client`);
    assert.equal(after.seven, 'visible', `${transport}: seven's tab stays in front`);
    assert.equal(after.driven, 'hidden', `${transport}: the driven tab stays in the background`);
    const cast = await page.evaluate(async (BUDGET) => {
      const { sessionId } = globalThis.__shot;
      const mark = h.events.length;
      const started = await h.attempt(
        'Page.startScreencast',
        { format: 'jpeg', quality: 50, everyNthFrame: 1 },
        sessionId
      );
      await h.attempt(
        'Runtime.evaluate',
        { expression: 'document.body.style.background = "rgb(0, 0, 255)"' },
        sessionId
      );
      const frame = await h.until(
        () => h.events.slice(mark).find((event) => event.method === 'Page.screencastFrame'),
        BUDGET
      );
      const stopped = await h.attempt('Page.stopScreencast', {}, sessionId);
      return {
        started: started.error ?? null,
        stopped: stopped.error ?? null,
        frame: Boolean(frame?.params?.data),
      };
    }, BUDGET);
    assert.deepEqual(
      cast,
      { started: null, stopped: null, frame: true },
      `${transport}: the client's own screencast still starts, streams and stops`
    );
    await page.evaluate(() => h.close(globalThis.__shot.targetId));
  });
}
