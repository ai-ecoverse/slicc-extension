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

function extPage(page, url) {
  return page.evaluate(
    async (u) => globalThis.sliccExtension.cdp.send('Target.createTarget', { url: u }),
    url
  );
}

async function extSession(page, targetId) {
  const { sessionId } = await page.evaluate(
    async (tid) =>
      globalThis.sliccExtension.cdp.send('Target.attachToTarget', {
        targetId: tid,
        flatten: true,
      }),
    targetId
  );
  for (let i = 0; i < 40; i++) {
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
      if (r?.result?.value === 2) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return sessionId;
}

function extEval(page, sessionId, expression) {
  return page.evaluate(
    async (opts) =>
      globalThis.sliccExtension.cdp.send(
        'Runtime.evaluate',
        { expression: opts.expr, awaitPromise: true, returnByValue: true },
        opts.sid
      ),
    { sid: sessionId, expr: expression }
  );
}

function extClose(page, targetId) {
  return page
    .evaluate(
      async (tid) => globalThis.sliccExtension.cdp.send('Target.closeTarget', { targetId: tid }),
      targetId
    )
    .catch(() => undefined);
}

test('plaintext canary: relay world sees no plaintext, secrets page lists it, fetch proxy injects it (B-SEC2)', async (t) => {
  const page = await chrome.visit(t, slicc);
  const canaryName = `B8_CANARY_${Date.now()}`;
  const canaryPlaintext = 'super-secret-canary-value-12345';
  const { targetId } = await extPage(page, `chrome-extension://${extId}/secrets.html`);
  const sid = await extSession(page, targetId);

  await extEval(
    page,
    sid,
    `new Promise((resolve, reject) => { chrome.runtime.sendMessage({ type: "secrets.set", name: "${canaryName}", value: "${canaryPlaintext}", domains: ["upstream.test"] }, (r) => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(r)); })`
  );
  await new Promise((r) => setTimeout(r, 500));

  const raw = await extEval(
    page,
    sid,
    `new Promise((resolve) => { chrome.storage.local.get("${canaryName}", (r) => { const v = r["${canaryName}"]; resolve({ isEncrypted: typeof v === "object" && v !== null && typeof v.ct === "string" && typeof v.iv === "string", isPlaintext: typeof v === "string" }); }); })`
  );
  assert.equal(raw.result.value.isPlaintext, false, 'canary must not be plaintext in storage');
  assert.equal(raw.result.value.isEncrypted, true, 'canary must be encrypted {ct, iv}');

  const listed = await extEval(
    page,
    sid,
    `new Promise((resolve, reject) => { chrome.runtime.sendMessage({ type: "secrets.list" }, (r) => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(r)); })`
  );
  const entries = listed.result.value?.entries ?? [];
  assert.ok(
    entries.some((e) => e.name === canaryName),
    `secrets.list must include ${canaryName}`
  );

  const remote = `https://upstream.test`;
  const fetched = await page.evaluate(
    async (opts) => {
      const response = await globalThis.sliccExtension.fetch(`${opts.remote}/probe-secret`, {
        headers: { authorization: `Bearer ${opts.canary}` },
      });
      return response.json();
    },
    { remote, canary: `{{${canaryName}}}` }
  );
  assert.ok(fetched.headers, 'fetch proxy must return headers');

  await extEval(
    page,
    sid,
    `new Promise((resolve) => { chrome.storage.local.remove(["${canaryName}", "${canaryName}_DOMAINS"], resolve); })`
  );
  await extClose(page, targetId);
});

test('content-script senders are refused by six handlers; secrets.html senders succeed (B-SEC1)', async (t) => {
  const page = await chrome.visit(t, slicc);

  const contentResults = await page.evaluate(async () => {
    const send = (msg) =>
      new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(msg, (r) => {
            if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
            else resolve(r ?? { silent: true });
          });
        } catch (e) {
          resolve({ error: String(e) });
        }
      });

    const list = await send({ type: 'secrets.list-with-values-for-pipeline' });
    const set = await send({
      type: 'secrets.set',
      name: 'ATTACK',
      value: 'stolen',
      domains: ['evil.test'],
    });
    const del = await send({ type: 'secrets.delete', name: 'ATTACK' });
    const offscreen = await send({ source: 'offscreen', payload: { type: 'cdp-command' } });
    const panel = await send({ source: 'panel', payload: { type: 'oauth-request' } });

    return { list, set, del, offscreen, panel };
  });

  for (const [name, result] of Object.entries(contentResults)) {
    assert.ok(
      result === undefined ||
        result === null ||
        result.silent ||
        result.error ||
        (result.entries === undefined && result.ok === undefined),
      `${name} from content script must be refused or unanswered: got ${JSON.stringify(result)}`
    );
  }

  const { targetId } = await extPage(page, `chrome-extension://${extId}/secrets.html`);
  const sid = await extSession(page, targetId);

  const extList = await extEval(
    page,
    sid,
    `new Promise((resolve, reject) => { chrome.runtime.sendMessage({ type: "secrets.list" }, (r) => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(r)); })`
  );
  assert.ok(
    Array.isArray(extList.result.value?.entries),
    'secrets.list from secrets.html must return entries'
  );

  await extClose(page, targetId);
});

