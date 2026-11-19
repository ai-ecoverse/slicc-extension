import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { listen } from '../../extension/cdp.js';

const ERROR_PAGE = 'chrome-error://chromewebdata/';
const failed = 'https://vault.sliccy.ai/controller/FAKEATTACH?q=FAKEATTACH';
const ordinary = 'https://ordinary.test/start';
const ordinaryFailed = 'https://ordinary.test/missing';
const refusal = /^slicc: refused:/;
const event = () => {
  const fns = new Set();
  return {
    addListener: (f) => fns.add(f),
    removeListener: (f) => fns.delete(f),
    fns,
  };
};

globalThis.chrome = {
  webNavigation: { getAllFrames: async () => [] },
  storage: { session: { get: async () => ({}), set: async () => {} } },
  runtime: { id: 'fx' },
};

const bundled = await build({
  entryPoints: ['six/extension/bridge-sw.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  define: { __SLICC_EXT_DEV__: 'false' },
});
const six = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function errorTree(unreachable) {
  const frame = {
    id: 'ROOT',
    loaderId: 'L1',
    url: ERROR_PAGE,
    securityOrigin: '://',
    mimeType: 'text/html',
  };
  if (unreachable !== undefined) frame.unreachableUrl = unreachable;
  return { frameTree: { frame } };
}

async function sevenAttach(reads, opts = {}) {
  let n = 0;
  const forwarded = [];
  const published = [];
  const detached = [];
  const tree = opts.tree ?? errorTree(opts.unreachable ?? failed);
  const api = {
    tabs: {
      get: async (id) => {
        if (id !== 1) return { id, url: ordinary, status: 'complete' };
        n += 1;
        return { id, ...reads(n) };
      },
      query: async () => [{ id: 1, ...reads(99) }],
      onUpdated: event(),
      onCreated: event(),
      onRemoved: event(),
      onActivated: event(),
    },
    windows: { onRemoved: event() },
    webNavigation: {
      getAllFrames: async () => [
        {
          frameId: 0,
          parentFrameId: -1,
          url: opts.navUrl ?? failed,
          errorOccurred: true,
          documentId: 'D',
          documentLifecycle: 'active',
        },
      ],
      getFrame: async () => ({ errorOccurred: true, url: opts.navUrl ?? failed }),
      onCreatedNavigationTarget: event(),
      onCommitted: event(),
    },
    debugger: {
      onEvent: event(),
      onDetach: event(),
      attach: async () => {},
      detach: async () => {
        detached.push(1);
      },
      sendCommand: async (_t, method, params) => {
        forwarded.push(method);
        if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree') {
          if (opts.treeError) throw new Error(opts.treeError);
          return typeof tree === 'function' ? tree(forwarded) : tree;
        }
        if (method === 'Page.getNavigationHistory') {
          return {
            currentIndex: 0,
            entries: [{ id: 1, url: ordinary, title: 'start' }],
          };
        }
        if (method === 'Runtime.evaluate') {
          return { result: { type: 'string', value: 'ok' } };
        }
        if (method === 'DOM.getDocument') {
          return { root: { nodeId: 1, documentURL: ERROR_PAGE, children: [] } };
        }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
        return {};
      },
    },
  };
  const conn = listen(
    {
      name: 'slicc-fetch',
      sender: { id: 'fx', url: 'https://seven.sliccy.ai/', origin: 'https://seven.sliccy.ai' },
      onDisconnect: event(),
      postMessage: (m) => published.push(m),
    },
    'fx',
    api
  );
  if (opts.failedRecord) conn.state.failed.set(1, failed.split('#')[0]);
  let attach;
  try {
    attach = { sessionId: (await conn.attach({ targetId: '1', flatten: true })).sessionId };
  } catch (e) {
    attach = { error: String(e.message) };
  }
  const announced = published.filter((m) => m.method === 'Target.attachedToTarget');
  const detaches = published.filter((m) => m.method === 'Target.detachedFromTarget');
  const out = {
    attach,
    announced,
    detaches,
    forwarded,
    detached,
    sessions: [...conn.state.sessions.keys()],
    tabs: [...conn.state.tabs.keys()],
    owned: [...conn.state.ownedTabs],
  };
  if (attach.sessionId) {
    const before = forwarded.length;
    await conn.run({
      id: 42,
      method: 'Page.getFrameTree',
      params: {},
      sessionId: attach.sessionId,
    });
    out.follow = {
      forwarded: forwarded.slice(before),
      reply: published.findLast((m) => m.id === 42),
    };
  } else if (opts.followRaw) {
    const before = forwarded.length;
    await api.debugger.sendCommand({ tabId: 1 }, 'Page.getFrameTree', {});
    out.follow = { forwarded: forwarded.slice(before) };
  }
  conn.close();
  return out;
}

