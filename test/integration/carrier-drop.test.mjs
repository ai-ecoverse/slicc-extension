import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { listen } from '../../extension/cdp.js';

const ordinary = 'https://ordinary.test/start';
const vault = 'https://vault.sliccy.ai/oauth?code=SECRET_TOKEN&state=x';
const host = 'vault.sliccy.ai';
const origin = 'https://vault.sliccy.ai';
const event = () => {
  const fns = new Set();
  return {
    addListener: (f) => fns.add(f),
    removeListener: (f) => fns.delete(f),
    fire: (...args) => {
      for (const f of fns) f(...args);
    },
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

function rootTree(url = ordinary, opts = {}) {
  return {
    frameTree: {
      frame: {
        id: 'ROOT',
        loaderId: opts.loaderId ?? 'L1',
        url,
        securityOrigin: new URL(url).origin,
        mimeType: 'text/html',
        ...(opts.name !== undefined ? { name: opts.name } : {}),
      },
    },
  };
}

function childTree(url) {
  const root = rootTree().frameTree;
  return {
    frameTree: {
      ...root,
      childFrames: [
        {
          frame: {
            id: 'CHILD',
            parentId: 'ROOT',
            loaderId: 'Lc',
            url,
            securityOrigin: new URL(url).origin,
            name: host,
          },
        },
      ],
    },
  };
}

async function sevenLive(opts = {}) {
  let tree = opts.tree ?? rootTree();
  let tabUrl = opts.tabUrl ?? ordinary;
  const published = [];
  const api = {
    tabs: {
      get: async () => ({ id: 1, url: tabUrl, title: 'ok', status: 'complete' }),
      query: async () => [{ id: 1, url: tabUrl, title: 'ok', status: 'complete' }],
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
          url: tabUrl,
          errorOccurred: false,
          documentId: 'D',
          documentLifecycle: 'active',
        },
      ],
      getFrame: async () => ({ errorOccurred: false, url: tabUrl }),
      onCreatedNavigationTarget: event(),
      onCommitted: event(),
    },
    debugger: {
      onEvent: event(),
      onDetach: event(),
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_t, method) => {
        if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree') return tree;
        if (method === 'Page.getNavigationHistory') {
          return {
            currentIndex: 0,
            entries: [
              { id: 1, url: tabUrl, title: opts.historyTitle ?? 'ok', userTypedURL: tabUrl },
            ],
          };
        }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
        if (method === 'Target.getTargetInfo') {
          return {
            targetInfo: {
              targetId: '1',
              type: 'page',
              url: tabUrl,
              title: opts.historyTitle ?? 'ok',
              attached: true,
            },
          };
        }
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
  await conn.run({ id: 1, method: 'Page.enable', params: {}, sessionId: attached.sessionId });
  let nextId = 1;
  return {
    sessionId: attached.sessionId,
    published,
    conn,
    api,
    setTree: (next) => {
      tree = next;
    },
    setTab: (url) => {
      tabUrl = url;
    },
    fire(method, params) {
      api.debugger.onEvent.fire({ tabId: 1 }, method, params);
    },
    async command(method, params = {}) {
      const id = ++nextId;
      await conn.run({ id, method, params, sessionId: attached.sessionId });
      return published.findLast((m) => m.id === id);
    },
    cut() {
      conn.state.cut.add(attached.sessionId);
      conn.state.sessions.delete(attached.sessionId);
      conn.state.tabs.get(1)?.sessions.delete(attached.sessionId);
    },
    close() {
      conn.close();
    },
  };
}

async function sixLive(opts = {}) {
  six.__clearTabShieldsForTest();
  six.__clearWelcomedLeaderPortsForTest();
  let tree = opts.tree ?? rootTree();
  let tabUrl = opts.tabUrl ?? ordinary;
  const published = [];
  const listeners = { msg: new Set(), disc: new Set() };
  const debuggerHandlers = new Set();
  const priorFrames = chrome.webNavigation.getAllFrames;
  chrome.webNavigation.getAllFrames = async () => [
    {
      frameId: 0,
      parentFrameId: -1,
      url: tabUrl,
      errorOccurred: false,
      documentId: 'D',
      documentLifecycle: 'active',
    },
  ];
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
    detachDebugger: async () => {},
    subscribeDebuggerEvents: (handler) => {
      debuggerHandlers.add(handler);
      return () => debuggerHandlers.delete(handler);
    },
    queryTabs: async () => [{ id: 1, url: tabUrl, title: 'ok', status: 'complete' }],
    queryActiveTabId: async () => 1,
    getTab: async () => ({ id: 1, url: tabUrl, title: 'ok', status: 'complete' }),
    sendDebuggerCommand: async (_tab, method) => {
      if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree') return tree;
      if (method === 'Page.getNavigationHistory') {
        return {
          currentIndex: 0,
          entries: [{ id: 1, url: tabUrl, title: opts.historyTitle ?? 'ok', userTypedURL: tabUrl }],
        };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
      if (method === 'Target.getTargetInfo') {
        return {
          targetInfo: {
            targetId: '1',
            type: 'page',
            url: tabUrl,
            title: opts.historyTitle ?? 'ok',
            attached: true,
          },
        };
      }
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
  const sessionId = a.result.sessionId;
  await cdp('Page.enable', {}, sessionId);
  return {
    sessionId,
    published,
    port,
    setTree: (next) => {
      tree = next;
    },
    setTab: (url) => {
      tabUrl = url;
    },
    fire(method, params) {
      for (const handler of debuggerHandlers) handler(1, method, params);
    },
    async command(method, params = {}) {
      return cdp(method, params, sessionId);
    },
    cut() {
      six.checkBridgeTabProtection(1, vault);
    },
    close() {
      for (const f of listeners.disc) f();
      six.__clearTabShieldsForTest();
      chrome.webNavigation.getAllFrames = priorFrames;
    },
  };
}

function clientEvents(published, before, transport) {
  if (transport === 'seven') {
    return published
      .slice(before)
      .filter((m) => typeof m.method === 'string' && m.id === undefined);
  }
  return published
    .slice(before)
    .filter((m) => m.kind === 'cdp.event' && typeof m.method === 'string');
}

function hasSecret(events) {
  return events.some((m) => JSON.stringify(m).includes('SECRET_TOKEN'));
}

for (const transport of ['seven', 'six-bridge']) {
  const open = transport === 'seven' ? sevenLive : sixLive;

  test(`${transport}: carrier drops stay ahead of scrub on protected and cut sessions`, async () => {
    const live = await open();
    await live.command('Page.enable', {});

    const carriers = [
      [
        'Page.windowOpen',
        { url: vault, windowName: host, windowFeatures: '' },
        { url: `${ordinary}/x`, windowName: 'app', windowFeatures: 'noopener' },
      ],
      [
        'Page.downloadWillBegin',
        { frameId: 'ROOT', guid: 'g', url: vault, suggestedFilename: `${host}.bin` },
        { frameId: 'ROOT', guid: 'g', url: `${ordinary}/f`, suggestedFilename: 'report.pdf' },
      ],
    ];

    for (const [method, protectedParams, ordinaryParams] of carriers) {
      const before = live.published.length;
      live.fire(method, protectedParams);
      await new Promise((r) => setTimeout(r, 10));
      const dropped = clientEvents(live.published, before, transport).filter(
        (m) => m.method === method
      );
      assert.equal(dropped.length, 0, `${method} protected must not deliver`);
      assert.equal(hasSecret(dropped), false);

      const beforeOrdinary = live.published.length;
      live.fire(method, ordinaryParams);
      await new Promise((r) => setTimeout(r, 10));
      const ordinaryEvents = clientEvents(live.published, beforeOrdinary, transport).filter(
        (m) => m.method === method
      );
      assert.equal(ordinaryEvents.length, 1, `${method} ordinary delivers`);
      if (method === 'Page.windowOpen') {
        assert.equal(ordinaryEvents[0].params.windowName, 'app');
        assert.ok(!JSON.stringify(ordinaryEvents[0]).includes('SECRET_TOKEN'));
      }
      if (method === 'Page.downloadWillBegin') {
        assert.equal(ordinaryEvents[0].params.suggestedFilename, 'report.pdf');
        const beforeProgress = live.published.length;
        live.fire('Page.downloadProgress', {
          guid: ordinaryParams.guid,
          totalBytes: 1,
          receivedBytes: 1,
          state: 'completed',
        });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(
          clientEvents(live.published, beforeProgress, transport).filter(
            (m) => m.method === 'Page.downloadProgress'
          ).length,
          1
        );
      }
    }

    live.setTree(childTree(vault));
    live.fire('Page.frameAttached', { frameId: 'CHILD', parentFrameId: 'ROOT' });
    live.fire('Page.frameNavigated', {
      frame: childTree(vault).frameTree.childFrames[0].frame,
    });
    await new Promise((r) => setTimeout(r, 10));
    const beforeChild = live.published.length;
    live.fire('Page.downloadWillBegin', {
      frameId: 'CHILD',
      guid: 'g2',
      url: `${ordinary}/from-child`,
      suggestedFilename: 'leak.pdf',
    });
    live.fire('Page.frameNavigated', {
      frame: {
        id: 'CHILD',
        parentId: 'ROOT',
        loaderId: 'Lc2',
        url: vault,
        securityOrigin: origin,
        name: host,
      },
    });
    live.fire('Network.responseReceivedExtraInfo', {
      requestId: 'child-r',
      statusCode: 200,
      headers: { 'content-disposition': `attachment; filename="${host}.bin"` },
      headersText: `content-disposition: attachment; filename="${host}.bin"\r\n`,
    });
    await new Promise((r) => setTimeout(r, 10));
    const childEvents = clientEvents(live.published, beforeChild, transport);
    assert.equal(
      childEvents.filter((m) => m.method === 'Page.downloadWillBegin').length,
      0,
      'protected-frame download must not deliver'
    );
    assert.equal(
      childEvents.filter((m) => m.method === 'Page.frameNavigated').length,
      0,
      'protected-frame frameNavigated must not deliver'
    );
    assert.ok(!hasSecret(childEvents));
    assert.ok(!childEvents.some((m) => JSON.stringify(m).includes(host)));

    const beforeExtra = live.published.length;
    live.fire('Network.requestWillBeSent', {
      requestId: 'r-ord',
      documentURL: ordinary,
      frameId: 'ROOT',
      request: { url: `${ordinary}/d`, method: 'GET' },
      type: 'Document',
    });
    live.fire('Network.responseReceived', {
      requestId: 'r-ord',
      frameId: 'ROOT',
      type: 'Document',
      response: { url: `${ordinary}/d`, status: 200, headers: {} },
    });
    live.fire('Network.responseReceivedExtraInfo', {
      requestId: 'r-ord',
      statusCode: 200,
      headers: { 'content-disposition': 'attachment; filename="report.pdf"' },
      headersText: 'content-disposition: attachment; filename="report.pdf"\r\n',
    });
    await new Promise((r) => setTimeout(r, 10));
    const extra = clientEvents(live.published, beforeExtra, transport).filter(
      (m) => m.method === 'Network.responseReceivedExtraInfo'
    );
    assert.equal(extra.length, 1);
    assert.equal(
      extra[0].params.headers['content-disposition'],
      'attachment; filename="report.pdf"'
    );

    const beforeHist = live.published.length;
    const history = await live.command('Page.getNavigationHistory');
    const histResult = transport === 'seven' ? history?.result : (history?.result ?? history);
    assert.ok(histResult?.entries);
    assert.equal(histResult.entries[0].url, ordinary);
    assert.equal(clientEvents(live.published, beforeHist, transport).length, 0);

    if (transport === 'seven') {
      const info = live.conn.info({ id: 1, url: vault, title: host });
      assert.equal(info.url, origin);
      assert.equal(info.title, origin);
      assert.ok(!String(info.title).includes('SECRET_TOKEN'));
    }

    const beforeMut = live.published.length;
    live.fire('Page.windowOpen', {
      url: vault,
      windowName: host,
      windowFeatures: '',
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(
      clientEvents(live.published, beforeMut, transport).filter(
        (m) => m.method === 'Page.windowOpen'
      ).length,
      0,
      'mutation baseline: protected windowOpen stays dropped'
    );
    const beforeFlip = live.published.length;
    live.fire('Page.windowOpen', {
      url: `${ordinary}/opened`,
      windowName: 'app',
      windowFeatures: 'noopener',
    });
    await new Promise((r) => setTimeout(r, 10));
    const flipped = clientEvents(live.published, beforeFlip, transport).filter(
      (m) => m.method === 'Page.windowOpen'
    );
    assert.equal(flipped.length, 1, 'mutation past drop delivers ordinary windowOpen');
    assert.equal(flipped[0].params.windowName, 'app');
    assert.ok(!JSON.stringify(flipped[0]).includes('SECRET_TOKEN'));

    live.cut();
    const beforeCut = live.published.length;
    live.fire('Page.windowOpen', {
      url: `${ordinary}/after-cut`,
      windowName: 'app',
      windowFeatures: '',
    });
    live.fire('Page.downloadWillBegin', {
      frameId: 'ROOT',
      guid: 'gc',
      url: `${ordinary}/after-cut`,
      suggestedFilename: 'a.pdf',
    });
    live.fire('Page.downloadProgress', {
      guid: 'gc',
      totalBytes: 1,
      receivedBytes: 1,
      state: 'completed',
    });
    await new Promise((r) => setTimeout(r, 10));
    const cutEvents = clientEvents(live.published, beforeCut, transport);
    assert.equal(cutEvents.filter((m) => m.method === 'Page.windowOpen').length, 0);
    assert.equal(cutEvents.filter((m) => m.method === 'Page.downloadWillBegin').length, 0);
    assert.equal(cutEvents.filter((m) => m.method === 'Page.downloadProgress').length, 0);
    if (transport === 'seven') {
      const cutCmd = await live.command('Page.getNavigationHistory');
      assert.match(String(cutCmd?.error ?? ''), /^slicc: refused:/);
    } else {
      const snap = six.__bridgePortSnapshotForTest(live.port);
      assert.ok(!(snap?.sessions ?? []).includes(live.sessionId));
      const cutCmd = await live.command('Page.getNavigationHistory');
      assert.ok(cutCmd.error);
    }

    live.close();
  });
}
