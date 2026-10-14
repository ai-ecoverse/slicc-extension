import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const slicc = 'https://seven.sliccy.ai/';
const extId = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';

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

test('plaintext secret canary is encrypted after migration (B-SEC2)', async (t) => {
  const page = await chrome.visit(t, slicc);
  const canaryName = `B8_CANARY_${Date.now()}`;
  const canaryPlaintext = 'super-secret-canary-value-12345';
  const { targetId } = await page.evaluate(
    async (opts) => {
      return globalThis.sliccExtension.cdp.send('Target.createTarget', {
        url: `chrome-extension://${opts.extId}/secrets.html`,
      });
    },
    { extId }
  );
  const { sessionId } = await page.evaluate(
    async (tid) =>
      globalThis.sliccExtension.cdp.send('Target.attachToTarget', {
        targetId: tid,
        flatten: true,
      }),
    targetId
  );
  let ctxReady = false;
  for (let i = 0; i < 40 && !ctxReady; i++) {
    try {
      const r = await page.evaluate(
        async (sid) =>
          globalThis.sliccExtension.cdp.send(
            'Runtime.evaluate',
            { expression: '1+1', returnByValue: true },
            sid
          ),
        sessionId
      );
      ctxReady = r?.result?.value === 2;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(ctxReady, 'secrets page context must be ready');
  await page.evaluate(
    async (opts) => {
      await globalThis.sliccExtension.cdp.send(
        'Runtime.evaluate',
        {
          expression: `new Promise((resolve, reject) => { chrome.runtime.sendMessage({ type: "secrets.set", name: "${opts.name}", value: "${opts.value}", domains: ["*.canary.test"] }, (r) => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(r)); })`,
          awaitPromise: true,
        },
        opts.sessionId
      );
    },
    { name: canaryName, value: canaryPlaintext, sessionId }
  );
  await new Promise((r) => setTimeout(r, 500));
  const raw = await page.evaluate(
    async (opts) => {
      const result = await globalThis.sliccExtension.cdp.send(
        'Runtime.evaluate',
        {
          expression: `new Promise((resolve) => { chrome.storage.local.get("${opts.name}", (r) => { const v = r["${opts.name}"]; resolve({ type: typeof v, isEncrypted: typeof v === "object" && v !== null && typeof v.ct === "string" && typeof v.iv === "string", isPlaintext: typeof v === "string" }); }); })`,
          awaitPromise: true,
          returnByValue: true,
        },
        opts.sessionId
      );
      return result?.result?.value;
    },
    { name: canaryName, sessionId }
  );
  await page.evaluate(
    async (opts) => {
      await globalThis.sliccExtension.cdp.send(
        'Runtime.evaluate',
        {
          expression: `new Promise((resolve) => { chrome.storage.local.remove(["${opts.name}", "${opts.name}_DOMAINS"], resolve); })`,
          awaitPromise: true,
        },
        opts.sessionId
      );
      await globalThis.sliccExtension.cdp
        .send('Target.closeTarget', { targetId: opts.targetId })
        .catch(() => undefined);
    },
    { name: canaryName, targetId, sessionId }
  );
  assert.ok(raw, 'should read canary from storage');
  assert.equal(raw.isPlaintext, false, 'canary must not be plaintext');
  assert.equal(raw.isEncrypted, true, 'canary must be encrypted {ct, iv}');
});
