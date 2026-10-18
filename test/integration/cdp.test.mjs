import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { listen } from '../../extension/cdp.js';
import { protectedOrigins } from '../../extension/protected.mjs';
import { protectedRules } from '../../extension/protected-rules.js';
import { launch } from './chrome.mjs';
import { openExtensionPage } from './extension-page.mjs';

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

const plainTree = { frameTree: { frame: { id: 'MAIN', url: 'https://other.test/' } } };

function fakeChrome() {
  const eventListeners = new Set();
  const detachListeners = new Set();
  const updateListeners = new Set();
  const createdListeners = new Set();
  const removedListeners = new Set();
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
        if (api.locations?.has(tabId)) {
          const value = api.locations.get(tabId);
          const tab = typeof value === 'string' ? { url: value } : value;
          return Promise.resolve({ id: tabId, ...tab });
        }
        return Promise.resolve({ id: tabId, url: known.get(tabId) ?? '' });
      },
      onUpdated: {
        addListener(listener) {
          updateListeners.add(listener);
        },
        removeListener(listener) {
          updateListeners.delete(listener);
        },
      },
      onCreated: {
        addListener(listener) {
          createdListeners.add(listener);
        },
        removeListener(listener) {
          createdListeners.delete(listener);
        },
      },
      onRemoved: {
        addListener(listener) {
          removedListeners.add(listener);
        },
        removeListener(listener) {
          removedListeners.delete(listener);
        },
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
        if (method === 'Page.getFrameTree') return Promise.resolve(plainTree);
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
    visit(tabId, tab) {
      api.locations = api.locations ?? new Map();
      api.locations.set(tabId, tab);
      for (const listener of updateListeners) listener(tabId, tab, { id: tabId, ...tab });
    },
    born(tab) {
      api.locations = api.locations ?? new Map();
      api.locations.set(tab.id, tab);
      for (const listener of createdListeners) listener(tab);
    },
    gone(tabId) {
      for (const listener of removedListeners) listener(tabId, {});
    },
    child(tabId, sessionId, method, params) {
      for (const listener of eventListeners) listener({ tabId, sessionId }, method, params);
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

function user(api) {
  return api.sent.filter(
    (sent) => !['Fetch.enable', 'Page.getFrameTree', 'Target.setAutoAttach'].includes(sent.method)
  );
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
    ['slicc-fetch', 'https://vault.sliccy.ai/', extensionId],
    ['slicc-fetch', 'https://vault-preview.sliccy.ai/', extensionId],
    ['slicc-fetch', 'https://vault-x.sliccy.ai/', extensionId],
    ['slicc-fetch', 'https://get.sliccy.ai/', extensionId],
    ['slicc-fetch', 'https://mcpcat.sliccy.ai/', extensionId],
    ['slicc-fetch', 'https://echo.sliccy.ai/', extensionId],
    ['slicc-fetch', 'https://sliccy.ai/', extensionId],
  ];
  for (const [name, url, id] of rejected) {
    const connection = port(name, url, id);
    const api = fakeChrome();
    assert.equal(listen(connection, extensionId, api), null);
    assert.equal(connection.disconnected, true);
    assert.equal(connection.posted.length, 0);
    assert.equal(api.attached.length, 0);
  }
  const otherPort = port('other', 'https://seven.sliccy.ai/', extensionId);
  assert.equal(listen(otherPort, extensionId, fakeChrome()), null);
  assert.equal(otherPort.disconnected, false);
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
  assert.equal(user(api).length, 0);
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
  assert.deepEqual(again.result, { sessionId: '8.1' });
  assert.equal(api.attached.length, 1);
  const evaluated = await command(cdp, connection, {
    id: 3,
    method: 'Runtime.evaluate',
    params: { expression: '1+1' },
    sessionId: '8',
  });
  assert.deepEqual(evaluated.result, { value: 2 });
  assert.deepEqual(user(api), [
    { tabId: 8, method: 'Runtime.evaluate', params: { expression: '1+1' } },
  ]);
  assert.deepEqual(api.sent[0], {
    tabId: 8,
    method: 'Fetch.enable',
    params: {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
      handleAuthRequests: false,
    },
  });
  const stolen = await command(other, stranger, {
    id: 4,
    method: 'Runtime.evaluate',
    params: {},
    sessionId: '8',
  });
  assert.match(stolen.error, /No tab attached for sessionId: 8/);
  api.fire(8, 'Page.loadEventFired', { name: 'load' });
  await cdp.settled();
  assert.deepEqual(connection.posted.slice(-2), [
    { method: 'Page.loadEventFired', params: { name: 'load' }, sessionId: '8' },
    { method: 'Page.loadEventFired', params: { name: 'load' }, sessionId: '8.1' },
  ]);
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
    params: { sessionId: '8.1' },
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
      title: '',
      url: 'https://seven.sliccy.ai/',
      attached: false,
      canAccessOpener: false,
      active: true,
    },
    {
      targetId: '8',
      type: 'page',
      title: 'other',
      url: 'https://other.test/',
      attached: false,
      canAccessOpener: false,
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
    'https://echo.sliccy.ai/',
    'http://a.b.sliccy.ai:8443/x',
    'devtools://devtools/bundled/inspector.html',
    'blob:https://vault.sliccy.ai/abc',
    'view-source:https://vault.sliccy.ai/',
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
  api.locations = new Map([[11, 'https://echo.sliccy.ai/']]);
  const echoed = await command(cdp, connection, {
    id: 46,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
    sessionId: '11',
  });
  assert.equal(echoed.error, refused);
  api.locations = new Map([[11, 'https://vault.sliccy.ai/']]);
  const later = await command(cdp, connection, {
    id: 43,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
    sessionId: '11',
  });
  assert.equal(later.error, refused);
  assert.equal(user(api).length, 0);
  api.locations = new Map([[11, 'https://example.test/']]);
  const navigated = await command(cdp, connection, {
    id: 44,
    method: 'Page.navigate',
    params: { url: 'https://seven.sliccy.ai/' },
    sessionId: '11',
  });
  assert.equal(navigated.error, refused);
  assert.equal(user(api).length, 0);
  const plain = await command(cdp, connection, {
    id: 45,
    method: 'Page.navigate',
    params: { url: 'https://example.test/next' },
    sessionId: '11',
  });
  assert.deepEqual(plain.result, { value: 2 });
  assert.equal(user(api).at(-1).method, 'Page.navigate');
  cdp.close();
});

