import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

const ERROR = 'chrome-error://chromewebdata/';
const ORDINARY = 'https://ordinary.test/';
const CANARY = 'https://127.0.0.1:1/ERROR_FRAME_CANARY';
const SIBLING = 'https://other.test/doc';
const SIGN_IN = 'https://ims-na1.adobelogin.com/auth/callback';
const VAULT = 'https://vault.sliccy.ai/doc?SWAPPED';

function rootFrame(loaderId) {
  return { id: 'root', loaderId, url: ORDINARY, securityOrigin: 'https://ordinary.test' };
}

async function fixtureFor(t, { unreachable = CANARY, canaryTarget = CANARY } = {}) {
  const fixture = await backend();
  t.after(() => fixture.close());
  const live = new Map([
    ['ERROR_TARGET', { targetId: 'ERROR_TARGET', type: 'iframe', url: canaryTarget }],
    ['SIBLING_TARGET', { targetId: 'SIBLING_TARGET', type: 'iframe', url: SIBLING }],
  ]);
  const trees = new Map([
    [
      'error-session',
      {
        frame: {
          id: 'ERROR_TARGET',
          loaderId: 'error-loader',
          url: ERROR,
          unreachableUrl: unreachable,
        },
      },
    ],
    [
      'sibling-session',
      {
        frame: {
          id: 'SIBLING_TARGET',
          loaderId: 'sibling-loader',
          url: SIBLING,
          securityOrigin: 'https://other.test',
        },
      },
    ],
  ]);
  const sends = [];
  let recording = false;
  let parentTree = { frame: rootFrame('ordinary-document') };
  fixture.api.tabs.get = async () => ({ id: 11, url: ORDINARY, status: 'complete' });
  fixture.api.webNavigation.getFrame = async () => ({ errorOccurred: false, url: ORDINARY });
  fixture.api.webNavigation.getAllFrames = async () => [
    {
      frameId: 0,
      parentFrameId: -1,
      documentId: 'ROOT',
      url: ORDINARY,
      documentLifecycle: 'active',
    },
    {
      frameId: 1,
      parentFrameId: 0,
      documentId: 'ERROR',
      url: unreachable,
      errorOccurred: true,
      documentLifecycle: 'active',
    },
    {
      frameId: 2,
      parentFrameId: 0,
      documentId: 'SIBLING',
      url: SIBLING,
      documentLifecycle: 'active',
    },
  ];
  const send = fixture.api.debugger.sendCommand;
  fixture.api.debugger.sendCommand = async (source, method, params) => {
    if (recording) sends.push({ source, method, params });
    if (method === 'Target.getTargetInfo') {
      const info = live.get(params?.targetId);
      if (!info) throw new Error('missing target');
      return { targetInfo: { ...info } };
    }
    if (source?.sessionId && method === 'Page.getFrameTree') {
      const tree = trees.get(source.sessionId);
      if (!tree) throw new Error('missing child tree');
      return { frameTree: structuredClone(tree) };
    }
    if (method === 'DOM.getFrameOwner') {
      const owner = { ERROR_TARGET: 21, SIBLING_TARGET: 22 }[params?.frameId];
      if (!owner) throw new Error('no owner');
      return { backendNodeId: owner };
    }
    if (method === 'Page.getFrameTree' && !source?.sessionId) {
      return { frameTree: structuredClone(parentTree) };
    }
    return send(source, method, params);
  };
  const tab = fixture.connection.tabState(11);
  tab.mainFrameId = 'root';
  tab.documents.frames.set('root', { loaderId: 'ordinary-document' });
  tab.debuggerRevision = 0;
  for (const [sessionId, targetId, url] of [
    ['error-session', 'ERROR_TARGET', canaryTarget],
    ['sibling-session', 'SIBLING_TARGET', SIBLING],
  ]) {
    await fixture.emit('Page.frameAttached', { frameId: targetId, parentFrameId: 'root' });
    await fixture.emit('Target.attachedToTarget', {
      sessionId,
      targetInfo: { targetId, type: 'iframe', url },
    });
  }
  return {
    fixture,
    tab,
    live,
    trees,
    sends,
    record: (on) => {
      recording = on;
      if (on) sends.length = 0;
    },
    setParentTree: (next) => {
      parentTree = next;
    },
  };
}

async function settle(tab) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (tab.childReobserveRunning == null) return;
  }
}

async function canaryChanged(fixture, url = CANARY) {
  await fixture.emit('Target.targetInfoChanged', {
    targetInfo: { targetId: 'ERROR_TARGET', type: 'iframe', url },
  });
}

