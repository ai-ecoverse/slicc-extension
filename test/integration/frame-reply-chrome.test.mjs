import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { assertFrameReply, committedFrame } from './fixtures/frame-reply-control.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

for (const host of ['seven.sliccy.ai', 'www.sliccy.ai']) {
  for (const protectedChild of [false, true]) {
    test(`${host} real page API ${protectedChild ? 'refuses a committed cross-process vault iframe without leaking frame data' : 'returns a URL-free complete ordinary cross-process frame reply'}`, async (t) => {
      const page = await chrome.visit(t, `https://${host}/`);
      const url = `https://ordinary.test/doc?frame-reply-${host}-${protectedChild}`;
      const target = await chrome.visit(t, url);
      const child = protectedChild
        ? `https://vault.sliccy.ai/doc?FRAME_REPLY_CANARY=${host}`
        : `https://other.test/doc?FRAME_REPLY_ORDINARY=${host}`;
      await target.evaluate(async (src) => {
        const iframe = document.createElement('iframe');
        const loaded = new Promise((resolve, reject) => {
          iframe.onload = resolve;
          iframe.onerror = () => reject(new Error('frame fixture did not load'));
        });
        iframe.src = src;
        document.body.append(iframe);
        await loaded;
      }, child);
      const committedChild = await committedFrame(chrome.cdp, target, child);
      const reply = await page.evaluate(async (url) => {
        const listed = await sliccExtension.cdp.send('Target.getTargets');
        const info = listed.targetInfos.find((entry) => entry.url === url);
        if (!info) throw new Error('ordinary fixture target was not listed');
        const attached = await sliccExtension.cdp.send('Target.attachToTarget', {
          targetId: info.targetId,
          flatten: true,
        });
        if (!attached.sessionId) throw new Error('ordinary fixture target was not attached');
        const events = [];
        const off = sliccExtension.cdp.on((message) => events.push(message));
        try {
          const snapshot = await sliccExtension.frames(Number(info.targetId));
          return { snapshot, events };
        } catch (error) {
          return { error: error.message, events };
        } finally {
          off();
        }
      }, url);
      assertFrameReply(reply, committedChild, protectedChild);
    });
  }
}
