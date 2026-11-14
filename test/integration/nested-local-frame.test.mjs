import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { listen } from '../../extension/cdp.js';

const ORDINARY = 'https://ordinary.test/';
const CHILD = 'https://ordinary.test/child';
const GRAND = 'https://ordinary.test/grand';
const SIBLING = 'https://ordinary.test/sibling';
const VAULT = 'https://vault.sliccy.ai/mid';
const SRCDOC = 'about:srcdoc';

const bundled = await build({
  entryPoints: ['six/extension/cdp-shield.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { TabShield, Bounded } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function bus() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    async emit(...args) {
      for (const listener of listeners) await listener(...args);
    },
  };
}

function frame(id, url, parentId) {
  return {
    id,
    ...(parentId ? { parentId } : {}),
    loaderId: `${id}-loader`,
    url,
    securityOrigin: url.startsWith('about:') ? 'null' : new URL(url).origin,
    mimeType: 'text/html',
  };
}

function node(id, url, parentId, children = [], resources = []) {
  return {
    frame: frame(id, url, parentId),
    childFrames: children,
    resources,
  };
}

function rootOnly() {
  return node('root', ORDINARY, undefined, [], [{ url: ORDINARY, type: 'Document' }]);
}

function nested(grandUrl = GRAND) {
  const grand = node('grand', grandUrl, 'mid', [], [{ url: grandUrl, type: 'Document' }]);
  const src = node('src', SRCDOC, 'mid', [], [{ url: SRCDOC, type: 'Document' }]);
  const mid = node('mid', VAULT, 'root', [grand, src], [{ url: VAULT, type: 'Document' }]);
  return node('root', ORDINARY, undefined, [mid], [{ url: ORDINARY, type: 'Document' }]);
}

function ordinaryNest() {
  const grand = node('grand', GRAND, 'child', [], [{ url: GRAND, type: 'Document' }]);
  const child = node('child', CHILD, 'root', [grand], [{ url: CHILD, type: 'Document' }]);
  return node('root', ORDINARY, undefined, [child], [{ url: ORDINARY, type: 'Document' }]);
}

function names(tree) {
  const found = [];
  const walk = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (typeof entry.frame?.id === 'string') found.push(entry.frame.id);
    if (typeof entry.frame?.url === 'string') found.push(entry.frame.url);
    for (const resource of entry.resources ?? []) {
      if (typeof resource.url === 'string') found.push(resource.url);
    }
    for (const child of entry.childFrames ?? []) walk(child);
  };
  walk(tree);
  return found;
}

function sent(requestId, frameId, url, type) {
  return {
    requestId,
    frameId,
    loaderId: `${frameId}-loader`,
    documentURL: url,
    type,
    request: { url, method: 'GET', headers: {} },
    initiator: { type: 'other' },
  };
}

function received(requestId, frameId, url, type) {
  return {
    requestId,
    frameId,
    loaderId: `${frameId}-loader`,
    type,
    response: { url, status: 200, headers: { 'content-type': 'text/html' } },
  };
}

function extra(requestId) {
  return {
    requestId,
    statusCode: 200,
    headers: { 'content-type': 'text/html' },
  };
}

function context(id, frameId, origin) {
  return {
    context: {
      id,
      uniqueId: `${frameId}-context`,
      origin,
      auxData: { isDefault: true, frameId },
    },
  };
}

