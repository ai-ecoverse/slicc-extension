import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const slicc = 'https://seven.sliccy.ai/';
const extId = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';
const refused = "slicc: refused: target is on seven's origin";

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
    'typeof serve === "function" && typeof chrome?.runtime?.id === "string" && location.hostname === "seven.sliccy.ai" ? chrome.runtime.id : null';
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

const IDB = `(fn) => new Promise((resolve, reject) => { const r = indexedDB.open('slicc-secrets', 2); r.onupgradeneeded = () => { for (const n of ['keys', 'records']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); }; r.onerror = () => reject(r.error); r.onsuccess = () => { const db = r.result; const tx = db.transaction(['keys', 'records'], 'readwrite'); let out; Promise.resolve(fn(tx, (v) => { out = v; })).catch(reject); tx.oncomplete = () => { db.close(); resolve(out); }; tx.onerror = () => reject(tx.error); }; })`;

async function assertRelayCannotReadSecrets(page, sid, control, needles) {
  const world = await relayWorld(page);
  const dump = await page.send('Runtime.evaluate', {
    expression:
      'chrome.storage.local.get(null).then((items) => ({ items: JSON.stringify(items) }), (e) => ({ error: String(e?.message ?? e) }))',
    awaitPromise: true,
    returnByValue: true,
    contextId: world,
  });
  const answer = dump.result.value;
  if (answer.error !== undefined) {
    assert.match(
      answer.error,
      /Access to storage is not allowed/,
      'setAccessLevel blocks relay.js'
    );
    const trusted = await extEval(
      page,
      sid,
      `chrome.storage.local.get(${JSON.stringify(control.key)})`
    );
    assert.equal(
      trusted.result.value[control.key],
      control.value,
      'control: the secrets page still reads a non-secret setting'
    );
    const all = await extEval(page, sid, 'chrome.storage.local.get(null)');
    assertNoSecretRecords(all.result.value, needles);
    return 'restricted';
  }
  const items = JSON.parse(answer.items);
  assert.equal(items[control.key], control.value, 'control: relay.js reads a non-secret setting');
  assertNoSecretRecords(items, needles);
  return 'readable';
}

function assertNoSecretRecords(items, needles) {
  const text = JSON.stringify(items);
  for (const needle of needles) {
    assert.equal(text.includes(needle), false, `chrome.storage.local still shows ${needle}`);
  }
  for (const [key, value] of Object.entries(items)) {
    assert.equal(
      key.endsWith('_DOMAINS'),
      false,
      `a secret's domains are still in storage.local: ${key}`
    );
    assert.equal(
      typeof value === 'object' && value !== null && 'ct' in value && 'iv' in value,
      false,
      `ciphertext is still in storage.local: ${key}`
    );
  }
}

function secretsCall(page, sid, message) {
  return extEval(
    page,
    sid,
    `new Promise((resolve, reject) => { chrome.runtime.sendMessage(${JSON.stringify(message)}, (r) => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(r)); })`
  ).then((r) => r.result.value);
}

test('B-SEC2 plaintext canary: migration encrypts 6.248.11 plaintext, relay.js world sees no canary, secrets.list lists it, fetch proxy delivers it upstream', async (t) => {
  const page = await chrome.visit(t, slicc);
  const canaryName = `B8_CANARY_${Date.now()}`;
  const canaryPlaintext = 'super-secret-canary-value-12345';
  const { targetId: secTid } = await extPage(page, `chrome-extension://${extId}/secrets.html`);
  const secSid = await extSession(page, secTid);

  const planted = await extEval(
    page,
    secSid,
    `new Promise((resolve, reject) => { chrome.storage.local.set({ B8_CONTROL_SETTING: "visible", ${JSON.stringify(canaryName)}: ${JSON.stringify(canaryPlaintext)}, ${JSON.stringify(`${canaryName}_DOMAINS`)}: "upstream.test" }, () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : chrome.storage.local.get(${JSON.stringify(canaryName)}, (r) => resolve(r[${JSON.stringify(canaryName)}]))); })`
  );
  assert.equal(planted.result.value, canaryPlaintext, 'canary must be planted as plaintext');

  const triggered = await secretsCall(page, secSid, { type: 'secrets.list' });
  assert.ok(Array.isArray(triggered?.entries), 'secrets.list must answer');

  const mode = await assertRelayCannotReadSecrets(
    page,
    secSid,
    { key: 'B8_CONTROL_SETTING', value: 'visible' },
    [canaryName, canaryPlaintext, 'upstream.test']
  );
  t.diagnostic(`relay.js storage.local: ${mode}`);

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
    `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'secrets.delete', name: ${JSON.stringify(canaryName)} }, () => chrome.storage.local.remove('B8_CONTROL_SETTING', resolve)))`
  );
  await extClose(page, secTid);
});