function blankChrome(document = 'null') {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'about:blank' }]]);
  let loader = 'L1';
  let main = 'about:blank';
  api.debugger.sendCommand = (target, method, params) => {
    api.sent.push({ tabId: target.tabId, method, params });
    if (method === 'Page.getFrameTree') {
      return Promise.resolve({
        frameTree: {
          frame: { id: 'MAIN', url: main, loaderId: loader, securityOrigin: '://' },
          childFrames: [{ frame: { id: 'CHILD', parentId: 'MAIN', url: 'https://other.test/' } }],
        },
      });
    }
    if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 5 });
    if (method === 'Runtime.evaluate' && params.expression === 'self.origin') {
      return Promise.resolve({ result: { type: 'string', value: document } });
    }
    if (method === 'Runtime.evaluate' && params.expression.startsWith('location.assign(')) {
      loader = 'L2';
      main = JSON.parse(params.expression.slice(16, -1));
    }
    return Promise.resolve({});
  };
  return { connection, api, cdp };
}

test('Page.navigate to about:blank is opened by the page itself, never by the extension', async () => {
  const { connection, api, cdp } = blankChrome();
  const attached = await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  assert.deepEqual(attached.result, { sessionId: '8' });
  const control = await command(cdp, connection, {
    id: 2,
    method: 'Page.navigate',
    params: { url: 'https://other.test/' },
    sessionId: '8',
  });
  assert.deepEqual(control.result, {});
  assert.equal(api.sent.filter((s) => s.method === 'Page.navigate').length, 1);
  const blank = await command(cdp, connection, {
    id: 3,
    method: 'Page.navigate',
    params: { url: 'about:blank' },
    sessionId: '8',
  });
  assert.deepEqual(blank.result, { frameId: 'MAIN', loaderId: 'L2', isDownload: false });
  assert.equal(api.sent.filter((s) => s.method === 'Page.navigate').length, 1);
  const assigned = api.sent.filter(
    (s) => s.method === 'Runtime.evaluate' && s.params.expression.startsWith('location.assign(')
  );
  assert.deepEqual(assigned.at(-1).params, {
    expression: 'location.assign("about:blank")',
    contextId: 5,
  });
  const fragment = await command(cdp, connection, {
    id: 4,
    method: 'Page.navigate',
    params: { url: 'about:blank#x' },
    sessionId: '8',
  });
  assert.deepEqual(fragment.result, { frameId: 'MAIN' });
  for (const [id, url] of [
    [5, 'about:srcdoc'],
    [6, 'about:BLANK'],
  ]) {
    const other = await command(cdp, connection, {
      id,
      method: 'Page.navigate',
      params: { url },
      sessionId: '8',
    });
    assert.match(other.error, /^slicc: refused: /, url);
  }
  const missing = await command(cdp, connection, {
    id: 7,
    method: 'Page.navigate',
    params: { url: 'about:blank', frameId: 'NOPE' },
    sessionId: '8',
  });
  assert.equal(missing.error, 'No frame with given id found');
  assert.equal(api.sent.filter((s) => s.method === 'Page.navigate').length, 1);
  assert.equal(connection.posted.filter((m) => m.method === 'Target.detachedFromTarget').length, 0);
  cdp.close();
});

test('an about:blank document on the extension origin is refused at attach, after an opaque control', async () => {
  const control = blankChrome();
  const opaque = await command(control.cdp, control.connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  assert.deepEqual(opaque.result, { sessionId: '8' });
  control.cdp.close();
  const { connection, api, cdp } = blankChrome(`chrome-extension://${extensionId}`);
  for (const id of [1, 2]) {
    const refusedAttach = await command(cdp, connection, {
      id,
      method: 'Target.attachToTarget',
      params: { targetId: '8', flatten: true },
    });
    assert.equal(refusedAttach.error, refused);
  }
  assert.deepEqual(api.detached, [8, 8]);
  assert.equal(connection.posted.filter((m) => m.method === 'Target.detachedFromTarget').length, 0);
  cdp.close();
});

test('attach fails closed when the frame tree or the main-frame origin cannot be read, after a control', async () => {
  const cases = [
    ['control', () => Promise.resolve(plainTree), true],
    [
      'commits while probed',
      (() => {
        let reads = 0;
        return () =>
          Promise.resolve(
            reads++ === 0 ? { frameTree: { frame: { id: 'MAIN', url: 'about:blank' } } } : plainTree
          );
      })(),
      true,
    ],
    ['rejects', () => Promise.reject(new Error('Page.getFrameTree failed')), false],
    ['hangs', () => new Promise(() => undefined), false],
    ['empty', () => Promise.resolve({}), false],
    [
      'blank without origin',
      () => Promise.resolve({ frameTree: { frame: { id: 'MAIN', url: 'about:blank' } } }),
      false,
    ],
  ];
  for (const [label, tree, attaches] of cases) {
    const { connection, api, cdp } = open();
    api.locations = new Map([[8, { url: 'https://other.test/' }]]);
    api.debugger.sendCommand = (target, method, params) => {
      api.sent.push({ tabId: target.tabId, method, params });
      if (method === 'Page.getFrameTree') return tree();
      return Promise.resolve({});
    };
    const answer = await command(cdp, connection, {
      id: 1,
      method: 'Target.attachToTarget',
      params: { targetId: '8', flatten: true },
    });
    if (attaches) {
      assert.deepEqual(answer.result, { sessionId: '8' }, label);
      assert.deepEqual(api.detached, [], label);
    } else {
      assert.equal(answer.error, refused, label);
      assert.deepEqual(api.detached, [8], label);
    }
    assert.equal(
      connection.posted.filter((m) => m.method === 'Target.detachedFromTarget').length,
      0,
      label
    );
    cdp.close();
  }
});

test('a child about: frame whose origin cannot be read is treated as protected', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  api.debugger.sendCommand = (target, method, params) => {
    api.sent.push({ tabId: target.tabId, method, params });
    if (method === 'Page.getFrameTree') {
      return Promise.resolve({
        frameTree: {
          frame: { id: 'MAIN', url: 'https://other.test/' },
          childFrames: [{ frame: { id: 'AD', parentId: 'MAIN', url: 'about:blank' } }],
        },
      });
    }
    return Promise.resolve({});
  };
  const attached = await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  assert.deepEqual(attached.result, { sessionId: '8' });
  const main = await command(cdp, connection, {
    id: 2,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
    sessionId: '8',
  });
  assert.equal(main.error, undefined);
  const child = await command(cdp, connection, {
    id: 3,
    method: 'Page.createIsolatedWorld',
    params: { frameId: 'AD' },
    sessionId: '8',
  });
  assert.equal(child.error, refused);
  cdp.close();
});

