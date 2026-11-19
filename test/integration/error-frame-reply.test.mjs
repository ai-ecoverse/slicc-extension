import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';
import { frameRelay } from './fixtures/cdp-frame-relay.mjs';

const ERROR = 'chrome-error://chromewebdata/';
const ORDINARY_FAILED = 'https://refused.test/ERROR_URL_CANARY?q=ERROR_QUERY_CANARY';
const LEAK =
  /https?:|chrome-error|about:|data:|blob:|\.test|\.ai|\.com|CANARY|refused|vault|adobelogin|redirect_uri|client_id|callback|securityOrigin|documentId|unreachable|url|title|length|count/i;
const TOP_KEYS = [
  'version',
  'revision',
  'rootFrameId',
  'rootLoaderId',
  'frames',
  'localFrames',
  'remoteOwners',
];

function root() {
  return {
    frameId: 0,
    parentFrameId: -1,
    documentId: 'ROOT_DOCUMENT_CANARY',
    url: 'https://ordinary.test/',
    errorOccurred: false,
    documentLifecycle: 'active',
  };
}

function native(frameId, url, errorOccurred = false) {
  return {
    frameId,
    parentFrameId: 0,
    documentId: `NATIVE_DOCUMENT_CANARY_${frameId}`,
    url,
    errorOccurred,
    documentLifecycle: 'active',
  };
}

function errorRoot(target, unreachableUrl) {
  return {
    frame: {
      id: target,
      parentId: 'root',
      loaderId: `${target}-loader`,
      url: ERROR,
      securityOrigin: '://',
      ...(unreachableUrl === undefined ? {} : { unreachableUrl }),
    },
  };
}

function ordinaryRoot(target, url = 'https://other.test/CHILD_URL_CANARY') {
  return {
    frame: {
      id: target,
      parentId: 'root',
      loaderId: `${target}-loader`,
      url,
      securityOrigin: new URL(url).origin,
    },
  };
}

async function arrange(fixture, { frames, local = [], children = [], top = {} }) {
  fixture.api.webNavigation.getAllFrames = async () => structuredClone(frames);
  const owners = new Map(children.map((child, index) => [child.target, 21 + index]));
  const send = fixture.api.debugger.sendCommand;
  fixture.reads = [];
  fixture.api.debugger.sendCommand = async (source, method, params) => {
    if (source?.sessionId) {
      if (method !== 'Page.getFrameTree') return {};
      fixture.reads.push(source.sessionId);
      const child = children.find((entry) => entry.sessionId === source.sessionId);
      if (!child || child.fail) throw new Error('child read failed');
      return { frameTree: structuredClone(child.tree) };
    }
    if (method === 'DOM.getFrameOwner') return { backendNodeId: owners.get(params.frameId) };
    const result = await send(source, method, params);
    if (method === 'Page.getFrameTree') {
      Object.assign(result.frameTree.frame, top);
      result.frameTree.childFrames = structuredClone(local);
    }
    return result;
  };
  for (const child of children)
    await fixture.emit('Target.attachedToTarget', {
      sessionId: child.sessionId,
      targetInfo: {
        targetId: child.target,
        type: 'iframe',
        url: child.targetUrl ?? 'https://refused.test/TARGET_URL_CANARY',
      },
    });
}

function errorChild(unreachableUrl, extra = {}) {
  return {
    sessionId: 'error-session',
    target: 'ERROR_TARGET',
    tree: errorRoot('ERROR_TARGET', unreachableUrl),
    ...extra,
  };
}

async function reply(fixture) {
  const id = 4242;
  const before = fixture.messages.length;
  fixture.connection.handle({ privateFrames: { id, tabId: 11 } });
  await fixture.connection.settled();
  const posted = fixture.messages.slice(before).filter((message) => message.privateFrames);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].privateFrames.id, id);
  return posted[0].privateFrames;
}