test('B-SEC2 the secrets page saves through encrypted storage, marks unreadable entries and offers Re-enter', async (t) => {
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
    `new Promise((resolve) => { const wait = () => document.readyState === "complete" ? resolve(true) : setTimeout(wait, 50); wait(); })`
  );
  await extEval(
    page,
    sessionId,
    `(${IDB})((tx) => { tx.objectStore('records').put({ name: ${JSON.stringify(broken)}, value: { ct: 'AAAA', iv: 'AAAAAAAAAAAAAAAA' }, domains: 'upstream.test' }, ${JSON.stringify(broken)}); })`
  );
  await extEval(
    page,
    sessionId,
    `(() => { document.querySelector('[data-pane="custom"]')?.click(); document.getElementById("c-name").value = ${JSON.stringify(name)}; document.getElementById("c-value").value = ${JSON.stringify(value)}; document.getElementById("c-domains").value = "upstream.test"; document.getElementById("c-save").click(); return true; })()`
  );
  const stored = await extEval(
    page,
    sessionId,
    `(async () => { const started = Date.now(); for (;;) { const rec = await (${IDB})((tx, done) => { const g = tx.objectStore('records').get(${JSON.stringify(name)}); g.onsuccess = () => done(g.result ?? null); }); if (rec || Date.now() - started > 10000) return { rec, local: await chrome.storage.local.get(null) }; await new Promise((r) => setTimeout(r, 100)); } })()`
  );
  const record = stored.result.value.rec;
  assert.ok(
    record && typeof record.value?.ct === 'string' && record.domains === 'upstream.test',
    `the page must store an encrypted record in IndexedDB: got ${JSON.stringify(record)}`
  );
  assert.equal(JSON.stringify(record).includes(value), false);
  assertNoSecretRecords(stored.result.value.local, [name, value]);
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
  const reenter = await extEval(
    page,
    sessionId,
    `(() => { const row = document.querySelector('.secret-row[data-name=${JSON.stringify(broken)}]'); const text = row.querySelector('.secret-unreadable').textContent; const button = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Re-enter'); button.click(); return { text, name: document.getElementById('c-name').value, domains: document.getElementById('c-domains').value, value: document.getElementById('c-value').value, pane: document.querySelector('.pane.active')?.id, focused: document.activeElement?.id }; })()`
  );
  assert.deepEqual(reenter.result.value, {
    text: "This value can't be read any more. Enter it again.",
    name: broken,
    domains: 'upstream.test',
    value: '',
    pane: 'pane-custom',
    focused: 'c-value',
  });
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
    `new Promise((resolve) => chrome.runtime.sendMessage({ type: 'secrets.delete', name: ${JSON.stringify(name)} }, resolve)).then(() => (${IDB})((tx) => { tx.objectStore('records').delete(${JSON.stringify(broken)}); }))`
  );
  await extClose(page, targetId);
});