async function open(transport, initial) {
  const published = [];
  let tree = initial;
  const events = bus();
  const readTab = async () => ({ id: 1, url: ORDINARY, status: 'complete' });
  const readFrames = async () => [
    { frameId: 0, parentFrameId: -1, url: ORDINARY, errorOccurred: false },
  ];
  const send = async (method) => {
    if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree') {
      return { frameTree: structuredClone(tree) };
    }
    if (method === 'Page.getNavigationHistory') {
      return { currentIndex: 0, entries: [{ id: 1, url: ORDINARY }] };
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'Runtime.evaluate') {
      return { result: { type: 'string', value: 'https://ordinary.test' } };
    }
    return {};
  };
  let command;
  let emit;
  let prepareChild = () => {};
  let close = () => {};
  let session;
  if (transport === 'seven') {
    const connection = listen(
      {
        name: 'slicc-fetch',
        sender: { id: 'fixture', url: 'https://seven.sliccy.ai/' },
        onDisconnect: bus(),
        postMessage(message) {
          published.push(message);
        },
      },
      'fixture',
      {
        tabs: {
          get: readTab,
          query: async () => [],
          onUpdated: bus(),
          onCreated: bus(),
          onRemoved: bus(),
          onActivated: bus(),
        },
        windows: { onRemoved: bus() },
        webNavigation: {
          getAllFrames: readFrames,
          getFrame: async () => ({ url: ORDINARY, errorOccurred: false }),
          onCreatedNavigationTarget: bus(),
          onCommitted: bus(),
          onCompleted: bus(),
          onDOMContentLoaded: bus(),
          onErrorOccurred: bus(),
          onHistoryStateUpdated: bus(),
          onReferenceFragmentUpdated: bus(),
          onTabReplaced: bus(),
        },
        debugger: {
          onEvent: events,
          onDetach: bus(),
          attach: async () => {},
          detach: async () => {},
          sendCommand: async (_target, method) => send(method),
        },
      }
    );
    assert.ok(connection);
    ({ sessionId: session } = await connection.attach({ targetId: '1', flatten: true }));
    let id = 1;
    command = async (method, params = {}) => {
      const next = ++id;
      await connection.run({ id: next, method, params, sessionId: session });
      await connection.settled();
      return published.findLast((message) => message.id === next);
    };
    emit = async (method, params) => {
      await events.emit({ tabId: 1 }, method, params);
      await connection.settled();
    };
    prepareChild = (frameId) => {
      const tab = connection.tabState(1);
      tab.mainFrameId = 'root';
      tab.frames.set('root', false);
      tab.frames.set(frameId, true);
      tab.pendingFrames.add(frameId);
    };
    close = () => connection.close();
  } else {
    const failedDocuments = new Bounded(200);
    const shield = new TabShield(send, () => {}, failedDocuments, readTab, undefined, readFrames);
    await shield.install();
    command = async (method, params = {}) => {
      try {
        return { result: await shield.command(method, params, send) };
      } catch (error) {
        return { error: String(error.message ?? error) };
      }
    };
    emit = async (method, params) => {
      const delivered = await shield.onEvent(method, params);
      for (const message of delivered ?? []) published.push(message);
    };
    close = () => {};
  }
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Page.setLifecycleEventsEnabled', { enabled: true });
  const hit = (method, pred = () => true) =>
    published.some((message) => message.method === method && pred(message.params ?? {}));
  return {
    command,
    emit,
    close,
    hit,
    prepareChild,
    setTree(next) {
      tree = next;
    },
  };
}

