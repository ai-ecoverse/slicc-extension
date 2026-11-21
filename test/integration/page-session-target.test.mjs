import assert from 'node:assert/strict';
import { test } from 'node:test';
import catalog from '@ai-ecoverse/slicc-browsers' with { type: 'json' };
import { build } from 'esbuild';

const NOT_ALLOWED = '{"code":-32000,"message":"Not allowed"}';
const RELATED = 'slicc: refused: Target.autoAttachRelated is not supported: attach to each target';
const FLATTEN = 'slicc: refused: only flatten: true is supported';
const AUTO = 'slicc: refused: auto-attach is not supported by the extension bridge';
const SESSIONLESS = 'No tab attached for sessionId: (none). Attach to a target first.';
const PROTECTED = catalog.protectedOrigins.refusal;

const tabs = new Map([
  [1, { id: 1, url: 'https://ordinary.test/start', title: 'one', status: 'complete' }],
  [2, { id: 2, url: 'https://ordinary.test/second', title: 'two', status: 'complete' }],
  [3, { id: 3, url: 'https://vault.sliccy.ai/', title: 'vault', status: 'complete' }],
]);

globalThis.chrome = {
  webNavigation: {
    getAllFrames: async ({ tabId }) => [
      {
        frameId: 0,
        parentFrameId: -1,
        url: tabs.get(tabId)?.url ?? '',
        errorOccurred: false,
        documentId: `D${tabId}`,
        documentLifecycle: 'active',
      },
    ],
  },
  storage: { session: { get: async () => ({}), set: async () => {} } },
  runtime: { id: 'fx' },
};

async function bundle(entry) {
  const built = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    define: { __SLICC_EXT_DEV__: 'false' },
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
  );
}

const six = await bundle('six/extension/bridge-sw.ts');

function answer(tabId, method) {
  const tab = tabs.get(tabId);
  if (method === 'Target.autoAttachRelated') throw new Error(NOT_ALLOWED);
  if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree') {
    return {
      frameTree: {
        frame: {
          id: `ROOT${tabId}`,
          loaderId: 'L1',
          url: tab.url,
          securityOrigin: new URL(tab.url).origin,
          mimeType: 'text/html',
        },
      },
    };
  }
  if (method === 'Page.getNavigationHistory') {
    return { currentIndex: 0, entries: [{ id: 1, url: tab.url, title: tab.title }] };
  }
  if (method === 'Target.getTargetInfo') {
    return {
      targetInfo: {
        targetId: String(tabId),
        type: 'page',
        url: tab.url,
        title: tab.title,
        attached: true,
      },
    };
  }
  return {};
}

