import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

const ERROR = 'chrome-error://chromewebdata/';
const ORDINARY = 'https://ordinary.test/';
const CANARY = 'https://127.0.0.1:1/ERROR_FRAME_CANARY';
const SIBLING = 'https://other.test/doc';
const SIGN_IN = 'https://ims-na1.adobelogin.com/auth/callback';
const VAULT = 'https://vault.sliccy.ai/doc?REOBSERVE';

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
      const id = String(params?.frameId ?? '');
      return { backendNodeId: id === 'ERROR_TARGET' ? 21 : id === 'SIBLING_TARGET' ? 22 : 20 };
    }
    if (method === 'Page.getFrameTree' && !source?.sessionId) {
      return {
        frameTree: {
          frame: {
            id: 'root',
            loaderId: 'ordinary-document',
            url: ORDINARY,
            securityOrigin: 'https://ordinary.test',
          },
        },
      };
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
  tab.documents.frames.set('root', { loaderId: 'ordinary-document' });
  for (const info of tab.debuggerChildInfo.values()) {
    info.generation = 'ordinary-document';
    info.revision = 0;
  }
  tab.debuggerRevision = 0;
  return { fixture, tab, live };
}

async function settle(tab) {
  for (let i = 0; i < 50; i += 1) {
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

test('a child that is protected at the re-read stays refused', async (t) => {
  const { fixture, tab, live } = await fixtureFor(t);
  live.set('ERROR_TARGET', { targetId: 'ERROR_TARGET', type: 'iframe', url: VAULT });
  await siblingCommit(fixture);
  await settle(tab);
  assert.notEqual(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, 'slicc: refused: unsettled frame list');
});

test('protected sign-in-callback error iframe next to a committing sibling stays locked', async (t) => {
  const { fixture, tab } = await fixtureFor(t, { unreachable: SIGN_IN, canaryTarget: CANARY });
  await siblingCommit(fixture);
  await settle(tab);
  assert.notEqual(tab.debuggerChildInfo.get('error-session').revision, tab.debuggerRevision);
  const reply = await privateFrames(fixture);
  assert.equal(reply.error, 'slicc: refused: unsettled frame list');
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
