import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { listen } from '../../extension/cdp.js';

const ordinary = 'https://ordinary.test/start';
const legacy = [
  ['Network.setRequestInterception', { patterns: [{ urlPattern: '*' }] }],
  [
    'Network.continueInterceptedRequest',
    { interceptionId: 'interception-job-1.0', rawResponse: btoa('HTTP/1.1 200 OK\r\n\r\n') },
  ],
];
const refusals = {
  'Network.setRequestInterception':
    'slicc: refused: Network.setRequestInterception is deprecated: intercept requests through Fetch instead',
  'Network.continueInterceptedRequest':
    'slicc: refused: Network.continueInterceptedRequest is deprecated: intercept requests through Fetch instead',
};
const paused = {
  requestId: 'fetch-1',
  networkId: 'net-1',
  frameId: 'ROOT',
  resourceType: 'XHR',
  request: { url: 'https://ordinary.test/data', method: 'GET', headers: {} },
  responseStatusCode: 200,
  responseHeaders: [{ name: 'content-type', value: 'text/plain' }],
};

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

const tree = {
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

function answer(method) {
  if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree') return tree;
  if (method === 'Page.getNavigationHistory') {
    return { currentIndex: 0, entries: [{ id: 1, url: ordinary, title: 'ok' }] };
  }
  if (method === 'Target.getTargetInfo') {
    return {
      targetInfo: { targetId: '1', type: 'page', url: ordinary, title: 'ok', attached: true },
    };
  }
  return {};
}

const frames = async () => [
  {
    frameId: 0,
    parentFrameId: -1,
    url: ordinary,
    errorOccurred: false,
    documentId: 'D',
    documentLifecycle: 'active',
  },
];

async function seven() {
  const sent = [];
  const published = [];
  const tab = { id: 1, url: ordinary, title: 'ok', status: 'complete' };
  const api = {
    tabs: {
      get: async () => tab,
      query: async () => [tab],
      onUpdated: event(),
      onCreated: event(),
      onRemoved: event(),
      onActivated: event(),
    },
    windows: { onRemoved: event() },
    webNavigation: {
      getAllFrames: frames,
      getFrame: async () => ({ errorOccurred: false, url: ordinary }),
      onCreatedNavigationTarget: event(),
      onCommitted: event(),
    },
    debugger: {
      onEvent: event(),
      onDetach: event(),
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target, method, params) => {
        sent.push({ method, params });
        return answer(method);
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
  const { sessionId } = await conn.attach({ targetId: '1', flatten: true });
  let id = 0;
  return {
    sessionId,
    sent,
    async send(method, params, session) {
      const at = ++id;
      await conn.run({ id: at, method, params, ...(session ? { sessionId: session } : {}) });
      const reply = published.findLast((m) => m.id === at);
      return { error: reply?.error, result: reply?.result };
    },
    fire(method, params) {
      api.debugger.onEvent.fire({ tabId: 1 }, method, params);
    },
    async delivered(method) {
      for (let i = 0; i < 100; i++) {
        const found = published.find((m) => m.method === method && m.sessionId === sessionId);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 2));
      }
      return undefined;
    },
    close: () => conn.close(),
  };
}

async function sixBridge() {
  six.__clearTabShieldsForTest();
  six.__clearWelcomedLeaderPortsForTest();
  const sent = [];
  const published = [];
  const listeners = new Set();
  const closers = new Set();
  const handlers = new Set();
  const prior = chrome.webNavigation.getAllFrames;
  chrome.webNavigation.getAllFrames = frames;
  const port = {
    name: 'slicc.cdp-bridge',
    sender: {
      origin: 'https://www.sliccy.ai',
      url: 'https://www.sliccy.ai/?slicc=leader',
      tab: { id: 99 },
      frameId: 0,
      documentId: 'doc',
    },
    onMessage: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) },
    onDisconnect: { addListener: (f) => closers.add(f), removeListener: () => {} },
    postMessage: (m) => published.push(m),
    disconnect: () => {},
  };
  const tab = { id: 1, url: ordinary, title: 'ok', status: 'complete' };
  const deps = six.buildDefaultBridgeSwDeps({
    readStoredLeaderTabId: async () => 99,
    readLeaderKind: async () => 'six',
    isLeaderDocument: async () => true,
    tabHasProtectedFrame: async () => false,
    attachDebugger: async () => true,
    detachDebugger: async () => {},
    subscribeDebuggerEvents: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    queryTabs: async () => [tab],
    queryActiveTabId: async () => 1,
    getTab: async () => tab,
    sendDebuggerCommand: async (_tab, method, params) => {
      sent.push({ method, params });
      return answer(method);
    },
  });
  await six.handleBridgePortConnect(port, deps);
  const raw = async (message) => {
    for (const f of listeners) f(message);
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 2));
      const reply = published.find((m) => m.kind === 'cdp.response' && m.id === message.id);
      if (reply) return reply;
    }
    return { timeout: true };
  };
  await raw({ bridge: 1, channelId: 'c', kind: 'handshake.hello' });
  await new Promise((r) => setTimeout(r, 10));
  let id = 0;
  const send = async (method, params, session) => {
    const reply = await raw({
      bridge: 1,
      channelId: 'c',
      kind: 'cdp.request',
      id: ++id,
      method,
      params,
      ...(session ? { sessionId: session } : {}),
    });
    return { error: reply.error, result: reply.result };
  };
  const attached = await send('Target.attachToTarget', { targetId: '1', flatten: true });
  const sessionId = attached.result.sessionId;
  return {
    sessionId,
    sent,
    send,
    fire(method, params) {
      for (const handler of handlers) handler(1, method, params);
    },
    async delivered(method) {
      for (let i = 0; i < 100; i++) {
        const found = published.find((m) => m.kind === 'cdp.event' && m.method === method);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 2));
      }
      return undefined;
    },
    close() {
      for (const f of closers) f();
      six.__clearTabShieldsForTest();
      chrome.webNavigation.getAllFrames = prior;
    },
  };
}