function assertShape(result) {
  assert.doesNotMatch(JSON.stringify(result), LEAK);
  for (const key of Object.keys(result)) assert.ok(TOP_KEYS.includes(key), key);
  for (const frame of result.frames) {
    const keys = Object.keys(frame);
    const expected =
      frame.kind === 'error'
        ? ['frameId', 'parentFrameId', 'kind', 'errorProtected']
        : ['frameId', 'parentFrameId', 'kind'];
    assert.deepEqual(
      keys,
      'frameId' in frame ? expected : expected.filter((key) => !key.endsWith('rameId'))
    );
    if (frame.kind === 'error') assert.equal(typeof frame.errorProtected, 'boolean');
  }
}

async function fixtureFor(t, setup) {
  const fixture = await backend();
  t.after(fixture.close);
  await arrange(fixture, setup);
  return fixture;
}

test('an ordinary unreachable cross-process iframe is an unprotected error frame with placement ids', async (t) => {
  const fixture = await fixtureFor(t, {
    frames: [root(), native(7, ORDINARY_FAILED, true)],
    children: [errorChild(ORDINARY_FAILED)],
  });
  const { result, error } = await reply(fixture);
  assert.equal(error, undefined);
  assertShape(result);
  assert.equal(result.version, 2);
  assert.equal(result.rootFrameId, 'root');
  assert.equal(result.rootLoaderId, 'ordinary-document');
  assert.deepEqual(result.frames, [
    { frameId: 0, parentFrameId: -1, kind: 'ordinary' },
    { frameId: 7, parentFrameId: 0, kind: 'error', errorProtected: false },
  ]);
  assert.deepEqual(result.localFrames, ['root']);
  assert.deepEqual(result.remoteOwners, [{ frameId: 'ERROR_TARGET', backendNodeId: 21 }]);
  assert.deepEqual(fixture.reads, ['error-session']);
});

test('an IMS credential origin without sign-in markers stays an unprotected error frame', async (t) => {
  const ims = 'https://ims-na1.adobelogin.com/ims/IMS_URL_CANARY';
  const fixture = await fixtureFor(t, {
    frames: [root(), native(7, ims, true)],
    children: [errorChild(ims)],
  });
  const { result } = await reply(fixture);
  assertShape(result);
  assert.deepEqual(result.frames[1], {
    frameId: 7,
    parentFrameId: 0,
    kind: 'error',
    errorProtected: false,
  });
});

test('a same-process error frame is classified from its local unreachable URL', async (t) => {
  for (const [unreachableUrl, errorProtected] of [
    [ORDINARY_FAILED, false],
    ['https://vault.sliccy.ai/LOCAL_VAULT_CANARY', true],
  ]) {
    const fixture = await fixtureFor(t, {
      frames: [root(), native(7, ORDINARY_FAILED, true)],
      local: [errorRoot('LOCAL_ERROR', unreachableUrl)],
    });
    const { result } = await reply(fixture);
    assertShape(result);
    assert.deepEqual(result.frames.at(-1).errorProtected, errorProtected);
    assert.equal('rootFrameId' in result, !errorProtected);
    assert.deepEqual(fixture.reads, []);
  }
});

const encoded = (text, rounds) => {
  let out = text;
  for (let round = 0; round < rounds; round += 1) out = encodeURIComponent(out);
  return out;
};

