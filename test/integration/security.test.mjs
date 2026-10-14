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

async function relayWorld(page) {
  const probe =
    'typeof serve === "function" && typeof chrome?.storage?.local?.get === "function" && location.hostname === "seven.sliccy.ai" ? chrome.runtime.id : null';
  for (let round = 0; round < 20; round++) {
    for (let contextId = 1; contextId <= 400; contextId++) {
      const answer = await page
        .send('Runtime.evaluate', { expression: probe, returnByValue: true, contextId }, 5000)
        .catch(() => null);
      if (answer?.result?.value === extId) return contextId;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('relay.js isolated world not found');
}

function secretsCall(page, sid, message) {
  return extEval(
    page,
    sid,
    `new Promise((resolve, reject) => { chrome.runtime.sendMessage(${JSON.stringify(message)}, (r) => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(r)); })`
  ).then((r) => r.result.value);
}

test('plaintext canary: migration encrypts 6.248.11 plaintext, relay.js world sees no canary, secrets.list lists it, fetch proxy delivers it upstream (B-SEC2)', async (t) => {
  const page = await chrome.visit(t, slicc);
  const canaryName = `B8_CANARY_${Date.now()}`;
  const canaryPlaintext = 'super-secret-canary-value-12345';
  const { targetId: secTid } = await extPage(page, `chrome-extension://${extId}/secrets.html`);
  const secSid = await extSession(page, secTid);

  const planted = await extEval(
    page,
    secSid,
    `new Promise((resolve, reject) => { chrome.storage.local.set({ ${JSON.stringify(canaryName)}: ${JSON.stringify(canaryPlaintext)}, ${JSON.stringify(`${canaryName}_DOMAINS`)}: "upstream.test" }, () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : chrome.storage.local.get(${JSON.stringify(canaryName)}, (r) => resolve(r[${JSON.stringify(canaryName)}]))); })`
  );
  assert.equal(planted.result.value, canaryPlaintext, 'canary must be planted as plaintext');

  const triggered = await secretsCall(page, secSid, { type: 'secrets.list' });
  assert.ok(Array.isArray(triggered?.entries), 'secrets.list must answer');

  const world = await relayWorld(page);
  const dump = await page.send('Runtime.evaluate', {
    expression:
      'new Promise((resolve) => chrome.storage.local.get(null, (items) => resolve(JSON.stringify(items))))',
    awaitPromise: true,
    returnByValue: true,
    contextId: world,
  });
  assert.equal(dump.exceptionDetails, undefined, 'relay.js world must read chrome.storage.local');
  const items = JSON.parse(dump.result.value);
  const stored = items[canaryName];
  assert.ok(
    stored && typeof stored.ct === 'string' && typeof stored.iv === 'string',
    `canary must be stored as {ct, iv}: got ${JSON.stringify(stored)}`
  );
  for (const [key, value] of Object.entries(items)) {
    assert.equal(
      JSON.stringify(value).includes(canaryPlaintext),
      false,
      `relay.js world sees the canary in ${key}`
    );
  }

  const listed = await secretsCall(page, secSid, { type: 'secrets.list' });
  assert.ok(
    (listed?.entries ?? []).some((e) => e.name === canaryName),
    `secrets.list must include ${canaryName}`
  );

  const masked = await secretsCall(page, secSid, { type: 'secrets.list-masked-entries' });
  const entry = (masked?.entries ?? []).find((e) => e.name === canaryName);
  assert.ok(entry, `masked entries must include ${canaryName}`);
  assert.notEqual(entry.maskedValue, canaryPlaintext, 'masked value must differ from plaintext');

  const www = await chrome.visit(t, 'https://www.sliccy.ai/?slicc=leader');
  const answer = await www.evaluate(
    async (opts) => {
      const port = chrome.runtime.connect(opts.extId, { name: 'fetch-proxy.fetch' });
      const done = new Promise((resolve) => {
        const chunks = [];
        let head;
        port.onMessage.addListener((msg) => {
          if (msg.type === 'response-head') head = msg;
          if (msg.type === 'response-chunk') chunks.push(msg.dataBase64);
          if (msg.type === 'response-error') resolve({ error: msg.error });
          if (msg.type === 'response-end') {
            const text = chunks.map((c) => atob(c)).join('');
            resolve({ status: head?.status, text });
          }
        });
        port.onDisconnect.addListener(() => resolve({ error: 'disconnected' }));
      });
      port.postMessage({
        type: 'request',
        url: `https://upstream.test/probe-canary/${opts.canaryName}`,
        method: 'GET',
        headers: { 'x-secret': opts.masked },
      });
      const result = await done;
      port.disconnect();
      return result;
    },
    { extId, canaryName, masked: entry.maskedValue }
  );
  assert.ok(!answer.error, `fetch proxy failed: ${answer.error}`);
  assert.equal(answer.status, 200);
  const seen = chrome.upstream.seen.filter((s) => s.path === `/probe-canary/${canaryName}`);
  assert.equal(seen.length, 1, 'upstream must receive the proxied request');
  assert.equal(
    seen[0].headers['x-secret'],
    canaryPlaintext,
    'upstream must receive the unmasked plaintext'
  );
  assert.equal(
    answer.text.includes(canaryPlaintext),
    false,
    'the proxied response must not hand the plaintext back to the page'
  );

  await extEval(
    page,
    secSid,
    `new Promise((resolve) => { chrome.storage.local.remove([${JSON.stringify(canaryName)}, ${JSON.stringify(`${canaryName}_DOMAINS`)}], resolve); })`
  );
  await extClose(page, secTid);
});

test('the secrets page saves through encrypted storage and marks unreadable entries (B-SEC2)', async (t) => {
  const page = await chrome.visit(t, slicc);
  const name = `B8_PAGE_${Date.now()}`;
  const broken = `${name}_BROKEN`;
  const value = 'page-saved-plaintext-67890';
  const { targetId, sessionId } = await (async () => {
    const created = await extPage(page, `chrome-extension://${extId}/secrets.html`);
    return { targetId: created.targetId, sessionId: await extSession(page, created.targetId) };
  })();
  await extEval(
    page,
    sessionId,
    `new Promise((resolve) => { const wait = () => document.getElementById("c-save") ? resolve(true) : setTimeout(wait, 50); wait(); })`
  );
  await extEval(
    page,
    sessionId,
    `new Promise((resolve) => chrome.storage.local.set({ ${JSON.stringify(broken)}: { ct: "AAAA", iv: "AAAAAAAAAAAAAAAA" }, ${JSON.stringify(`${broken}_DOMAINS`)}: "upstream.test" }, resolve))`
  );
  await extEval(
    page,
    sessionId,
    `(() => { document.querySelector('[data-pane="custom"]')?.click(); document.getElementById("c-name").value = ${JSON.stringify(name)}; document.getElementById("c-value").value = ${JSON.stringify(value)}; document.getElementById("c-domains").value = "upstream.test"; document.getElementById("c-save").click(); return true; })()`
  );
  const stored = await extEval(
    page,
    sessionId,
    `new Promise((resolve) => { const started = Date.now(); const poll = () => chrome.storage.local.get(${JSON.stringify(name)}, (r) => { const v = r[${JSON.stringify(name)}]; if (v !== undefined || Date.now() - started > 10000) resolve(v ?? null); else setTimeout(poll, 100); }); poll(); })`
  );
  assert.ok(
    stored.result.value && typeof stored.result.value.ct === 'string',
    `the page must store {ct, iv}: got ${JSON.stringify(stored.result.value)}`
  );
  assert.equal(JSON.stringify(stored.result.value).includes(value), false);
  const rows = await extEval(
    page,
    sessionId,
    `new Promise((resolve) => { document.getElementById("refreshBtn").click(); const started = Date.now(); const poll = () => { const found = [...document.querySelectorAll(".secret-row")].map((row) => ({ name: row.dataset.name, unreadable: row.classList.contains("secret-row-unreadable") })); if (found.some((r) => r.name === ${JSON.stringify(broken)}) || Date.now() - started > 10000) resolve(found); else setTimeout(poll, 100); }; poll(); })`
  );
  const listed = rows.result.value;
  assert.deepEqual(
    listed.find((r) => r.name === name),
    { name, unreadable: false },
    'the saved secret is listed as readable'
  );
  assert.deepEqual(
    listed.find((r) => r.name === broken),
    { name: broken, unreadable: true },
    'the broken ciphertext is listed as unreadable'
  );
  const masked = await extEval(
    page,
    sessionId,
    `new Promise((resolve) => chrome.runtime.sendMessage({ type: "secrets.list-masked-entries" }, resolve))`
  );
  assert.ok(
    masked.result.value.entries.some((e) => e.name === name && e.maskedValue !== value),
    'the pipeline decrypts the page-saved secret'
  );
  await extEval(
    page,
    sessionId,
    `new Promise((resolve) => chrome.storage.local.remove([${JSON.stringify(name)}, ${JSON.stringify(`${name}_DOMAINS`)}, ${JSON.stringify(broken)}, ${JSON.stringify(`${broken}_DOMAINS`)}], resolve))`
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

    const created = await send('Target.createTarget', { url: 'https://other.test/' });
    if (created.error) {
      port.disconnect();
      return { error: 'create failed', created };
    }
    const tabId = created.result.targetId;
    for (let i = 0; i < 50; i++) {
      const listed = await send('Target.getTargets');
      const found = listed.result?.targetInfos?.find((ti) => ti.targetId === tabId);
      if (found?.url.startsWith('https://other.test')) break;
      await new Promise((r) => setTimeout(r, 100));
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
