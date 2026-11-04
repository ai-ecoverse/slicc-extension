import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

const POLICY = 'geolocation=()';
const CHILD = 'child';
const LOADER = 'child-loader';
const REQUEST = 'child-doc';

function events(fixture) {
  return fixture.messages.filter((message) => typeof message.method === 'string');
}

function documentResponse(overrides = {}) {
  return {
    requestId: REQUEST,
    frameId: CHILD,
    loaderId: LOADER,
    type: 'Document',
    response: {
      url: 'https://ordinary.test/child',
      status: 200,
      headers: { 'permissions-policy': POLICY },
    },
    ...overrides,
  };
}

function childFrame(overrides = {}) {
  return {
    id: CHILD,
    parentId: 'root',
    loaderId: LOADER,
    url: 'https://ordinary.test/child',
    securityOrigin: 'https://ordinary.test',
    ...overrides,
  };
}

async function pendingChild(fixture) {
  await fixture.lease();
  const enabled = await fixture.command('Page.enable');
  assert.equal(enabled.error, undefined);
  const tab = fixture.connection.tabState(11);
  tab.mainFrameId = 'root';
  tab.frames.set('root', false);
  tab.pendingFrames.add(CHILD);
  tab.frames.set(CHILD, true);
  return tab;
}

async function settle(fixture) {
  await fixture.connection.settled();
  await new Promise(setImmediate);
}

test('ordinary same-origin child Document response reaches the client before frameNavigated with ExtraInfo', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await pendingChild(fixture);
  await fixture.emit('Network.responseReceived', documentResponse());
  await settle(fixture);
  assert.equal(
    events(fixture).some((message) => message.method === 'Network.responseReceived'),
    false
  );
  await fixture.emit('Network.responseReceivedExtraInfo', {
    requestId: REQUEST,
    statusCode: 200,
    headers: { 'permissions-policy': POLICY },
  });
  await settle(fixture);
  assert.equal(
    events(fixture).some((message) => message.method === 'Network.responseReceivedExtraInfo'),
    false
  );
  await fixture.emit('Page.frameNavigated', { frame: childFrame() });
  await settle(fixture);
  const delivered = events(fixture).filter((message) =>
    [
      'Network.responseReceived',
      'Network.responseReceivedExtraInfo',
      'Page.frameNavigated',
    ].includes(message.method)
  );
  assert.equal(delivered[0]?.method, 'Network.responseReceived');
  assert.equal(delivered[0]?.params?.frameId, CHILD);
  assert.equal(delivered[0]?.params?.loaderId, LOADER);
  assert.equal(delivered[0]?.params?.response?.headers?.['permissions-policy'], POLICY);
  assert.equal(delivered[1]?.method, 'Network.responseReceivedExtraInfo');
  assert.equal(delivered[2]?.method, 'Page.frameNavigated');
});

for (const [name, frame] of [
  [
    'protected origin',
    childFrame({ url: 'https://vault.sliccy.ai/', securityOrigin: 'https://vault.sliccy.ai' }),
  ],
  [
    'chrome-error',
    childFrame({
      url: 'chrome-error://chromewebdata/',
      securityOrigin: '://',
      unreachableUrl: 'https://vault.sliccy.ai/blocked',
    }),
  ],
  ['unknown origin', childFrame({ url: 'data:text/html,hi', securityOrigin: 'null' })],
  ['loader mismatch', childFrame({ loaderId: 'other-loader' })],
]) {
  test(`held child Document response is dropped on ${name} commit`, async (t) => {
    const fixture = await backend();
    t.after(fixture.close);
    await pendingChild(fixture);
    await fixture.emit('Network.responseReceived', documentResponse());
    await fixture.emit('Network.responseReceivedExtraInfo', {
      requestId: REQUEST,
      statusCode: 200,
      headers: { 'permissions-policy': POLICY },
    });
    await fixture.emit('Page.frameNavigated', { frame });
    await settle(fixture);
    assert.equal(
      events(fixture).some((message) =>
        ['Network.responseReceived', 'Network.responseReceivedExtraInfo'].includes(message.method)
      ),
      false
    );
  });
}

test('held child Document response is dropped when the frame detaches before commit', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await pendingChild(fixture);
  await fixture.emit('Network.responseReceived', documentResponse());
  await fixture.emit('Page.frameDetached', { frameId: CHILD });
  await fixture.emit('Page.frameNavigated', { frame: childFrame() });
  await settle(fixture);
  assert.equal(
    events(fixture).some((message) => message.method === 'Network.responseReceived'),
    false
  );
});