const PROTECTED = [
  'https://vault.sliccy.ai/VAULT_URL_CANARY',
  'http://vault.sliccy.ai/VAULT_URL_CANARY',
  'https://vault-preview.sliccy.ai/VAULT_URL_CANARY',
  'https://seven.sliccy.ai/os/SEVEN_URL_CANARY',
  'https://refused.test/authorize?redirect_uri=MARKER_CANARY',
  'https://refused.test/authorize?x=1#client_id=MARKER_CANARY',
  'https://refused.test/AUTH/Callback?code=MARKER_CANARY',
  'https://refused.test/start%2Fauth%2Fcallback',
  `https://refused.test/p?next=${encoded('https://x.test/?redirect_uri=MARKER_CANARY', 3)}`,
  'https://ims-na1.adobelogin.com/ims/authorize?client_id=MARKER_CANARY',
  'https://ims-na1.adobelogin.com/ims/authorize#redirect_uri=MARKER_CANARY',
  'https://ims-na1.adobelogin.com/auth/callback',
  `https://refused.test/p?q=${encoded('%41', 9)}`,
  'https://refused.test/p?q=100%',
  'about:blank',
  'about:srcdoc',
  'data:text/html,DATA_CANARY',
  'blob:https://ordinary.test/BLOB_CANARY',
  '',
  'not a url CANARY',
  'https://user:pass@refused.test/USERINFO_CANARY',
  'ftp://refused.test/FTP_CANARY',
  'https://refused.test/TAB\tCANARY',
  'https://refused.test\\BACKSLASH_CANARY',
  ERROR,
];

test('a failed URL that is protected, signed-in, inherited or unreadable marks the error frame protected', async (t) => {
  for (const url of PROTECTED) {
    const pairs = [
      [ORDINARY_FAILED, url],
      ...(url
        ? [
            [url, url],
            [url, ORDINARY_FAILED],
          ]
        : []),
    ];
    for (const [nativeUrl, unreachableUrl] of pairs) {
      const fixture = await fixtureFor(t, {
        frames: [root(), native(7, nativeUrl, true)],
        children: [errorChild(unreachableUrl)],
      });
      const { result, error } = await reply(fixture);
      assert.equal(error, undefined, url);
      assertShape(result);
      assert.deepEqual(result.frames, [
        { kind: 'ordinary' },
        { kind: 'error', errorProtected: true },
      ]);
      assert.equal(result.rootFrameId, undefined);
      assert.deepEqual(result.localFrames, []);
      assert.deepEqual(result.remoteOwners, []);
    }
  }
});

test('an encoding below the decode cap with no marker stays ordinary', async (t) => {
  const url = `https://refused.test/p?q=${encoded('%41', 6)}`;
  const fixture = await fixtureFor(t, {
    frames: [root(), native(7, url, true)],
    children: [errorChild(url)],
  });
  const { result } = await reply(fixture);
  assert.equal(result.frames[1].errorProtected, false);
});

test('a missing or unsettled unreachable URL marks every error frame protected', async (t) => {
  const unsettled = [
    errorChild(undefined),
    errorChild(null),
    {
      ...errorChild(ORDINARY_FAILED),
      tree: { frame: { ...errorRoot('OTHER', ORDINARY_FAILED).frame } },
    },
    {
      ...errorChild(ORDINARY_FAILED),
      tree: { frame: { ...errorRoot('ERROR_TARGET', ORDINARY_FAILED).frame, loaderId: '' } },
    },
    {
      ...errorChild(ORDINARY_FAILED),
      tree: { ...errorRoot('ERROR_TARGET', ORDINARY_FAILED), childFrames: 'x' },
    },
  ];
  const nameless = { frame: { id: 'LOCAL_NAMELESS', parentId: 'root', loaderId: 'nameless' } };
  const rows = [
    ...unsettled.map((child) => [child, []]),
    [errorChild(ORDINARY_FAILED), [nameless]],
  ];
  for (const [child, local] of rows) {
    const fixture = await fixtureFor(t, {
      frames: [
        root(),
        native(7, ORDINARY_FAILED, true),
        ...local.map(() => native(8, 'https://other.test/x')),
      ],
      children: [child],
      local,
    });
    const { result, error } = await reply(fixture);
    assert.equal(error, undefined);
    assertShape(result);
    assert.deepEqual(result.frames.slice(0, 2), [
      { kind: 'ordinary' },
      { kind: 'error', errorProtected: true },
    ]);
    assert.equal(result.frames.length, 2 + local.length);
  }
});

