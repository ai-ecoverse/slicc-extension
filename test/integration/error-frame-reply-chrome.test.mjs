import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const LEAK =
  /https?:|chrome-error|127\.0\.0\.1|\.test|\.ai|CANARY|vault|redirect|securityOrigin|documentId|unreachable|url|title|length|count/i;

async function framed(t, host, name, sources) {
  const page = await chrome.visit(t, `https://${host}/`);
  const url = `https://ordinary.test/doc?error-frame-${name}-${host}`;
  const target = await chrome.visit(t, url);
  const targetId = await page.evaluate(async (url) => {
    const listed = await sliccExtension.cdp.send('Target.getTargets');
    const info = listed.targetInfos.find((entry) => entry.url === url);
    if (!info) throw new Error('ordinary fixture target was not listed');
    const attached = await sliccExtension.cdp.send('Target.attachToTarget', {
      targetId: info.targetId,
      flatten: true,
    });
    if (!attached.sessionId) throw new Error('ordinary fixture target was not attached');
    return info.targetId;
  }, url);
  await target.evaluate(async (sources) => {
    await Promise.all(
      sources.map(
        (src) =>
          new Promise((resolve) => {
            const iframe = document.createElement('iframe');
            iframe.onload = resolve;
            iframe.src = src;
            document.body.append(iframe);
          })
      )
    );
  }, sources);
  return { page, targetId };
}

async function snapshot(page, targetId, settled) {
  return page.evaluate(
    async ({ targetId, settled }) => {
      const events = [];
      const off = sliccExtension.cdp.on((message) => events.push(message));
      let last;
      try {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          try {
            last = { snapshot: await sliccExtension.frames(Number(targetId)) };
          } catch (error) {
            last = { error: error.message };
          }
          if (settled && last.snapshot) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return { ...last, events };
      } finally {
        off();
      }
    },
    { targetId, settled }
  );
}

for (const host of ['seven.sliccy.ai', 'www.sliccy.ai']) {
  test(`${host} real page API places an ordinary unreachable iframe as an unprotected error frame`, async (t) => {
    const { page, targetId } = await framed(t, host, 'ordinary', [
      'https://127.0.0.1:1/ERROR_FRAME_CANARY?q=CANARY',
      `https://other.test/doc?ERROR_FRAME_SIBLING_CANARY=${host}`,
    ]);
    const reply = await snapshot(page, targetId, true);
    assert.equal(reply.error, undefined);
    assert.doesNotMatch(JSON.stringify(reply.snapshot), LEAK);
    assert.deepEqual(reply.events, []);
    const result = reply.snapshot;
    assert.equal(result.version, 2);
    assert.deepEqual(Object.keys(result).sort(), [
      'frames',
      'localFrames',
      'remoteOwners',
      'revision',
      'rootFrameId',
      'rootLoaderId',
      'version',
    ]);
    assert.equal(typeof result.rootFrameId, 'string');
    assert.equal(result.frames.length, 3);
    assert.equal(result.localFrames.length + result.remoteOwners.length, 3);
    assert.deepEqual(
      result.frames.map(({ kind, errorProtected }) => [kind, errorProtected]).sort(),
      [
        ['error', false],
        ['ordinary', undefined],
        ['ordinary', undefined],
      ]
    );
    for (const frame of result.frames) {
      assert.ok(Number.isSafeInteger(frame.frameId));
      assert.ok(Number.isSafeInteger(frame.parentFrameId));
      assert.deepEqual(
        Object.keys(frame),
        frame.kind === 'error'
          ? ['frameId', 'parentFrameId', 'kind', 'errorProtected']
          : ['frameId', 'parentFrameId', 'kind']
      );
    }
  });

  test(`${host} real page API still refuses a frame whose protected hop the guard blocked`, async (t) => {
    const hop = `https://vault.sliccy.ai/doc?ERROR_HOP_CANARY=${host}`;
    const { page, targetId } = await framed(t, host, 'hop', [
      `https://ordinary.test/redirect?to=${encodeURIComponent(hop)}`,
    ]);
    const reply = await snapshot(page, targetId, false);
    assert.doesNotMatch(JSON.stringify(reply), LEAK);
    assert.deepEqual(reply, { error: 'slicc: refused: unsettled frame list', events: [] });
  });
}
