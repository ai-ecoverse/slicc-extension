import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { listen } from '../../extension/cdp.js';
import { protectedOrigins } from '../../extension/protected.mjs';
import { protectedRules } from '../../extension/protected-rules.js';
import { launch } from './chrome.mjs';

const refused = "slicc: refused: target is on seven's origin";

const extensionId = 'ext';
const slicc = 'https://seven.sliccy.ai/';

function port(name, url, id = extensionId) {
  const disconnectListeners = new Set();
  return {
    name,
    sender: { id, url },
    disconnected: false,
    posted: [],
    disconnect() {
      this.disconnected = true;
      for (const listener of disconnectListeners) listener();
    },
    postMessage(message) {
      this.posted.push(structuredClone(message));
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.add(listener);
      },
    },
  };
}

function fakeChrome() {
  const eventListeners = new Set();
  const detachListeners = new Set();
  const api = {
    attached: [],
    detached: [],
    sent: [],
    removed: [],
    created: [],
    opened: [],
    activated: [],
    focused: [],
    tabs: {
      query(info) {
        if (info.active) return Promise.resolve([{ id: 7 }]);
        return Promise.resolve([
          { id: 7, title: 'fake slicc', url: 'https://seven.sliccy.ai/', windowId: 1 },
          { id: 8, title: 'other', url: 'https://other.test/', windowId: 1 },
          { title: 'no id' },
        ]);
      },
      create(options) {
        api.created.push(options);
        return Promise.resolve({ id: 11 });
      },
      update(tabId, props) {
        api.activated.push({ tabId, props });
        return Promise.resolve({ id: tabId, windowId: 3 });
      },
      remove(tabId) {
        api.removed.push(tabId);
        return Promise.resolve();
      },
      get(tabId) {
        const known = new Map([
          [7, 'https://seven.sliccy.ai/'],
          [8, 'https://other.test/'],
          [11, api.created.at(-1)?.url ?? 'https://example.test/'],
          [12, api.opened.at(-1)?.url ?? ''],
        ]);
        if (api.locations?.has(tabId))
          return Promise.resolve({ id: tabId, url: api.locations.get(tabId) });
        return Promise.resolve({ id: tabId, url: known.get(tabId) ?? '' });
      },
    },
    windows: {
      create(options) {
        api.opened.push(options);
        return Promise.resolve({ id: 4, tabs: [{ id: 12 }] });
      },
      update(windowId, props) {
        api.focused.push({ windowId, props });
        return Promise.resolve();
      },
    },
    debugger: {
      attach(target, version) {
        api.attached.push({ ...target, version });
        return Promise.resolve();
      },
      detach(target) {
        api.detached.push(target.tabId);
        return Promise.resolve();
      },
      sendCommand(target, method, params) {
        api.sent.push({ tabId: target.tabId, method, params });
        return Promise.resolve({ value: 2 });
      },
      onEvent: {
        addListener(listener) {
          eventListeners.add(listener);
        },
        removeListener(listener) {
          eventListeners.delete(listener);
        },
      },
      onDetach: {
        addListener(listener) {
          detachListeners.add(listener);
        },
        removeListener(listener) {
          detachListeners.delete(listener);
        },
      },
    },
    fire(tabId, method, params) {
      for (const listener of eventListeners) listener({ tabId }, method, params);
    },
    drop(tabId) {
      for (const listener of detachListeners) listener({ tabId }, 'target_closed');
    },
  };
  return api;
}

function open(url = 'https://seven.sliccy.ai/play') {
  const connection = port('slicc-fetch', url);
  const api = fakeChrome();
  const cdp = listen(connection, extensionId, api);
  assert.ok(cdp);
  return { connection, api, cdp };
}

async function command(cdp, connection, message) {
  assert.equal(cdp.handle(message), true);
  await cdp.settled();
  return connection.posted.at(-1);
}