async function sixAttach(reads, opts = {}) {
  six.__clearTabShieldsForTest();
  six.__clearWelcomedLeaderPortsForTest();
  let n = 0;
  const forwarded = [];
  const published = [];
  const detached = [];
  const listeners = { msg: new Set(), disc: new Set() };
  const tree = opts.tree ?? errorTree(opts.unreachable ?? failed);
  const port = {
    name: 'slicc.cdp-bridge',
    sender: {
      origin: 'https://www.sliccy.ai',
      url: 'https://www.sliccy.ai/?slicc=leader',
      tab: { id: 99 },
      frameId: 0,
      documentId: 'doc',
    },
    onMessage: {
      addListener: (f) => listeners.msg.add(f),
      removeListener: (f) => listeners.msg.delete(f),
    },
    onDisconnect: {
      addListener: (f) => listeners.disc.add(f),
      removeListener: () => {},
    },
    postMessage: (m) => published.push(m),
    disconnect: () => {},
  };
  const deps = six.buildDefaultBridgeSwDeps({
    readStoredLeaderTabId: async () => 99,
    readLeaderKind: async () => 'six',
    isLeaderDocument: async () => true,
    tabHasProtectedFrame: async () => false,
    attachDebugger: async () => true,
    detachDebugger: async () => {
      detached.push(1);
    },
    subscribeDebuggerEvents: () => () => {},
    queryTabs: async () => [{ id: 1, ...reads(99) }],
    queryActiveTabId: async () => 1,
    getTab: async (id) => {
      if (id !== 1) return { id, url: ordinary, status: 'complete' };
      n += 1;
      return { id, ...reads(n) };
    },
    sendDebuggerCommand: async (_tab, method, params) => {
      forwarded.push(method);
      if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree') {
        if (opts.treeError) throw new Error(opts.treeError);
        return typeof tree === 'function' ? tree(forwarded) : tree;
      }
      if (method === 'Page.getNavigationHistory') {
        return { currentIndex: 0, entries: [{ id: 1, url: ordinary, title: 'start' }] };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { type: 'string', value: 'ok' } };
      }
      if (method === 'DOM.getDocument') {
        return { root: { nodeId: 1, documentURL: ERROR_PAGE, children: [] } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
      return {};
    },
  });
  if (opts.failedRecord) six.__noteFailedForTest(1, failed);
  await six.handleBridgePortConnect(port, deps);
  const send = async (raw) => {
    for (const f of listeners.msg) f(raw);
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 2));
      const reply = published.find((m) => m.kind === 'cdp.response' && m.id === raw.id);
      if (reply) return reply;
    }
    return { timeout: true };
  };
  await send({ bridge: 1, channelId: 'c', kind: 'handshake.hello' });
  await new Promise((r) => setTimeout(r, 10));
  let id = 0;
  const cdp = (method, params = {}, sessionId) =>
    send({
      bridge: 1,
      channelId: 'c',
      kind: 'cdp.request',
      id: ++id,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    });
  const a = await cdp('Target.attachToTarget', { targetId: '1', flatten: true });
  const attach = a.error
    ? { error: typeof a.error === 'string' ? a.error : (a.error.message ?? String(a.error)) }
    : a.result;
  const announced = published.filter((m) => m.method === 'Target.attachedToTarget');
  const detaches = published.filter((m) => m.method === 'Target.detachedFromTarget');
  const out = {
    attach,
    announced,
    detaches,
    forwarded,
    detached,
  };
  const sessionId = attach?.sessionId;
  if (sessionId) {
    const before = forwarded.length;
    const reply = await cdp('Page.getFrameTree', {}, sessionId);
    out.follow = { forwarded: forwarded.slice(before), reply };
  } else {
    const ghost = await cdp('Page.getFrameTree', {}, '1');
    out.ghost = ghost.error?.message ?? ghost.error ?? ghost;
  }
  for (const f of listeners.disc) f();
  six.__clearTabShieldsForTest();
  return out;
}

