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

function paused(requestId, frameId, url, type = 'Script') {
  return {
    requestId,
    frameId,
    networkId: `${requestId}-net`,
    resourceType: type,
    request: { url, method: 'GET', headers: {} },
  };
}

async function open(transport, initial) {
  const published = [];
  const continued = [];
  let tree = initial;
  const events = bus();
  const readTab = async () => ({ id: 1, url: ORDINARY, status: 'complete' });
  const readFrames = async () => [
    { frameId: 0, parentFrameId: -1, url: ORDINARY, errorOccurred: false },
  ];
  const send = async (method, params = {}) => {
    if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest') {
      continued.push({ method, ...(params ?? {}) });
      return {};
    }
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
    if (method === 'DOM.getDocument') return { root: { nodeId: 1, backendNodeId: 1 } };
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
    if (method === 'DOMSnapshot.captureSnapshot') return { documents: [], strings: [] };
    return {};
  };
  let command;
  let emit;
  let prepareChild = () => {};
  let close = () => {};
  let session;
  let tabOf = () => undefined;
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
          sendCommand: async (_target, method, params) => send(method, params),
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
    tabOf = () => connection.tabState(1);
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
    tabOf = () => shield;
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
    tabOf,
    continued,
    setTree(next) {
      tree = next;
    },
  };
}

