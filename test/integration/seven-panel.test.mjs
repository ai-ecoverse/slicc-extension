import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { extId, openExtensionPage } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const www = 'https://www.sliccy.ai';
const os = `${www}/os/`;

const wwwTabs = `chrome.tabs.query({}).then((tabs) => tabs
  .map((tab) => ({ id: tab.id, url: tab.url || '', pinned: tab.pinned, active: tab.active }))
  .filter((tab) => tab.url.startsWith('https://www.sliccy.ai/')))`;
const shown = `({
  state: document.getElementById('cherry-status').dataset.state,
  src: document.getElementById('cherry-follower').getAttribute('src'),
  text: document.getElementById('cherry-status-text').textContent,
  action: document.getElementById('cherry-status-action').hidden ? null : document.getElementById('cherry-status-action').textContent,
})`;
const upgraded = `chrome.storage.local.get('slicc_seven_upgraded').then((s) => s.slicc_seven_upgraded === true)`;
const stored = `chrome.storage.session.get(['slicc_leader_tab_id', 'slicc_leader_kind'])`;

const probe = `(async () => {
  const one = (name, message, read) => new Promise((resolve) => {
    const port = chrome.runtime.connect(${JSON.stringify(extId)}, { name });
    const timer = setTimeout(() => { port.disconnect(); resolve('silent'); }, 5000);
    port.onDisconnect.addListener(() => { clearTimeout(timer); resolve('closed'); });
    port.onMessage.addListener((m) => {
      const verdict = read(m);
      if (!verdict) return;
      clearTimeout(timer);
      port.disconnect();
      resolve(verdict);
    });
    port.postMessage(message);
  });
  return {
    bridge: await one('slicc.cdp-bridge', { bridge: 1, channelId: 'probe', kind: 'handshake.hello' },
      (m) => m.kind === 'handshake.rejected' ? 'refused ' + m.reason : m.kind === 'handshake.welcome' ? 'open' : ''),
    fetch: await one('fetch-proxy.fetch', { type: 'request', url: 'https://upstream.test/data?n=probe', method: 'GET', headers: {} },
      (m) => m.type === 'response-error' ? 'refused ' + m.error : m.type === 'response-head' ? 'open' : ''),
    secrets: await one('secrets.crud', { id: 1, type: 'secrets.list' },
      (m) => m.response?.error ? 'refused ' + m.response.error : m.response ? 'open' : ''),
    mount: await one('mount.sign-and-forward', { id: 1, type: 'mount.s3-sign-and-forward', envelope: { profile: 'none', method: 'GET', bucket: 'b', key: 'k' } },
      (m) => m.response?.error && /pin failed/.test(m.response.error) ? 'refused ' + m.response.error : m.response ? 'open' : ''),
  };
})()`;

function refusedEverywhere(ports, reason) {
  for (const [name, verdict] of Object.entries(ports)) {
    assert.match(verdict, /^refused /, `${name}: ${verdict}`);
    assert.ok(verdict.includes(reason), `${name} names ${reason}: ${verdict}`);
  }
}

async function panel(t) {
  const start = await chrome.visit(t, 'https://other.test/');
  const side = await openExtensionPage(start, 'sidepanel.html');
  await side.evaluate(`(() => {
    globalThis.seen = [];
    const status = document.getElementById('cherry-status');
    new MutationObserver(() => seen.push(status.dataset.state)).observe(status, { attributes: true });
    return true;
  })()`);
  return side;
}

function cookie(name, value, expires) {
  const cookie = { name, value, url: `${www}/`, path: '/', secure: true };
  return chrome.cdp.send('Storage.setCookies', {
    cookies: [expires === undefined ? cookie : { ...cookie, expires }],
  });
}

async function targetOf(url) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const found = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(url));
    if (found) return found.targetId;
    if (Date.now() > deadline) throw new Error(`no tab on ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function inTab(targetId, expression) {
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const answer = await chrome.cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.text);
    return answer.result.value;
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }
}

async function goTo(targetId, url, lands = url) {
  await inTab(targetId, `location.assign(${JSON.stringify(url)}); true`);
  const deadline = Date.now() + 15000;
  for (;;) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const now = targetInfos.find((t) => t.targetId === targetId)?.url;
    if (now === lands && (await inTab(targetId, 'document.readyState')) === 'complete') return;
    if (Date.now() > deadline) throw new Error(`the tab stayed on ${now}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const connectable = `document.readyState === 'complete' && typeof globalThis.chrome?.runtime?.connect === 'function'`;

async function settled(targetId, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const ready = await inTab(targetId, connectable).catch(() => false);
    if (ready) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function open(url) {
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url });
  await targetOf(url);
  if (await settled(targetId, 5000)) return targetId;
  await inTab(targetId, 'location.reload(); true');
  if (await settled(targetId, 15000)) return targetId;
  throw new Error(`${url} loaded without chrome.runtime.connect, also after a reload`);
}

