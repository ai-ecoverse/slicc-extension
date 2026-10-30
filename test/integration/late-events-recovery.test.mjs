import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listen } from '../../extension/cdp.js';

const vault = 'http://vault.sliccy.ai:45903/vault';
const ordinary = 'http://localhost:36295/recovery-hop.html';
const destination = 'http://localhost:36295/recovery-destination.html';
const refused = "slicc: refused: target is on seven's origin";
const errorPage = 'chrome-error://chromewebdata/';
const root = (url, loaderId = 'HOP') => ({
  id: 'MAIN',
  url,
  loaderId,
  securityOrigin: new URL(url).origin,
});
const errorFrame = {
  ...root(errorPage, 'ERROR'),
  securityOrigin: '://',
  unreachableUrl: vault,
};

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    fire: (...args) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

function fixture() {
  const calls = [];
  const posted = [];
  let live = { id: 7, url: ordinary, pendingUrl: '', status: 'complete' };
  let frame = root(ordinary);
  let beforeGet;
  const api = {
    tabs: {
      async get() {
        if (beforeGet) {
          const run = beforeGet;
          beforeGet = undefined;
          await run();
        }
        return { ...live };
      },
      async query() {
        return [];
      },
      onUpdated: event(),
      onCreated: event(),
      onRemoved: event(),
      onActivated: event(),
    },
    debugger: {
      async attach() {},
      async detach() {},
      async sendCommand(target, method, params) {
        calls.push({ method, params });
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { ...frame } } };
        if (method === 'Page.getNavigationHistory') {
          return { currentIndex: 0, entries: [{ id: 1, url: live.url }] };
        }
        if (method === 'Runtime.enable') {
          api.debugger.onEvent.fire(target, 'Runtime.executionContextCreated', {
            context: {
              id: 9999,
              uniqueId: 'fake-main',
              origin: frame.securityOrigin,
              auxData: { frameId: 'MAIN', isDefault: true },
            },
          });
        }
        if (method === 'Runtime.evaluate') return { result: { type: 'object', objectId: 'probe' } };
        return {};
      },
      onEvent: event(),
      onDetach: event(),
    },
    webNavigation: {
      async getFrame() {
        return { frameId: 0, url: live.url, errorOccurred: frame.url === errorPage };
      },
      async getAllFrames() {
        return [{ frameId: 0, url: live.url, errorOccurred: frame.url === errorPage }];
      },
      onCreatedNavigationTarget: event(),
    },
  };
  const port = {
    name: 'slicc-fetch',
    sender: { id: 'ext', url: 'https://seven.sliccy.ai/' },
    postMessage: (message) => posted.push(message),
    onDisconnect: event(),
  };
  const cdp = listen(port, 'ext', api);
  assert.ok(cdp);
  let id = 0;
  const send = async (method, params = {}, sessionId) => {
    const requestId = ++id;
    assert.equal(cdp.handle({ id: requestId, method, params, sessionId }), true);
    await cdp.settled();
    return posted.find((message) => message.id === requestId);
  };
  const commit = (next) =>
    api.debugger.onEvent.fire({ tabId: 7 }, 'Page.frameNavigated', { frame: next });
  const updated = () => api.tabs.onUpdated.fire(7, { url: ordinary }, { id: 7, url: ordinary });
  const drain = () => new Promise((resolve) => setImmediate(resolve));
  return {
    api,
    calls,
    posted,
    send,
    commit,
    updated,
    drain,
    beforeGet: (run) => {
      beforeGet = run;
    },
    live: (url, next = root(url)) => {
      live = { ...live, url };
      frame = next;
    },
    async start() {
      const answer = await send('Target.attachToTarget', { targetId: '7', flatten: true });
      assert.equal(answer.error, undefined);
      commit(root(ordinary));
      return answer.result.sessionId;
    },
    async block(requestId = 'BLOCK') {
      api.debugger.onEvent.fire({ tabId: 7 }, 'Fetch.requestPaused', {
        requestId,
        frameId: 'MAIN',
        resourceType: 'Document',
        request: { url: vault, method: 'GET' },
      });
      await drain();
      assert.ok(
        calls.some(
          (call) => call.method === 'Fetch.failRequest' && call.params.requestId === requestId
        )
      );
      live = { ...live, url: vault };
      frame = errorFrame;
      commit(errorFrame);
    },
    close: () => port.onDisconnect.fire(),
  };
}

const orderings = [
  [
    'late ordinary root commit',
    async (f) => {
      f.commit(root(ordinary));
      f.commit(errorFrame);
    },
  ],
  [
    'late ordinary tab update',
    async (f) => {
      f.updated();
      await f.drain();
    },
  ],
  [
    'second block after ordinary commit',
    async (f) => {
      f.commit(root(ordinary));
      await f.block('SECOND');
    },
  ],
  [
    'second block before late tab update',
    async (f) => {
      await f.block('SECOND');
      f.updated();
      await f.drain();
    },
  ],
  [
    'tab update during live read',
    async (f) => {
      f.beforeGet(f.updated);
    },
  ],
  ['tab update between attach and navigate', async () => {}, true],
];

for (const [name, arrange, afterAttach] of orderings) {
  test(`late recovery: ${name}`, async () => {
    const f = fixture();
    try {
      await f.start();
      await f.block();
      await arrange(f);
      const attached = await f.send('Target.attachToTarget', { targetId: '7', flatten: true });
      assert.equal(attached.error, undefined, 'error document remains attachable');
      if (afterAttach) {
        f.updated();
        await f.drain();
      }
      const navigation = await f.send(
        'Page.navigate',
        { url: destination },
        attached.result.sessionId
      );
      assert.equal(navigation.error, undefined, 'recovery navigation remains admitted');
      assert.ok(
        f.calls.some((call) => call.method === 'Page.navigate' && call.params.url === destination)
      );
    } finally {
      f.close();
    }
  });
}

for (const name of [
  'live protected return',
  'unblocked error document',
  'ordinary commit clears recovery',
  'live view is not an error page',
]) {
  test(`late recovery negative: ${name}`, async () => {
    const f = fixture();
    try {
      const sessionId = await f.start();
      if (name !== 'unblocked error document') {
        await f.block();
        f.live(destination);
        f.commit(root(destination, 'DESTINATION'));
        f.updated();
        await f.drain();
      }
      if (name === 'ordinary commit clears recovery') {
        const ordinaryAttach = await f.send('Target.attachToTarget', {
          targetId: '7',
          flatten: true,
        });
        assert.equal(ordinaryAttach.error, undefined);
      }
      const isError = name === 'unblocked error document';
      f.live(vault, isError ? errorFrame : root(vault, 'LIVE'));
      if (isError) f.commit(errorFrame);
      const at = f.calls.length;
      const attach = await f.send('Target.attachToTarget', { targetId: '7', flatten: true });
      assert.equal(attach.error, refused);
      const navigate = await f.send('Page.navigate', { url: destination }, sessionId);
      assert.equal(navigate.error, refused);
      assert.equal(
        f.calls.slice(at).some((call) => call.method === 'Page.navigate'),
        false
      );
    } finally {
      f.close();
    }
  });
}