async function sixBridge() {
  six.__clearTabShieldsForTest();
  six.__clearWelcomedLeaderPortsForTest();
  const sent = [];
  const attached = [];
  const detached = [];
  const published = [];
  const listeners = new Set();
  const closers = new Set();
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
  const deps = six.buildDefaultBridgeSwDeps({
    readStoredLeaderTabId: async () => 99,
    readLeaderKind: async () => 'six',
    isLeaderDocument: async () => true,
    tabHasProtectedFrame: async () => false,
    attachDebugger: async (tabId) => {
      attached.push(tabId);
      return true;
    },
    detachDebugger: async (tabId) => {
      detached.push(tabId);
    },
    subscribeDebuggerEvents: () => () => {},
    queryTabs: async () => [...tabs.values()],
    queryActiveTabId: async () => 1,
    getTab: async (tabId) => tabs.get(tabId),
    sendDebuggerCommand: async (tabId, method, params) => {
      sent.push({ tabId, method, params });
      return answer(tabId, method);
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
  const first = await send('Target.attachToTarget', { targetId: '1', flatten: true });
  assert.equal(first.result?.sessionId, '1');
  const mark = () => ({
    sent: sent.length,
    published: published.length,
    attached: attached.length,
  });
  return {
    sessionId: first.result.sessionId,
    sent,
    attached,
    detached,
    published,
    send,
    mark,
    since: (at) => ({
      sent: sent.slice(at.sent),
      published: published.slice(at.published),
      attached: attached.slice(at.attached),
    }),
    close() {
      for (const f of closers) f();
      six.__clearTabShieldsForTest();
    },
  };
}

test('six-bridge: a page session refuses Target.autoAttachRelated and sends nothing to the debugger', async () => {
  const live = await sixBridge();
  try {
    const at = live.mark();
    const reply = await live.send(
      'Target.autoAttachRelated',
      { targetId: '1', waitForDebuggerOnStart: false },
      live.sessionId
    );
    assert.equal(reply.error, RELATED);
    assert.deepEqual(live.since(at).sent, []);
  } finally {
    live.close();
  }
});

for (const [label, params] of [
  ['without flatten', { targetId: '2' }],
  ['with flatten: false', { targetId: '2', flatten: false }],
  ["with flatten: 'true'", { targetId: '2', flatten: 'true' }],
  ['with flatten: null', { targetId: '2', flatten: null }],
  ['with flatten: undefined', { targetId: '2', flatten: undefined }],
]) {
  for (const scoped of [true, false]) {
    test(`six-bridge: ${scoped ? 'a page session' : 'a command without a session'} refuses Target.attachToTarget ${label} and attaches nothing`, async () => {
      const live = await sixBridge();
      try {
        const at = live.mark();
        const reply = await live.send(
          'Target.attachToTarget',
          params,
          scoped ? live.sessionId : undefined
        );
        assert.equal(reply.error, FLATTEN);
        assert.equal(reply.result, undefined);
        const after = live.since(at);
        assert.deepEqual(after.sent, []);
        assert.deepEqual(after.attached, []);
        assert.equal(
          after.published.some((m) => m.method === 'Target.attachedToTarget'),
          false
        );
        const later = await live.send('Runtime.enable', {}, '2');
        assert.equal(later.error, 'No tab attached for sessionId: 2. Attach to a target first.');
      } finally {
        live.close();
      }
    });
  }
}

const announced = {
  bridge: 1,
  channelId: 'c',
  kind: 'cdp.event',
  method: 'Target.attachedToTarget',
  params: {
    sessionId: '2',
    targetInfo: {
      targetId: '2',
      type: 'page',
      title: 'two',
      url: 'https://ordinary.test/second',
      attached: true,
      canAccessOpener: false,
    },
    waitingForDebugger: false,
  },
};

for (const scoped of [true, false]) {
  test(`six-bridge: Target.attachToTarget with flatten: true ${scoped ? 'on a page session' : 'without a session'} attaches an ordinary tab and detaches it`, async () => {
    const live = await sixBridge();
    try {
      const at = live.mark();
      const reply = await live.send(
        'Target.attachToTarget',
        { targetId: '2', flatten: true },
        scoped ? live.sessionId : undefined
      );
      assert.equal(reply.error, undefined);
      assert.deepEqual(reply.result, { sessionId: '2' });
      const after = live.since(at);
      assert.deepEqual(after.attached, [2]);
      assert.deepEqual(
        after.published.map((m) => (m.kind === 'cdp.event' ? m : { kind: m.kind, id: m.id })),
        [announced, { kind: 'cdp.response', id: 2 }]
      );
      const ran = await live.send('Runtime.enable', {}, '2');
      assert.equal(ran.error, undefined);
      const gone = await live.send('Target.detachFromTarget', { sessionId: '2' });
      assert.deepEqual(gone.result, {});
      assert.deepEqual(live.detached, [2]);
      const later = await live.send('Runtime.enable', {}, '2');
      assert.equal(later.error, 'No tab attached for sessionId: 2. Attach to a target first.');
    } finally {
      live.close();
    }
  });

  test(`six-bridge: Target.attachToTarget with flatten: true ${scoped ? 'on a page session' : 'without a session'} refuses a protected tab`, async () => {
    const live = await sixBridge();
    try {
      const at = live.mark();
      const reply = await live.send(
        'Target.attachToTarget',
        { targetId: '3', flatten: true },
        scoped ? live.sessionId : undefined
      );
      assert.equal(reply.error, PROTECTED);
      const after = live.since(at);
      assert.deepEqual(after.attached, []);
      assert.deepEqual(after.sent, []);
      assert.equal(
        after.published.some((m) => m.method === 'Target.attachedToTarget'),
        false
      );
    } finally {
      live.close();
    }
  });
}

test('six-bridge: a page session answers Target.setAutoAttach {autoAttach: false} with {} and sends nothing to the debugger', async () => {
  const live = await sixBridge();
  try {
    const at = live.mark();
    const reply = await live.send(
      'Target.setAutoAttach',
      { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
      live.sessionId
    );
    assert.equal(reply.error, undefined);
    assert.deepEqual(reply.result, {});
    assert.deepEqual(live.since(at).sent, []);
  } finally {
    live.close();
  }
});

test('six-bridge: a page session refuses Target.setAutoAttach {autoAttach: true} and never forwards it', async () => {
  const live = await sixBridge();
  try {
    const reply = await live.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      live.sessionId
    );
    assert.equal(reply.error, AUTO);
    assert.equal(
      live.sent.some((s) => s.method === 'Target.setAutoAttach'),
      false
    );
  } finally {
    live.close();
  }
});

test('six-bridge: without a session, Target.autoAttachRelated and Target.setAutoAttach answer that no tab is attached and send nothing', async () => {
  const live = await sixBridge();
  try {
    const at = live.mark();
    const related = await live.send('Target.autoAttachRelated', {
      targetId: '1',
      waitForDebuggerOnStart: false,
    });
    const on = await live.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    const off = await live.send('Target.setAutoAttach', {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    assert.equal(related.error, SESSIONLESS);
    assert.equal(on.error, SESSIONLESS);
    assert.equal(off.error, SESSIONLESS);
    assert.deepEqual(live.since(at).sent, []);
  } finally {
    live.close();
  }
});