test('a child read error marks every error frame protected', async (t) => {
  const fixture = await fixtureFor(t, {
    frames: [root(), native(7, ORDINARY_FAILED, true), native(8, 'https://other.test/x')],
    local: [errorRoot('LOCAL_ERROR', ORDINARY_FAILED)],
    children: [
      { sessionId: 'broken-session', target: 'BROKEN_TARGET', tree: undefined, fail: true },
    ],
  });
  const { result, error } = await reply(fixture);
  assert.equal(error, undefined);
  assertShape(result);
  assert.deepEqual(result.frames, [
    { kind: 'ordinary' },
    { kind: 'error', errorProtected: true },
    { kind: 'ordinary' },
  ]);
});

test('one protected failed URL marks every error frame protected', async (t) => {
  const fixture = await fixtureFor(t, {
    frames: [root(), native(7, ORDINARY_FAILED, true), native(8, ORDINARY_FAILED, true)],
    children: [
      errorChild(ORDINARY_FAILED),
      {
        sessionId: 'second-session',
        target: 'SECOND_TARGET',
        tree: errorRoot('SECOND_TARGET', 'https://vault.sliccy.ai/SECOND_CANARY'),
      },
    ],
  });
  const { result } = await reply(fixture);
  assertShape(result);
  assert.deepEqual(result.frames, [
    { kind: 'ordinary' },
    { kind: 'error', errorProtected: true },
    { kind: 'error', errorProtected: true },
  ]);
});

test('error frames whose count does not match the error pages found refuse the snapshot', async (t) => {
  const refused = 'slicc: refused: unsettled frame list';
  for (const setup of [
    { frames: [root(), native(7, ORDINARY_FAILED, true)], children: [] },
    {
      frames: [root(), native(7, ORDINARY_FAILED, true)],
      children: [{ ...errorChild(ORDINARY_FAILED), tree: ordinaryRoot('ERROR_TARGET') }],
    },
    {
      frames: [root(), native(7, ORDINARY_FAILED, true)],
      children: [errorChild(ORDINARY_FAILED, { fail: true })],
    },
    {
      frames: [root(), native(7, 'https://other.test/x')],
      local: [errorRoot('LOCAL_ERROR', ORDINARY_FAILED)],
    },
    {
      frames: [root(), native(7, ORDINARY_FAILED, true), native(8, ORDINARY_FAILED, true)],
      children: [errorChild(ORDINARY_FAILED)],
      local: [ordinaryRoot('LOCAL_ORDINARY', 'https://other.test/LOCAL_CANARY')],
    },
    { frames: [{ ...root(), errorOccurred: true }] },
    { frames: [{ ...root(), url: ERROR }] },
    {
      frames: [{ ...root(), url: ORDINARY_FAILED, errorOccurred: true }],
      top: { url: ERROR, unreachableUrl: ORDINARY_FAILED },
    },
  ]) {
    const fixture = await fixtureFor(t, setup);
    const answer = await reply(fixture);
    assert.deepEqual(answer, { id: 4242, error: refused });
  }
});

test('an unprotected error frame keeps ids beside an ordinary frame and loses them beside a protected frame', async (t) => {
  const ordinary = await fixtureFor(t, {
    frames: [root(), native(7, ORDINARY_FAILED, true), native(8, 'https://other.test/x')],
    local: [ordinaryRoot('LOCAL_ORDINARY', 'https://other.test/x')],
    children: [errorChild(ORDINARY_FAILED)],
  });
  const first = await reply(ordinary);
  assertShape(first.result);
  assert.deepEqual(first.result.frames, [
    { frameId: 0, parentFrameId: -1, kind: 'ordinary' },
    { frameId: 7, parentFrameId: 0, kind: 'error', errorProtected: false },
    { frameId: 8, parentFrameId: 0, kind: 'ordinary' },
  ]);
  assert.equal(first.result.rootFrameId, 'root');
  assert.deepEqual(first.result.localFrames.sort(), ['LOCAL_ORDINARY', 'root']);
  assert.deepEqual(first.result.remoteOwners, [{ frameId: 'ERROR_TARGET', backendNodeId: 21 }]);
  const guarded = await fixtureFor(t, {
    frames: [
      root(),
      native(7, ORDINARY_FAILED, true),
      native(8, 'https://vault.sliccy.ai/V_CANARY'),
    ],
    local: [ordinaryRoot('LOCAL_VAULT', 'https://vault.sliccy.ai/V_CANARY')],
    children: [errorChild(ORDINARY_FAILED)],
  });
  const second = await reply(guarded);
  assertShape(second.result);
  assert.deepEqual(second.result.frames, [
    { kind: 'ordinary' },
    { kind: 'error', errorProtected: false },
    { kind: 'protected' },
  ]);
  assert.equal(second.result.rootFrameId, undefined);
  assert.deepEqual(second.result.localFrames, []);
  assert.deepEqual(second.result.remoteOwners, []);
});