test('protected origins follow the slicc-browsers corpus, including the vault', async () => {
  const root = new URL('../../node_modules/@ai-ecoverse/slicc-browsers/', import.meta.url);
  const catalog = JSON.parse(await readFile(new URL('catalog.json', root)));
  assert.deepEqual(protectedRules, catalog.protectedOrigins);
  const shipped = await readFile(new URL('../../extension/protected.mjs', import.meta.url), 'utf8');
  const source = await readFile(new URL('protected.mjs', root), 'utf8');
  assert.equal(shipped, source);
  const data = JSON.parse(await readFile(new URL('protected.json', root)));
  const match = protectedOrigins(protectedRules, data.origins);
  for (const item of data.urls) assert.equal(match.url(item.url), item.protected, item.url);
  for (const item of data.targets) assert.equal(match.target(item), item.protected, item.url);
  for (const item of data.cookieDomains) {
    assert.equal(match.cookieDomain(item.domain), item.protected, item.domain);
  }
  for (const item of data.storageKeys) {
    assert.equal(match.storageKey(item.key), item.protected, item.key);
  }
  assert.equal(match.url('https://vault.sliccy.ai/'), true);
  assert.equal(match.url('https://vault.sliccy.ai/oauth/callback'), true);
  assert.equal(protectedRules.refusal, refused);
});

test('an untrusted sender is disconnected before a CDP command can run', () => {
  const rejected = [
    ['slicc-fetch', 'https://evil.test/', extensionId],
    ['slicc-fetch', 'http://seven.sliccy.ai/', extensionId],
    ['slicc-fetch', 'https://notsliccy.ai/', extensionId],
    ['slicc-fetch', 'https://seven.sliccy.ai.evil.test/', extensionId],
    ['slicc-fetch', 'https://seven.sliccy.ai/', 'someone-else'],
    ['slicc-fetch', 'not a url', extensionId],
    ['other', 'https://seven.sliccy.ai/', extensionId],
  ];
  for (const [name, url, id] of rejected) {
    const connection = port(name, url, id);
    const api = fakeChrome();
    assert.equal(listen(connection, extensionId, api), null);
    assert.equal(connection.disconnected, true);
    assert.equal(connection.posted.length, 0);
    assert.equal(api.attached.length, 0);
  }
});

test('flatten other than true is an error and does not attach', async () => {
  const { connection, api, cdp } = open();
  const missing = await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8' },
  });
  const explicit = await command(cdp, connection, {
    id: 2,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: false },
  });
  assert.equal(missing.error, 'only flatten: true is supported');
  assert.equal(explicit.error, 'only flatten: true is supported');
  assert.equal(api.attached.length, 0);
  const later = await command(cdp, connection, {
    id: 3,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
    sessionId: '8',
  });
  assert.match(later.error, /No tab attached for sessionId: 8/);
  assert.equal(api.sent.length, 0);
  cdp.close();
});