async function swapOut(fixture, frameId) {
  await fixture.emit('Page.frameDetached', { frameId, reason: 'swap' });
}

async function siblingCommit(fixture, tab) {
  await fixture.api.webNavigation.onCommitted.emit({
    tabId: 11,
    frameId: 2,
    url: SIBLING,
    transitionType: 'auto_subframe',
  });
  await settle(tab);
}

async function forcingOrder(fixture, tab, url = CANARY) {
  await canaryChanged(fixture, url);
  await swapOut(fixture, 'ERROR_TARGET');
  await swapOut(fixture, 'SIBLING_TARGET');
  await siblingCommit(fixture, tab);
}

async function mainNavigates(fixture, setParentTree, loaderId) {
  setParentTree({ frame: rootFrame(loaderId) });
  await fixture.emit('Page.frameNavigated', { frame: rootFrame(loaderId) });
}

async function privateFrames(fixture) {
  const before = fixture.messages.length;
  fixture.connection.handle({ privateFrames: { id: 9001, tabId: 11 } });
  await fixture.connection.settled();
  const posted = fixture.messages.slice(before).filter((message) => message.privateFrames);
  assert.equal(posted.length, 1);
  return posted[0].privateFrames;
}

function canary(tab) {
  return tab.debuggerChildInfo.get('error-session');
}

test('a swapped-out error child whose last change preceded the bump settles', async (t) => {
  const { fixture, tab } = await fixtureFor(t);
  await forcingOrder(fixture, tab);
  assert.equal(tab.frameParents.has('ERROR_TARGET'), false);
  assert.equal(tab.debuggerRevision, 1);
  assert.equal(canary(tab).revision, 1);
  assert.equal(canary(tab).generation, 'ordinary-document');
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, undefined);
  assert.deepEqual(
    reply.result.frames.map(({ kind, errorProtected }) => [kind, errorProtected]).sort(),
    [
      ['error', false],
      ['ordinary', undefined],
      ['ordinary', undefined],
    ]
  );
});

test('the same order settles when the change and the bump share one tick', async (t) => {
  const { fixture, tab } = await fixtureFor(t);
  await Promise.all([
    canaryChanged(fixture),
    swapOut(fixture, 'ERROR_TARGET'),
    swapOut(fixture, 'SIBLING_TARGET'),
    fixture.api.webNavigation.onCommitted.emit({
      tabId: 11,
      frameId: 2,
      url: SIBLING,
      transitionType: 'auto_subframe',
    }),
  ]);
  await settle(tab);
  assert.equal(canary(tab).revision, tab.debuggerRevision);
  assert.equal((await privateFrames(fixture)).error, undefined);
});

test('an old-document swapped child stays stale and its kept parent is purged by the pass', async (t) => {
  const { fixture, tab, setParentTree } = await fixtureFor(t);
  await canaryChanged(fixture);
  await swapOut(fixture, 'ERROR_TARGET');
  await mainNavigates(fixture, setParentTree, 'next-document');
  assert.equal(tab.swappedParents.get('ERROR_TARGET')?.generation, 'ordinary-document');
  await siblingCommit(fixture, tab);
  assert.equal(tab.swappedParents.has('ERROR_TARGET'), false);
  assert.equal(canary(tab).revision, 0);
  assert.equal((await privateFrames(fixture)).error, 'slicc: refused: unsettled frame list');
});

test('a kept parent from an older document is purged by a pass with nothing stale', async (t) => {
  const { fixture, tab, setParentTree } = await fixtureFor(t);
  await swapOut(fixture, 'ERROR_TARGET');
  await mainNavigates(fixture, setParentTree, 'next-document');
  for (const info of tab.debuggerChildInfo.values()) info.revision = 1;
  tab.debuggerRevision = 1;
  assert.equal(tab.swappedParents.has('ERROR_TARGET'), true);
  await fixture.connection.reobserveStaleChildren(11, 1);
  assert.equal(tab.swappedParents.has('ERROR_TARGET'), false);
});

test('a swapped child that is then removed stays stale', async (t) => {
  const { fixture, tab } = await fixtureFor(t);
  await canaryChanged(fixture);
  await swapOut(fixture, 'ERROR_TARGET');
  await fixture.emit('Page.frameDetached', { frameId: 'ERROR_TARGET', reason: 'remove' });
  assert.equal(tab.swappedParents.has('ERROR_TARGET'), false);
  await siblingCommit(fixture, tab);
  assert.equal(canary(tab).revision, 0);
  assert.equal((await privateFrames(fixture)).error, 'slicc: refused: unsettled frame list');
});

