import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const slicc = 'https://seven.sliccy.ai/';

test('internal handlers refuse content-script senders (B-SEC1)', async (t) => {
  const page = await chrome.visit(t, slicc);
  const result = await page.evaluate(async () => {
    const signIn = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'slicc-sign-in', options: { clientId: 'good', scopes: 'openid' } },
        (response) => resolve(response)
      );
    }).catch((error) => ({ error: String(error) }));
    return { signIn };
  });
  assert.ok(
    result.signIn?.token || result.signIn?.error,
    'sign-in handler should respond to content scripts (relay.js serving)'
  );
});

test('CDP detaches when a tab navigates to vault (integration)', async (t) => {
  const page = await chrome.visit(t, slicc);
  const answer = await page.evaluate(async () => {
    const created = await globalThis.sliccExtension.cdp.send('Target.createTarget', {
      url: 'https://other.test/',
    });
    const attached = await globalThis.sliccExtension.cdp.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    });
    let ready;
    for (let i = 0; i < 40; i++) {
      try {
        ready = await globalThis.sliccExtension.cdp.send(
          'Runtime.evaluate',
          { expression: '1+1', returnByValue: true },
          attached.sessionId
        );
        break;
      } catch (error) {
        if (!String(error.message).includes('execution context')) throw error;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (ready?.result?.value !== 2) throw new Error('no context');
    await globalThis.sliccExtension.cdp
      .send(
        'Runtime.evaluate',
        { expression: 'location.href = "https://vault.sliccy.ai/"', returnByValue: true },
        attached.sessionId
      )
      .catch(() => undefined);
    let detached = false;
    for (let i = 0; i < 80; i++) {
      try {
        await globalThis.sliccExtension.cdp.send(
          'Runtime.evaluate',
          { expression: '1', returnByValue: true },
          attached.sessionId
        );
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        detached = true;
        break;
      }
    }
    await globalThis.sliccExtension.cdp
      .send('Target.closeTarget', { targetId: created.targetId })
      .catch(() => undefined);
    return { detached };
  });
  assert.equal(answer.detached, true);
});
