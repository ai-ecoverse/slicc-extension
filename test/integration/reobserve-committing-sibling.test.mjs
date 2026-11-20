import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

const ERROR = 'chrome-error://chromewebdata/';
const ORDINARY = 'https://ordinary.test/';
const CANARY = 'https://127.0.0.1:1/ERROR_FRAME_CANARY';
const SIBLING = 'https://other.test/doc';
const SIGN_IN = 'https://ims-na1.adobelogin.com/auth/callback';
const VAULT = 'https://vault.sliccy.ai/doc?REOBSERVE';
const MAIN_FAILED = 'https://ordinary.test/missing';

async function fixtureFor(
  t,
  {
    unreachable = CANARY,
    canaryTarget = CANARY,
    tabUrl = ORDINARY,
    mainErrorOccurred = false,
    owners,
    parentLoader = 'ordinary-document',
    getTargetInfoDelay = 0,
    getTargetInfoFail = false,
  } = {}
) {
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
  const ownerIds =
    owners ??
    new Map([
      ['ERROR_TARGET', 21],
      ['SIBLING_TARGET', 22],
    ]);
  const sends = [];
  let recording = false;
  let delay = getTargetInfoDelay;
  let fail = getTargetInfoFail;
  let parentTree = {
    frame: {
      id: 'root',
      loaderId: parentLoader,
      url: tabUrl === MAIN_FAILED ? ERROR : ORDINARY,
      unreachableUrl: tabUrl === MAIN_FAILED ? MAIN_FAILED : undefined,
      securityOrigin: 'https://ordinary.test',
    },
  };
  const documentRoot = {
    nodeType: 9,
    nodeName: '#document',
    nodeId: 1,
    frameId: 'root',
    backendNodeId: 1,
    children: [{ nodeName: 'DIV', nodeId: 2, backendNodeId: 2, attributes: ['id', 'mark'] }],
  };
  const nodes = new Map([
    [1, documentRoot],
    [2, documentRoot.children[0]],
  ]);
  fixture.api.tabs.get = async () => ({ id: 11, url: tabUrl, status: 'complete' });
  fixture.api.webNavigation.getFrame = async () => ({
    errorOccurred: mainErrorOccurred,
    url: tabUrl,
  });
  fixture.api.webNavigation.getAllFrames = async () => [
    {
      frameId: 0,
      parentFrameId: -1,
      documentId: 'ROOT_DOCUMENT',
      url: ORDINARY,
      documentLifecycle: 'active',
    },
    {
      frameId: 1,
      parentFrameId: 0,
      documentId: 'ERROR_DOCUMENT',
      url: unreachable,
      errorOccurred: true,
      documentLifecycle: 'active',
    },
    {
      frameId: 2,
      parentFrameId: 0,
      documentId: 'SIBLING_DOCUMENT',
      url: SIBLING,
      documentLifecycle: 'active',
    },
  ];
  const send = fixture.api.debugger.sendCommand;
  fixture.api.debugger.sendCommand = async (source, method, params) => {
    if (recording) sends.push({ source, method, params });
    if (method === 'Target.getTargetInfo') {
      if (fail) throw new Error('target-info-failed');
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
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
      const id = String(params?.frameId ?? '');
      if (!ownerIds.has(id)) throw new Error('no owner');
      const backendNodeId = ownerIds.get(id);
      if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) throw new Error('bad owner');
      return { backendNodeId };
    }
    if (method === 'DOM.getDocument') {
      return { root: structuredClone(documentRoot) };
    }
    if (method === 'DOM.querySelector') {
      const node = [...nodes.values()].find(
        (entry) =>
          Array.isArray(entry.attributes) &&
          entry.attributes.includes('id') &&
          entry.attributes.includes(String(params?.selector ?? '').replace(/^#/, ''))
      );
      if (!node) return { nodeId: 0 };
      return { nodeId: node.nodeId };
    }
    if (method === 'DOM.describeNode') {
      const node = nodes.get(params?.nodeId);
      if (!node) throw new Error('Could not find node with given id');
      return { node: structuredClone(node) };
    }
    if (method === 'Page.getFrameTree' && !source?.sessionId) {
      return { frameTree: structuredClone(parentTree) };
    }
    return send(source, method, params);
  };
  for (const child of [
    {
      sessionId: 'error-session',
      target: 'ERROR_TARGET',
      url: canaryTarget,
    },
    {
      sessionId: 'sibling-session',
      target: 'SIBLING_TARGET',
      url: SIBLING,
    },
  ]) {
    await fixture.emit('Target.attachedToTarget', {
      sessionId: child.sessionId,
      targetInfo: { targetId: child.target, type: 'iframe', url: child.url },
    });
  }
  const tab = fixture.connection.tabState(11);
  tab.mainFrameId = 'root';
  tab.documents.frames.set('root', { loaderId: parentLoader });
  tab.frameParents = new Map([
    ['ERROR_TARGET', 'root'],
    ['SIBLING_TARGET', 'root'],
  ]);
  for (const info of tab.debuggerChildInfo.values()) {
    info.generation = parentLoader;
    info.revision = 0;
  }
  tab.debuggerRevision = 0;
  return {
    fixture,
    tab,
    live,
    trees,
    ownerIds,
    sends,
    record: (on) => {
      recording = on;
      if (on) sends.length = 0;
    },
    setDelay: (ms) => {
      delay = ms;
    },
    setFail: (v) => {
      fail = v;
    },
    setParentTree: (next) => {
      parentTree = next;
    },
  };
}

function reobserveDomMethods(sends) {
  return sends
    .map((entry) => entry.method)
    .filter(
      (method) =>
        method === 'DOM.getDocument' ||
        method === 'DOM.enable' ||
        method === 'DOM.getFrameOwner' ||
        method.startsWith('DOM.')
    );
}

async function settle(tab, rounds = 50) {
  for (let i = 0; i < rounds; i += 1) {
    if (tab.childReobserveRunning == null) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function siblingCommit(fixture) {
  await fixture.api.webNavigation.onCommitted.emit({
    tabId: 11,
    frameId: 2,
    url: SIBLING,
    transitionType: 'auto_subframe',
  });
}

async function privateFrames(fixture) {
  const id = 9001;
  const before = fixture.messages.length;
  fixture.connection.handle({ privateFrames: { id, tabId: 11 } });
  await fixture.connection.settled();
  const posted = fixture.messages.slice(before).filter((message) => message.privateFrames);
  assert.equal(posted.length, 1);
  return posted[0].privateFrames;
}

test('seven: error iframe next to a committing sibling settles', async (t) => {
  const { fixture, tab } = await fixtureFor(t);
  await siblingCommit(fixture);
  await settle(tab);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.frames.length, 3);
  assert.deepEqual(
    reply.result.frames.map(({ kind, errorProtected }) => [kind, errorProtected]).sort(),
    [
      ['error', false],
      ['ordinary', undefined],
      ['ordinary', undefined],
    ]
  );
});

test('a failed re-read keeps the child stale and the snapshot refuses', async (t) => {
  const { fixture, tab, setFail } = await fixtureFor(t);
  setFail(true);
  await siblingCommit(fixture);
  await settle(tab);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, 0);
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, 'slicc: refused: unsettled frame list');
});