function message(error) {
  return typeof error === 'string' ? error : error?.message;
}

for (const [transport, open] of [
  ['seven', seven],
  ['six-bridge', sixBridge],
]) {
  for (const [method, params] of legacy) {
    for (const scoped of [true, false]) {
      test(`${transport}: ${method} ${scoped ? 'on a page session' : 'without a session'} is refused and never reaches the debugger`, async () => {
        const live = await open();
        try {
          const reply = await live.send(method, params, scoped ? live.sessionId : undefined);
          assert.equal(message(reply.error), refusals[method]);
          assert.equal(
            live.sent.some((s) => s.method === method),
            false
          );
        } finally {
          live.close();
        }
      });
    }
  }

  test(`${transport} control: Fetch interception on a page session still enables, delivers and fulfills`, async () => {
    const live = await open();
    try {
      const enabled = await live.send(
        'Fetch.enable',
        { patterns: [{ urlPattern: '*', requestStage: 'Response' }] },
        live.sessionId
      );
      assert.equal(enabled.error, undefined);
      assert.equal(
        live.sent.some(
          (s) =>
            s.method === 'Fetch.enable' &&
            s.params?.patterns?.some((p) => p.urlPattern === '*' && p.requestStage === 'Response')
        ),
        true
      );
      live.fire('Fetch.requestPaused', paused);
      const seen = await live.delivered('Fetch.requestPaused');
      assert.equal(seen?.params?.requestId, 'fetch-1');
      const fulfilled = await live.send(
        'Fetch.fulfillRequest',
        {
          requestId: 'fetch-1',
          responseCode: 200,
          responseHeaders: [{ name: 'set-cookie', value: 'sid=1; Path=/' }],
          body: btoa('ok'),
        },
        live.sessionId
      );
      assert.equal(fulfilled.error, undefined);
      assert.equal(
        live.sent.some(
          (s) => s.method === 'Fetch.fulfillRequest' && s.params?.requestId === 'fetch-1'
        ),
        true
      );
    } finally {
      live.close();
    }
  });
}

const shieldBundle = await build({
  entryPoints: ['six/extension/cdp-shield.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  define: { __SLICC_EXT_DEV__: 'false' },
});
const { TabShield } = await import(
  `data:text/javascript;base64,${Buffer.from(shieldBundle.outputFiles[0].text).toString('base64')}`
);

for (const [method, params] of legacy) {
  test(`six shield: ${method} is refused by the tab shield itself and never forwarded`, async () => {
    const tab = { id: 1, url: ordinary, title: 'ok', status: 'complete' };
    const shield = new TabShield(
      async (m) => answer(m),
      () => {},
      undefined,
      async () => tab,
      async () => tab,
      frames
    );
    const forwarded = [];
    await assert.rejects(
      shield.command(method, params, async (m) => {
        forwarded.push(m);
        return {};
      }),
      { message: refusals[method] }
    );
    assert.deepEqual(forwarded, []);
  });
}