function assertRefused(out) {
  assert.match(out.attach.error ?? '', refusal);
  assert.equal(out.announced.length, 0);
  assert.equal(out.detaches.length, 0);
  assert.ok(out.forwarded.includes('Fetch.disable') || out.detached.length > 0);
  assert.ok(!out.forwarded.includes('Fetch.enable') || out.forwarded.includes('Fetch.disable'));
  if (out.forwarded.includes('Fetch.enable')) {
    assert.ok(out.forwarded.includes('Fetch.disable'));
    assert.ok(out.detached.length > 0);
  }
}

function assertAttached(out, title) {
  assert.equal(typeof out.attach.sessionId, 'string');
  assert.equal(out.announced.length, 1);
  if (title !== undefined) assert.equal(out.announced[0].params.targetInfo.title, title);
}

for (const transport of ['seven', 'six-bridge']) {
  const run = transport === 'seven' ? sevenAttach : sixAttach;

  test(`${transport}: lagging ordinary url with protected error root is refused`, async () => {
    const out = await run(() => ({ url: ordinary, title: 'start', status: 'loading' }));
    assertRefused(out);
    if (transport === 'seven') {
      assert.deepEqual(out.sessions, []);
      assert.deepEqual(out.tabs, []);
      assert.deepEqual(out.owned, []);
    }
  });

  test(`${transport}: lagging empty url with protected error root is refused`, async () => {
    const out = await run(() => ({
      url: '',
      title: '',
      status: 'loading',
      openerTabId: 2,
    }));
    assertRefused(out);
  });

  test(`${transport}: lagging first read only still refuses when tree is protected error`, async () => {
    const out = await run((n) =>
      n <= 1
        ? { url: ordinary, title: 'start', status: 'loading' }
        : { url: failed, title: 'vault.sliccy.ai', status: 'complete' }
    );
    assertRefused(out);
  });

  test(`${transport}: lagging for three reads still refuses`, async () => {
    const out = await run((n) =>
      n <= 3
        ? { url: ordinary, title: 'start', status: 'loading' }
        : { url: failed, title: 'vault.sliccy.ai', status: 'complete' }
    );
    assertRefused(out);
  });

  test(`${transport}: tab changing to protected between demand and announce is refused`, async () => {
    const ordinaryTree = {
      frameTree: {
        frame: {
          id: 'ROOT',
          loaderId: 'L1',
          url: ordinary,
          securityOrigin: 'https://ordinary.test',
          mimeType: 'text/html',
        },
      },
    };
    const hold = transport === 'seven' ? 1 : 3;
    const out = await run(
      (n) =>
        n <= hold
          ? { url: ordinary, title: 'start', status: 'complete' }
          : { url: failed, title: 'vault.sliccy.ai', status: 'complete' },
      { tree: ordinaryTree, navUrl: ordinary }
    );
    assertRefused(out);
  });

  test(`${transport}: missing unreachableUrl on error root is refused`, async () => {
    const out = await run(() => ({ url: ordinary, title: 'start', status: 'complete' }), {
      unreachable: undefined,
      tree: errorTree(undefined),
    });
    assertRefused(out);
  });

  test(`${transport}: unparseable unreachableUrl on error root is refused`, async () => {
    const out = await run(() => ({ url: ordinary, title: 'start', status: 'complete' }), {
      tree: errorTree('not a url'),
    });
    assertRefused(out);
  });

  test(`${transport}: unreadable frame tree is refused`, async () => {
    const out = await run(() => ({ url: ordinary, title: 'start', status: 'complete' }), {
      treeError: 'no tree',
    });
    assertRefused(out);
  });

  test(`${transport}: ordinary unreachableUrl on error root stays attachable with real title`, async () => {
    const title = 'Missing page';
    const out = await run(() => ({ url: ordinaryFailed, title, status: 'complete' }), {
      tree: errorTree(ordinaryFailed),
      navUrl: ordinaryFailed,
    });
    assertAttached(out, title);
    assert.equal(out.announced[0].params.targetInfo.url, ordinaryFailed);
  });

  test(`${transport}: guard-recorded failure still attaches the first client`, async () => {
    const out = await run(() => ({ url: failed, title: 'vault.sliccy.ai', status: 'complete' }), {
      failedRecord: true,
    });
    assertAttached(out);
    assert.equal(out.announced.length, 1);
  });

  test(`${transport}: refused attach leaves Fetch disabled and the tab usable`, async () => {
    const out = await run(() => ({ url: ordinary, title: 'start', status: 'loading' }), {
      followRaw: true,
    });
    assertRefused(out);
    assert.ok(out.forwarded.includes('Fetch.disable'));
    assert.ok(out.detached.length > 0);
    const enableAt = out.forwarded.indexOf('Fetch.enable');
    const disableAt = out.forwarded.indexOf('Fetch.disable');
    assert.ok(enableAt >= 0);
    assert.ok(disableAt > enableAt);
  });

  test(`${transport}: sign-in-marked failed URL is refused; plain stays attachable`, async () => {
    const title = 'Missing page';
    let deep = ' ';
    for (let i = 0; i < 12; i += 1) deep = encodeURIComponent(deep);
    for (const marked of [
      `${ordinaryFailed}?client_id=abc`,
      `${ordinaryFailed}?redirect_uri=https://app.test/cb`,
      `${ordinaryFailed}/auth/callback`,
      `${ordinaryFailed}?q=%E0%A4%A`,
      `${ordinaryFailed}?q=${deep}`,
    ]) {
      const out = await run(() => ({ url: marked, title, status: 'complete' }), {
        tree: errorTree(marked),
        navUrl: marked,
      });
      assertRefused(out);
    }
    const plain = await run(() => ({ url: ordinaryFailed, title, status: 'complete' }), {
      tree: errorTree(ordinaryFailed),
      navUrl: ordinaryFailed,
    });
    assertAttached(plain, title);
  });
}