test('a timed-out re-read keeps the child stale and the snapshot refuses', async (t) => {
  const { fixture, tab, setDelay } = await fixtureFor(t);
  setDelay(2500);
  await siblingCommit(fixture);
  await settle(tab, 600);
  assert.equal(tab.childReobserveRunning, null);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, 0);
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, 'slicc: refused: unsettled frame list');
});

test('a child that is protected at the re-read stays refused', async (t) => {
  const { fixture, tab, live } = await fixtureFor(t);
  live.set('ERROR_TARGET', { targetId: 'ERROR_TARGET', type: 'iframe', url: VAULT });
  await siblingCommit(fixture);
  await settle(tab);
  assert.notEqual(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, 'slicc: refused: unsettled frame list');
});

test('protected navigation after re-read is caught by knownChildren on the stamped url', async (t) => {
  const { fixture, tab } = await fixtureFor(t);
  await siblingCommit(fixture);
  await settle(tab);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, 1);
  fixture.connection.watchChild(11, 'Target.targetInfoChanged', {
    targetInfo: { targetId: 'ERROR_TARGET', type: 'iframe', url: VAULT },
    sessionId: 'error-session',
  });
  assert.equal(tab.debuggerChildInfo.get('error-session').url, VAULT);
  assert.equal(fixture.connection.debuggerGate.knownChildren(tab), false);
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, 'slicc: refused: unsettled frame list');
});