test('a swapped child whose target is torn down loses its kept parent', async (t) => {
  const { fixture, tab } = await fixtureFor(t);
  await canaryChanged(fixture);
  await swapOut(fixture, 'ERROR_TARGET');
  await fixture.emit('Target.detachedFromTarget', {
    sessionId: 'error-session',
    targetId: 'ERROR_TARGET',
  });
  assert.equal(tab.swappedParents.has('ERROR_TARGET'), false);
  assert.equal(tab.debuggerChildInfo.has('error-session'), false);
  await fixture.emit('Target.attachedToTarget', {
    sessionId: 'error-session',
    targetInfo: { targetId: 'ERROR_TARGET', type: 'iframe', url: CANARY },
  });
  await siblingCommit(fixture, tab);
  assert.equal(canary(tab).revision, 0);
  assert.equal((await privateFrames(fixture)).error, 'slicc: refused: unsettled frame list');
});

test('a frame id reused after a cross-document navigation does not inherit the kept parent', async (t) => {
  const { fixture, tab, trees, setParentTree } = await fixtureFor(t);
  await canaryChanged(fixture);
  await swapOut(fixture, 'ERROR_TARGET');
  await mainNavigates(fixture, setParentTree, 'next-document');
  trees.get('error-session').frame.loaderId = 'error-loader-next';
  await canaryChanged(fixture);
  await swapOut(fixture, 'ERROR_TARGET');
  assert.equal(tab.swappedParents.has('ERROR_TARGET'), false);
  await siblingCommit(fixture, tab);
  assert.equal(canary(tab).revision, 0);
  assert.equal((await privateFrames(fixture)).error, 'slicc: refused: unsettled frame list');
});

test('a frame attached again in the new document is tagged with the new document', async (t) => {
  const { fixture, tab, setParentTree } = await fixtureFor(t);
  await swapOut(fixture, 'ERROR_TARGET');
  await mainNavigates(fixture, setParentTree, 'next-document');
  await fixture.emit('Page.frameAttached', { frameId: 'ERROR_TARGET', parentFrameId: 'root' });
  assert.equal(tab.swappedParents.has('ERROR_TARGET'), false);
  await canaryChanged(fixture);
  await swapOut(fixture, 'ERROR_TARGET');
  assert.equal(tab.swappedParents.get('ERROR_TARGET')?.generation, 'next-document');
  await siblingCommit(fixture, tab);
  assert.equal(canary(tab).revision, tab.debuggerRevision);
  assert.equal(canary(tab).generation, 'next-document');
});

test('a child whose own parentId differs from the kept parent stays stale', async (t) => {
  const { fixture, tab, trees } = await fixtureFor(t);
  trees.get('error-session').frame.parentId = 'elsewhere';
  await forcingOrder(fixture, tab);
  assert.equal(canary(tab).revision, 0);
  assert.equal((await privateFrames(fixture)).error, 'slicc: refused: unsettled frame list');
});

test('a child whose own parentId matches the kept parent settles', async (t) => {
  const { fixture, tab, trees } = await fixtureFor(t);
  trees.get('error-session').frame.parentId = 'root';
  await forcingOrder(fixture, tab);
  assert.equal(canary(tab).revision, tab.debuggerRevision);
  assert.equal((await privateFrames(fixture)).error, undefined);
});

test('a child in the root tree whose own parentId differs stays stale', async (t) => {
  const { fixture, tab, trees, setParentTree } = await fixtureFor(t);
  setParentTree({
    frame: rootFrame('ordinary-document'),
    childFrames: [{ frame: { id: 'ERROR_TARGET', parentId: 'root', loaderId: 'error-loader' } }],
  });
  trees.get('error-session').frame.parentId = 'elsewhere';
  await canaryChanged(fixture);
  await siblingCommit(fixture, tab);
  assert.equal(canary(tab).revision, 0);
  trees.get('error-session').frame.parentId = 'root';
  await siblingCommit(fixture, tab);
  assert.equal(canary(tab).revision, tab.debuggerRevision);
});

test('a kept parent chain through a swapped ancestor reaches the main frame', async (t) => {
  const { fixture, tab } = await fixtureFor(t);
  await fixture.emit('Page.frameAttached', { frameId: 'MIDDLE', parentFrameId: 'root' });
  await fixture.emit('Page.frameAttached', { frameId: 'ERROR_TARGET', parentFrameId: 'MIDDLE' });
  await swapOut(fixture, 'MIDDLE');
  await forcingOrder(fixture, tab);
  assert.equal(canary(tab).revision, tab.debuggerRevision);
  await fixture.emit('Page.frameDetached', { frameId: 'MIDDLE', reason: 'remove' });
  await siblingCommit(fixture, tab);
  assert.equal(canary(tab).revision, tab.debuggerRevision - 1);
});

