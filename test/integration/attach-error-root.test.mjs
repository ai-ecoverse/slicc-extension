import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { listen } from '../../extension/cdp.js';
import { protectedOrigins } from '../../extension/protected.mjs';
import { protectedRules } from '../../extension/protected-rules.js';
import { redactProtected, strictGuard, urlProtected } from '../../extension/shield.js';

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
    fire: (...args) => {
      for (const f of fns) f(...args);
    },
    fns,
  };
};

globalThis.chrome = {
  webNavigation: { getAllFrames: async () => [] },
  storage: { session: { get: async () => ({}), set: async () => {} } },
  runtime: { id: 'fx' },
};

const guard = strictGuard(protectedOrigins(protectedRules), protectedRules);
const anyProtected = (text, options) => urlProtected(guard, text, options);

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
const shieldBundle = await build({
  entryPoints: ['six/extension/cdp-shield.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  define: { __SLICC_EXT_DEV__: 'false' },
});
const sixShield = await import(
  `data:text/javascript;base64,${Buffer.from(shieldBundle.outputFiles[0].text).toString('base64')}`
);

function errorTree(unreachable, opts = {}) {
  const frame = {
    id: opts.frameId ?? 'ROOT',
    loaderId: opts.loaderId ?? 'L1',
    url: ERROR_PAGE,
    securityOrigin: '://',
    mimeType: 'text/html',
  };
  if (opts.name !== undefined) frame.name = opts.name;
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
          const answer = typeof tree === 'function' ? tree(forwarded) : tree;
          if (opts.raceNavigated && method === 'Page.getFrameTree') {
            const trees = forwarded.filter((m) => m === 'Page.getFrameTree').length;
            if (trees === 1) {
              const d2 = errorTree(failed, { loaderId: 'L-race' }).frameTree.frame;
              queueMicrotask(() => {
                api.debugger.onEvent.fire({ tabId: 1 }, 'Page.frameNavigated', { frame: d2 });
              });
            }
          }
          return answer;
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
  if (opts.failedRecord) {
    const recorded = opts.failedRecordUrl ?? failed;
    conn.state.failed.set(1, recorded.split('#')[0]);
  }
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
  const debuggerHandlers = new Set();
  const deps = six.buildDefaultBridgeSwDeps({
    readStoredLeaderTabId: async () => 99,
    readLeaderKind: async () => 'six',
    isLeaderDocument: async () => true,
    tabHasProtectedFrame: async () => false,
    attachDebugger: async () => true,
    detachDebugger: async () => {
      detached.push(1);
    },
    subscribeDebuggerEvents: (handler) => {
      debuggerHandlers.add(handler);
      return () => debuggerHandlers.delete(handler);
    },
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
        const answer = typeof tree === 'function' ? tree(forwarded) : tree;
        if (opts.raceNavigated && method === 'Page.getFrameTree') {
          const trees = forwarded.filter((m) => m === 'Page.getFrameTree').length;
          if (trees === 2) {
            const d2 = errorTree(failed, { loaderId: 'L-race' }).frameTree.frame;
            queueMicrotask(() => {
              for (const handler of debuggerHandlers)
                handler(1, 'Page.frameNavigated', { frame: d2 });
            });
          }
        }
        return answer;
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
  if (opts.failedRecord) six.__noteFailedForTest(1, opts.failedRecordUrl ?? failed);
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
    assertAttached(out, '');
    assert.ok(!String(out.announced[0]?.params?.targetInfo?.title ?? '').includes('vault'));
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

  test(`${transport}: ordinary then protected failed load on the same tab is refused`, async () => {
    const out = await run(
      () => ({ url: ordinaryFailed, title: 'Missing page', status: 'complete' }),
      {
        tree: (forwarded) =>
          forwarded.includes('Runtime.enable')
            ? errorTree(failed, { loaderId: 'L-protected' })
            : errorTree(ordinaryFailed, { loaderId: 'L-ordinary' }),
        navUrl: ordinaryFailed,
        failedRecord: true,
        failedRecordUrl: ordinaryFailed,
      }
    );
    assertRefused(out);
    assert.ok(!out.announced.some((m) => m.params?.targetInfo?.title === 'vault.sliccy.ai'));
  });

  test(`${transport}: protected failed record then ordinary error root still attaches`, async () => {
    const title = 'Missing page';
    const out = await run(() => ({ url: ordinaryFailed, title, status: 'complete' }), {
      tree: errorTree(ordinaryFailed, { loaderId: 'L-ordinary' }),
      navUrl: ordinaryFailed,
      failedRecord: true,
      failedRecordUrl: failed,
    });
    assertAttached(out, title);
  });

  test(`${transport}: inventoried error root must still be the same document at announce`, async () => {
    const out = await run(
      () => ({ url: ordinaryFailed, title: 'Missing page', status: 'complete' }),
      {
        tree: (forwarded) =>
          forwarded.includes('Runtime.enable')
            ? errorTree(failed, { loaderId: 'L-protected' })
            : errorTree(ordinaryFailed, { loaderId: 'L-ordinary' }),
        navUrl: ordinaryFailed,
      }
    );
    assertRefused(out);
    assert.equal(out.announced.length, 0);
  });

  test(`${transport}: frameNavigated after inventory cannot widen a frozen attach root`, async () => {
    const d1 = errorTree(ordinaryFailed, { loaderId: 'L1' });
    const d2 = errorTree(failed, { loaderId: 'L-race' });
    const out = await run(
      () => ({ url: ordinaryFailed, title: 'Missing page', status: 'complete' }),
      {
        raceNavigated: true,
        tree: (forwarded) => {
          const trees = forwarded.filter(
            (m) => m === 'Page.getFrameTree' || m === 'Page.getResourceTree'
          ).length;
          if (transport === 'seven') return trees <= 1 ? d1 : d2;
          return trees <= 2 ? d1 : d2;
        },
        navUrl: ordinaryFailed,
      }
    );
    assertRefused(out);
    assert.equal(out.announced.length, 0);
    assert.ok(
      !out.announced.some((m) => String(m.params?.targetInfo?.title ?? '').includes('vault'))
    );
    assert.equal(d2.frameTree.frame.loaderId, 'L-race');
    assert.equal(d2.frameTree.frame.unreachableUrl, failed);
  });

  test(`${transport}: back-to-back navigation before announce refuses the stale inventory`, async () => {
    const out = await run(
      () => ({ url: ordinaryFailed, title: 'Missing page', status: 'complete' }),
      {
        tree: (forwarded) => {
          const trees = forwarded.filter(
            (m) => m === 'Page.getFrameTree' || m === 'Page.getResourceTree'
          ).length;
          return trees <= 1
            ? errorTree(ordinaryFailed, { loaderId: 'L1' })
            : errorTree(failed, { loaderId: 'L2' });
        },
        navUrl: ordinaryFailed,
      }
    );
    assertRefused(out);
    assert.equal(out.announced.length, 0);
  });

  test(`${transport}: failed record for another URL does not prove the current error root`, async () => {
    const out = await run(
      () => ({ url: ordinaryFailed, title: 'Missing page', status: 'complete' }),
      {
        tree: errorTree(failed, { loaderId: 'L-protected' }),
        navUrl: ordinaryFailed,
        failedRecord: true,
        failedRecordUrl: ordinaryFailed,
      }
    );
    assertRefused(out);
    assert.equal(out.announced.length, 0);
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

test('six-bridge: owner abort tears down even when a live session still uses the tab', async () => {
  six.__clearTabShieldsForTest();
  six.__clearWelcomedLeaderPortsForTest();
  const forwarded = [];
  const detached = [];
  const published = [];
  const listeners = { msg: new Set(), disc: new Set() };
  let phase = 'first';
  let reads = 0;
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
  const port = {
    name: 'slicc.cdp-bridge',
    sender: {
      origin: 'https://www.sliccy.ai',
      url: 'https://www.sliccy.ai/?slicc=leader',
      tab: { id: 99 },
      frameId: 0,
      documentId: 'doc-owner',
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
    queryTabs: async () => [live],
    queryActiveTabId: async () => 1,
    getTab: async () => {
      if (phase !== 'second') return live;
      reads += 1;
      if (reads >= 3) return { id: 1, url: failed, title: 'vault.sliccy.ai', status: 'complete' };
      return live;
    },
    sendDebuggerCommand: async (_tab, method) => {
      forwarded.push(method);
      if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree') return ordinaryTree;
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
  const send = async (raw) => {
    for (const f of listeners.msg) f(raw);
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 2));
      const reply = published.find((m) => m.kind === 'cdp.response' && m.id === raw.id);
      if (reply) return reply;
    }
    return { timeout: true };
  };
  await six.handleBridgePortConnect(port, deps);
  await send({ bridge: 1, channelId: 'c', kind: 'handshake.hello' });
  await new Promise((r) => setTimeout(r, 10));
  const first = await send({
    bridge: 1,
    channelId: 'c',
    kind: 'cdp.request',
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: '1', flatten: true },
  });
  assert.equal(typeof first.result?.sessionId, 'string');
  assert.equal(six.__hasTabShieldForTest(1), true);
  assert.ok((six.__bridgePortSnapshotForTest(port)?.owned ?? []).includes(1));
  phase = 'second';
  reads = 0;
  const second = await send({
    bridge: 1,
    channelId: 'c',
    kind: 'cdp.request',
    id: 2,
    method: 'Target.attachToTarget',
    params: { targetId: '1', flatten: true },
  });
  assert.ok(second.error);
  assert.ok(forwarded.includes('Fetch.disable'));
  assert.ok(detached.length > 0);
  assert.equal(six.__hasTabShieldForTest(1), false);
  const snap = six.__bridgePortSnapshotForTest(port);
  assert.ok(!(snap?.owned ?? [1]).includes(1));
  for (const f of listeners.disc) f();
  six.__clearTabShieldsForTest();
});

const host = 'vault.sliccy.ai';
const origin = 'https://vault.sliccy.ai';

for (const transport of ['seven', 'six-bridge']) {
  const redact =
    transport === 'seven'
      ? (value, method) => redactProtected(value, anyProtected, method)
      : (value, method) => sixShield.redactProtected(value, method);

  test(`${transport}: chrome-error targetInfo title is not a failed host`, () => {
    const changed = redact(
      {
        targetInfo: {
          targetId: '1',
          type: 'page',
          url: ERROR_PAGE,
          title: host,
          attached: true,
        },
      },
      'Target.targetInfoChanged'
    );
    assert.notEqual(changed.targetInfo.title, host);
    assert.equal(changed.targetInfo.title, origin);
    const targets = redact(
      {
        targetInfos: [
          { targetId: '1', type: 'page', url: ERROR_PAGE, title: host },
          { targetId: '2', type: 'page', url: ordinary, title: 'ok' },
        ],
      },
      'Target.getTargets'
    );
    assert.equal(targets.targetInfos[0].title, origin);
    assert.equal(targets.targetInfos[1].title, 'ok');
    const plain = redact(
      {
        targetInfo: {
          targetId: '3',
          type: 'page',
          url: ERROR_PAGE,
          title: 'Missing page',
          attached: false,
        },
      },
      'Target.getTargetInfo'
    );
    assert.equal(plain.targetInfo.title, '');
  });

  test(`${transport}: error-document context and DOM name do not carry a failed host`, () => {
    const context = redact(
      {
        context: {
          id: 1,
          origin: '://',
          name: '',
          auxData: { isDefault: true, frameId: 'ROOT', type: 'default' },
        },
      },
      'Runtime.executionContextCreated'
    );
    assert.equal(context.context.name, '');
    const named = redact(
      {
        context: {
          id: 2,
          origin: 'null',
          name: '__crx_world__',
          auxData: { isDefault: false, frameId: 'ROOT', type: 'isolated' },
        },
      },
      'Runtime.executionContextCreated'
    );
    assert.equal(named.context.name, '__crx_world__');
    const node = {
      nodeId: 1,
      attributes: ['name', host, 'id', 'panel'],
      documentURL: ERROR_PAGE,
      baseURL: ERROR_PAGE,
      nodeValue: host,
    };
    const scrubbed = redact({ node }, 'DOM.describeNode');
    assert.deepEqual(scrubbed.node.attributes, ['id', 'panel']);
    assert.equal(scrubbed.node.nodeValue, origin);
    assert.equal(scrubbed.node.documentURL, ERROR_PAGE);
    assert.ok(!scrubbed.node.attributes.includes(host));
    assert.notEqual(scrubbed.node.nodeValue, host);
    const ordinaryName = redact(
      {
        node: {
          nodeId: 2,
          attributes: ['name', 'section'],
          documentURL: ERROR_PAGE,
          baseURL: ERROR_PAGE,
        },
      },
      'DOM.describeNode'
    );
    assert.deepEqual(ordinaryName.node.attributes, ['name', 'section']);
    const outer = redact({ outerHTML: `<html name="${host}">${host}</html>` }, 'DOM.getOuterHTML');
    assert.equal(outer.outerHTML, `<html name="${origin}">${origin}</html>`);
    node.documentURL = ordinary;
    node.baseURL = ordinary;
    assert.deepEqual(redact({ node }, 'DOM.describeNode').node.attributes, [
      'name',
      host,
      'id',
      'panel',
    ]);
    node.documentURL = ERROR_PAGE;
    node.baseURL = ERROR_PAGE;
    node.attributes = ['name', 'section', 'id', host];
    assert.deepEqual(redact({ node }, 'DOM.describeNode').node.attributes, [
      'name',
      'section',
      'id',
      origin,
    ]);
  });

  test(`${transport}: shape-scoped name scrub keeps ordinary reply shapes`, () => {
    const evaluated = redact(
      { result: { type: 'object', value: [{ name: 'Docs', url: failed }] } },
      'Runtime.evaluate'
    );
    assert.equal(evaluated.result.value[0].name, 'Docs');
    assert.equal(evaluated.result.value[0].url, origin);
    const ax = redact(
      {
        nodes: [
          {
            nodeId: '1',
            role: { type: 'role', value: 'link' },
            name: { type: 'computedString', value: 'Docs' },
            url: failed,
          },
        ],
      },
      'Accessibility.getFullAXTree'
    );
    assert.equal(ax.nodes[0].name.value, 'Docs');
    assert.equal(ax.nodes[0].url, origin);
    const partial = redact(
      {
        nodes: [
          {
            nodeId: '2',
            role: { type: 'role', value: 'link' },
            name: { type: 'computedString', value: 'Docs' },
            url: failed,
          },
        ],
      },
      'Accessibility.getPartialAXTree'
    );
    assert.equal(partial.nodes[0].name.value, 'Docs');
    const anchor = redact(
      {
        node: {
          nodeId: 3,
          localName: 'a',
          attributes: ['name', 'section', 'href', failed],
          documentURL: ordinary,
          baseURL: ordinary,
        },
      },
      'DOM.describeNode'
    );
    assert.deepEqual(anchor.node.attributes, ['name', 'section', 'href', origin]);
    assert.equal(
      redact({ url: ordinary, windowName: 'app', windowFeatures: 'noopener' }, 'Page.windowOpen')
        .windowName,
      'app'
    );
    assert.equal(
      redact(
        { frameId: 'ROOT', guid: 'g', url: ordinary, suggestedFilename: 'report.pdf' },
        'Page.downloadWillBegin'
      ).suggestedFilename,
      'report.pdf'
    );
    const frame = {
      id: 'SAND',
      loaderId: 'L-sand',
      url: 'about:blank',
      securityOrigin: '://',
      name: 'sandbox',
    };
    assert.equal(redact({ frame }, 'Page.frameNavigated').frame.name, 'sandbox');
    const tree = redact(
      {
        frameTree: {
          frame: {
            id: 'ROOT',
            url: ordinary,
            securityOrigin: 'https://ordinary.test',
            name: 'main',
          },
          childFrames: [{ frame }],
        },
      },
      'Page.getFrameTree'
    );
    assert.equal(tree.frameTree.frame.name, 'main');
    assert.equal(tree.frameTree.childFrames[0].frame.name, 'sandbox');
    assert.equal(
      redact(
        {
          context: {
            id: 9,
            origin: 'null',
            name: '__crx_isolated_world__',
            auxData: { isDefault: false, frameId: 'SAND', type: 'isolated' },
          },
        },
        'Runtime.executionContextCreated'
      ).context.name,
      '__crx_isolated_world__'
    );
    const generic = (value) => {
      if (value === null || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(generic);
      const out = { ...value };
      for (const [key, item] of Object.entries(out)) out[key] = generic(item);
      if (
        ['url', 'documentURL', 'baseURL', 'securityOrigin', 'unreachableUrl'].some(
          (key) => typeof out[key] === 'string' && out[key].includes('vault.sliccy.ai')
        )
      ) {
        delete out.name;
        delete out.windowName;
      }
      return out;
    };
    assert.equal(generic(evaluated).result.value[0].name, undefined);
    assert.equal(evaluated.result.value[0].name, 'Docs');
  });

  test(`${transport}: windowName and sibling name carriers omit on protected or unproven`, () => {
    const opened = redact(
      { url: failed, windowName: host, windowFeatures: 'noopener' },
      'Page.windowOpen'
    );
    assert.equal(opened.windowName, undefined);
    assert.equal(opened.url, origin);
    assert.equal(opened.windowFeatures, 'noopener');
    const openedOrdinary = redact(
      { url: ordinary, windowName: 'app', windowFeatures: 'noopener' },
      'Page.windowOpen'
    );
    assert.equal(openedOrdinary.windowName, 'app');
    const openedUnproven = redact(
      { url: ERROR_PAGE, windowName: host, windowFeatures: '', title: host },
      'Page.windowOpen'
    );
    assert.equal(openedUnproven.windowName, undefined);
    assert.equal(openedUnproven.title, 'about:blank');
    const resource = redact(
      {
        frameTree: {
          frame: {
            id: 'ROOT',
            url: ERROR_PAGE,
            securityOrigin: '://',
            unreachableUrl: failed,
            name: host,
          },
          childFrames: [
            { frame: { id: 'CHILD', url: failed, securityOrigin: origin, name: host } },
          ],
        },
      },
      'Page.getResourceTree'
    );
    assert.equal(resource.frameTree.frame.name, undefined);
    assert.equal(resource.frameTree.childFrames[0].frame.name, undefined);
    const resourceOrdinary = redact(
      {
        frameTree: {
          frame: {
            id: 'ROOT',
            url: ordinary,
            securityOrigin: 'https://ordinary.test',
            name: 'main',
          },
          childFrames: [
            {
              frame: {
                id: 'CHILD',
                url: `${ordinary}/i`,
                securityOrigin: 'https://ordinary.test',
                name: 'child',
              },
            },
          ],
        },
      },
      'Page.getResourceTree'
    );
    assert.equal(resourceOrdinary.frameTree.frame.name, 'main');
    assert.equal(resourceOrdinary.frameTree.childFrames[0].frame.name, 'child');
    const context = redact(
      {
        context: {
          id: 1,
          origin,
          name: host,
          auxData: { isDefault: true, frameId: 'ROOT', type: 'default' },
        },
      },
      'Runtime.executionContextCreated'
    );
    assert.equal(context.context.name, undefined);
    assert.equal(context.context.origin, origin);
    assert.equal(context.context.auxData.frameId, 'ROOT');
    assert.equal(
      redact(
        {
          context: {
            id: 2,
            origin: 'https://ordinary.test',
            name: 'world',
            auxData: { isDefault: true, frameId: 'ROOT' },
          },
        },
        'Runtime.executionContextCreated'
      ).context.name,
      'world'
    );
    const download = redact(
      { frameId: 'ROOT', guid: 'g', url: failed, suggestedFilename: `${host}.bin` },
      'Page.downloadWillBegin'
    );
    assert.equal(download.suggestedFilename, '');
    assert.equal(download.url, origin);
    assert.equal(
      redact(
        { frameId: 'ROOT', guid: 'g', url: ordinary, suggestedFilename: 'report.pdf' },
        'Page.downloadWillBegin'
      ).suggestedFilename,
      'report.pdf'
    );
    const node = redact(
      {
        node: {
          nodeId: 1,
          localName: 'iframe',
          attributes: ['name', host, 'src', failed],
          documentURL: failed,
          baseURL: failed,
          frameId: 'CHILD',
        },
      },
      'DOM.describeNode'
    );
    assert.deepEqual(node.node.attributes, ['src', origin]);
    assert.deepEqual(
      redact(
        {
          node: {
            nodeId: 2,
            attributes: ['name', 'panel', 'src', ordinary],
            documentURL: ordinary,
            baseURL: ordinary,
          },
        },
        'DOM.describeNode'
      ).node.attributes,
      ['name', 'panel', 'src', ordinary]
    );
    const target = redact(
      { targetInfo: { targetId: '1', type: 'page', title: host, url: failed, attached: true } },
      'Target.targetInfoChanged'
    );
    assert.equal(target.targetInfo.title, origin);
    assert.equal(target.targetInfo.url, origin);
    assert.equal(
      redact({ url: failed, message: 'alert', type: 'alert' }, 'Page.javascriptDialogOpening').url,
      origin
    );
    assert.equal(
      redact(
        { entry: { source: 'network', level: 'error', text: 'fail', url: failed } },
        'Log.entryAdded'
      ).entry.url,
      origin
    );
    const network = redact(
      {
        requestId: '1',
        documentURL: failed,
        request: { url: `${failed}/doc`, method: 'GET' },
        type: 'Document',
      },
      'Network.requestWillBeSent'
    );
    assert.equal(network.documentURL, origin);
    assert.equal(network.request.url, origin);
    for (const method of ['Page.frameNavigated', 'Page.frameAttached']) {
      const scrubbed = redact(
        {
          frame: {
            id: 'ROOT',
            loaderId: 'L1',
            url: ERROR_PAGE,
            securityOrigin: '://',
            unreachableUrl: failed,
            name: host,
          },
        },
        method
      );
      assert.equal(scrubbed.frame.name, undefined);
    }
    for (const method of ['Page.frameRequestedNavigation', 'Page.frameStartedNavigating']) {
      assert.equal(redact({ frameId: 'ROOT', url: failed }, method).url, origin);
    }
    const mutated = {
      frame: {
        id: 'ROOT',
        url: ERROR_PAGE,
        securityOrigin: '://',
        unreachableUrl: failed,
        name: 'Missing page',
      },
    };
    assert.equal(redact(mutated, 'Page.frameNavigated').frame.name, undefined);
    mutated.frame.unreachableUrl = ordinaryFailed;
    assert.equal(redact(mutated, 'Page.frameNavigated').frame.name, 'Missing page');
    const openMutated = { url: failed, windowName: host, windowFeatures: 'noopener' };
    assert.equal(redact(openMutated, 'Page.windowOpen').windowName, undefined);
    openMutated.url = ordinary;
    openMutated.windowName = 'app';
    assert.equal(redact(openMutated, 'Page.windowOpen').windowName, 'app');
  });
}

function navFrame(url) {
  return {
    frameId: 0,
    parentFrameId: -1,
    url,
    errorOccurred: true,
    documentId: 'D',
    documentLifecycle: 'active',
  };
}

async function sevenSession(opts = {}) {
  let tree = opts.tree ?? errorTree(ordinaryFailed, { loaderId: 'L1' });
  let navUrl = opts.navUrl ?? ordinaryFailed;
  let tabUrl = opts.tabUrl ?? navUrl;
  let tabTitle = opts.tabTitle ?? 'Missing page';
  const published = [];
  const detached = [];
  const api = {
    tabs: {
      get: async () => ({ id: 1, url: tabUrl, title: tabTitle, status: 'complete' }),
      query: async () => [{ id: 1, url: tabUrl, title: tabTitle, status: 'complete' }],
      onUpdated: event(),
      onCreated: event(),
      onRemoved: event(),
      onActivated: event(),
    },
    windows: { onRemoved: event() },
    webNavigation: {
      getAllFrames: async () => [navFrame(navUrl)],
      getFrame: async () => ({ errorOccurred: true, url: navUrl }),
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
        if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree') return tree;
        if (method === 'Page.getNavigationHistory') {
          return { currentIndex: 0, entries: [{ id: 1, url: tabUrl, title: tabTitle }] };
        }
        if (method === 'DOM.getDocument') {
          return {
            root: {
              nodeId: 1,
              documentURL: ERROR_PAGE,
              baseURL: ERROR_PAGE,
              attributes: opts.domAttributes ?? ['name', host, 'id', 'panel'],
              children: [{ nodeId: 2, nodeName: '#text', nodeValue: opts.domText ?? host }],
            },
          };
        }
        if (method === 'DOM.describeNode') {
          return {
            node: {
              nodeId: 1,
              documentURL: ERROR_PAGE,
              baseURL: ERROR_PAGE,
              attributes: opts.domAttributes ?? ['name', host],
            },
          };
        }
        if (method === 'DOM.getOuterHTML') {
          return {
            outerHTML: opts.outerHTML ?? `<html name="${host}">${host}</html>`,
          };
        }
        if (method === 'Runtime.evaluate') {
          return { result: { type: 'string', value: opts.domText ?? host } };
        }
        if (method === 'Page.captureScreenshot') return { data: 'abc' };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
        if (method === 'Input.dispatchMouseEvent') return {};
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
  const attached = await conn.attach({ targetId: '1', flatten: true });
  let nextId = 0;
  const command = async (method, params = {}) => {
    const id = ++nextId;
    await conn.run({ id, method, params, sessionId: attached.sessionId });
    const reply = published.findLast((m) => m.id === id);
    if (reply?.error) return { error: reply.error };
    return { result: reply?.result };
  };
  return {
    sessionId: attached.sessionId,
    published,
    detached,
    command,
    navigate(nextTree, nextNav, title = tabTitle) {
      tree = nextTree;
      navUrl = nextNav;
      tabUrl = nextNav;
      tabTitle = title;
      api.debugger.onEvent.fire({ tabId: 1 }, 'Page.frameNavigated', {
        frame: nextTree.frameTree.frame,
      });
    },
    fire(method, params) {
      api.debugger.onEvent.fire({ tabId: 1 }, method, params);
    },
    stillAttached() {
      return {
        sessions: [...conn.state.sessions.keys()],
        tabs: [...conn.state.tabs.keys()],
        owned: [...conn.state.ownedTabs],
        detached: detached.length,
      };
    },
    info() {
      return conn.info({ id: 1, url: tabUrl, title: tabTitle });
    },
    close() {
      conn.close();
    },
  };
}

async function sixSession(opts = {}) {
  six.__clearTabShieldsForTest();
  six.__clearWelcomedLeaderPortsForTest();
  let tree = opts.tree ?? errorTree(ordinaryFailed, { loaderId: 'L1' });
  let navUrl = opts.navUrl ?? ordinaryFailed;
  let tabUrl = opts.tabUrl ?? navUrl;
  let tabTitle = opts.tabTitle ?? 'Missing page';
  const published = [];
  const detached = [];
  const listeners = { msg: new Set(), disc: new Set() };
  const debuggerHandlers = new Set();
  const priorFrames = chrome.webNavigation.getAllFrames;
  chrome.webNavigation.getAllFrames = async () => [navFrame(navUrl)];
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
    subscribeDebuggerEvents: (handler) => {
      debuggerHandlers.add(handler);
      return () => debuggerHandlers.delete(handler);
    },
    queryTabs: async () => [{ id: 1, url: tabUrl, title: tabTitle, status: 'complete' }],
    queryActiveTabId: async () => 1,
    getTab: async () => ({ id: 1, url: tabUrl, title: tabTitle, status: 'complete' }),
    sendDebuggerCommand: async (_tab, method) => {
      if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree') return tree;
      if (method === 'Page.getNavigationHistory') {
        return { currentIndex: 0, entries: [{ id: 1, url: tabUrl, title: tabTitle }] };
      }
      if (method === 'DOM.getDocument') {
        return {
          root: {
            nodeId: 1,
            documentURL: ERROR_PAGE,
            baseURL: ERROR_PAGE,
            attributes: opts.domAttributes ?? ['name', host, 'id', 'panel'],
            children: [{ nodeId: 2, nodeName: '#text', nodeValue: opts.domText ?? host }],
          },
        };
      }
      if (method === 'DOM.describeNode') {
        return {
          node: {
            nodeId: 1,
            documentURL: ERROR_PAGE,
            baseURL: ERROR_PAGE,
            attributes: opts.domAttributes ?? ['name', host],
          },
        };
      }
      if (method === 'DOM.getOuterHTML') {
        return { outerHTML: opts.outerHTML ?? `<html name="${host}">${host}</html>` };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { type: 'string', value: opts.domText ?? host } };
      }
      if (method === 'Page.captureScreenshot') return { data: 'abc' };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
      if (method === 'Input.dispatchMouseEvent') return {};
      return {};
    },
  });
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
  if (a.error) {
    chrome.webNavigation.getAllFrames = priorFrames;
    throw new Error(typeof a.error === 'string' ? a.error : (a.error.message ?? String(a.error)));
  }
  const sessionId = a.result.sessionId;
  return {
    sessionId,
    published,
    detached,
    command: async (method, params = {}) => {
      const reply = await cdp(method, params, sessionId);
      if (reply.error) {
        return {
          error:
            typeof reply.error === 'string'
              ? reply.error
              : (reply.error.message ?? String(reply.error)),
        };
      }
      return { result: reply.result };
    },
    navigate(nextTree, nextNav, title = tabTitle) {
      tree = nextTree;
      navUrl = nextNav;
      tabUrl = nextNav;
      tabTitle = title;
      for (const handler of debuggerHandlers) {
        handler(1, 'Page.frameNavigated', { frame: nextTree.frameTree.frame });
      }
    },
    fire(method, params) {
      for (const handler of debuggerHandlers) handler(1, method, params);
    },
    stillAttached() {
      return {
        sessions: six.__bridgePortSnapshotForTest(port)?.sessions ?? [],
        shield: six.__hasTabShieldForTest(1),
        owned: six.__bridgePortSnapshotForTest(port)?.owned ?? [],
        detached: detached.length,
      };
    },
    info() {
      return undefined;
    },
    close() {
      for (const f of listeners.disc) f();
      six.__clearTabShieldsForTest();
      chrome.webNavigation.getAllFrames = priorFrames;
    },
  };
}

for (const transport of ['seven', 'six-bridge']) {
  const open = transport === 'seven' ? sevenSession : sixSession;

  test(`${transport}: chrome-error DOM reads refuse protected and scrub unproven`, async () => {
    const protectedSession = await open();
    protectedSession.navigate(errorTree(failed, { loaderId: 'L-a' }), failed, host);
    await new Promise((r) => setTimeout(r, 10));
    for (const method of ['DOM.getDocument', 'DOM.describeNode', 'DOM.getOuterHTML']) {
      const reply = await protectedSession.command(method);
      assert.match(String(reply.error ?? ''), refusal, method);
    }
    const sealed = protectedSession.stillAttached();
    if (transport === 'seven') {
      assert.deepEqual(sealed.sessions, ['1']);
      assert.deepEqual(sealed.tabs, [1]);
      assert.deepEqual(sealed.owned, [1]);
    } else {
      assert.equal(sealed.shield, true);
      assert.ok((sealed.owned ?? []).includes(1));
    }
    assert.equal(sealed.detached, 0);
    protectedSession.close();

    const unproven = await open();
    unproven.navigate(errorTree(undefined, { loaderId: 'L-b' }), ordinaryFailed);
    await new Promise((r) => setTimeout(r, 10));
    const doc = await unproven.command('DOM.getDocument');
    assert.equal(doc.error, undefined);
    assert.deepEqual(doc.result.root.attributes, ['id', 'panel']);
    assert.equal(doc.result.root.children[0].nodeValue, origin);
    assert.ok(!doc.result.root.attributes.includes(host));
    assert.notEqual(doc.result.root.children[0].nodeValue, host);
    const described = await unproven.command('DOM.describeNode');
    assert.equal(described.error, undefined);
    assert.deepEqual(described.result.node.attributes, []);
    const outer = await unproven.command('DOM.getOuterHTML');
    assert.equal(outer.error, undefined);
    assert.equal(outer.result.outerHTML, `<html name="${origin}">${origin}</html>`);
    unproven.close();

    const ordinarySession = await open({
      domAttributes: ['name', 'section', 'id', 'panel'],
      domText: 'Missing page',
      outerHTML: '<html name="section">Missing page</html>',
    });
    const ordinaryDoc = await ordinarySession.command('DOM.getDocument');
    assert.equal(ordinaryDoc.error, undefined);
    assert.deepEqual(ordinaryDoc.result.root.attributes, ['name', 'section', 'id', 'panel']);
    assert.equal(ordinaryDoc.result.root.children[0].nodeValue, 'Missing page');
    const ordinaryOuter = await ordinarySession.command('DOM.getOuterHTML');
    assert.equal(ordinaryOuter.error, undefined);
    assert.equal(ordinaryOuter.result.outerHTML, '<html name="section">Missing page</html>');
    ordinarySession.close();
  });

  test(`${transport}: sealed protected error session stays attached without host`, async () => {
    const session = await open();
    const before = session.published.length;
    session.navigate(errorTree(failed, { loaderId: 'L-seal', name: host }), failed, host);
    session.fire('Target.targetInfoChanged', {
      targetInfo: {
        targetId: '1',
        type: 'page',
        url: ERROR_PAGE,
        title: host,
        attached: true,
      },
    });
    await new Promise((r) => setTimeout(r, 15));
    const events = session.published.slice(before).filter((m) => m.method && !m.id);
    assert.equal(events.filter((m) => m.method === 'Page.frameNavigated').length, 0);
    assert.ok(!events.some((m) => JSON.stringify(m).includes(host)));
    for (const method of [
      'DOM.getDocument',
      'Runtime.evaluate',
      'Page.captureScreenshot',
      'Input.dispatchMouseEvent',
    ]) {
      const reply = await session.command(
        method,
        method.startsWith('Input.')
          ? { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }
          : {}
      );
      assert.match(String(reply.error ?? ''), refusal, method);
    }
    const live = session.stillAttached();
    if (transport === 'seven') {
      assert.deepEqual(live.sessions, ['1']);
      assert.deepEqual(live.owned, [1]);
      const info = session.info();
      assert.equal(info.url, origin);
      assert.equal(info.title, origin);
      assert.ok(!String(info.title).includes(host) || info.title === origin);
    } else {
      assert.equal(live.shield, true);
      assert.ok((live.owned ?? []).includes(1));
    }
    assert.equal(live.detached, 0);
    session.close();
  });
}