test('seven: tab state gone after fresh re-read refuses cleanly', async () => {
  let conn;
  const forwarded = [];
  const detached = [];
  const published = [];
  const ordinaryTree = {
    frameTree: {
      frame: {
        id: 'ROOT',
        loaderId: 'L1',
        url: ordinary,
        securityOrigin: 'https://ordinary.test',
        mimeType: 'text/html',
      },
    },
  };
  let phase = 0;
  const api = {
    tabs: {
      get: async () => {
        phase += 1;
        if (phase >= 2 && conn) conn.state.tabs.delete(1);
        return { id: 1, url: ordinary, title: 'start', status: 'complete' };
      },
      query: async () => [],
      onUpdated: event(),
      onCreated: event(),
      onRemoved: event(),
      onActivated: event(),
    },
    windows: { onRemoved: event() },
    webNavigation: {
      getAllFrames: async () => [],
      getFrame: async () => ({ errorOccurred: false, url: ordinary }),
      onCreatedNavigationTarget: event(),
      onCommitted: event(),
    },
    debugger: {
      onEvent: event(),
      onDetach: event(),
      attach: async () => {},
      detach: async () => {
        detached.push(1);
      },
      sendCommand: async (_t, method) => {
        forwarded.push(method);
        if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree')
          return ordinaryTree;
        if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'ok' } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
        return {};
      },
    },
  };
  conn = listen(
    {
      name: 'slicc-fetch',
      sender: { id: 'fx', url: 'https://seven.sliccy.ai/', origin: 'https://seven.sliccy.ai' },
      onDisconnect: event(),
      postMessage: (m) => published.push(m),
    },
    'fx',
    api
  );
  await assert.rejects(
    () => conn.attach({ targetId: '1', flatten: true }),
    (error) => refusal.test(String(error?.message ?? error))
  );
  assert.equal(published.filter((m) => m.method === 'Target.attachedToTarget').length, 0);
  assert.ok(forwarded.includes('Fetch.disable'));
  assert.ok(detached.length > 0);
  assert.deepEqual([...conn.state.sessions.keys()], []);
  assert.deepEqual([...conn.state.tabs.keys()], []);
  assert.deepEqual([...conn.state.ownedTabs], []);
  conn.close();
});