test('a bump during the re-read invalidates it and leaves stale until a later pass', async (t) => {
  const { fixture, tab, setDelay } = await fixtureFor(t);
  setDelay(30);
  const first = siblingCommit(fixture);
  await first;
  assert.equal(tab.childReobserveRunning, 1);
  await fixture.api.webNavigation.onCommitted.emit({
    tabId: 11,
    frameId: 2,
    url: SIBLING,
    transitionType: 'auto_subframe',
  });
  assert.equal(tab.debuggerRevision, 2);
  await settle(tab);
  await settle(tab);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.frames.length, 3);
});

test('a bump between the reads and the stamps leaves everything stale', async (t) => {
  const { fixture, tab, setFail } = await fixtureFor(t);
  const pass = fixture.connection.childReobservePass.bind(fixture.connection);
  let bumped = false;
  fixture.connection.childReobservePass = async (...args) => {
    if (!bumped) {
      bumped = true;
      tab.debuggerRevision += 1;
      setFail(true);
    }
    return pass(...args);
  };
  await siblingCommit(fixture);
  await settle(tab);
  await settle(tab);
  assert.equal(bumped, true);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, 0);
  assert.equal(tab.debuggerChildInfo.get('sibling-session').revision, 0);
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, 'slicc: refused: unsettled frame list');
});

test('forgetting the tab mid-read stamps nothing and does not throw', async (t) => {
  const { fixture, tab, setDelay } = await fixtureFor(t);
  setDelay(40);
  void siblingCommit(fixture);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(tab.childReobserveRunning, 1);
  fixture.connection.forget(11);
  await settle(tab);
  assert.equal(fixture.connection.tabState(11), undefined);
  await assert.doesNotReject(fixture.connection.runChildReobserve(11, 1));
});

test('protected sign-in-callback error iframe next to a committing sibling stays locked', async (t) => {
  const { fixture, tab } = await fixtureFor(t, { unreachable: SIGN_IN, canaryTarget: CANARY });
  await siblingCommit(fixture);
  await settle(tab);
  assert.notEqual(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, 'slicc: refused: unsettled frame list');
});

test('main confirmed error plus protected sign-in child stays locked', async (t) => {
  const { fixture, tab, trees, setParentTree } = await fixtureFor(t, {
    unreachable: SIGN_IN,
    canaryTarget: CANARY,
    tabUrl: MAIN_FAILED,
    mainErrorOccurred: true,
  });
  fixture.connection.state.failed.set(11, MAIN_FAILED);
  setParentTree({
    frame: {
      id: 'root',
      loaderId: 'ordinary-document',
      url: ERROR,
      unreachableUrl: MAIN_FAILED,
    },
  });
  trees.set('error-session', {
    frame: {
      id: 'ERROR_TARGET',
      loaderId: 'error-loader',
      url: ERROR,
      unreachableUrl: SIGN_IN,
    },
  });
  assert.equal(await fixture.connection.confirmedError(11, { url: MAIN_FAILED }), true);
  assert.equal(
    await fixture.connection.errorRootAllowed(11, {
      url: ERROR,
      unreachableUrl: SIGN_IN,
    }),
    true
  );
  await siblingCommit(fixture);
  await settle(tab);
  assert.notEqual(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, 'slicc: refused: unsettled frame list');
});

test('an old-document child that still answers stays stale', async (t) => {
  const { fixture, tab, setParentTree } = await fixtureFor(t);
  tab.documents.frames.set('root', { loaderId: 'next-document' });
  setParentTree({
    frame: {
      id: 'root',
      loaderId: 'next-document',
      url: ORDINARY,
      securityOrigin: 'https://ordinary.test',
    },
  });
  tab.frameParents.delete('ERROR_TARGET');
  await siblingCommit(fixture);
  await settle(tab);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, 0);
  assert.equal(tab.debuggerChildInfo.get('error-session').generation, 'ordinary-document');
  assert.equal(tab.debuggerChildInfo.get('sibling-session').revision, tab.debuggerRevision);
  assert.equal(tab.debuggerChildInfo.get('sibling-session').generation, 'next-document');
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, 'slicc: refused: unsettled frame list');
});

test('an OOPIF child with an unknown parent chain stays stale', async (t) => {
  const { fixture, tab } = await fixtureFor(t);
  tab.frameParents.delete('ERROR_TARGET');
  await siblingCommit(fixture);
  await settle(tab);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, 0);
  assert.equal(tab.debuggerChildInfo.get('sibling-session').revision, tab.debuggerRevision);
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, 'slicc: refused: unsettled frame list');
});