async function showMid(fixture) {
  await fixture.emit('Page.frameNavigated', { frame: frame('mid', VAULT, 'root') });
  assert.equal(
    fixture.hit('Page.frameNavigated', (params) => params.frame?.id === 'mid'),
    false
  );
  await fixture.emit('Page.frameAttached', { frameId: 'mid', parentFrameId: 'root' });
  assert.equal(
    fixture.hit('Page.frameAttached', (params) => params.frameId === 'mid'),
    false
  );
}

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport}: a protected frame already in the tree keeps its local frames hidden`, async (t) => {
    if (transport === 'six-bridge') {
      await assert.rejects(() => open(transport, nested()), /slicc: refused:/);
      return;
    }
    const fixture = await open(transport, nested());
    t.after(fixture.close);
    await fixture.emit('Page.frameAttached', { frameId: 'mid', parentFrameId: 'root' });
    await fixture.emit('Page.frameAttached', { frameId: 'grand', parentFrameId: 'mid' });
    await fixture.emit('Page.frameNavigated', { frame: frame('grand', GRAND, 'mid') });
    await fixture.emit('Page.frameNavigated', { frame: frame('src', SRCDOC, 'mid') });
    await fixture.emit(
      'Runtime.executionContextCreated',
      context(3, 'grand', 'https://ordinary.test')
    );
    await fixture.emit('Runtime.executionContextCreated', context(4, 'src', 'null'));
    assert.equal(
      fixture.hit('Page.frameAttached', (params) => params.frameId === 'mid'),
      false
    );
    assert.equal(
      fixture.hit('Page.frameAttached', (params) => params.frameId === 'grand'),
      false
    );
    assert.equal(
      fixture.hit('Page.frameNavigated', (params) => params.frame?.id === 'grand'),
      false
    );
    assert.equal(
      fixture.hit('Page.frameNavigated', (params) => params.frame?.url === SRCDOC),
      false
    );
    assert.equal(
      fixture.hit(
        'Runtime.executionContextCreated',
        (params) => params.context?.auxData?.frameId === 'grand'
      ),
      false
    );
    assert.equal(
      fixture.hit('Runtime.executionContextCreated', (params) => params.context?.origin === 'null'),
      false
    );
    for (const method of ['Page.getFrameTree', 'Page.getResourceTree']) {
      const reply = await fixture.command(method);
      assert.equal(reply.error, undefined, method);
      const listed = names(reply.result?.frameTree);
      assert.equal(listed.includes('root'), true, method);
      assert.equal(listed.includes('grand'), false, method);
      assert.equal(listed.includes('src'), false, method);
      assert.equal(listed.includes(GRAND), false, method);
      assert.equal(listed.includes(VAULT), false, method);
    }
  });

  test(`${transport}: a protected frame that appears later keeps its local frames hidden`, async (t) => {
    const fixture = await open(transport, rootOnly());
    t.after(fixture.close);
    await showMid(fixture);
    await fixture.emit('Page.frameAttached', { frameId: 'grand', parentFrameId: 'mid' });
    await fixture.emit('Page.frameNavigated', { frame: frame('grand', GRAND, 'mid') });
    await fixture.emit('Page.frameAttached', { frameId: 'src', parentFrameId: 'mid' });
    await fixture.emit('Page.frameNavigated', { frame: frame('src', SRCDOC, 'mid') });
    await fixture.emit('Network.requestWillBeSent', sent('grand-doc', 'grand', GRAND, 'Document'));
    await fixture.emit(
      'Network.responseReceived',
      received('grand-doc', 'grand', GRAND, 'Document')
    );
    await fixture.emit('Network.responseReceivedExtraInfo', extra('grand-doc'));
    await fixture.emit(
      'Network.requestWillBeSent',
      sent('grand-script', 'grand', SIBLING, 'Script')
    );
    await fixture.emit(
      'Network.responseReceived',
      received('grand-script', 'grand', SIBLING, 'Script')
    );
    await fixture.emit('Network.responseReceivedExtraInfo', extra('grand-script'));
    await fixture.emit('Network.requestWillBeSent', sent('src-doc', 'src', SRCDOC, 'Document'));
    await fixture.emit('Network.responseReceived', received('src-doc', 'src', SRCDOC, 'Document'));
    await fixture.emit(
      'Runtime.executionContextCreated',
      context(3, 'grand', 'https://ordinary.test')
    );
    await fixture.emit('Runtime.executionContextCreated', context(4, 'src', 'null'));
    fixture.setTree(nested());
    assert.equal(
      fixture.hit('Page.frameAttached', (params) => params.frameId === 'grand'),
      false
    );
    assert.equal(
      fixture.hit(
        'Page.frameNavigated',
        (params) => params.frame?.id === 'grand' && params.frame?.parentId === 'mid'
      ),
      false
    );
    assert.equal(
      fixture.hit(
        'Page.frameNavigated',
        (params) =>
          params.frame?.id === 'src' &&
          params.frame?.url === SRCDOC &&
          params.frame?.securityOrigin === 'null' &&
          params.frame?.parentId === 'mid'
      ),
      false
    );
    for (const requestId of ['grand-doc', 'grand-script', 'src-doc']) {
      assert.equal(
        fixture.hit('Network.requestWillBeSent', (params) => params.requestId === requestId),
        false,
        requestId
      );
      assert.equal(
        fixture.hit('Network.responseReceived', (params) => params.requestId === requestId),
        false,
        requestId
      );
      assert.equal(
        fixture.hit(
          'Network.responseReceivedExtraInfo',
          (params) => params.requestId === requestId
        ),
        false,
        requestId
      );
    }
    assert.equal(
      fixture.hit(
        'Runtime.executionContextCreated',
        (params) => params.context?.auxData?.frameId === 'grand'
      ),
      false
    );
    assert.equal(
      fixture.hit(
        'Runtime.executionContextCreated',
        (params) => params.context?.auxData?.frameId === 'src'
      ),
      false
    );
    for (const method of ['Page.getFrameTree', 'Page.getResourceTree']) {
      const reply = await fixture.command(method);
      assert.equal(reply.error, undefined, method);
      const listed = names(reply.result?.frameTree);
      assert.equal(listed.includes('root'), true, method);
      assert.equal(listed.includes('grand'), false, method);
      assert.equal(listed.includes(GRAND), false, method);
      assert.equal(listed.includes(VAULT), false, method);
    }
  });

  test(`${transport}: an event waits until its parent is known, then follows that parent`, async (t) => {
    const fixture = await open(transport, rootOnly());
    t.after(fixture.close);
    await showMid(fixture);
    await fixture.emit('Network.responseReceived', received('late', 'late', SIBLING, 'Script'));
    await fixture.emit('Network.responseReceivedExtraInfo', extra('late'));
    assert.equal(
      fixture.hit('Network.responseReceived', (params) => params.requestId === 'late'),
      false
    );
    await fixture.emit('Page.frameNavigated', { frame: frame('late', SIBLING, 'root') });
    assert.equal(
      fixture.hit('Network.responseReceived', (params) => params.requestId === 'late'),
      true
    );
    assert.equal(
      fixture.hit('Network.responseReceivedExtraInfo', (params) => params.requestId === 'late'),
      true
    );
    assert.equal(
      fixture.hit(
        'Page.frameNavigated',
        (params) => params.frame?.id === 'late' && params.frame?.parentId === 'root'
      ),
      true
    );
    await fixture.emit('Network.responseReceived', received('doomed', 'doomed', SIBLING, 'Script'));
    assert.equal(
      fixture.hit('Network.responseReceived', (params) => params.requestId === 'doomed'),
      false
    );
    await fixture.emit('Page.frameNavigated', { frame: frame('doomed', SIBLING, 'mid') });
    assert.equal(
      fixture.hit('Network.responseReceived', (params) => params.requestId === 'doomed'),
      false
    );
    assert.equal(
      fixture.hit('Page.frameNavigated', (params) => params.frame?.id === 'doomed'),
      false
    );
  });

  test(`${transport}: an ordinary parent and its local child stay visible`, async (t) => {
    const fixture = await open(transport, rootOnly());
    t.after(fixture.close);
    await fixture.emit('Network.responseReceived', received('early', 'early', SIBLING, 'Script'));
    assert.equal(
      fixture.hit('Network.responseReceived', (params) => params.requestId === 'early'),
      true
    );
    await fixture.emit('Page.frameAttached', { frameId: 'child', parentFrameId: 'root' });
    await fixture.emit('Page.frameNavigated', { frame: frame('child', CHILD, 'root') });
    await fixture.emit('Page.frameAttached', { frameId: 'grand', parentFrameId: 'child' });
    await fixture.emit('Page.frameNavigated', { frame: frame('grand', GRAND, 'child') });
    await fixture.emit('Network.requestWillBeSent', sent('grand-doc', 'grand', GRAND, 'Document'));
    await fixture.emit(
      'Network.responseReceived',
      received('grand-doc', 'grand', GRAND, 'Document')
    );
    await fixture.emit('Network.responseReceivedExtraInfo', extra('grand-doc'));
    await fixture.emit(
      'Runtime.executionContextCreated',
      context(3, 'grand', 'https://ordinary.test')
    );
    fixture.setTree(ordinaryNest());
    assert.equal(
      fixture.hit('Page.frameAttached', (params) => params.frameId === 'child'),
      true
    );
    assert.equal(
      fixture.hit(
        'Page.frameNavigated',
        (params) =>
          params.frame?.id === 'grand' &&
          params.frame?.url === GRAND &&
          params.frame?.securityOrigin === 'https://ordinary.test' &&
          params.frame?.parentId === 'child'
      ),
      true
    );
    assert.equal(
      fixture.hit('Network.responseReceived', (params) => params.requestId === 'grand-doc'),
      true
    );
    assert.equal(
      fixture.hit(
        'Network.responseReceivedExtraInfo',
        (params) => params.requestId === 'grand-doc'
      ),
      true
    );
    assert.equal(
      fixture.hit(
        'Runtime.executionContextCreated',
        (params) => params.context?.auxData?.frameId === 'grand'
      ),
      true
    );
    for (const method of ['Page.getFrameTree', 'Page.getResourceTree']) {
      const reply = await fixture.command(method);
      assert.equal(reply.error, undefined, method);
      const listed = names(reply.result?.frameTree);
      assert.equal(listed.includes('grand'), true, method);
      assert.equal(listed.includes(GRAND), true, method);
    }
  });

  test(`${transport}: an ordinary child document still reaches the client`, async (t) => {
    const fixture = await open(transport, rootOnly());
    t.after(fixture.close);
    fixture.prepareChild('child');
    await fixture.emit(
      'Network.responseReceived',
      received('child-doc', 'child', CHILD, 'Document')
    );
    await fixture.emit('Network.responseReceivedExtraInfo', extra('child-doc'));
    if (transport === 'seven') {
      assert.equal(
        fixture.hit('Network.responseReceived', (params) => params.requestId === 'child-doc'),
        false
      );
    }
    await fixture.emit('Page.frameNavigated', { frame: frame('child', CHILD, 'root') });
    assert.equal(
      fixture.hit('Network.responseReceived', (params) => params.requestId === 'child-doc'),
      true
    );
    assert.equal(
      fixture.hit(
        'Network.responseReceivedExtraInfo',
        (params) => params.requestId === 'child-doc'
      ),
      true
    );
    assert.equal(
      fixture.hit(
        'Page.frameNavigated',
        (params) => params.frame?.id === 'child' && params.frame?.parentId === 'root'
      ),
      true
    );
  });
}