test('six-bridge: non-owner abort leaves a live peer shield and session alone', async () => {
  for (const trigger of ['fresh', 'gone', 'shield']) {
    six.__clearTabShieldsForTest();
    six.__clearWelcomedLeaderPortsForTest();
    const forwarded = [];
    const detached = [];
    let attached = false;
    let bPhase = false;
    let bReads = 0;
    const live = { id: 1, url: ordinaryFailed, title: 'Missing page', status: 'complete' };
    const ordinaryTree = {
      frameTree: {
        frame: {
          id: 'ROOT',
          loaderId: 'L1',
          url: ordinaryFailed,
          securityOrigin: 'https://ordinary.test',
          mimeType: 'text/html',
        },
      },
    };
    const makePort = (doc) => {
      const listeners = { msg: new Set(), disc: new Set() };
      const published = [];
      const port = {
        name: 'slicc.cdp-bridge',
        sender: {
          origin: 'https://www.sliccy.ai',
          url: 'https://www.sliccy.ai/?slicc=leader',
          tab: { id: 99 },
          frameId: 0,
          documentId: doc,
        },
        onMessage: {
          addListener: (f) => listeners.msg.add(f),
          removeListener: (f) => listeners.msg.delete(f),
        },
        onDisconnect: {
          addListener: (f) => listeners.disc.add(f),
          removeListener: () => {},
        },
        postMessage: (m) => published.push(m),
        disconnect: () => {},
      };
      return { port, listeners, published };
    };
    const a = makePort('doc-a');
    const b = makePort('doc-b');
    const deps = six.buildDefaultBridgeSwDeps({
      readStoredLeaderTabId: async () => 99,
      readLeaderKind: async () => 'six',
      isLeaderDocument: async () => true,
      tabHasProtectedFrame: async () => trigger === 'shield' && bPhase,
      attachDebugger: async () => {
        if (attached) return false;
        attached = true;
        return true;
      },
      detachDebugger: async () => {
        detached.push(1);
      },
      subscribeDebuggerEvents: () => () => {},
      queryTabs: async () => [live],
      queryActiveTabId: async () => 1,
      getTab: async () => {
        if (!bPhase) return live;
        bReads += 1;
        if (trigger === 'gone' && bReads >= 3) return undefined;
        if (trigger === 'fresh' && bReads >= 3) {
          return { id: 1, url: failed, title: 'vault.sliccy.ai', status: 'complete' };
        }
        return live;
      },
      sendDebuggerCommand: async (_tab, method) => {
        forwarded.push(method);
        if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree')
          return ordinaryTree;
        if (method === 'Page.getNavigationHistory') {
          return {
            currentIndex: 0,
            entries: [{ id: 1, url: ordinaryFailed, title: 'Missing page' }],
          };
        }
        if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'ok' } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
        return {};
      },
    });
    const send = async (side, raw) => {
      for (const f of side.listeners.msg) f(raw);
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 2));
        const reply = side.published.find((m) => m.kind === 'cdp.response' && m.id === raw.id);
        if (reply) return reply;
      }
      return { timeout: true };
    };
    await six.handleBridgePortConnect(a.port, deps);
    await six.handleBridgePortConnect(b.port, deps);
    await send(a, { bridge: 1, channelId: 'ca', kind: 'handshake.hello' });
    await send(b, { bridge: 1, channelId: 'cb', kind: 'handshake.hello' });
    await new Promise((r) => setTimeout(r, 10));
    const aAttach = await send(a, {
      bridge: 1,
      channelId: 'ca',
      kind: 'cdp.request',
      id: 1,
      method: 'Target.attachToTarget',
      params: { targetId: '1', flatten: true },
    });
    assert.equal(typeof aAttach.result?.sessionId, 'string');
    assert.equal(six.__hasTabShieldForTest(1), true);
    const afterA = forwarded.filter((m) => m === 'Fetch.disable').length;
    const detachedAfterA = detached.length;
    bPhase = true;
    bReads = 0;
    const bAttach = await send(b, {
      bridge: 1,
      channelId: 'cb',
      kind: 'cdp.request',
      id: 2,
      method: 'Target.attachToTarget',
      params: { targetId: '1', flatten: true },
    });
    assert.ok(bAttach.error);
    assert.equal(six.__hasTabShieldForTest(1), true);
    assert.equal(forwarded.filter((m) => m === 'Fetch.disable').length, afterA);
    assert.equal(detached.length, detachedAfterA);
    const snap = six.__bridgePortSnapshotForTest(b.port);
    assert.deepEqual(snap?.sessions ?? ['missing'], []);
    assert.deepEqual(snap?.refs ?? ['missing'], []);
    assert.ok(!(snap?.owned ?? [1]).includes(1));
    for (const f of a.listeners.disc) f();
    for (const f of b.listeners.disc) f();
    six.__clearTabShieldsForTest();
  }
});