test('view-source and other wrappers of about: urls are refused before forwarding, after a control', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  const control = await command(cdp, connection, {
    id: 2,
    method: 'Page.navigate',
    params: { url: 'view-source:https://other.test/' },
    sessionId: '8',
  });
  assert.deepEqual(control.result, { value: 2 });
  let id = 3;
  for (const url of [
    'view-source:about:blank',
    ' VIEW-SOURCE:about:blank#x',
    'view-source:view-source:about:srcdoc',
    'blob:about:blank',
    'filesystem:about:blank',
  ]) {
    const answer = await command(cdp, connection, {
      id: id++,
      method: 'Page.navigate',
      params: { url },
      sessionId: '8',
    });
    assert.equal(
      answer.error,
      'slicc: refused: view-source and other wrappers of about: urls do not open',
      url
    );
  }
  const created = await command(cdp, connection, {
    id: id++,
    method: 'Target.createTarget',
    params: { url: 'view-source:about:blank' },
  });
  assert.equal(
    created.error,
    'slicc: refused: view-source and other wrappers of about: urls do not open'
  );
  assert.equal(api.created.length, 0);
  assert.equal(api.sent.filter((s) => s.method === 'Page.navigate').length, 1);
  cdp.close();
});

test('pending url, opener, and a later navigation stay off protected origins', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([
    [8, { url: 'https://seven.sliccy.ai/', pendingUrl: 'https://example.test/' }],
  ]);
  const masked = await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  assert.equal(masked.error, refused);
  assert.equal(api.attached.length, 0);
  api.locations = new Map([
    [8, { url: 'https://other.test/', pendingUrl: 'https://vault.sliccy.ai/x' }],
  ]);
  const pending = await command(cdp, connection, {
    id: 2,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  assert.equal(pending.error, refused);
  assert.equal(api.attached.length, 0);
  api.locations = new Map([[8, { url: 'about:blank' }]]);
  const bare = await command(cdp, connection, {
    id: 3,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  assert.deepEqual(bare.result, { sessionId: '8' });
  await command(cdp, connection, {
    id: 4,
    method: 'Target.detachFromTarget',
    params: { sessionId: '8' },
  });
  api.locations = new Map([[8, { url: 'about:blank', openerTabId: 7 }]]);
  const inherited = await command(cdp, connection, {
    id: 3,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  assert.equal(inherited.error, refused);
  assert.equal(api.attached.length, 1);
  api.locations = new Map([[11, { url: 'about:blank', openerTabId: 8 }]]);
  const clear = await command(cdp, connection, {
    id: 4,
    method: 'Target.attachToTarget',
    params: { targetId: '11', flatten: true },
  });
  assert.deepEqual(clear.result, { sessionId: '11' });
  await command(cdp, connection, {
    id: 5,
    method: 'Target.closeTarget',
    params: { targetId: '11' },
  });
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  const attached = await command(cdp, connection, {
    id: 6,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  assert.deepEqual(attached.result, { sessionId: '8' });
  api.fire(8, 'Page.frameNavigated', {
    frame: { url: 'https://seven.sliccy.ai/play' },
  });
  assert.equal(
    connection.posted.some((message) => message.method === 'Page.frameNavigated'),
    false
  );
  assert.equal(connection.posted.at(-1).method, 'Target.detachedFromTarget');
  assert.equal(api.detached.at(-1), 8);
  const later = await command(cdp, connection, {
    id: 7,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
    sessionId: '8',
  });
  assert.match(later.error, /No tab attached/);
  assert.equal(user(api).length, 0);
  api.fire(8, 'Runtime.consoleAPICalled', { type: 'log' });
  assert.equal(
    connection.posted.some((message) => message.method === 'Runtime.consoleAPICalled'),
    false
  );
  const again = await command(cdp, connection, {
    id: 8,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  assert.deepEqual(again.result, { sessionId: '8' });
  const held = api.detached.length;
  api.fire(8, 'Network.requestWillBeSent', {
    type: 'XHR',
    request: { url: 'https://vault.sliccy.ai/oauth/token' },
  });
  api.fire(8, 'Network.requestWillBeSent', {
    requestId: 'n1',
    type: 'XHR',
    request: { url: 'https://other.test/ok' },
  });
  assert.equal(connection.posted.at(-1).method, 'Network.requestWillBeSent');
  assert.equal(connection.posted.at(-1).params.request.url, 'https://other.test/ok');
  assert.equal(
    connection.posted.filter((message) => message.method === 'Network.requestWillBeSent').length,
    1
  );
  assert.equal(api.detached.length, held);
  api.fire(8, 'Fetch.requestPaused', {
    requestId: 'interception-1',
    resourceType: 'Document',
    request: { url: 'https://vault.sliccy.ai/' },
  });
  await cdp.settled();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(api.sent.at(-1), {
    tabId: 8,
    method: 'Fetch.failRequest',
    params: { requestId: 'interception-1', errorReason: 'BlockedByClient' },
  });
  assert.equal(
    connection.posted.some((message) => message.method === 'Fetch.requestPaused'),
    false
  );
  assert.equal(api.detached.length, held, 'the session stays');
  api.locations = new Map([
    [8, { url: 'https://other.test/', pendingUrl: 'https://seven.sliccy.ai/' }],
  ]);
  const pendingNow = await command(cdp, connection, {
    id: 9,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
    sessionId: '8',
  });
  assert.equal(pendingNow.error, refused, 'commands wait out a pending protected navigation');
  api.visit(8, { url: 'https://seven.sliccy.ai/' });
  assert.equal(connection.posted.at(-1).method, 'Target.detachedFromTarget');
  const moved = await command(cdp, connection, {
    id: 10,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
    sessionId: '8',
  });
  assert.match(moved.error, /No tab attached/);
  cdp.close();
});

async function sevenTab(page) {
  const ext = await openExtensionPage(page, 'secrets.html');
  try {
    return await ext.until(
      'chrome.tabs.query({}).then((tabs) => tabs.filter((tab) => (tab.url || "").startsWith("https://seven.sliccy.ai/")).map((tab) => String(tab.id))[0])'
    );
  } finally {
    await ext.close();
  }
}

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

test('a sliccy.ai page can list and open targets, and flatten is required', async (t) => {
  const page = await chrome.visit(t, slicc);
  const listed = await page.evaluate(async () => {
    const { targetInfos } = await globalThis.sliccExtension.cdp.send('Target.getTargets');
    return {
      some: targetInfos.length > 0,
      seven: targetInfos.some((target) => target.url.startsWith('https://seven.sliccy.ai/')),
    };
  });
  assert.deepEqual(listed, { some: true, seven: true });
  const seven = await sevenTab(page);
  assert.match(seven, /^\d+$/);
  const rejected = await page.evaluate(async (targetId) => {
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
  }, seven);
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
      url: 'https://other.test/',
    });
    try {
      const attached = await globalThis.sliccExtension.cdp.send('Target.attachToTarget', {
        targetId: created.targetId,
        flatten: true,
      });
      let evaluated;
      let missed;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          evaluated = await globalThis.sliccExtension.cdp.send(
            'Runtime.evaluate',
            { expression: '1+1', returnByValue: true },
            attached.sessionId
          );
          break;
        } catch (error) {
          missed = error;
          if (!String(error.message).includes('execution context')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      if (!evaluated) throw missed;
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
  const scoped = answer.events.filter((event) => !event.method.startsWith('Target.'));
  assert.equal(scoped.length > 0, true);
  assert.equal(
    scoped.every((event) => event.sessionId === answer.attached.sessionId),
    true
  );
});

test('a sliccy.ai page cannot open or attach to seven or the vault', async (t) => {
  const page = await chrome.visit(t, slicc);
  const seven = await sevenTab(page);
  assert.match(seven, /^\d+$/);
  const answer = await page.evaluate(
    async ({ refused, targetId, errorPage }) => {
      const fail = async (method, params, sessionId) => {
        try {
          await globalThis.sliccExtension.cdp.send(method, params, sessionId);
          return 'ran';
        } catch (error) {
          return error.message;
        }
      };
      const attached = await fail('Target.attachToTarget', { targetId, flatten: true });
      const vault = await fail('Target.createTarget', { url: 'https://vault.sliccy.ai/' });
      const blank = await globalThis.sliccExtension.cdp.send('Target.createTarget', {
        url: 'about:blank',
      });
      const blankOk = typeof blank.targetId === 'string';
      await globalThis.sliccExtension.cdp
        .send('Target.closeTarget', { targetId: blank.targetId })
        .catch(() => undefined);
      const created = await globalThis.sliccExtension.cdp.send('Target.createTarget', {
        url: 'https://other.test/',
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
      const hopped = await globalThis.sliccExtension.cdp.send('Target.createTarget', {
        url: 'https://other.test/',
      });
      const hoppedSession = await globalThis.sliccExtension.cdp.send('Target.attachToTarget', {
        targetId: hopped.targetId,
        flatten: true,
      });
      const seen = [];
      globalThis.sliccExtension.cdp.on((event) => seen.push(event));
      const href = (expression) =>
        globalThis.sliccExtension.cdp
          .send('Runtime.evaluate', { expression, returnByValue: true }, hoppedSession.sessionId)
          .then(
            (r) => r.result?.value,
            (error) => `error ${error.message}`
          );
      const loaded = 'https://other.test/ complete';
      let ready = '';
      for (let attempt = 0; attempt < 200 && ready !== loaded; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50));
        ready = await href('`${location.href} ${document.readyState}`');
      }
      if (ready !== loaded) throw new Error(`not loaded: ${ready}`);
      await href('location.href = "https://seven.sliccy.ai/"');
      const hops = [];
      for (let attempt = 0; attempt < 200 && hops.at(-1) !== errorPage; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50));
        hops.push(await href('location.href'));
      }
      await globalThis.sliccExtension.cdp
        .send('Target.closeTarget', { targetId: hopped.targetId })
        .catch(() => undefined);
      return {
        attached,
        vault,
        blankOk,
        navigated,
        hops,
        leaked: seen.some((event) => JSON.stringify(event).includes('seven.sliccy.ai')),
      };
    },
    { refused, targetId: seven, errorPage: 'chrome-error://chromewebdata/' }
  );
  assert.equal(answer.attached, refused);
  assert.equal(answer.vault, refused);
  assert.equal(answer.blankOk, true);
  assert.equal(answer.navigated, refused);
  assert.equal(answer.leaked, false);
  assert.equal(answer.hops.at(-1), 'chrome-error://chromewebdata/', 'the hop fails at the request');
  assert.deepEqual(
    answer.hops.filter(
      (href) =>
        href !== 'https://other.test/' &&
        href !== 'chrome-error://chromewebdata/' &&
        href !== `error ${refused}`
    ),
    [],
    'the session stays and seven never commits'
  );
});

test('vault-feature-x gets no extension scripts (B24-4)', async (t) => {
  const page = await chrome.visit(t, 'https://vault-feature-x.sliccy.ai/');
  assert.equal(
    await page.evaluate(() => 'sliccExtension' in globalThis),
    false,
    'vault-feature-x must not have sliccExtension'
  );
});

test('createTarget about:blank succeeds and creates a real tab (S7-1)', async () => {
  const { connection, api, cdp } = open();
  const blank = await command(cdp, connection, {
    id: 1,
    method: 'Target.createTarget',
    params: { url: 'about:blank' },
  });
  assert.ok(blank.result?.targetId);
  assert.deepEqual(api.created, [{ url: 'about:blank', active: false }]);
  const empty = await command(cdp, connection, {
    id: 2,
    method: 'Target.createTarget',
    params: {},
  });
  assert.ok(empty.result?.targetId);
  cdp.close();
});

test('securityOrigin in Page.frameNavigated triggers detach (S7-1)', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  api.fire(8, 'Page.frameNavigated', {
    frame: { id: 'f1', url: 'https://vault.sliccy.ai/', securityOrigin: 'https://vault.sliccy.ai' },
  });
  await cdp.settled();
  assert.equal(connection.posted.at(-1).method, 'Target.detachedFromTarget');
  cdp.close();
});

test('Runtime.executionContextCreated with protected origin triggers detach (S7-1)', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  api.fire(8, 'Page.frameNavigated', {
    frame: { id: 'main-frame-1', url: 'https://other.test/', securityOrigin: 'https://other.test' },
  });
  await cdp.settled();
  api.fire(8, 'Runtime.executionContextCreated', {
    context: {
      id: 1,
      origin: 'https://vault.sliccy.ai',
      auxData: { isDefault: true, frameId: 'main-frame-1' },
    },
  });
  await cdp.settled();
  assert.equal(connection.posted.at(-1).method, 'Target.detachedFromTarget');
  cdp.close();
});

test('a protected iframe does not detach the tab (Codex P2)', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  api.fire(8, 'Page.frameNavigated', {
    frame: { id: 'main-frame-1', url: 'https://other.test/', securityOrigin: 'https://other.test' },
  });
  await cdp.settled();
  api.fire(8, 'Runtime.executionContextCreated', {
    context: {
      id: 2,
      origin: 'https://vault.sliccy.ai',
      auxData: { isDefault: true, frameId: 'iframe-1' },
    },
  });
  await cdp.settled();
  const last = connection.posted.at(-1);
  assert.notEqual(
    last.method,
    'Target.detachedFromTarget',
    'iframe context must not detach the tab'
  );
  const eval1 = await command(cdp, connection, {
    id: 2,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
    sessionId: '8',
  });
  assert.deepEqual(eval1.result, { value: 2 });
  cdp.close();
});

test('a session answers its own held ordinary requests while its tab heads to a protected url, and nothing else', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  await command(cdp, connection, {
    id: 2,
    method: 'Fetch.enable',
    params: { patterns: [{ urlPattern: '*' }] },
    sessionId: '8',
  });
  for (const requestId of ['r1', 'r2']) {
    api.fire(8, 'Fetch.requestPaused', {
      requestId,
      resourceType: 'Ping',
      request: { url: `https://other.test/${requestId}` },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  api.locations.set(8, { url: 'https://other.test/', pendingUrl: 'https://vault.sliccy.ai/' });
  const evaluate = await command(cdp, connection, {
    id: 3,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
    sessionId: '8',
  });
  assert.equal(
    evaluate.error,
    refused,
    'other commands are refused while the tab heads to the vault'
  );
  const unknown = await command(cdp, connection, {
    id: 4,
    method: 'Fetch.continueRequest',
    params: { requestId: 'r9' },
    sessionId: '8',
  });
  assert.equal(unknown.error, refused, 'an unknown request id is not admitted');
  const held = await command(cdp, connection, {
    id: 5,
    method: 'Fetch.continueRequest',
    params: { requestId: 'r1' },
    sessionId: '8',
  });
  assert.equal(held.error, undefined, 'the held ordinary request is continued');
  assert.ok(
    api.sent.some(
      (sent) => sent.method === 'Fetch.continueRequest' && sent.params?.requestId === 'r1'
    ),
    'the continue reaches chrome'
  );
  api.locations.set(8, { url: 'https://vault.sliccy.ai/' });
  const committed = await command(cdp, connection, {
    id: 6,
    method: 'Fetch.continueRequest',
    params: { requestId: 'r2' },
    sessionId: '8',
  });
  assert.equal(committed.error, refused, 'a tab on a committed protected url is refused');
  assert.equal(
    api.sent.some(
      (sent) => sent.method === 'Fetch.continueRequest' && sent.params?.requestId === 'r2'
    ),
    false
  );
  cdp.close();
});

test('concurrent dispatch: awaitPromise evaluate does not deadlock with Fetch.continueRequest (S7-2)', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  await command(cdp, connection, {
    id: 2,
    method: 'Fetch.enable',
    params: { patterns: [{ urlPattern: '*' }] },
    sessionId: '8',
  });
  api.fire(8, 'Fetch.requestPaused', {
    requestId: 'r1',
    resourceType: 'XHR',
    request: { url: 'https://other.test/x' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(connection.posted.at(-1).method, 'Fetch.requestPaused');
  assert.equal(connection.posted.at(-1).sessionId, '8');
  let evalResolved = false;
  let fetchResolved = false;
  const evalPromise = new Promise((resolve) => {
    api.debugger.sendCommand = (target, method, params) => {
      api.sent.push({ tabId: target.tabId, method, params });
      if (method === 'Page.getFrameTree') return Promise.resolve(plainTree);
      if (method === 'Runtime.evaluate') {
        return new Promise((r) => {
          setTimeout(() => {
            evalResolved = true;
            r({ result: { value: 'done' } });
          }, 50);
        });
      }
      if (method === 'Fetch.continueRequest') {
        fetchResolved = true;
        return Promise.resolve({});
      }
      return Promise.resolve({ value: 2 });
    };
  });
  cdp.handle({
    id: 10,
    method: 'Runtime.evaluate',
    params: { expression: 'await fetch("/x")', awaitPromise: true },
    sessionId: '8',
  });
  cdp.handle({
    id: 11,
    method: 'Fetch.continueRequest',
    params: { requestId: 'r1' },
    sessionId: '8',
  });
  await cdp.settled();
  assert.equal(evalResolved, true);
  assert.equal(fetchResolved, true);
  cdp.close();
});

test('blob: and view-source: URLs over protected origins are refused in createTarget', async () => {
  const { connection, api, cdp } = open();
  for (const url of [
    'blob:https://vault.sliccy.ai/abc',
    'view-source:https://vault.sliccy.ai/',
    'blob:https://seven.sliccy.ai/xyz',
    'view-source:https://seven.sliccy.ai/page',
  ]) {
    const result = await command(cdp, connection, {
      id: 1,
      method: 'Target.createTarget',
      params: { url },
    });
    assert.equal(result.error, refused, `${url} should be refused`);
  }
  cdp.close();
});

async function tick() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function events(connection, method) {
  return connection.posted.filter((message) => message.method === method);
}

test('S7-3 Target.getTargetInfo reports type, url and openerId for every tab', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([
    [8, { url: 'https://other.test/', title: 'other', openerTabId: 11 }],
    [11, { url: 'https://example.test/' }],
  ]);
  const plain = await command(cdp, connection, {
    id: 1,
    method: 'Target.getTargetInfo',
    params: { targetId: '8' },
  });
  assert.deepEqual(plain.result.targetInfo, {
    targetId: '8',
    type: 'page',
    title: 'other',
    url: 'https://other.test/',
    attached: false,
    canAccessOpener: false,
    openerId: '11',
  });
  const blank = await command(cdp, connection, {
    id: 2,
    method: 'Target.getTargetInfo',
    params: { targetId: '11' },
  });
  assert.equal(blank.result.targetInfo.openerId, undefined);
  const seven = await command(cdp, connection, {
    id: 3,
    method: 'Target.getTargetInfo',
    params: { targetId: '7' },
  });
  assert.equal(
    seven.result.targetInfo.url,
    'https://seven.sliccy.ai/',
    'the guard sees the real url'
  );
  api.locations.set(12, { url: 'about:blank', openerTabId: 7 });
  const inherited = await command(cdp, connection, {
    id: 4,
    method: 'Target.getTargetInfo',
    params: { targetId: '12' },
  });
  assert.equal(inherited.result.targetInfo.openerId, '7', 'the guard sees the protected opener');
  const attach = await command(cdp, connection, {
    id: 7,
    method: 'Target.attachToTarget',
    params: { targetId: '12', flatten: true },
  });
  assert.equal(attach.error, refused);
  const browser = await command(cdp, connection, { id: 5, method: 'Target.getTargetInfo' });
  assert.equal(browser.result.targetInfo.type, 'browser');
  const version = await command(cdp, connection, { id: 6, method: 'Browser.getVersion' });
  assert.match(version.result.product, /^Chrome\//);
  assert.equal(version.result.protocolVersion, '1.3');
  cdp.close();
});

test('S7-3 setDiscoverTargets emits created, changed and destroyed, and detaches tabs that become protected', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/', title: 'other' }]]);
  const on = await command(cdp, connection, {
    id: 1,
    method: 'Target.setDiscoverTargets',
    params: { discover: true },
  });
  assert.deepEqual(on.result, {});
  assert.deepEqual(
    events(connection, 'Target.targetCreated').map((e) => e.params.targetInfo.targetId),
    ['7', '8']
  );
  api.born({ id: 20, url: '', pendingUrl: 'https://example.test/', openerTabId: 8 });
  api.born({ id: 21, url: '', pendingUrl: 'https://vault.sliccy.ai/' });
  await tick();
  const created = events(connection, 'Target.targetCreated')
    .map((e) => e.params.targetInfo)
    .sort((a, b) => Number(a.targetId) - Number(b.targetId));
  assert.deepEqual(
    created.map((info) => info.targetId),
    ['7', '8', '20', '21']
  );
  assert.equal(created[2].openerId, '8');
  assert.equal(created[3].url, 'https://vault.sliccy.ai/');
  api.visit(20, { url: 'https://example.test/a', title: 'a' });
  await tick();
  api.visit(20, { url: 'https://example.test/b', title: 'a' });
  await tick();
  assert.deepEqual(
    events(connection, 'Target.targetInfoChanged').map((e) => e.params.targetInfo.url),
    ['https://example.test/a', 'https://example.test/b']
  );
  await command(cdp, connection, {
    id: 2,
    method: 'Target.attachToTarget',
    params: { targetId: '20', flatten: true },
  });
  api.visit(20, { url: 'https://seven.sliccy.ai/x' });
  await tick();
  assert.equal(
    events(connection, 'Target.targetInfoChanged').at(-1).params.targetInfo.url,
    'https://seven.sliccy.ai/x'
  );
  assert.deepEqual(
    events(connection, 'Target.detachedFromTarget').map((e) => e.params.sessionId),
    ['20']
  );
  const after = await command(cdp, connection, {
    id: 4,
    method: 'Runtime.evaluate',
    params: {},
    sessionId: '20',
  });
  assert.match(after.error, /No tab attached/);
  api.gone(8);
  await tick();
  assert.deepEqual(
    events(connection, 'Target.targetDestroyed').map((e) => e.params.targetId),
    ['8']
  );
  await command(cdp, connection, {
    id: 3,
    method: 'Target.setDiscoverTargets',
    params: { discover: false },
  });
  api.born({ id: 22, url: 'https://example.test/' });
  await tick();
  assert.equal(events(connection, 'Target.targetCreated').length, 4);
  cdp.close();
});

test('S7-3 detachedFromTarget fires for every session when a tab closes or the backend drops it', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  const first = await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  const second = await command(cdp, connection, {
    id: 2,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  assert.notEqual(first.result.sessionId, second.result.sessionId);
  api.drop(8);
  assert.deepEqual(
    events(connection, 'Target.detachedFromTarget').map((e) => e.params.sessionId),
    [first.result.sessionId, second.result.sessionId]
  );
  const later = await command(cdp, connection, {
    id: 3,
    method: 'Runtime.evaluate',
    params: {},
    sessionId: second.result.sessionId,
  });
  assert.match(later.error, /No tab attached/);
  cdp.close();
});

test('shield refuses browser-wide, origin-keyed and protected-target commands', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  const before = user(api).length;
  let id = 10;
  for (const [method, params, sessionId] of [
    ['Target.exposeDevToolsProtocol', { targetId: '8' }],
    ['Target.sendMessageToTarget', { targetId: '8', message: '{}' }],
    ['Target.attachToBrowserTarget', {}],
    ['Target.setAutoAttach', { autoAttach: true, flatten: true }, '8'],
    ['Tracing.start', {}, '8'],
    ['Extensions.loadUnpacked', { path: '/x' }, '8'],
    ['Network.clearBrowserCookies', {}, '8'],
    ['Storage.clearCookies', {}, '8'],
    ['Browser.resetPermissions', {}, '8'],
    ['Browser.grantPermissions', { permissions: ['geolocation'] }, '8'],
    ['Security.setIgnoreCertificateErrors', { ignore: true }, '8'],
    ['Fetch.enable', {}],
    ['Target.activateTarget', { targetId: '7' }],
    ['Target.closeTarget', { targetId: '7' }],
    ['Storage.clearDataForOrigin', { origin: 'https://vault.sliccy.ai', storageTypes: 'all' }, '8'],
    ['Storage.getUsageAndQuota', { origin: 'https://seven.sliccy.ai' }, '8'],
    [
      'Storage.clearDataForStorageKey',
      { storageKey: 'https://vault.sliccy.ai/', storageTypes: 'all' },
      '8',
    ],
    [
      'DOMStorage.getDOMStorageItems',
      { storageId: { securityOrigin: 'https://vault.sliccy.ai', isLocalStorage: true } },
      '8',
    ],
    ['IndexedDB.requestDatabaseNames', { securityOrigin: 'https://seven.sliccy.ai' }, '8'],
    ['CacheStorage.requestCacheNames', { storageKey: 'https://seven.sliccy.ai/' }, '8'],
    [
      'Browser.setPermission',
      {
        permission: { name: 'geolocation' },
        setting: 'granted',
        origin: 'https://vault.sliccy.ai',
      },
      '8',
    ],
    ['Network.loadNetworkResource', { url: 'https://vault.sliccy.ai/x', options: {} }, '8'],
    ['Fetch.enable', { patterns: [{ urlPattern: '*://vault.sliccy.ai/*' }] }, '8'],
    ['Network.getResponseBody', { requestId: 'unknown' }, '8'],
    ['IO.read', { handle: 'h1' }, '8'],
    ['Fetch.fulfillRequest', { requestId: 'interception-job-9.0', responseCode: 200 }, '8'],
  ]) {
    const answer = await command(cdp, connection, { id: id++, method, params, sessionId });
    assert.match(answer.error ?? '', /^slicc: refused: /, `${method} ${JSON.stringify(params)}`);
  }
  assert.equal(user(api).length, before, 'nothing refused reached chrome.debugger');
  assert.deepEqual(api.removed, []);
  const plain = await command(cdp, connection, {
    id: id++,
    method: 'Storage.getUsageAndQuota',
    params: { origin: 'https://other.test' },
    sessionId: '8',
  });
  assert.equal(plain.error, undefined, 'the same command on an ordinary origin passes');
  cdp.close();
});

test('shield refuses protected cookie writes and filters protected cookies from reads', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  api.debugger.sendCommand = (target, method, params) => {
    api.sent.push({ tabId: target.tabId, method, params });
    if (method === 'Page.getFrameTree') return Promise.resolve(plainTree);
    if (method.endsWith('Cookies')) {
      return Promise.resolve({
        cookies: [
          { name: 'v', domain: 'vault.sliccy.ai' },
          { name: 's', domain: '.sliccy.ai' },
          { name: 'ok', domain: 'other.test' },
        ],
      });
    }
    return Promise.resolve({});
  };
  await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  let id = 2;
  for (const [method, params] of [
    ['Network.setCookie', { name: 'x', value: '1', url: 'https://vault.sliccy.ai/' }],
    ['Network.setCookie', { name: 'x', value: '1', domain: '.sliccy.ai' }],
    ['Network.setCookies', { cookies: [{ name: 'x', value: '1', domain: 'seven.sliccy.ai' }] }],
    ['Network.deleteCookies', { name: 'x', url: 'https://seven.sliccy.ai/' }],
    ['Storage.setCookies', { cookies: [{ name: 'x', value: '1', domain: 'vault.sliccy.ai' }] }],
    ['Page.deleteCookie', { cookieName: 'x', url: 'https://vault.sliccy.ai/' }],
  ]) {
    const answer = await command(cdp, connection, { id: id++, method, params, sessionId: '8' });
    assert.match(answer.error ?? '', /^slicc: refused: /, `${method} ${JSON.stringify(params)}`);
  }
  const set = await command(cdp, connection, {
    id: id++,
    method: 'Network.setCookie',
    params: { name: 'ok', value: '1', url: 'https://other.test/' },
    sessionId: '8',
  });
  assert.equal(set.error, undefined);
  for (const method of ['Network.getCookies', 'Network.getAllCookies', 'Storage.getCookies']) {
    const read = await command(cdp, connection, { id: id++, method, params: {}, sessionId: '8' });
    assert.deepEqual(read.result.cookies, [{ name: 'ok', domain: 'other.test' }], method);
  }
  for (const urls of [
    ['https://vault.sliccy.ai/'],
    ['https://vault.sliccy.ai/', 'https://seven.sliccy.ai/', 'https://other.test/'],
  ]) {
    const read = await command(cdp, connection, {
      id: id++,
      method: 'Network.getCookies',
      params: { urls },
      sessionId: '8',
    });
    assert.equal(read.error, undefined, `readers filter, never refuse: ${urls}`);
    assert.deepEqual(read.result.cookies, [{ name: 'ok', domain: 'other.test' }], `${urls}`);
  }
  cdp.close();
});

test('shield wraps init scripts so they throw on protected origins before client code', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  await command(cdp, connection, {
    id: 2,
    method: 'Page.addScriptToEvaluateOnNewDocument',
    params: { source: 'window.marker = 1;', runImmediately: true },
    sessionId: '8',
  });
  const sent = user(api).at(-1);
  assert.equal(sent.method, 'Page.addScriptToEvaluateOnNewDocument');
  assert.equal(sent.params.runImmediately, true);
  assert.ok(sent.params.source.endsWith('\nwindow.marker = 1;'));
  assert.ok(sent.params.source.startsWith('if ((function () {'));
  assert.match(sent.params.source, /throw "slicc: refused: init script on a protected origin"/);
  cdp.close();
});

test('shield owns Fetch: protected requests never reach the client, client patterns chain across sessions', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  const second = (
    await command(cdp, connection, {
      id: 2,
      method: 'Target.attachToTarget',
      params: { targetId: '8', flatten: true },
    })
  ).result.sessionId;
  api.fire(8, 'Page.frameNavigated', { frame: { id: 'main', url: 'https://other.test/' } });
  await command(cdp, connection, {
    id: 3,
    method: 'Fetch.enable',
    params: { patterns: [{ urlPattern: '*', resourceType: 'Document' }] },
    sessionId: '8',
  });
  await command(cdp, connection, {
    id: 4,
    method: 'Fetch.enable',
    params: { patterns: [{ urlPattern: 'https://other.test/*' }] },
    sessionId: second,
  });
  assert.deepEqual(api.sent.filter((s) => s.method === 'Fetch.enable').at(-1).params, {
    patterns: [
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
      { urlPattern: '*', resourceType: 'Document' },
      { urlPattern: 'https://other.test/*' },
    ],
    handleAuthRequests: false,
  });
  api.fire(8, 'Fetch.requestPaused', {
    requestId: 'i1',
    frameId: 'main',
    resourceType: 'Document',
    request: { url: 'https://other.test/next' },
  });
  await tick();
  assert.deepEqual(
    events(connection, 'Fetch.requestPaused').map((e) => [e.params.requestId, e.sessionId]),
    [['i1', '8']]
  );
  const forged = await command(cdp, connection, {
    id: 5,
    method: 'Fetch.continueRequest',
    params: { requestId: 'i1' },
    sessionId: second,
  });
  assert.match(forged.error, /^slicc: refused: /, 'only the owner answers');
  await command(cdp, connection, {
    id: 6,
    method: 'Fetch.continueRequest',
    params: { requestId: 'i1' },
    sessionId: '8',
  });
  assert.deepEqual(
    events(connection, 'Fetch.requestPaused').map((e) => [e.params.requestId, e.sessionId]),
    [
      ['i1', '8'],
      ['i1', second],
    ]
  );
  assert.equal(
    user(api).some((s) => s.method === 'Fetch.continueRequest'),
    false
  );
  await command(cdp, connection, {
    id: 7,
    method: 'Fetch.continueRequest',
    params: { requestId: 'i1' },
    sessionId: second,
  });
  assert.deepEqual(user(api).at(-1), {
    tabId: 8,
    method: 'Fetch.continueRequest',
    params: { requestId: 'i1' },
  });
  api.fire(8, 'Fetch.requestPaused', {
    requestId: 'i2',
    frameId: 'main',
    resourceType: 'XHR',
    request: { url: 'https://vault.sliccy.ai/api' },
  });
  api.fire(8, 'Fetch.requestPaused', {
    requestId: 'i4',
    frameId: 'main',
    resourceType: 'Image',
    request: { url: 'https://cdn.test/a.png' },
  });
  await tick();
  assert.deepEqual(
    user(api)
      .slice(-2)
      .map((s) => [s.method, s.params]),
    [
      ['Fetch.continueRequest', { requestId: 'i2' }],
      ['Fetch.continueRequest', { requestId: 'i4' }],
    ]
  );
  assert.equal(events(connection, 'Fetch.requestPaused').length, 2);
  assert.equal(events(connection, 'Target.detachedFromTarget').length, 0);
  api.fire(8, 'Fetch.requestPaused', {
    requestId: 'i3',
    frameId: 'child',
    resourceType: 'Document',
    request: { url: 'https://seven.sliccy.ai/frame' },
  });
  api.fire(8, 'Fetch.requestPaused', {
    requestId: 'i5',
    frameId: 'main',
    resourceType: 'Document',
    redirectedRequestId: 'i1',
    request: { url: 'https://vault.sliccy.ai/' },
  });
  await tick();
  assert.deepEqual(
    user(api)
      .slice(-2)
      .map((s) => [s.method, s.params]),
    [
      ['Fetch.failRequest', { requestId: 'i3', errorReason: 'BlockedByClient' }],
      ['Fetch.failRequest', { requestId: 'i5', errorReason: 'BlockedByClient' }],
    ]
  );
  assert.deepEqual(api.detached, [], 'the tab and its sessions stay');
  assert.equal(events(connection, 'Target.detachedFromTarget').length, 0);
  assert.equal(events(connection, 'Fetch.requestPaused').length, 2);
  cdp.close();
});

test('shield fails a redirect hop into a protected origin before it commits', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  await command(cdp, connection, {
    id: 2,
    method: 'Fetch.enable',
    params: { patterns: [{ urlPattern: '*' }] },
    sessionId: '8',
  });
  api.fire(8, 'Fetch.requestPaused', {
    requestId: 'r1',
    resourceType: 'Document',
    request: { url: 'https://other.test/redirect' },
  });
  await tick();
  await command(cdp, connection, {
    id: 3,
    method: 'Fetch.continueRequest',
    params: { requestId: 'r1' },
    sessionId: '8',
  });
  api.fire(8, 'Fetch.requestPaused', {
    requestId: 'r2',
    resourceType: 'Document',
    redirectedRequestId: 'r1',
    request: { url: 'https://vault.sliccy.ai/landing?k=SECRET' },
  });
  await tick();
  assert.deepEqual(api.detached, []);
  assert.deepEqual(user(api).at(-1), {
    tabId: 8,
    method: 'Fetch.failRequest',
    params: { requestId: 'r2', errorReason: 'BlockedByClient' },
  });
  assert.deepEqual(
    events(connection, 'Fetch.requestPaused').map((e) => e.params.requestId),
    ['r1']
  );
  assert.equal(JSON.stringify(connection.posted).includes('SECRET'), false);
  cdp.close();
});

test('shield hides protected network events, holds ExtraInfo until classified, and drops child sessions', async () => {
  const { connection, api, cdp } = open();
  api.locations = new Map([[8, { url: 'https://other.test/' }]]);
  await command(cdp, connection, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '8', flatten: true },
  });
  api.fire(8, 'Network.requestWillBeSentExtraInfo', {
    requestId: 'n1',
    associatedCookies: [{ cookie: { name: 'v', domain: 'vault.sliccy.ai' } }],
  });
  api.fire(8, 'Network.requestWillBeSentExtraInfo', { requestId: 'n2', headers: {} });
  assert.equal(events(connection, 'Network.requestWillBeSentExtraInfo').length, 0);
  api.fire(8, 'Network.requestWillBeSent', {
    requestId: 'n1',
    type: 'XHR',
    request: { url: 'https://vault.sliccy.ai/x' },
  });
  api.fire(8, 'Network.responseReceived', {
    requestId: 'n1',
    response: { url: 'https://vault.sliccy.ai/x' },
  });
  api.fire(8, 'Network.loadingFinished', { requestId: 'n1' });
  api.fire(8, 'Network.requestWillBeSent', {
    requestId: 'n2',
    type: 'XHR',
    request: { url: 'https://other.test/y' },
  });
  api.fire(8, 'Network.requestWillBeSent', {
    requestId: 'n3',
    type: 'Script',
    documentURL: 'https://other.test/',
    initiator: { type: 'script', url: 'https://seven.sliccy.ai/x.js' },
    request: { url: 'https://cdn.test/z.js' },
  });
  api.fire(8, 'Runtime.consoleAPICalled', { args: [{ value: 'https://vault.sliccy.ai/leak' }] });
  api.child(8, 'child-1', 'Runtime.consoleAPICalled', { args: [] });
  const ids = connection.posted
    .filter((m) => m.method?.startsWith('Network.'))
    .map((m) => [m.method, m.params.requestId]);
  assert.deepEqual(ids, [
    ['Network.requestWillBeSent', 'n2'],
    ['Network.requestWillBeSentExtraInfo', 'n2'],
  ]);
  assert.equal(events(connection, 'Runtime.consoleAPICalled').length, 0);
  const body = await command(cdp, connection, {
    id: 2,
    method: 'Network.getResponseBody',
    params: { requestId: 'n1' },
    sessionId: '8',
  });
  assert.equal(body.error, refused);
  const initiated = await command(cdp, connection, {
    id: 3,
    method: 'Network.getResponseBody',
    params: { requestId: 'n3' },
    sessionId: '8',
  });
  assert.equal(initiated.error, refused);
  const allowed = await command(cdp, connection, {
    id: 4,
    method: 'Network.getResponseBody',
    params: { requestId: 'n2' },
    sessionId: '8',
  });
  assert.equal(allowed.error, undefined);
  cdp.close();
});