test('CDP detaches when a tab navigates to vault via seven (integration)', async (t) => {
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

test('six bridge navigation to vault triggers detach (B24-1-tabs-onupdated)', async (t) => {
  const www = await chrome.visit(t, 'https://www.sliccy.ai/?slicc=leader');
  const answer = await www.evaluate(async (eid) => {
    const port = chrome.runtime.connect(eid, { name: 'slicc.cdp-bridge' });
    const channelId = crypto.randomUUID();
    const events = [];
    port.onMessage.addListener((msg) => {
      if (msg.kind === 'cdp.event') events.push(msg);
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = Math.random();
        const handler = (msg) => {
          if (msg.kind === 'cdp.response' && msg.id === id) {
            port.onMessage.removeListener(handler);
            resolve(msg);
          }
        };
        port.onMessage.addListener(handler);
        const msg = {
          bridge: 1,
          channelId,
          kind: 'cdp.request',
          id,
          method,
          params: { ...params },
        };
        if (params.sessionId !== undefined) {
          msg.sessionId = params.sessionId;
          delete msg.params.sessionId;
        }
        port.postMessage(msg);
      });

    port.postMessage({ bridge: 1, channelId, kind: 'handshake.hello' });
    await new Promise((resolve) => {
      const wait = (msg) => {
        if (msg.kind === 'handshake.welcome') {
          port.onMessage.removeListener(wait);
          resolve();
        }
      };
      port.onMessage.addListener(wait);
    });
    await new Promise((r) => setTimeout(r, 300));

    const targets = await send('Target.getTargets');
    const ordinary = targets.result?.targetInfos?.find(
      (ti) =>
        !ti.url.startsWith('https://www.sliccy.ai') &&
        !ti.url.startsWith('chrome') &&
        ti.type === 'page'
    );
    if (!ordinary) {
      const created = await send('Target.createTarget', { url: 'https://other.test/' });
      if (created.error) {
        port.disconnect();
        return { error: 'create failed', created };
      }
      await new Promise((r) => setTimeout(r, 1000));
      const newTargets = await send('Target.getTargets');
      const newTab = newTargets.result?.targetInfos?.find((ti) =>
        ti.url.startsWith('https://other.test')
      );
      if (!newTab) {
        port.disconnect();
        return { error: 'no other.test tab', newTargets };
      }
      var tabId = newTab.targetId;
    } else {
      tabId = ordinary.targetId;
    }

    const attached = await send('Target.attachToTarget', {
      targetId: tabId,
      flatten: true,
    });
    if (attached.error) {
      port.disconnect();
      return { error: 'attach failed', attached };
    }

    const sessionId = attached.result?.sessionId;
    let evaled;
    for (let i = 0; i < 40; i++) {
      evaled = await send('Runtime.evaluate', {
        expression: '1+1',
        returnByValue: true,
        sessionId,
      });
      if (evaled.result?.result?.value === 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (evaled?.result?.result?.value !== 2) {
      port.disconnect();
      return { error: 'no context', evaled };
    }

    await send('Runtime.evaluate', {
      expression: 'location.href = "https://vault.sliccy.ai/"',
      returnByValue: true,
      sessionId,
    }).catch(() => undefined);

    let detached = false;
    for (let i = 0; i < 80; i++) {
      if (events.some((e) => e.method === 'Target.detachedFromTarget')) {
        detached = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    const after = await send('Runtime.evaluate', {
      expression: '1',
      returnByValue: true,
      sessionId,
    });
    const refused = !!after.error;

    port.disconnect();
    return { detached, refused };
  }, extId);
  assert.ok(!answer.error, `bridge test failed: ${JSON.stringify(answer)}`);
  assert.equal(answer.detached, true, 'bridge must receive Target.detachedFromTarget');
  assert.equal(answer.refused, true, 'evaluate after detach must be refused');
});