async function showMidChromeOrder(fixture) {
  await fixture.emit('Page.frameAttached', { frameId: 'mid', parentFrameId: 'root' });
  assert.equal(
    fixture.hit('Page.frameAttached', (params) => params.frameId === 'mid'),
    true
  );
  await fixture.emit('Page.frameNavigated', { frame: frame('mid', VAULT, 'root') });
  assert.equal(
    fixture.hit('Page.frameNavigated', (params) => params.frame?.id === 'mid'),
    false
  );
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

test('six-bridge: an isolated extension world stays hidden and the tab stays open', async (t) => {
  const fixture = await open('six-bridge', rootOnly());
  t.after(fixture.close);
  await fixture.emit('Runtime.executionContextCreated', {
    context: {
      id: 21,
      origin: 'chrome-extension://abcdefghijklmnop',
      name: 'ext',
      auxData: { isDefault: false, frameId: 'root' },
    },
  });
  assert.equal(
    fixture.hit('Runtime.executionContextCreated', (params) => params.context?.id === 21),
    false
  );
  const enabled = await fixture.command('Page.enable');
  assert.equal(enabled.error, undefined);
});

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport}: attach before navigate keeps the grandchild hidden`, async (t) => {
    const fixture = await open(transport, rootOnly());
    t.after(fixture.close);
    await showMidChromeOrder(fixture);
    await fixture.emit('Page.frameAttached', { frameId: 'grand', parentFrameId: 'mid' });
    await fixture.emit('Page.frameNavigated', { frame: frame('grand', GRAND, 'mid') });
    assert.equal(
      fixture.hit('Page.frameAttached', (params) => params.frameId === 'grand'),
      false
    );
    assert.equal(
      fixture.hit('Page.frameNavigated', (params) => params.frame?.id === 'grand'),
      false
    );
  });

  test(`${transport}: an ordinary child's attach still reaches the client`, async (t) => {
    const fixture = await open(transport, rootOnly());
    t.after(fixture.close);
    await fixture.emit('Page.frameAttached', { frameId: 'child', parentFrameId: 'root' });
    await fixture.emit('Page.frameNavigated', { frame: frame('child', CHILD, 'root') });
    assert.equal(
      fixture.hit('Page.frameAttached', (params) => params.frameId === 'child'),
      true
    );
    assert.equal(
      fixture.hit('Page.frameNavigated', (params) => params.frame?.id === 'child'),
      true
    );
  });

  test(`${transport}: a never-committing ordinary iframe's attach is delivered`, async (t) => {
    const fixture = await open(transport, rootOnly());
    t.after(fixture.close);
    await fixture.emit('Page.frameAttached', { frameId: 'hung', parentFrameId: 'root' });
    assert.equal(
      fixture.hit('Page.frameAttached', (params) => params.frameId === 'hung'),
      true
    );
  });

  test(`${transport}: a slow-commit ordinary iframe stays consistent`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    const fixture = await open(transport, rootOnly());
    t.after(fixture.close);
    await fixture.emit('Page.frameAttached', { frameId: 'slow', parentFrameId: 'root' });
    assert.equal(
      fixture.hit('Page.frameAttached', (params) => params.frameId === 'slow'),
      true
    );
    t.mock.timers.tick(10_001);
    await fixture.emit('Page.frameNavigated', { frame: frame('slow', CHILD, 'root') });
    assert.equal(
      fixture.hit('Page.frameAttached', (params) => params.frameId === 'slow'),
      true
    );
    assert.equal(
      fixture.hit('Page.frameNavigated', (params) => params.frame?.id === 'slow'),
      true
    );
  });

  test(`${transport}: a hidden context's console, exception and script stay hidden`, async (t) => {
    const fixture = await open(transport, rootOnly());
    t.after(fixture.close);
    await showMid(fixture);
    await fixture.emit('Page.frameAttached', { frameId: 'grand', parentFrameId: 'mid' });
    await fixture.emit('Page.frameNavigated', { frame: frame('grand', GRAND, 'mid') });
    await fixture.emit(
      'Runtime.executionContextCreated',
      context(3, 'grand', 'https://ordinary.test')
    );
    assert.equal(
      fixture.hit(
        'Runtime.executionContextCreated',
        (params) => params.context?.auxData?.frameId === 'grand'
      ),
      false
    );
    await fixture.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'secret' }],
      executionContextId: 3,
    });
    await fixture.emit('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'boom',
        executionContextId: 3,
        url: `${GRAND}/x.js`,
      },
    });
    await fixture.emit('Debugger.scriptParsed', {
      scriptId: '1',
      url: `${GRAND}/x.js`,
      executionContextId: 3,
    });
    assert.equal(
      fixture.hit('Runtime.consoleAPICalled', (params) => params.executionContextId === 3),
      false
    );
    assert.equal(
      fixture.hit(
        'Runtime.exceptionThrown',
        (params) => params.exceptionDetails?.executionContextId === 3
      ),
      false
    );
    assert.equal(
      fixture.hit('Debugger.scriptParsed', (params) => params.executionContextId === 3),
      false
    );
    const evaluated = await fixture.command('Runtime.evaluate', {
      expression: '1',
      contextId: 3,
      returnByValue: true,
    });
    assert.equal(evaluated.error !== undefined, true);
  });

  test(`${transport}: an unresolved chain stays held until the parent commits protected`, async (t) => {
    const fixture = await open(transport, rootOnly());
    t.after(fixture.close);
    await showMid(fixture);
    await fixture.emit(
      'Network.responseReceived',
      received('held-chain', 'ghost-child', SIBLING, 'Script')
    );
    assert.equal(
      fixture.hit('Network.responseReceived', (params) => params.requestId === 'held-chain'),
      false
    );
    await fixture.emit('Page.frameAttached', {
      frameId: 'ghost-child',
      parentFrameId: 'ghost-parent',
    });
    assert.equal(
      fixture.hit('Network.responseReceived', (params) => params.requestId === 'held-chain'),
      false
    );
    assert.equal(
      fixture.hit('Page.frameAttached', (params) => params.frameId === 'ghost-child'),
      false
    );
    await fixture.emit('Page.frameNavigated', {
      frame: frame('ghost-parent', VAULT, 'root'),
    });
    assert.equal(
      fixture.hit('Network.responseReceived', (params) => params.requestId === 'held-chain'),
      false
    );
    assert.equal(
      fixture.hit('Page.frameAttached', (params) => params.frameId === 'ghost-child'),
      false
    );
  });

  test(`${transport}: held events stay bounded by frame count and deadline`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    const fixture = await open(transport, rootOnly());
    t.after(fixture.close);
    await showMid(fixture);
    for (let index = 0; index < 33; index++) {
      const id = `cap-${index}`;
      await fixture.emit(
        'Network.responseReceived',
        received(`cap-req-${index}`, id, `${SIBLING}/${id}`, 'Script')
      );
    }
    assert.equal(
      fixture.hit('Network.responseReceived', (params) => params.requestId === 'cap-req-0'),
      false
    );
    {
      const held = fixture.tabOf().unresolved;
      assert.ok(held.size <= 32);
    }
    await fixture.emit(
      'Network.responseReceived',
      received('deadline-req', 'deadline-frame', `${SIBLING}/deadline`, 'Script')
    );
    assert.equal(
      fixture.hit('Network.responseReceived', (params) => params.requestId === 'deadline-req'),
      false
    );
    t.mock.timers.tick(10_001);
    await fixture.emit('Page.frameNavigated', {
      frame: frame('deadline-frame', `${SIBLING}/deadline`, 'root'),
    });
    assert.equal(
      fixture.hit('Network.responseReceived', (params) => params.requestId === 'deadline-req'),
      false
    );
  });

  test(`${transport}: DOM, AX, Fetch and evaluate into a hidden grandchild are refused`, async (t) => {
    const fixture = await open(transport, rootOnly());
    t.after(fixture.close);
    await showMid(fixture);
    await fixture.emit('Page.frameAttached', { frameId: 'grand', parentFrameId: 'mid' });
    await fixture.emit('Page.frameNavigated', { frame: frame('grand', GRAND, 'mid') });
    await fixture.emit(
      'Runtime.executionContextCreated',
      context(3, 'grand', 'https://ordinary.test')
    );
    fixture.setTree(nested());
    const doc = await fixture.command('DOM.getDocument', { frameId: 'grand', depth: -1 });
    assert.equal(doc.error !== undefined, true);
    const ax = await fixture.command('Accessibility.getFullAXTree', { frameId: 'grand' });
    assert.equal(ax.error !== undefined, true);
    const evaluated = await fixture.command('Runtime.evaluate', {
      expression: '1',
      contextId: 3,
      returnByValue: true,
    });
    assert.equal(evaluated.error !== undefined, true);
    await fixture.command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    fixture.continued.length = 0;
    await fixture.emit('Fetch.requestPaused', paused('grand-fetch', 'grand', SIBLING));
    assert.equal(
      fixture.hit('Fetch.requestPaused', (params) => params.requestId === 'grand-fetch'),
      false
    );
    assert.equal(
      fixture.continued.some((item) => item.requestId === 'grand-fetch'),
      true
    );
  });
}

test('six-bridge: an ordinary iframe present at attach stays live after an opaque child', async (t) => {
  const fixture = await open('six-bridge', ordinaryNest());
  t.after(fixture.close);
  await fixture.command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  fixture.continued.length = 0;
  await fixture.emit('Fetch.requestPaused', paused('child-fetch', 'child', CHILD));
  assert.equal(
    fixture.hit('Fetch.requestPaused', (params) => params.requestId === 'child-fetch'),
    true
  );
  await fixture.emit('Runtime.executionContextCreated', context(9, 'blank', 'null'));
  fixture.continued.length = 0;
  await fixture.emit('Fetch.requestPaused', paused('child-fetch-2', 'child', `${CHILD}/2`));
  assert.equal(
    fixture.hit('Fetch.requestPaused', (params) => params.requestId === 'child-fetch-2'),
    true
  );
  assert.equal(
    fixture.continued.some((item) => item.requestId === 'child-fetch-2'),
    false
  );
  await fixture.emit('Network.responseReceived', received('child-net', 'child', CHILD, 'Script'));
  assert.equal(
    fixture.hit('Network.responseReceived', (params) => params.requestId === 'child-net'),
    true
  );
});