test('B-SEC1 content-script senders are refused by six handlers; secrets.html senders succeed', async (t) => {
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

test('B24-1 seven: a navigation to the vault fails before it commits and the session stays', async (t) => {
  const page = await chrome.visit(t, slicc);
  const answer = await page.evaluate(async () => {
    const created = await globalThis.sliccExtension.cdp.send('Target.createTarget', {
      url: 'https://other.test/',
    });
    const attached = await globalThis.sliccExtension.cdp.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    });
    const href = (expression) =>
      globalThis.sliccExtension.cdp
        .send('Runtime.evaluate', { expression, returnByValue: true }, attached.sessionId)
        .then(
          (r) => r.result?.value,
          (error) => `error ${error.message}`
        );
    const loaded = 'https://other.test/ complete';
    let ready = '';
    for (let i = 0; i < 200 && ready !== loaded; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 50));
      ready = await href('`${location.href} ${document.readyState}`');
    }
    if (ready !== loaded) throw new Error(`not loaded: ${ready}`);
    await href('location.href = "https://vault.sliccy.ai/"');
    const hops = [];
    for (let i = 0; i < 200 && hops.at(-1) !== 'chrome-error://chromewebdata/'; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 50));
      hops.push(await href('location.href'));
    }
    await globalThis.sliccExtension.cdp
      .send('Target.closeTarget', { targetId: created.targetId })
      .catch(() => undefined);
    return { hops };
  });
  assert.equal(answer.hops.at(-1), 'chrome-error://chromewebdata/', 'the hop fails at the request');
  assert.deepEqual(
    answer.hops.filter(
      (href) =>
        href !== 'https://other.test/' &&
        href !== 'chrome-error://chromewebdata/' &&
        href !== `error ${refused}`
    ),
    [],
    'the session stays and the vault never commits'
  );
});