test('held child Document response is dropped when the root navigates in between', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await pendingChild(fixture);
  await fixture.emit('Network.responseReceived', documentResponse());
  await fixture.emit('Page.frameNavigated', {
    frame: {
      id: 'root',
      loaderId: 'root-next',
      url: 'https://ordinary.test/next',
      securityOrigin: 'https://ordinary.test',
    },
  });
  await fixture.emit('Page.frameNavigated', { frame: childFrame() });
  await settle(fixture);
  assert.equal(
    events(fixture).some(
      (message) =>
        message.method === 'Network.responseReceived' && message.params?.frameId === CHILD
    ),
    false
  );
});

test('held child Document response is dropped when its parent stays protected', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  const tab = await pendingChild(fixture);
  tab.frames.set('root', true);
  await fixture.emit('Network.responseReceived', documentResponse());
  await fixture.emit('Page.frameNavigated', { frame: childFrame() });
  await settle(fixture);
  assert.equal(
    events(fixture).some((message) => message.method === 'Network.responseReceived'),
    false
  );
});

test('held child Document response is dropped when its parent is sealed', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  const tab = await pendingChild(fixture);
  tab.frames.set('root', false);
  tab.seal = { sealed: new Set(['root']) };
  await fixture.emit('Network.responseReceived', documentResponse());
  await fixture.emit('Network.responseReceivedExtraInfo', {
    requestId: REQUEST,
    statusCode: 200,
    headers: { 'permissions-policy': POLICY },
  });
  await fixture.emit('Page.frameNavigated', { frame: childFrame() });
  await settle(fixture);
  assert.equal(
    events(fixture).some((message) =>
      ['Network.responseReceived', 'Network.responseReceivedExtraInfo'].includes(message.method)
    ),
    false
  );
});

test('a dropped held Document response never flushes its ExtraInfo', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await pendingChild(fixture);
  await fixture.emit('Network.responseReceived', documentResponse());
  await fixture.emit('Network.responseReceivedExtraInfo', {
    requestId: REQUEST,
    statusCode: 200,
    headers: { 'permissions-policy': POLICY, 'x-private': '1' },
  });
  await fixture.emit('Page.frameNavigated', {
    frame: childFrame({
      url: 'https://vault.sliccy.ai/',
      securityOrigin: 'https://vault.sliccy.ai',
    }),
  });
  await fixture.emit('Network.loadingFinished', { requestId: REQUEST });
  await settle(fixture);
  assert.equal(
    events(fixture).some((message) =>
      ['Network.responseReceived', 'Network.responseReceivedExtraInfo'].includes(message.method)
    ),
    false
  );
});

test('a newer Document response for the same pending frame replaces the older hold', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await pendingChild(fixture);
  await fixture.emit(
    'Network.responseReceived',
    documentResponse({
      requestId: 'old',
      loaderId: 'old-loader',
      response: {
        url: 'https://ordinary.test/old',
        status: 200,
        headers: { 'permissions-policy': 'camera=()' },
      },
    })
  );
  await fixture.emit('Network.responseReceived', documentResponse());
  await fixture.emit('Page.frameNavigated', { frame: childFrame() });
  await settle(fixture);
  const received = events(fixture).filter(
    (message) => message.method === 'Network.responseReceived'
  );
  assert.equal(received.length, 1);
  assert.equal(received[0].params.requestId, REQUEST);
  assert.equal(received[0].params.loaderId, LOADER);
});

test('a newer Document response that reuses the replaced requestId fails closed', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await pendingChild(fixture);
  await fixture.emit(
    'Network.responseReceived',
    documentResponse({
      loaderId: 'old-loader',
      response: {
        url: 'https://ordinary.test/old',
        status: 200,
        headers: { 'permissions-policy': 'camera=()' },
      },
    })
  );
  await fixture.emit('Network.responseReceivedExtraInfo', {
    requestId: REQUEST,
    statusCode: 200,
    headers: { 'permissions-policy': 'camera=()' },
  });
  await fixture.emit('Network.responseReceived', documentResponse());
  await fixture.emit('Network.responseReceivedExtraInfo', {
    requestId: REQUEST,
    statusCode: 200,
    headers: { 'permissions-policy': POLICY },
  });
  await fixture.emit('Page.frameNavigated', { frame: childFrame() });
  await settle(fixture);
  assert.equal(
    events(fixture).some(
      (message) =>
        (message.method === 'Network.responseReceived' ||
          message.method === 'Network.responseReceivedExtraInfo') &&
        message.params?.requestId === REQUEST
    ),
    false
  );
});