test('the trusted snapshot and the Stage 1 placement keep refusing error frames', async (t) => {
  const fixture = await fixtureFor(t, {
    frames: [root(), native(7, ORDINARY_FAILED, true)],
    children: [errorChild(ORDINARY_FAILED)],
  });
  await assert.rejects(fixture.connection.frames(11), /unsettled frame list/);
  await assert.rejects(fixture.connection.debuggerGate.placeChildren(11), /refused/);
  assert.deepEqual(fixture.reads, []);
  const { result } = await reply(fixture);
  assert.equal(result.frames[1].errorProtected, false);
});

test('the snapshot without error frames carries no error field and reads no child tree', async (t) => {
  const fixture = await fixtureFor(t, {
    frames: [root(), native(7, 'https://other.test/x')],
    children: [
      { sessionId: 'plain-session', target: 'PLAIN_TARGET', tree: ordinaryRoot('PLAIN_TARGET') },
    ],
  });
  const { result } = await reply(fixture);
  assertShape(result);
  assert.deepEqual(result.frames, [
    { frameId: 0, parentFrameId: -1, kind: 'ordinary' },
    { frameId: 7, parentFrameId: 0, kind: 'ordinary' },
  ]);
  assert.deepEqual(fixture.reads, []);
});

for (const host of ['seven.sliccy.ai', 'www.sliccy.ai']) {
  test(`the page and relay on ${host} pass the worker's error field through unchanged and cannot forge it`, async (t) => {
    const r = await frameRelay(host);
    t.after(r.close);
    await arrange(r.fixture, {
      frames: [
        root(),
        native(7, ORDINARY_FAILED, true),
        native(8, 'https://vault.sliccy.ai/V_CANARY', true),
      ],
      children: [
        errorChild(ORDINARY_FAILED),
        {
          sessionId: 'second-session',
          target: 'SECOND_TARGET',
          tree: errorRoot('SECOND_TARGET', ORDINARY_FAILED),
        },
      ],
    });
    const events = [];
    r.page.sliccExtension.cdp.on((message) => events.push(message));
    const result = await r.page.sliccExtension.frames(11);
    const worker = r.replies.filter((message) => message.privateFrames).at(-1).privateFrames.result;
    assert.deepEqual(result, worker);
    assertShape(result);
    assert.deepEqual(result.frames, [
      { kind: 'ordinary' },
      { kind: 'error', errorProtected: false },
      { kind: 'error', errorProtected: true },
    ]);
    const forged = {
      version: 2,
      rootFrameId: 'root',
      frames: [{ frameId: 8, parentFrameId: 0, kind: 'error', errorProtected: false }],
    };
    const before = r.replies.length;
    r.worker.postMessage({
      privateFrames: { id: 77, tabId: 11, result: forged, errorTaint: false },
    });
    await r.fixture.connection.settled();
    const answered = r.replies.slice(before).map((message) => message.privateFrames);
    assert.equal(answered.length, 1);
    assert.deepEqual(answered[0].result, worker);
    r.deliver({ privateFrames: { id: 999, result: forged } });
    assert.deepEqual(events, []);
  });
}