test('a swapped-out protected canary stays refused', async (t) => {
  const { fixture, tab, live } = await fixtureFor(t);
  live.set('ERROR_TARGET', { targetId: 'ERROR_TARGET', type: 'iframe', url: VAULT });
  await forcingOrder(fixture, tab);
  assert.equal(canary(tab).revision, 0);
  assert.equal((await privateFrames(fixture)).error, 'slicc: refused: unsettled frame list');
});

test('a swapped-out sign-in callback error child stays refused', async (t) => {
  const { fixture, tab } = await fixtureFor(t, { unreachable: SIGN_IN });
  await forcingOrder(fixture, tab);
  assert.equal(canary(tab).revision, 0);
  assert.equal((await privateFrames(fixture)).error, 'slicc: refused: unsettled frame list');
});

test('ordinary swapped-out children settle unchanged', async (t) => {
  const { fixture, tab, trees } = await fixtureFor(t);
  trees.set('error-session', {
    frame: {
      id: 'ERROR_TARGET',
      loaderId: 'error-loader',
      url: SIBLING,
      securityOrigin: 'https://other.test',
    },
  });
  await forcingOrder(fixture, tab, SIBLING);
  assert.equal(canary(tab).revision, tab.debuggerRevision);
  assert.equal(tab.debuggerChildInfo.get('sibling-session').revision, tab.debuggerRevision);
});

test('www: a tab without debugger children is unchanged', async (t) => {
  const fixture = await backend();
  t.after(() => fixture.close());
  const tab = fixture.connection.tabState(11);
  tab.mainFrameId = 'root';
  tab.documents.frames.set('root', { loaderId: 'ordinary-document' });
  await fixture.emit('Page.frameAttached', { frameId: 'LOCAL', parentFrameId: 'root' });
  await swapOut(fixture, 'LOCAL');
  fixture.api.webNavigation.getAllFrames = async () => [
    {
      frameId: 0,
      parentFrameId: -1,
      documentId: 'ROOT',
      url: ORDINARY,
      documentLifecycle: 'active',
    },
  ];
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, undefined);
  assert.deepEqual(
    reply.result.frames.map(({ kind }) => kind),
    ['ordinary']
  );
});

test('the pass for a swapped-out child sends only Page.getFrameTree and Target.getTargetInfo', async (t) => {
  const { fixture, tab, record, sends } = await fixtureFor(t);
  await canaryChanged(fixture);
  await swapOut(fixture, 'ERROR_TARGET');
  record(true);
  await siblingCommit(fixture, tab);
  record(false);
  assert.equal(canary(tab).revision, tab.debuggerRevision);
  assert.deepEqual([...new Set(sends.map((entry) => entry.method))].sort(), [
    'Page.getFrameTree',
    'Target.getTargetInfo',
  ]);
});

test('mutation: default-true membership admits the old-document child', async (t) => {
  const { fixture, tab, setParentTree } = await fixtureFor(t);
  fixture.connection.childUnderCurrentMain = () => true;
  await canaryChanged(fixture);
  await swapOut(fixture, 'ERROR_TARGET');
  await mainNavigates(fixture, setParentTree, 'next-document');
  await siblingCommit(fixture, tab);
  assert.equal(canary(tab).revision, tab.debuggerRevision);
});

test('mutation: without the generation purge the old-document child is admitted', async (t) => {
  const { fixture, tab, setParentTree } = await fixtureFor(t);
  fixture.connection.purgeSwappedParents = () => undefined;
  await canaryChanged(fixture);
  await swapOut(fixture, 'ERROR_TARGET');
  await mainNavigates(fixture, setParentTree, 'next-document');
  await siblingCommit(fixture, tab);
  assert.equal(canary(tab).revision, tab.debuggerRevision);
});

test('mutation: without the parentId cross-check a mismatched child is admitted', async (t) => {
  const { fixture, tab, trees } = await fixtureFor(t);
  const membership = fixture.connection.childUnderCurrentMain.bind(fixture.connection);
  fixture.connection.childUnderCurrentMain = (tab, parentTree, frameId, generation) =>
    membership(tab, parentTree, frameId, generation, undefined);
  trees.get('error-session').frame.parentId = 'elsewhere';
  await forcingOrder(fixture, tab);
  assert.equal(canary(tab).revision, tab.debuggerRevision);
});
