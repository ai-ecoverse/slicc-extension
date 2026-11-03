import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

for (const host of ['seven.sliccy.ai', 'www.sliccy.ai']) {
  for (const protectedChild of [false, true]) {
    test(`${host} real page API frame reply contains no URL, origin or document ID beside ${protectedChild ? 'a loaded vault' : 'an ordinary'} iframe`, async (t) => {
      const page = await chrome.visit(t, `https://${host}/`);
      const url = `https://ordinary.test/doc?frame-reply-${host}-${protectedChild}`;
      const target = await chrome.visit(t, url);
      const child = protectedChild
        ? 'https://vault.sliccy.ai/doc?FRAME_REPLY_CANARY'
        : 'https://other.test/doc?FRAME_REPLY_ORDINARY';
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
      const raw = await target.send('Page.getFrameTree');
      assert.ok(
        raw.frameTree.childFrames?.some(({ frame }) => frame.url === child),
        'raw control must prove the child committed before the extension attaches'
      );
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
        } finally {
          off();
        }
      }, url);
      const serialized = JSON.stringify(reply.snapshot);
      assert.doesNotMatch(JSON.stringify(reply), /vault\.sliccy\.ai|FRAME_REPLY_CANARY/);
      assert.doesNotMatch(
        serialized,
        /https?:\/\/|vault\.sliccy\.ai|ordinary\.test|other\.test|FRAME_REPLY_CANARY|FRAME_REPLY_ORDINARY/
      );
      assert.doesNotMatch(serialized, /"(?:url|origin|securityOrigin|documentId|rootDocumentId)"/);
      assert.equal(reply.snapshot.version, 2);
      assert.equal(reply.snapshot.frames.length, 2);
      assert.equal(reply.snapshot.localFrames.length + reply.snapshot.remoteOwners.length, 2);
      assert.ok(
        reply.snapshot.frames.some(
          (frame) => frame.kind === (protectedChild ? 'protected' : 'ordinary')
        )
      );
      if (!protectedChild)
        assert.ok(reply.snapshot.frames.every((frame) => frame.kind === 'ordinary'));
      assert.equal(
        reply.events.some((message) => message.privateFrames || message.result?.frames),
        false
      );
    });
  }
}