async function closeWww() {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  for (const { targetId, type, url } of targetInfos) {
    if (type === 'page' && url.startsWith(`${www}/`)) {
      await chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
  }
}

test('only the six leader document on / is the leader: /preview/?slicc=leader is refused as a claim and as the stored tab', async (t) => {
  t.after(closeWww);
  const keys = `chrome.storage.session.get('slicc_leader_tab_id').then((s) => s.slicc_leader_tab_id ?? null)`;
  const preview = await open(`${www}/preview/x.html?slicc=leader`);
  refusedEverywhere(await inTab(preview, probe), 'not-leader-document');
  await chrome.cdp.send('Target.closeTarget', { targetId: preview });

  const leader = await open(`${www}/?slicc=leader`);
  assert.deepEqual(await inTab(leader, probe), {
    bridge: 'open',
    fetch: 'open',
    secrets: 'open',
    mount: 'open',
  });
  const first = await panel(t);
  const stored = await first.evaluate(keys);
  await first.close();
  assert.notEqual(stored, null);
  await goTo(leader, `${www}/preview/x.html?slicc=leader`);
  refusedEverywhere(await inTab(leader, probe), 'not-leader-document');
  const side = await panel(t);
  assert.notEqual(await side.evaluate(keys), stored, 'the stored leader was dropped');
});

test('before the upgrade: a six leader wins and its ports open, a /os/ or /7/ tab is never adopted, and none of six’s ports reach it', async (t) => {
  t.after(closeWww);
  const leader = await open(`${www}/?slicc=leader`);
  assert.deepEqual(await inTab(leader, probe), {
    bridge: 'open',
    fetch: 'open',
    secrets: 'open',
    mount: 'open',
  });
  const mine = await open(os);
  const bios = await open(`${www}/7/`);
  const side = await panel(t);
  assert.notEqual((await side.evaluate(shown)).src, os);
  refusedEverywhere(await inTab(mine, probe), 'leader-is-seven');
  refusedEverywhere(await inTab(bios, probe), 'leader-is-seven');
  await chrome.cdp.send('Target.closeTarget', { targetId: leader });
  await side.close();

  const again = await panel(t);
  assert.ok(
    await again.until(
      `${wwwTabs}.then((tabs) => tabs.some((tab) => /[?&]slicc=leader/.test(tab.url)))`,
      15000
    ),
    'a six leader is created next to the seven tabs'
  );
  assert.equal(await again.evaluate(upgraded), false);
  const ids = (await again.evaluate(wwwTabs)).filter((tab) => tab.url.startsWith(os));
  assert.equal(ids.length, 1);
  assert.notEqual((await again.evaluate(stored)).slicc_leader_tab_id, ids[0].id);
  assert.notEqual((await again.evaluate(shown)).src, os);
  refusedEverywhere(await inTab(mine, probe), 'leader-is-seven');
});

test('before the upgrade, page script can’t forge it: a leader sent to /os/ or /7 by script, or a page that pushes a leader URL, is refused and never adopted', async (t) => {
  t.after(closeWww);
  const side = await panel(t);
  assert.ok(await side.until(`${stored}.then((s) => s.slicc_leader_tab_id !== undefined)`, 15000));
  const leader = await targetOf(`${www}/?slicc=leader`);
  await goTo(leader, os);
  assert.ok(
    await side.until(`${stored}.then((s) => s.slicc_leader_tab_id === undefined)`, 10000),
    'leaving the leader document drops the stored leader'
  );
  refusedEverywhere(await inTab(leader, probe), 'leader-is-seven');
  await goTo(leader, `${www}/?slicc=leader&n=again`);
  await goTo(leader, `${www}/7`, `${www}/7/`);
  assert.equal(await side.evaluate(upgraded), false, 'a script navigation is no upgrade');

  const preview = await open(`${www}/preview/x.html`);
  await inTab(preview, `history.pushState(null, '', '/?slicc=leader'); true`);
  const forged = await inTab(preview, probe);
  for (const verdict of Object.values(forged)) assert.match(verdict, /not-leader-document/);
  assert.equal(await side.evaluate(upgraded), false);
  assert.notEqual((await side.evaluate(shown)).src, os);
});

test('seven’s service worker redirecting the leader is the upgrade: the panel follows, every port refuses it', async (t) => {
  t.after(closeWww);
  const page = await open(`${www}/preview/register.html`);
  await inTab(
    page,
    `navigator.serviceWorker.register('/fake-seven-sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready).then(() => true)`
  );
  t.after(() =>
    open(`${www}/preview/unregister.html`).then((tab) =>
      inTab(
        tab,
        `navigator.serviceWorker.getRegistrations().then((all) => Promise.all(all.map((r) => r.unregister()))).then(() => true)`
      )
    )
  );
  const side = await panel(t);
  assert.ok(
    await side.until(
      `(() => { const s = ${shown}; return s.state === 'live' && s.src === ${JSON.stringify(os)}; })()`,
      20000
    ),
    JSON.stringify(await side.evaluate(shown))
  );
  assert.equal(await side.evaluate(upgraded), true);
  assert.equal((await side.evaluate(stored)).slicc_leader_kind, 'seven');
  refusedEverywhere(await inTab(await targetOf(os), probe), 'leader-is-seven');
});

test('after the upgrade: the redirected leader is adopted and the panel follows it, opening the panel again opens no other tab, and every port refuses it, also after it navigates to /preview/', async (t) => {
  t.after(closeWww);
  await cookie('__Host-slicc-six-retired', '1');
  const side = await panel(t);
  assert.ok(
    await side.until(
      `(() => { const s = ${shown}; return s.state === 'live' && s.src === ${JSON.stringify(os)}; })()`,
      20000
    ),
    JSON.stringify(await side.evaluate(shown))
  );
  assert.equal(await side.evaluate(upgraded), true);
  const first = await side.evaluate(wwwTabs);
  assert.equal(first.length, 1, JSON.stringify(first));
  assert.equal(first[0].url, os);
  assert.equal(first[0].pinned, true);
  assert.deepEqual(await side.evaluate(stored), {
    slicc_leader_tab_id: first[0].id,
    slicc_leader_kind: 'seven',
  });
  const leader = await targetOf(os);
  refusedEverywhere(await inTab(leader, probe), 'leader-is-seven');
  await side.close();

  for (let again = 0; again < 2; again++) {
    const reopened = await panel(t);
    assert.ok(
      await reopened.until(`${shown}.state === 'live'`, 20000),
      JSON.stringify(await reopened.evaluate(shown))
    );
    assert.deepEqual(
      (await reopened.evaluate(wwwTabs)).map((tab) => tab.id),
      [first[0].id],
      'no second leader tab'
    );
    await reopened.close();
  }

  const watch = await panel(t);
  await goTo(leader, `${www}/preview/x.html`);
  assert.ok(
    await watch.until(`${stored}.then((s) => s.slicc_leader_tab_id === undefined)`, 10000),
    'leaving seven drops the stored leader'
  );
  refusedEverywhere(await inTab(leader, probe), 'not-leader-document');
  await inTab(leader, `history.pushState(null, '', '/?slicc=leader'); true`);
  refusedEverywhere(await inTab(leader, probe), 'not-leader-document');
});

test('after the upgrade, a seven tab the user opened becomes the leader as it is', async (t) => {
  t.after(closeWww);
  const mine = await open(os);
  const side = await panel(t);
  assert.ok(
    await side.until(`${shown}.state === 'live'`, 20000),
    JSON.stringify(await side.evaluate(shown))
  );
  const tabs = await side.evaluate(wwwTabs);
  assert.equal(tabs.length, 1, JSON.stringify(tabs));
  assert.equal(tabs[0].pinned, false, 'a seven tab is adopted as it is');
  assert.equal((await side.evaluate(stored)).slicc_leader_kind, 'seven');
  refusedEverywhere(await inTab(mine, probe), 'leader-is-seven');
});

for (const [says, why] of [
  ['wrong-type', 'a message of another type'],
  ['elsewhere', 'the frame’s window on another origin'],
]) {
  test(`the panel ignores ${why}, and its own window, and falls back to Show SLICC tab`, async (t) => {
    await cookie('seven-says', says);
    t.after(() => cookie('seven-says', '', 1));
    t.after(closeWww);
    const side = await panel(t);
    assert.ok(await side.until(`${shown}.src === ${JSON.stringify(os)}`, 15000));
    await side.evaluate(`postMessage({ type: 'slicc-seven-panel', role: 'follower' }, '*'); true`);
    assert.ok(
      await side.until(`${shown}.state === 'tab'`, 30000),
      JSON.stringify(await side.evaluate(shown))
    );
    assert.equal((await side.evaluate('seen')).includes('live'), false);
  });
}

test('a seven that refuses the frame leaves the panel on Show SLICC tab, which brings the tab to the front', async (t) => {
  await cookie('seven-refuses', '1');
  t.after(() => cookie('seven-refuses', '', 1));
  t.after(closeWww);
  const side = await panel(t);
  assert.ok(
    await side.until(`${shown}.state === 'tab'`, 30000),
    JSON.stringify(await side.evaluate(shown))
  );
  assert.deepEqual(await side.evaluate(shown), {
    state: 'tab',
    src: os,
    text: 'SLICC runs in its tab. Reload that tab to use SLICC here, or open it.',
    action: 'Show SLICC tab',
  });
  await side.evaluate(`document.getElementById('cherry-status-action').click()`);
  assert.ok(
    await side.until(`${wwwTabs}.then((tabs) => tabs.length === 1 && tabs[0].active)`, 10000),
    JSON.stringify(await side.evaluate(wwwTabs))
  );
});