test('a 33rd hold evicts the oldest without delivering it or its ExtraInfo', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  const tab = await pendingChild(fixture);
  const oldest = 'held-0';
  const oldestRequest = 'req-0';
  for (let index = 0; index < 33; index++) {
    const id = `held-${index}`;
    const requestId = `req-${index}`;
    tab.pendingFrames.add(id);
    tab.frames.set(id, true);
    await fixture.emit(
      'Network.responseReceived',
      documentResponse({
        frameId: id,
        requestId,
        loaderId: `loader-${index}`,
        response: {
          url: `https://ordinary.test/${id}`,
          status: 200,
          headers: { 'permissions-policy': POLICY },
        },
      })
    );
    await fixture.emit('Network.responseReceivedExtraInfo', {
      requestId,
      statusCode: 200,
      headers: { 'permissions-policy': POLICY },
    });
  }
  await settle(fixture);
  assert.equal(tab.heldDocuments.has(oldest), false);
  assert.equal(tab.heldDocuments.size, 32);
  assert.equal(tab.requests.get(oldestRequest), true);
  tab.frames.set(oldest, false);
  await fixture.emit('Page.frameNavigated', {
    frame: childFrame({
      id: oldest,
      loaderId: 'loader-0',
      url: `https://ordinary.test/${oldest}`,
    }),
  });
  await settle(fixture);
  assert.equal(
    events(fixture).some(
      (message) =>
        (message.method === 'Network.responseReceived' &&
          message.params?.requestId === oldestRequest) ||
        (message.method === 'Network.responseReceivedExtraInfo' &&
          message.params?.requestId === oldestRequest)
    ),
    false
  );
});

test('loadingFinished before release still delivers the response and ExtraInfo once each', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await pendingChild(fixture);
  await fixture.emit('Network.responseReceived', documentResponse());
  await fixture.emit('Network.responseReceivedExtraInfo', {
    requestId: REQUEST,
    statusCode: 200,
    headers: { 'permissions-policy': POLICY },
  });
  await fixture.emit('Network.loadingFinished', { requestId: REQUEST });
  await settle(fixture);
  assert.equal(
    events(fixture).filter((message) => message.method === 'Network.loadingFinished').length,
    1
  );
  assert.equal(
    events(fixture).some((message) =>
      ['Network.responseReceived', 'Network.responseReceivedExtraInfo'].includes(message.method)
    ),
    false
  );
  await fixture.emit('Page.frameNavigated', { frame: childFrame() });
  await settle(fixture);
  const received = events(fixture).filter(
    (message) => message.method === 'Network.responseReceived'
  );
  const extra = events(fixture).filter(
    (message) => message.method === 'Network.responseReceivedExtraInfo'
  );
  const finished = events(fixture).filter(
    (message) => message.method === 'Network.loadingFinished'
  );
  assert.equal(received.length, 1);
  assert.equal(extra.length, 1);
  assert.equal(finished.length, 1);
  assert.equal(received[0].params.requestId, REQUEST);
  assert.equal(extra[0].params.requestId, REQUEST);
});

test('held Document responses expire by time bound without delivery', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  const tab = await pendingChild(fixture);
  await fixture.emit('Network.responseReceived', documentResponse());
  const held = tab.heldDocuments?.get(CHILD);
  assert.ok(held, 'expected a held document');
  held.at = Date.now() - 60_000;
  await fixture.emit('Page.frameNavigated', { frame: childFrame() });
  await settle(fixture);
  assert.equal(
    events(fixture).some((message) => message.method === 'Network.responseReceived'),
    false
  );
});

test('pruneFrames marks an unsettled null-origin child so a Document response is held then released', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  const tab = await pendingChild(fixture);
  tab.frames.delete(CHILD);
  assert.equal(tab.frames.has(CHILD), false);
  fixture.connection.pruneFrames(tab, {
    frame: {
      id: 'root',
      loaderId: 'ordinary-document',
      url: 'https://ordinary.test/',
      securityOrigin: 'https://ordinary.test',
    },
    childFrames: [
      {
        frame: {
          id: CHILD,
          parentId: 'root',
          loaderId: 'about',
          url: 'about:blank',
          securityOrigin: 'null',
        },
      },
    ],
  });
  assert.equal(tab.frames.get(CHILD), true);
  await fixture.emit('Network.responseReceived', documentResponse());
  await settle(fixture);
  assert.equal(tab.heldDocuments?.has(CHILD), true);
  assert.equal(
    events(fixture).some((message) => message.method === 'Network.responseReceived'),
    false
  );
  await fixture.emit('Page.frameNavigated', { frame: childFrame() });
  await settle(fixture);
  assert.equal(
    events(fixture).some(
      (message) =>
        message.method === 'Network.responseReceived' &&
        message.params?.response?.headers?.['permissions-policy'] === POLICY
    ),
    true
  );
});