test('an ordinary OOPIF child whose parent is the main frame is stamped', async (t) => {
  const { fixture, tab } = await fixtureFor(t);
  assert.equal(tab.frameParents.get('ERROR_TARGET'), 'root');
  assert.equal(tab.frameParents.get('SIBLING_TARGET'), 'root');
  await siblingCommit(fixture);
  await settle(tab);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  assert.equal(tab.debuggerChildInfo.get('sibling-session').revision, tab.debuggerRevision);
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, undefined);
});

test('reobserve sends no DOM.getDocument, DOM.enable, or DOM.getFrameOwner', async (t) => {
  const { fixture, tab, record, sends } = await fixtureFor(t);
  record(true);
  await siblingCommit(fixture);
  await settle(tab);
  record(false);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  assert.deepEqual(reobserveDomMethods(sends), []);
  assert.ok(sends.some((entry) => entry.method === 'Page.getFrameTree'));
  assert.ok(sends.some((entry) => entry.method === 'Target.getTargetInfo'));
});

test('a client nodeId survives a child commit and reobserve pass', async (t) => {
  const { fixture, tab, record, sends } = await fixtureFor(t);
  const doc = await fixture.api.debugger.sendCommand({ tabId: 11 }, 'DOM.getDocument', {});
  assert.equal(doc.root.nodeId, 1);
  const selected = await fixture.api.debugger.sendCommand({ tabId: 11 }, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: '#mark',
  });
  assert.equal(selected.nodeId, 2);
  record(true);
  await siblingCommit(fixture);
  await settle(tab);
  record(false);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  assert.deepEqual(reobserveDomMethods(sends), []);
  const described = await fixture.api.debugger.sendCommand({ tabId: 11 }, 'DOM.describeNode', {
    nodeId: selected.nodeId,
  });
  assert.equal(described.node.nodeId, 2);
  assert.equal(described.node.backendNodeId, 2);
});

test('mutation: putting DOM.getDocument back into reobserve makes the no-DOM row red', async (t) => {
  const { fixture, tab, record, sends } = await fixtureFor(t);
  const prior = fixture.connection.reobserveStaleChildren.bind(fixture.connection);
  fixture.connection.reobserveStaleChildren = async (tabId, startedRevision) => {
    await fixture.api.debugger.sendCommand({ tabId }, 'DOM.getDocument', {
      depth: -1,
      pierce: true,
    });
    return prior(tabId, startedRevision);
  };
  record(true);
  await siblingCommit(fixture);
  await settle(tab);
  record(false);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  assert.ok(reobserveDomMethods(sends).includes('DOM.getDocument'));
});

test('reobserve sends nothing when no child is stale', async (t) => {
  const { fixture, tab, record, sends } = await fixtureFor(t);
  for (const info of tab.debuggerChildInfo.values()) info.revision = 1;
  tab.debuggerRevision = 1;
  record(true);
  await fixture.connection.reobserveStaleChildren(11, 1);
  record(false);
  assert.deepEqual(sends, []);
});

test('N rapid child commits coalesce into one reobserve pass batch', async (t) => {
  const { fixture, tab } = await fixtureFor(t);
  let passes = 0;
  const prior = fixture.connection.reobserveStaleChildren.bind(fixture.connection);
  fixture.connection.reobserveStaleChildren = async (...args) => {
    passes += 1;
    return prior(...args);
  };
  const n = 5;
  await Promise.all(Array.from({ length: n }, () => siblingCommit(fixture)));
  await settle(tab);
  await settle(tab);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  assert.ok(
    passes >= 1 && passes <= 2,
    `expected 1 coalesced batch (got ${passes} for ${n} commits)`
  );
});

test('reobserve does not mutate documents.frames or frameParents', async (t) => {
  const { fixture, tab } = await fixtureFor(t);
  const beforeFrames = JSON.stringify([...tab.documents.frames.entries()]);
  const beforeParents = JSON.stringify([...tab.frameParents.entries()]);
  await siblingCommit(fixture);
  await settle(tab);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  assert.equal(JSON.stringify([...tab.documents.frames.entries()]), beforeFrames);
  assert.equal(JSON.stringify([...tab.frameParents.entries()]), beforeParents);
});

test('www: ordinary-only children stay settled without debugger children', async (t) => {
  const fixture = await backend();
  t.after(() => fixture.close());
  const tab = fixture.connection.tabState(11);
  tab.debuggerChildren.clear();
  tab.debuggerChildInfo.clear();
  tab.debuggerRevision = 1;
  tab.mainFrameId = 'root';
  tab.documents.frames.set('root', { loaderId: 'ordinary-document' });
  fixture.api.webNavigation.getAllFrames = async () => [
    {
      frameId: 0,
      parentFrameId: -1,
      documentId: 'ROOT_DOCUMENT',
      url: ORDINARY,
      documentLifecycle: 'active',
    },
  ];
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.frames.length, 1);
  assert.equal(reply.result.frames[0].kind, 'ordinary');
});