test('B24-1 six bridge: a navigation to the vault detaches the session (tabs.onUpdated)', async (t) => {
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

test('webNavigation adds no permission warning over 6.248.11, so an in-place update stays enabled', async (t) => {
  const page = await chrome.visit(t, slicc);
  const current = JSON.parse(
    await readFile(new URL('../../extension/manifest.json', import.meta.url))
  );
  const released = {
    ...current,
    permissions: [
      'debugger',
      'tabs',
      'tabGroups',
      'identity',
      'storage',
      'webRequest',
      'declarativeNetRequestWithHostAccess',
      'notifications',
      'sidePanel',
    ],
  };
  assert.deepEqual(
    current.permissions.filter((p) => !released.permissions.includes(p)),
    ['webNavigation']
  );
  const { targetId } = await extPage(page, `chrome-extension://${extId}/secrets.html`);
  const sid = await extSession(page, targetId);
  const warnings = await extEval(
    page,
    sid,
    `Promise.all([${JSON.stringify(JSON.stringify(released))}, ${JSON.stringify(JSON.stringify(current))}].map((m) => chrome.management.getPermissionWarningsByManifest(m)))`
  );
  const [before, after] = warnings.result.value;
  assert.ok(before.length > 0, `6.248.11 has warnings: ${JSON.stringify(before)}`);
  assert.deepEqual([...after].sort(), [...before].sort(), 'the warning set is unchanged');
  await extClose(page, targetId);
});

test('B24-3 the legacy offscreen cdp-command path is gone: no answer, nothing attaches; a trusted internal message still works', async (t) => {
  const page = await chrome.visit(t, slicc);
  const created = await page.evaluate(async () =>
    globalThis.sliccExtension.cdp.send('Target.createTarget', { url: 'https://other.test/' })
  );
  const { targetId } = await extPage(page, `chrome-extension://${extId}/secrets.html`);
  const sid = await extSession(page, targetId);
  const answer = await extEval(
    page,
    sid,
    `(async () => {
      const relayed = [];
      chrome.runtime.onMessage.addListener((m) => { if (m?.source === 'service-worker') relayed.push(m.payload?.type); });
      const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve({ response: r ?? null, error: chrome.runtime.lastError?.message ?? null })));
      const control = await send({ type: 'secrets.list' });
      const legacy = [];
      for (const [method, params] of [['Target.getTargets', {}], ['Target.attachToTarget', { targetId: ${JSON.stringify(created.targetId)}, flatten: true }], ['Runtime.evaluate', { expression: '1+1' }]]) {
        legacy.push(await send({ source: 'offscreen', payload: { type: 'cdp-command', id: method, method, params, sessionId: ${JSON.stringify(created.targetId)} } }));
      }
      await new Promise((r) => setTimeout(r, 1500));
      return { control: Array.isArray(control.response?.entries), legacy, relayed };
    })()`
  );
  const result = answer.result.value;
  assert.equal(result.control, true, 'secrets.list from secrets.html answers');
  for (const legacy of result.legacy) {
    assert.equal(
      legacy.response,
      null,
      `legacy cdp-command must get no answer: ${JSON.stringify(legacy)}`
    );
  }
  assert.deepEqual(result.relayed, [], 'no cdp-response is broadcast');
  const attach = await page.evaluate(
    async (tid) =>
      globalThis.sliccExtension.cdp
        .send('Target.attachToTarget', { targetId: tid, flatten: true })
        .then(
          (r) => r.sessionId,
          (e) => `error ${e.message}`
        ),
    created.targetId
  );
  assert.equal(attach, created.targetId, 'the tab was never attached by the legacy path');
  await extClose(page, created.targetId);
  await extClose(page, targetId);
});

test('B-SEC2 in-place migration moves 6.248.11 plaintext and {ct, iv} records into IndexedDB, crash-safely, and relay.js can read none of them', async (t) => {
  const page = await chrome.visit(t, slicc);
  const stamp = Date.now();
  const plain = {
    name: `B8_MIG_PLAIN_${stamp}`,
    value: 'migrate-plain-value-111',
    domains: 'plain.example',
  };
  const sealed = {
    name: `B8_MIG_SEALED_${stamp}`,
    value: 'migrate-sealed-value-222',
    domains: 'sealed.example',
  };
  const first = await extPage(page, `chrome-extension://${extId}/secrets.html`);
  const firstSid = await extSession(page, first.targetId);
  await secretsCall(page, firstSid, {
    type: 'secrets.set',
    name: `B8_MIG_WARM_${stamp}`,
    value: 'warm-up-value-333',
    domains: ['warm.example'],
  });
  const planted = await extEval(
    page,
    firstSid,
    `(async () => {
      const key = await (${IDB})((tx, done) => { const g = tx.objectStore('keys').get('aes-gcm-secrets'); g.onsuccess = () => done(g.result); });
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(${JSON.stringify(sealed.value)})));
      const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
      await chrome.storage.local.set({
        B8_MIG_SETTING: 'still-here',
        ${JSON.stringify(plain.name)}: ${JSON.stringify(plain.value)},
        ${JSON.stringify(`${plain.name}_DOMAINS`)}: ${JSON.stringify(plain.domains)},
        ${JSON.stringify(sealed.name)}: { ct: b64(ct), iv: b64(iv) },
        ${JSON.stringify(`${sealed.name}_DOMAINS`)}: ${JSON.stringify(sealed.domains)},
      });
      return Object.keys(await chrome.storage.local.get(null));
    })()`
  );
  assert.ok(planted.result.value.includes(sealed.name), 'both formats planted');
  const second = await extPage(page, `chrome-extension://${extId}/secrets.html`);
  const secondSid = await extSession(page, second.targetId);
  const migrated = await extEval(
    page,
    secondSid,
    `(async () => { const started = Date.now(); for (;;) { const local = await chrome.storage.local.get(null); if (!(${JSON.stringify(plain.name)} in local) && !(${JSON.stringify(sealed.name)} in local)) return local; if (Date.now() - started > 15000) return local; await new Promise((r) => setTimeout(r, 100)); } })()`
  );
  assertNoSecretRecords(migrated.result.value, [
    plain.name,
    sealed.name,
    plain.value,
    sealed.value,
  ]);
  assert.equal(migrated.result.value.B8_MIG_SETTING, 'still-here', 'non-secret settings stay put');
  const values = async (sid) =>
    (await secretsCall(page, sid, { type: 'secrets.list-with-values-for-pipeline' })).entries;
  const after = await values(secondSid);
  for (const want of [plain, sealed]) {
    const got = after.find((e) => e.name === want.name);
    assert.equal(got?.value, want.value, `${want.name} keeps its value`);
    assert.deepEqual(got?.domains, [want.domains], `${want.name} keeps its domains`);
  }
  await extEval(
    page,
    secondSid,
    `chrome.storage.local.set({ ${JSON.stringify(plain.name)}: 'stale-after-crash', ${JSON.stringify(`${plain.name}_DOMAINS`)}: 'stale.example' })`
  );
  const third = await extPage(page, `chrome-extension://${extId}/secrets.html`);
  const thirdSid = await extSession(page, third.targetId);
  const retried = await extEval(
    page,
    thirdSid,
    `(async () => { const started = Date.now(); for (;;) { const local = await chrome.storage.local.get(null); if (!(${JSON.stringify(plain.name)} in local) || Date.now() - started > 15000) return local; await new Promise((r) => setTimeout(r, 100)); } })()`
  );
  assertNoSecretRecords(retried.result.value, [plain.name, 'stale-after-crash']);
  const kept = (await values(thirdSid)).find((e) => e.name === plain.name);
  assert.equal(kept?.value, plain.value, 'a rerun after a crash keeps the IndexedDB record');
  const mode = await assertRelayCannotReadSecrets(
    page,
    thirdSid,
    { key: 'B8_MIG_SETTING', value: 'still-here' },
    [plain.name, sealed.name, plain.value, sealed.value, plain.domains]
  );
  t.diagnostic(`relay.js storage.local: ${mode}`);
  for (const name of [plain.name, sealed.name, `B8_MIG_WARM_${stamp}`]) {
    await secretsCall(page, thirdSid, { type: 'secrets.delete', name });
  }
  await extEval(page, thirdSid, `chrome.storage.local.remove('B8_MIG_SETTING')`);
  for (const tab of [first, second, third]) await extClose(page, tab.targetId);
});

test('B-SEC2 secrets.delete removes an unreadable record by name; a readable record is deleted too (control)', async (t) => {
  const page = await chrome.visit(t, slicc);
  const stamp = Date.now();
  const readable = `B8_DEL_OK_${stamp}`;
  const broken = `B8_DEL_BROKEN_${stamp}`;
  const { targetId } = await extPage(page, `chrome-extension://${extId}/secrets.html`);
  const sid = await extSession(page, targetId);
  const set = await secretsCall(page, sid, {
    type: 'secrets.set',
    name: readable,
    value: 'delete-me-readable-444',
    domains: ['del.example'],
  });
  assert.ok(set?.ok !== false, `secrets.set: ${JSON.stringify(set)}`);
  await extEval(
    page,
    sid,
    `(${IDB})((tx) => { tx.objectStore('records').put({ name: ${JSON.stringify(broken)}, value: { ct: 'AAAA', iv: 'AAAAAAAAAAAAAAAA' }, domains: 'del.example' }, ${JSON.stringify(broken)}); })`
  );
  const record = (name) =>
    extEval(
      page,
      sid,
      `(${IDB})((tx, done) => { const g = tx.objectStore('records').get(${JSON.stringify(name)}); g.onsuccess = () => done(g.result ?? null); })`
    ).then((r) => r.result.value);
  assert.ok(await record(readable), 'the readable record exists');
  assert.ok(await record(broken), 'the unreadable record exists');
  const control = await secretsCall(page, sid, { type: 'secrets.delete', name: readable });
  assert.deepEqual(control, { ok: true, removed: true, fromSession: false });
  assert.equal(await record(readable), null, 'control: the readable record is gone');
  const answer = await secretsCall(page, sid, { type: 'secrets.delete', name: broken });
  assert.deepEqual(answer, { ok: true, removed: true, fromSession: false });
  assert.equal(await record(broken), null, 'the unreadable record is gone');
  const again = await secretsCall(page, sid, { type: 'secrets.delete', name: broken });
  assert.deepEqual(again, { ok: true, removed: false });
  await extClose(page, targetId);
});

test('B24-2 six bridge: blob:, filesystem: and view-source: over seven and the vault are refused; ordinary URLs work (control)', async (t) => {
  const www = await chrome.visit(t, 'https://www.sliccy.ai/?slicc=leader');
  await www.evaluate(install, 'six-bridge', extId);
  const answer = await www.evaluate(async () => {
    const created = await h.attempt('Target.createTarget', { url: 'https://other.test/b24-2' });
    const targetId = created.result?.targetId;
    const attached = targetId
      ? await h.attempt('Target.attachToTarget', { targetId, flatten: true })
      : { error: 'no target' };
    const sessionId = attached.result?.sessionId;
    const navControl = sessionId
      ? await h.attempt('Page.navigate', { url: 'https://other.test/b24-2-next' }, sessionId)
      : { error: 'no session' };
    const wrapped = [
      'blob:https://vault.sliccy.ai/0b9e',
      'filesystem:https://vault.sliccy.ai/temporary/x',
      'view-source:https://vault.sliccy.ai/',
      'blob:https://seven.sliccy.ai/0b9e',
      'view-source:https://seven.sliccy.ai/os/',
      'https://vault.sliccy.ai/',
      'https://seven.sliccy.ai/',
    ];
    const create = {};
    const navigate = {};
    for (const url of wrapped) {
      create[url] = (await h.attempt('Target.createTarget', { url })).error ?? 'created';
      navigate[url] = sessionId
        ? ((await h.attempt('Page.navigate', { url }, sessionId)).error ?? 'navigated')
        : 'no session';
    }
    const viewSource = await h.attempt('Target.createTarget', {
      url: 'view-source:https://other.test/',
    });
    if (targetId) await h.attempt('Target.closeTarget', { targetId });
    if (viewSource.result?.targetId) {
      await h.attempt('Target.closeTarget', { targetId: viewSource.result.targetId });
    }
    return { created, attached, navControl, create, navigate, viewSource };
  });
  assert.match(answer.created.result?.targetId ?? '', /^\d+$/, 'control: an ordinary tab opens');
  assert.ok(answer.attached.result?.sessionId, 'control: and attaches');
  assert.equal(answer.navControl.error, undefined, 'control: an ordinary navigation works');
  assert.doesNotMatch(
    answer.viewSource.error ?? '',
    /refused/,
    'control: view-source of an ordinary origin is not refused'
  );
  for (const [url, error] of Object.entries(answer.create)) {
    assert.match(error, /^slicc: refused: /, `createTarget ${url}`);
  }
  for (const [url, error] of Object.entries(answer.navigate)) {
    assert.match(error, /^slicc: refused: /, `Page.navigate ${url}`);
  }
});

test('B24-5 discovery and handoff probe and announce an ordinary origin (control) but never fetch from or announce a protected one', async (t) => {
  const www = await chrome.visit(t, 'https://www.sliccy.ai/?slicc=leader');
  await www.evaluate(async (id) => {
    window.b8licks = [];
    const port = chrome.runtime.connect(id, { name: 'slicc.cdp-bridge' });
    const channelId = crypto.randomUUID();
    port.onMessage.addListener((msg) => {
      if (msg.kind === 'extension.lick' || msg.kind === 'extension.discovery') {
        window.b8licks.push(msg);
      }
    });
    await new Promise((resolve) => {
      const wait = (msg) => {
        if (msg.kind !== 'handshake.welcome') return;
        port.onMessage.removeListener(wait);
        resolve();
      };
      port.onMessage.addListener(wait);
      port.postMessage({ bridge: 1, channelId, kind: 'handshake.hello' });
    });
  }, extId);
  const stamp = Date.now();
  const licks = () => www.evaluate(() => window.b8licks);
  const until = async (fn, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const hits = (host) => chrome.site.seen.filter((r) => r.host === host);
  await chrome.visit(t, `https://discover.test/linked?n=ctl-${stamp}`);
  const probed = await until(() =>
    ['/.well-known/ai-catalog.json', '/llms.txt'].every((path) =>
      hits('discover.test').some((r) => r.path === path)
    )
  );
  assert.equal(probed, true, 'control: the ordinary origin is probed for its well-known files');
  const announced = await until(async () => {
    const got = await licks();
    return (
      got.some(
        (m) =>
          m.kind === 'extension.lick' && m.target === `https://upstream.test/handoff-ctl-${stamp}`
      ) &&
      got.some(
        (m) => m.kind === 'extension.discovery' && m.discoveryOrigin === 'https://discover.test'
      )
    );
  });
  assert.equal(announced, true, 'control: its handoff Link and discovery reach the leader');
  const before = (await licks()).length;
  const mark = chrome.site.seen.length;
  await chrome.visit(t, `https://vault.sliccy.ai/linked?n=vault-${stamp}`);
  await new Promise((r) => setTimeout(r, 4000));
  const vaultHits = chrome.site.seen.slice(mark).filter((r) => r.host === 'vault.sliccy.ai');
  assert.ok(
    vaultHits.some((r) => r.path === '/linked'),
    'control: the vault page itself loaded with its Link headers'
  );
  assert.deepEqual(
    vaultHits.map((r) => r.path).filter((path) => !['/linked', '/favicon.ico'].includes(path)),
    [],
    'nothing is fetched from the vault beyond the page and its favicon'
  );
  const later = (await licks()).slice(before);
  assert.deepEqual(
    later.filter((m) => JSON.stringify(m).includes('vault')),
    [],
    'no handoff or discovery for the vault reaches the leader'
  );
});