test('flatten true keeps the session on the attaching port and forwards its events', async () => {
  const { connection, api, cdp } = open();
  const stranger = port('slicc-fetch', 'https://a.sliccy.ai/');
  const other = listen(stranger, extensionId, api);
  const attached = await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  assert.deepEqual(attached.result, { sessionId: '8' });
  assert.deepEqual(api.attached, [{ tabId: 8, version: '1.3' }]);
  const again = await command(cdp, connection, {
    id: 2,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  assert.deepEqual(again.result, { sessionId: '8' });
  assert.equal(api.attached.length, 1);
  const evaluated = await command(cdp, connection, {
    id: 3,
    method: 'Runtime.evaluate',
    params: { expression: '1+1' },
    sessionId: '8',
  });
  assert.deepEqual(evaluated.result, { value: 2 });
  assert.deepEqual(api.sent, [
    { tabId: 8, method: 'Runtime.evaluate', params: { expression: '1+1' } },
  ]);
  const stolen = await command(other, stranger, {
    id: 4,
    method: 'Runtime.evaluate',
    params: {},
    sessionId: '8',
  });
  assert.match(stolen.error, /No tab attached for sessionId: 8/);
  api.fire(8, 'Page.loadEventFired', { name: 'load' });
  await cdp.settled();
  assert.deepEqual(connection.posted.at(-1), {
    method: 'Page.loadEventFired',
    params: { name: 'load' },
    sessionId: '8',
  });
  assert.equal(
    stranger.posted.some((message) => message.method === 'Page.loadEventFired'),
    false
  );
  const brought = await command(cdp, connection, {
    id: 5,
    method: 'Page.bringToFront',
    sessionId: '8',
  });
  assert.deepEqual(brought.result, { value: 2 });
  assert.deepEqual(api.activated.at(-1), { tabId: 8, props: { active: true } });
  assert.deepEqual(api.focused.at(-1), { windowId: 3, props: { focused: true } });
  await command(cdp, connection, {
    id: 6,
    method: 'Target.detachFromTarget',
    params: { sessionId: '8' },
  });
  assert.equal(api.detached.length, 0);
  await command(cdp, connection, {
    id: 7,
    method: 'Target.detachFromTarget',
    params: { sessionId: '8' },
  });
  assert.deepEqual(api.detached, [8]);
  cdp.close();
  other.close();
});

test('target commands list, open, activate, and close tabs', async () => {
  const { connection, api, cdp } = open();
  const listed = await command(cdp, connection, { id: 1, method: 'Target.getTargets' });
  assert.deepEqual(listed.result.targetInfos, [
    {
      targetId: '7',
      type: 'page',
      title: 'fake slicc',
      url: 'https://seven.sliccy.ai/',
      attached: false,
      active: true,
    },
    {
      targetId: '8',
      type: 'page',
      title: 'other',
      url: 'https://other.test/',
      attached: false,
      active: false,
    },
  ]);
  const created = await command(cdp, connection, {
    id: 2,
    method: 'Target.createTarget',
    params: { url: 'https://example.test/' },
  });
  assert.deepEqual(created.result, { targetId: '11' });
  assert.deepEqual(api.created, [{ url: 'https://example.test/', active: false }]);
  const windowed = await command(cdp, connection, {
    id: 3,
    method: 'Target.createTarget',
    params: { url: 'https://example.test/win', newWindow: true, decorated: false },
  });
  assert.deepEqual(windowed.result, { targetId: '12' });
  assert.equal(api.opened[0].type, 'popup');
  await command(cdp, connection, {
    id: 4,
    method: 'Target.activateTarget',
    params: { targetId: '11' },
  });
  assert.equal(api.activated.at(-1).tabId, 11);
  await command(cdp, connection, {
    id: 5,
    method: 'Target.attachToTarget',
    params: { targetId: '11', flatten: true },
  });
  const closed = await command(cdp, connection, {
    id: 6,
    method: 'Target.closeTarget',
    params: { targetId: '11' },
  });
  assert.deepEqual(closed.result, { success: true });
  assert.deepEqual(api.removed, [11]);
  assert.equal(api.detached.includes(11), true);
  api.fire(11, 'Page.loadEventFired', {});
  assert.equal(
    connection.posted.some((message) => message.method === 'Page.loadEventFired'),
    false
  );
  cdp.close();
});

test('open, attach and navigate refuse seven and the vault', async () => {
  const { connection, api, cdp } = open();
  const blocked = [
    'https://seven.sliccy.ai/',
    'https://vault.sliccy.ai/oauth/callback',
    'http://a.b.sliccy.ai:8443/x',
    'devtools://devtools/bundled/inspector.html',
  ];
  for (const [index, url] of blocked.entries()) {
    const opened = await command(cdp, connection, {
      id: index + 1,
      method: 'Target.createTarget',
      params: { url },
    });
    assert.equal(opened.error, refused);
    const windowed = await command(cdp, connection, {
      id: index + 20,
      method: 'Target.createTarget',
      params: { url, newWindow: true },
    });
    assert.equal(windowed.error, refused);
  }
  assert.equal(api.created.length, 0);
  assert.equal(api.opened.length, 0);
  const attached = await command(cdp, connection, {
    id: 40,
    method: 'Target.attachToTarget',
    params: { targetId: '7', flatten: true },
  });
  assert.equal(attached.error, refused);
  assert.equal(api.attached.length, 0);
  const allowed = await command(cdp, connection, {
    id: 41,
    method: 'Target.createTarget',
    params: { url: 'https://example.test/' },
  });
  assert.deepEqual(allowed.result, { targetId: '11' });
  const session = await command(cdp, connection, {
    id: 42,
    method: 'Target.attachToTarget',
    params: { targetId: '11', flatten: true },
  });
  assert.deepEqual(session.result, { sessionId: '11' });
  api.locations = new Map([[11, 'https://vault.sliccy.ai/']]);
  const later = await command(cdp, connection, {
    id: 43,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
    sessionId: '11',
  });
  assert.equal(later.error, refused);
  assert.equal(api.sent.length, 0);
  api.locations = new Map([[11, 'https://example.test/']]);
  const navigated = await command(cdp, connection, {
    id: 44,
    method: 'Page.navigate',
    params: { url: 'https://seven.sliccy.ai/' },
    sessionId: '11',
  });
  assert.equal(navigated.error, refused);
  assert.equal(api.sent.length, 0);
  cdp.close();
});

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

test('a sliccy.ai page can list and open targets, and flatten is required', async (t) => {
  const page = await chrome.visit(t, slicc);
  const listed = await page.evaluate(async () => {
    const { targetInfos } = await globalThis.sliccExtension.cdp.send('Target.getTargets');
    return targetInfos.some((target) => target.url.startsWith('https://seven.sliccy.ai/'));
  });
  assert.equal(listed, true);
  const rejected = await page.evaluate(async () => {
    const { targetInfos } = await globalThis.sliccExtension.cdp.send('Target.getTargets');
    const targetId = targetInfos.find((target) =>
      target.url.startsWith('https://seven.sliccy.ai/')
    ).targetId;
    const missing = await globalThis.sliccExtension.cdp
      .send('Target.attachToTarget', { targetId })
      .then(
        () => 'attached',
        (error) => error.message
      );
    const explicit = await globalThis.sliccExtension.cdp
      .send('Target.attachToTarget', { targetId, flatten: false })
      .then(
        () => 'attached',
        (error) => error.message
      );
    const later = await globalThis.sliccExtension.cdp
      .send('Runtime.evaluate', { expression: '1' }, targetId)
      .then(
        () => 'ran',
        (error) => error.message
      );
    return { missing, explicit, later };
  });
  assert.equal(rejected.missing, 'only flatten: true is supported');
  assert.equal(rejected.explicit, 'only flatten: true is supported');
  assert.match(rejected.later, /No tab attached/);
  const stranger = await chrome.visit(t, 'https://other.test/');
  assert.equal(await stranger.evaluate(() => 'sliccExtension' in globalThis), false);
});

test('flatten true attaches, evaluates, and returns events on that session', async (t) => {
  const page = await chrome.visit(t, slicc);
  const answer = await page.evaluate(async () => {
    const events = [];
    globalThis.sliccExtension.cdp.on((event) => events.push(event));
    const created = await globalThis.sliccExtension.cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    try {
      const attached = await globalThis.sliccExtension.cdp.send('Target.attachToTarget', {
        targetId: created.targetId,
        flatten: true,
      });
      const evaluated = await globalThis.sliccExtension.cdp.send(
        'Runtime.evaluate',
        { expression: '1+1', returnByValue: true },
        attached.sessionId
      );
      await globalThis.sliccExtension.cdp.send('Runtime.enable', {}, attached.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { attached, evaluated, events };
    } finally {
      await globalThis.sliccExtension.cdp
        .send('Target.closeTarget', { targetId: created.targetId })
        .catch(() => undefined);
    }
  });
  assert.match(answer.attached.sessionId, /^\d+$/);
  assert.equal(answer.evaluated.result.value, 2);
  assert.equal(answer.events.length > 0, true);
  assert.equal(
    answer.events.every((event) => event.sessionId === answer.attached.sessionId),
    true
  );
});

test('a sliccy.ai page cannot open or attach to seven or the vault', async (t) => {
  const page = await chrome.visit(t, slicc);
  const answer = await page.evaluate(async (refused) => {
    const fail = async (method, params, sessionId) => {
      try {
        await globalThis.sliccExtension.cdp.send(method, params, sessionId);
        return 'ran';
      } catch (error) {
        return error.message;
      }
    };
    const { targetInfos } = await globalThis.sliccExtension.cdp.send('Target.getTargets');
    const targetId = targetInfos.find((target) =>
      target.url.startsWith('https://seven.sliccy.ai/')
    ).targetId;
    const attached = await fail('Target.attachToTarget', { targetId, flatten: true });
    const vault = await fail('Target.createTarget', { url: 'https://vault.sliccy.ai/' });
    const created = await globalThis.sliccExtension.cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const session = await globalThis.sliccExtension.cdp.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    });
    const navigated = await fail(
      'Page.navigate',
      { url: 'https://vault.sliccy.ai/secret' },
      session.sessionId
    );
    await globalThis.sliccExtension.cdp
      .send('Target.closeTarget', { targetId: created.targetId })
      .catch(() => undefined);
    return { attached, vault, navigated };
  }, refused);
  assert.equal(answer.attached, refused);
  assert.equal(answer.vault, refused);
  assert.equal(answer.navigated, refused);
});