test('ordinary-only children are unchanged', async (t) => {
  const fixture = await backend();
  t.after(() => fixture.close());
  const tab = fixture.connection.tabState(11);
  tab.debuggerChildren.clear();
  tab.debuggerChildInfo.clear();
  tab.debuggerRevision = 1;
  tab.mainFrameId = 'root';
  tab.documents.frames.set('root', { loaderId: 'ordinary-document' });
  fixture.api.webNavigation.getAllFrames = async () => [
    {
      frameId: 0,
      parentFrameId: -1,
      documentId: 'ROOT_DOCUMENT',
      url: ORDINARY,
      documentLifecycle: 'active',
    },
  ];
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.frames.length, 1);
  assert.equal(reply.result.frames[0].kind, 'ordinary');
});

test('mutation: blind re-stamp would admit a protected live child', async (t) => {
  const { fixture, tab, live } = await fixtureFor(t);
  live.set('ERROR_TARGET', { targetId: 'ERROR_TARGET', type: 'iframe', url: VAULT });
  await siblingCommit(fixture);
  await settle(tab);
  assert.notEqual(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  tab.debuggerChildInfo.get('error-session').revision = tab.debuggerRevision;
  tab.debuggerChildInfo.get('error-session').url = CANARY;
  assert.equal(fixture.connection.debuggerGate.knownChildren(tab), true);
});

test('mutation: routing childReobservePass through errorRootAllowed admits the sign-in child', async (t) => {
  const { fixture, tab, trees, setParentTree } = await fixtureFor(t, {
    unreachable: SIGN_IN,
    canaryTarget: CANARY,
    tabUrl: MAIN_FAILED,
    mainErrorOccurred: true,
  });
  fixture.connection.state.failed.set(11, MAIN_FAILED);
  setParentTree({
    frame: {
      id: 'root',
      loaderId: 'ordinary-document',
      url: ERROR,
      unreachableUrl: MAIN_FAILED,
    },
  });
  trees.set('error-session', {
    frame: {
      id: 'ERROR_TARGET',
      loaderId: 'error-loader',
      url: ERROR,
      unreachableUrl: SIGN_IN,
    },
  });
  const pass = fixture.connection.childReobservePass.bind(fixture.connection);
  fixture.connection.childReobservePass = async (tabId, targetInfo, childTree) => {
    if (!targetInfo || !childTree) return false;
    const type = targetInfo?.type;
    if (type && type !== 'iframe' && type !== 'worker') return false;
    const liveUrl = targetInfo?.url;
    if (liveUrl && fixture.connection.protectedOrigin(liveUrl)) return false;
    const root = childTree?.frame;
    if (root && String(root.url || '').startsWith('chrome-error:')) {
      if (!(await fixture.connection.errorRootAllowed(tabId, root))) return false;
      const unreachable = String(root.unreachableUrl || '');
      if (
        !unreachable ||
        !/^https?:\/\//.test(unreachable) ||
        !URL.canParse(unreachable) ||
        fixture.connection.protectedOrigin(unreachable)
      )
        return false;
      return true;
    }
    return pass(tabId, targetInfo, childTree);
  };
  await siblingCommit(fixture);
  await settle(tab);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  assert.equal(fixture.connection.debuggerGate.knownChildren(tab), true);
});

test('mutation: stamping the current loaderId blindly admits an old-document child', async (t) => {
  const { fixture, tab, setParentTree } = await fixtureFor(t);
  tab.documents.frames.set('root', { loaderId: 'next-document' });
  setParentTree({
    frame: {
      id: 'root',
      loaderId: 'next-document',
      url: ORDINARY,
      securityOrigin: 'https://ordinary.test',
    },
  });
  tab.frameParents.delete('ERROR_TARGET');
  await siblingCommit(fixture);
  await settle(tab);
  assert.equal(tab.debuggerChildInfo.get('error-session').revision, 0);
  tab.debuggerChildInfo.get('error-session').generation = 'next-document';
  tab.debuggerChildInfo.get('error-session').revision = tab.debuggerRevision;
  assert.equal(fixture.connection.debuggerGate.knownChildren(tab), true);
});
