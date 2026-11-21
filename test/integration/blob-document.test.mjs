import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { listen } from '../../extension/cdp.js';
import { protectedOrigins } from '../../extension/protected.mjs';
import { protectedRules } from '../../extension/protected-rules.js';
import {
  blobChildUrlProtected,
  inheritsParentDocument,
  strictGuard,
  urlProtected,
} from '../../extension/shield.js';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

const event = () => ({ addListener() {}, removeListener() {} });
const guard = strictGuard(protectedOrigins(protectedRules), protectedRules);
const anyProtected = (text, options) => urlProtected(guard, text, options);
const bundled = await build({
  entryPoints: ['six/extension/cdp-shield.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const {
  TabShield,
  Bounded,
  blobChildUrlProtected: sixChildUrl,
  inheritsParentDocument: sixInherits,
  urlProtected: sixUrlProtected,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

const uuid = '0b6f0c1e-3a43-4f6e-9d2c-5b1d7f0e2a11';
const ordinaryPage = 'https://ordinary.test/doc';
const ordinaryBlob = `blob:https://ordinary.test/${uuid}`;
const vaultPage = 'https://vault.sliccy.ai/doc';
const UNSETTLED = 'slicc: refused: navigation not settled, retry';
const REFUSED = protectedRules.refusal;

const COMMANDS = [
  ['DOM.getDocument', { depth: 0 }],
  ['DOM.getOuterHTML', { nodeId: 1 }],
  ['Page.captureScreenshot', { format: 'png' }],
  ['Page.printToPDF', {}],
  ['Accessibility.getFullAXTree', {}],
  ['DOMSnapshot.captureSnapshot', { computedStyles: [] }],
  ['Page.getFrameTree', {}],
  ['CSS.getComputedStyleForNode', { nodeId: 1 }],
];

function originOf(url) {
  const origin = URL.canParse(url) ? new URL(url).origin : 'null';
  return origin === 'null' ? 'null' : origin;
}

function root(url, extra = {}) {
  return { id: 'ROOT', loaderId: `L-${url}`, url, securityOrigin: originOf(url), ...extra };
}

function chromeFrames(url) {
  if (url.startsWith('blob:')) return [];
  return [
    {
      frameId: 0,
      parentFrameId: -1,
      documentId: `D-${url}`,
      documentLifecycle: 'active',
      frameType: 'outermost_frame',
      processId: 1,
      url,
      errorOccurred: false,
    },
  ];
}

function snapshot(state) {
  const frames = [state.tree(), ...framesOf(state.children)];
  const strings = [];
  const documents = frames.map((frame) => {
    strings.push(frame.url, frame.id);
    return { documentURL: strings.length - 2, frameId: strings.length - 1, nodes: {} };
  });
  return { documents, strings };
}

function framesOf(children = []) {
  return children.flatMap((node) => [node.frame, ...framesOf(node.childFrames)]);
}

function cloneTree(nodes = []) {
  return nodes.map((node) => ({
    ...node,
    frame: node.frame ? { ...node.frame } : node.frame,
    childFrames: cloneTree(node.childFrames),
  }));
}

function answers(method, state) {
  switch (method) {
    case 'Page.getFrameTree':
      return { frameTree: { frame: state.tree(), childFrames: cloneTree(state.children) } };
    case 'Page.getNavigationHistory':
      return { currentIndex: 0, entries: [{ id: 1, url: state.history?.() ?? state.tree().url }] };
    case 'DOM.getDocument':
      return { root: { nodeId: 1, backendNodeId: 1, nodeName: '#document' } };
    case 'DOM.getOuterHTML':
      return { outerHTML: '<html><body>ok</body></html>' };
    case 'DOM.describeNode':
      return { node: { nodeId: 1, backendNodeId: 1 } };
    case 'Page.captureScreenshot':
    case 'Page.printToPDF':
      return { data: 'ZmFrZQ==' };
    case 'Accessibility.getFullAXTree':
      return { nodes: [] };
    case 'DOMSnapshot.captureSnapshot':
      return snapshot(state);
    case 'CSS.getComputedStyleForNode':
      return { computedStyle: [] };
    default:
      return {};
  }
}

async function fixture(transport, url) {
  const state = {
    tab: () => ({ id: 1, url, status: 'complete' }),
    frames: () => chromeFrames(url),
    tree: () => root(url),
    children: [],
  };
  const readTab = async () => state.tab();
  const send = async (method) => answers(method, state);
  if (transport === 'seven') {
    const published = [];
    const connection = listen(
      {
        name: 'slicc-fetch',
        sender: {
          id: 'fixture',
          url: 'https://seven.sliccy.ai/',
          origin: 'https://seven.sliccy.ai',
        },
        onDisconnect: event(),
        postMessage(message) {
          published.push(message);
        },
      },
      'fixture',
      {
        tabs: { get: readTab, query: async () => [] },
        webNavigation: { getAllFrames: async () => state.frames() },
        debugger: {
          onEvent: event(),
          onDetach: event(),
          attach: async () => {},
          detach: async () => {},
          sendCommand: async (_target, method) => send(method),
        },
      }
    );
    let sessionId;
    let id = 1000;
    return {
      state,
      connection,
      async open() {
        ({ sessionId } = await connection.attach({ targetId: '1', flatten: true }));
      },
      commit(frame) {
        connection.watchFrame(1, connection.tabState(1), frame);
      },
      check: (method) => connection.checkContent(1, method, {}),
      async attempt(method, params = {}) {
        id += 1;
        await connection.run({ id, method, params, sessionId });
        const message = published.findLast((m) => m.id === id);
        return message?.error === undefined
          ? { result: message?.result }
          : { error: String(message.error?.message ?? message.error) };
      },
      close() {
        connection.closed = false;
        connection.close();
      },
    };
  }
  const shield = new TabShield(
    send,
    () => {},
    new Bounded(200),
    readTab,
    undefined,
    async () => state.frames()
  );
  return {
    state,
    shield,
    open: () => shield.install(),
    check: (method) => shield.checkContent(method, {}),
    commit(frame) {
      shield.onEvent('Page.frameNavigated', { frame });
    },
    async attempt(method, params = {}) {
      try {
        return { result: await shield.command(method, params, send) };
      } catch (error) {
        return { error: String(error.message) };
      }
    },
    close() {},
  };
}

async function at(transport, url, t) {
  const f = await fixture(transport, url);
  t.after(() => f.close());
  await f.open();
  f.commit(root(url));
  return f;
}

async function opened(transport, url, t) {
  try {
    return await at(transport, url, t);
  } catch (error) {
    return { attach: String(error.message) };
  }
}

async function judged(transport, url, t) {
  const f = await opened(transport, url, t);
  if (f.attach) return { attach: f.attach };
  return verdicts(f);
}

async function verdicts(f) {
  const out = {};
  for (const [method, params] of COMMANDS) {
    const answer = await f.attempt(method, params);
    out[method] = answer.error ?? 'answered';
  }
  return out;
}

function all(verdict) {
  return Object.fromEntries(COMMANDS.map(([method]) => [method, verdict]));
}

const vaultBlob = `blob:https://vault.sliccy.ai/${uuid}`;
const wwwBlob = `blob:https://www.sliccy.ai/${uuid}`;
const otherBlob = `blob:https://ordinary.test/1c2d3e4f-0000-4000-8000-000000000000`;

function fail() {
  throw new Error('No tab with id: 1.');
}

function child(url) {
  return { frame: { ...root(url), id: 'CHILD', parentId: 'ROOT' } };
}

function move(f, { tab, pendingUrl, frames, tree, origin, history, children = [] }) {
  f.state.history = history ? () => history : undefined;
  f.state.tab = () => ({
    id: 1,
    url: tab,
    status: 'complete',
    ...(pendingUrl ? { pendingUrl } : {}),
  });
  f.state.frames = typeof frames === 'function' ? frames : () => chromeFrames(frames ?? tab);
  f.state.tree = () => root(tree ?? tab, origin ? { securityOrigin: origin } : {});
  f.state.children = children;
}

const vaultError = {
  ...root('chrome-error://chromewebdata/'),
  securityOrigin: '://',
  unreachableUrl: vaultPage,
};

function framedFrames(rootUrl, frames) {
  if (rootUrl.startsWith('blob:')) return [];
  return [
    ...chromeFrames(rootUrl),
    ...frames.map((frame, i) => ({
      frameId: i + 1,
      parentFrameId: 0,
      documentId: `D-child-${i}`,
      documentLifecycle: 'active',
      frameType: 'sub_frame',
      processId: 2,
      url: frame.url,
      errorOccurred: frame.error === true,
    })),
  ];
}

const ordinaryIframe = 'https://other.test/hello';

function oopif(url, extra = {}) {
  return {
    frame: {
      id: 'CHILD',
      parentId: 'ROOT',
      loaderId: `L-${url || 'oopif'}`,
      url,
      ...extra,
    },
  };
}

const FRAMING = {
  'a same-process vault iframe': {
    children: [child(vaultPage)],
    listed: [{ url: vaultPage }],
  },
  'an out-of-process vault iframe': {
    children: [oopif(vaultPage)],
    listed: [{ url: vaultPage }],
  },
  'a vault iframe the frame list omits': { children: [child(vaultPage)], listed: [] },
  'a nested ordinary blob frame hosting a vault page': {
    children: [
      {
        ...child(otherBlob),
        childFrames: [{ frame: { ...root(vaultPage), id: 'GRAND', parentId: 'CHILD' } }],
      },
    ],
    listed: [{ url: vaultPage }],
  },
  'a srcdoc child on the vault origin': {
    children: [
      {
        frame: {
          id: 'CHILD',
          parentId: 'ROOT',
          loaderId: 'L-srcdoc',
          url: 'about:srcdoc',
          securityOrigin: 'https://vault.sliccy.ai',
        },
      },
    ],
    listed: [],
  },
  'an error iframe for a vault url': {
    children: [{ frame: { ...vaultError, id: 'CHILD', parentId: 'ROOT' } }],
    listed: [{ url: vaultPage, error: true }],
  },
  'an ordinary https iframe': {
    children: [child(ordinaryIframe)],
    listed: [{ url: ordinaryIframe }],
  },
  'an about:blank child that inherits the document origin': {
    children: [
      {
        frame: {
          id: 'CHILD',
          parentId: 'ROOT',
          loaderId: 'L-blank',
          url: 'about:blank',
          securityOrigin: 'https://ordinary.test',
        },
      },
    ],
    listed: [],
  },
  'an about:srcdoc child that inherits the document origin': {
    children: [
      {
        frame: {
          id: 'CHILD',
          parentId: 'ROOT',
          loaderId: 'L-srcdoc-ok',
          url: 'about:srcdoc',
          securityOrigin: 'https://ordinary.test',
        },
      },
    ],
    listed: [],
  },
  'a data child with an opaque origin': {
    children: [
      {
        frame: {
          id: 'CHILD',
          parentId: 'ROOT',
          loaderId: 'L-data',
          url: 'data:text/html,<p>ok</p>',
          securityOrigin: 'null',
        },
      },
    ],
    listed: [],
  },
  'a nested protected blob child': {
    children: [child(vaultBlob)],
    listed: [{ url: vaultBlob }],
  },
  'an ordinary https child on a protected securityOrigin': {
    children: [
      {
        frame: {
          id: 'CHILD',
          parentId: 'ROOT',
          loaderId: 'L-origin-only',
          url: ordinaryIframe,
          securityOrigin: 'https://vault.sliccy.ai',
        },
      },
    ],
    listed: [{ url: ordinaryIframe }],
  },
};

async function framedVerdicts(transport, rootUrl, name, t) {
  const { children, listed } = FRAMING[name];
  const f = await at(transport, rootUrl, t);
  f.state.children = cloneTree(children);
  f.state.frames = () => framedFrames(rootUrl, listed);
  const out = await verdicts(f);
  const tree = await f.attempt('Page.getFrameTree', {});
  const shown = JSON.stringify([
    tree.result ?? {},
    (await f.attempt('DOMSnapshot.captureSnapshot', { computedStyles: [] })).result ?? {},
  ]);
  return { ...out, vault: shown.includes('vault.sliccy.ai') };
}

function walkChildren(tree, parentOrigin, { urlProtected: urlHit, originProtected, refuseOther }) {
  const pending = Array.isArray(tree?.childFrames) ? [...tree.childFrames] : [];
  while (pending.length > 0) {
    const node = pending.pop();
    const frame = node?.frame;
    const url = frame?.url;
    const origin = frame?.securityOrigin;
    if (refuseOther?.(url)) return true;
    if (urlHit(url)) return true;
    if (originProtected && typeof origin === 'string' && originProtected(origin)) return true;
    const badUrl = typeof url !== 'string' || url === '';
    const badOrigin = typeof origin !== 'string';
    if ((badUrl || badOrigin) && !(inheritsParentDocument(url) && origin === parentOrigin))
      return true;
    if (Array.isArray(node?.childFrames)) pending.push(...node.childFrames);
  }
  return false;
}

function walkTreatingBlobOrdinary(tree, parentOrigin, isProtected, inherits) {
  const pending = Array.isArray(tree?.childFrames) ? [...tree.childFrames] : [];
  while (pending.length > 0) {
    const node = pending.pop();
    const frame = node?.frame;
    const url = frame?.url;
    const origin = frame?.securityOrigin;
    if (typeof url === 'string' && url.startsWith('blob:')) {
      if (Array.isArray(node?.childFrames)) pending.push(...node.childFrames);
      continue;
    }
    if (typeof url === 'string' && url !== '' && isProtected(url)) return true;
    if (typeof origin === 'string' && isProtected(origin)) return true;
    const badUrl = typeof url !== 'string' || url === '';
    const badOrigin = typeof origin !== 'string';
    if ((badUrl || badOrigin) && !(inherits(url) && origin === parentOrigin)) return true;
    if (Array.isArray(node?.childFrames)) pending.push(...node.childFrames);
  }
  return false;
}

function sevenWalk(kind) {
  if (kind === 'withoutOrigin') {
    return (tree, parentOrigin) =>
      walkChildren(tree, parentOrigin, {
        urlProtected: (url) => blobChildUrlProtected(url, anyProtected),
        originProtected: undefined,
      });
  }
  if (kind === 'withoutBlob') {
    return (tree, parentOrigin) =>
      walkTreatingBlobOrdinary(tree, parentOrigin, anyProtected, inheritsParentDocument);
  }
  return (tree, parentOrigin) =>
    walkChildren(tree, parentOrigin, {
      urlProtected: (url) => blobChildUrlProtected(url, anyProtected),
      originProtected: anyProtected,
      refuseOther: (url) =>
        typeof url === 'string' &&
        url !== '' &&
        !/^https?:/i.test(url) &&
        !inheritsParentDocument(url),
    });
}

function sixWalk(kind) {
  if (kind === 'withoutOrigin') {
    return (tree, parentOrigin) =>
      walkChildren(tree, parentOrigin, {
        urlProtected: (url) => sixChildUrl(url),
        originProtected: undefined,
      });
  }
  if (kind === 'withoutBlob') {
    return (tree, parentOrigin) =>
      walkTreatingBlobOrdinary(tree, parentOrigin, sixUrlProtected, sixInherits);
  }
  return (tree, parentOrigin) =>
    walkChildren(tree, parentOrigin, {
      urlProtected: (url) => sixChildUrl(url),
      originProtected: sixUrlProtected,
      refuseOther: (url) =>
        typeof url === 'string' && url !== '' && !/^https?:/i.test(url) && !sixInherits(url),
    });
}

async function mutateBlobWalk(transport, url, t, kind) {
  const f = await at(transport, url, t);
  if (transport === 'seven') f.connection.blobFrameProtected = sevenWalk(kind);
  else f.shield.blobFrameProtected = sixWalk(kind);
  return f;
}

const SCENARIOS = {
  'ordinary blob to vault page': [ordinaryBlob, { tab: vaultPage }],
  'ordinary blob, vault page pending': [ordinaryBlob, { tab: ordinaryBlob, pendingUrl: vaultPage }],
  'ordinary blob, frame tree already on the vault page': [
    ordinaryBlob,
    { tab: ordinaryBlob, tree: vaultPage },
  ],
  'ordinary blob, frame tree already on the next ordinary page': [
    ordinaryBlob,
    { tab: ordinaryBlob, tree: ordinaryPage },
  ],
  'ordinary blob, frame tree already on another ordinary blob': [
    ordinaryBlob,
    { tab: ordinaryBlob, tree: otherBlob },
  ],
  'ordinary blob, frame tree already on a vault blob': [
    ordinaryBlob,
    { tab: ordinaryBlob, tree: vaultBlob },
  ],
  'ordinary blob, tab on a www blob, tree still on the ordinary blob': [
    ordinaryBlob,
    { tab: wwwBlob, tree: ordinaryBlob },
  ],
  'ordinary blob, history already on a vault blob': [
    ordinaryBlob,
    { tab: ordinaryBlob, history: vaultBlob },
  ],
  'ordinary blob, a different ordinary page pending': [
    ordinaryBlob,
    { tab: ordinaryBlob, pendingUrl: ordinaryPage },
  ],
  'ordinary blob, frame list missing': [
    ordinaryBlob,
    { tab: ordinaryBlob, frames: () => undefined },
  ],
  'ordinary blob, frame list throws': [ordinaryBlob, { tab: ordinaryBlob, frames: () => fail() }],
  'ordinary page, empty frame list': [ordinaryPage, { tab: ordinaryPage, frames: () => [] }],
  'ordinary page, frame list missing': [
    ordinaryPage,
    { tab: ordinaryPage, frames: () => undefined },
  ],
  'ordinary page, frame list throws': [ordinaryPage, { tab: ordinaryPage, frames: () => fail() }],
  'ordinary page to vault blob': [ordinaryPage, { tab: vaultBlob }],
  'ordinary page to www blob': [ordinaryPage, { tab: wwwBlob }],
  'vault blob to ordinary page': [vaultBlob, { tab: ordinaryPage }],
  'vault blob to ordinary page, frames empty, tree still on the vault blob': [
    vaultBlob,
    { tab: ordinaryPage, frames: vaultBlob, tree: vaultBlob },
  ],
  'vault blob to ordinary blob, tree still on the vault blob': [
    vaultBlob,
    { tab: ordinaryBlob, tree: vaultBlob },
  ],
  'vault blob to ordinary blob': [vaultBlob, { tab: ordinaryBlob }],
  'ordinary page with an ordinary blob iframe': [
    ordinaryPage,
    { tab: ordinaryPage, children: [child(ordinaryBlob)] },
  ],
  'ordinary page with a vault blob iframe': [
    ordinaryPage,
    { tab: ordinaryPage, children: [child(vaultBlob)] },
  ],
  'ordinary blob with an opaque securityOrigin': [
    ordinaryBlob,
    { tab: ordinaryBlob, origin: 'null' },
  ],
};

async function scenario(transport, name, t) {
  const [start, next] = SCENARIOS[name];
  if (start.includes('vault.sliccy.ai')) {
    const f = await fixture(transport, next.tab);
    t.after(() => f.close());
    move(f, next);
    return attached(f, next);
  }
  const f = await at(transport, start, t);
  move(f, next);
  f.commit(f.state.tree());
  return verdicts(f);
}

async function attached(f, next) {
  try {
    await f.open();
  } catch (error) {
    return { attach: String(error.message) };
  }
  f.commit(f.state.tree());
  return verdicts(f);
}

const TABS = [
  [`blob:https://www.sliccy.ai/${uuid}`, { attach: REFUSED }],
  [`blob:https://sub.sliccy.ai/${uuid}`, { attach: REFUSED }],
  [`blob:https://sliccy.ai/${uuid}`, { attach: REFUSED }],
  [`blob:https://vault.sliccy.ai/${uuid}`, { attach: REFUSED }],
  [`blob:null/${uuid}`, { attach: REFUSED }],
  [`blob:https://ordinary.test:99999/${uuid}`, { attach: REFUSED }],
  [`blob:blob:https://ordinary.test/${uuid}`, all(UNSETTLED)],
  [`blob:ftp://ordinary.test/${uuid}`, all(UNSETTLED)],
  [`blob:https://ordinary.test:443/${uuid}`, all('answered')],
  [`blob:https://ordinary.test@www.sliccy.ai/${uuid}`, { attach: REFUSED }],
];

const FRAMED_BLOB = {
  'a same-process vault iframe': REFUSED,
  'an out-of-process vault iframe': REFUSED,
  'a vault iframe the frame list omits': REFUSED,
  'a nested ordinary blob frame hosting a vault page': REFUSED,
  'a srcdoc child on the vault origin': REFUSED,
  'an error iframe for a vault url': REFUSED,
  'an ordinary https iframe': 'answered',
  'an about:blank child that inherits the document origin': 'answered',
  'an about:srcdoc child that inherits the document origin': 'answered',
  'a data child with an opaque origin': 'answered',
  'a nested protected blob child': REFUSED,
  'an ordinary https child on a protected securityOrigin': REFUSED,
};

const FRAMED_PAGE = {
  'a same-process vault iframe': 'answered',
  'an out-of-process vault iframe': 'answered',
  'a vault iframe the frame list omits': 'answered',
  'a nested ordinary blob frame hosting a vault page': 'answered',
  'a srcdoc child on the vault origin': 'answered',
  'an error iframe for a vault url': REFUSED,
  'an ordinary https iframe': 'answered',
  'an about:blank child that inherits the document origin': 'answered',
  'an about:srcdoc child that inherits the document origin': 'answered',
  'a data child with an opaque origin': 'answered',
  'a nested protected blob child': 'answered',
  'an ordinary https child on a protected securityOrigin': 'answered',
};

const EXPECTED = {
  'ordinary blob to vault page': REFUSED,
  'ordinary blob, vault page pending': REFUSED,
  'ordinary blob, frame tree already on the vault page': REFUSED,
  'ordinary blob, frame tree already on the next ordinary page': UNSETTLED,
  'ordinary blob, frame tree already on another ordinary blob': UNSETTLED,
  'ordinary blob, frame tree already on a vault blob': REFUSED,
  'ordinary blob, tab on a www blob, tree still on the ordinary blob': REFUSED,
  'ordinary blob, history already on a vault blob': 'refused',
  'ordinary blob, a different ordinary page pending': UNSETTLED,
  'ordinary blob, frame list missing': UNSETTLED,
  'ordinary blob, frame list throws': UNSETTLED,
  'ordinary page, empty frame list': UNSETTLED,
  'ordinary page, frame list missing': UNSETTLED,
  'ordinary page, frame list throws': UNSETTLED,
  'ordinary page to vault blob': REFUSED,
  'ordinary page to www blob': REFUSED,
  'vault blob to ordinary page': 'answered',
  'vault blob to ordinary page, frames empty, tree still on the vault blob': REFUSED,
  'vault blob to ordinary blob, tree still on the vault blob': REFUSED,
  'vault blob to ordinary blob': 'answered',
  'ordinary page with an ordinary blob iframe': 'answered',
  'ordinary page with a vault blob iframe': 'answered',
  'ordinary blob with an opaque securityOrigin': UNSETTLED,
};

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport}: an ordinary blob document answers every content command`, async (t) => {
    const f = await at(transport, ordinaryBlob, t);
    assert.deepEqual(await verdicts(f), all('answered'));
  });

  test(`${transport}: a plain-http blob document is judged as its plain-http page`, async (t) => {
    const page = await at(transport, 'http://upstream.test/doc', t);
    const plain = await verdicts(page);
    assert.deepEqual(plain, all('answered'));
    const f = await at(transport, `blob:http://upstream.test/${uuid}`, t);
    assert.deepEqual(await verdicts(f), plain);
  });

  test(`${transport}: a blob url with inner userinfo is judged by its parsed host`, async (t) => {
    const page = await judged(transport, 'https://www.sliccy.ai@ordinary.test/doc', t);
    assert.deepEqual(page, all('answered'));
    const blob = await judged(transport, `blob:https://www.sliccy.ai@ordinary.test/${uuid}`, t);
    assert.deepEqual(blob, page);
  });

  for (const name of Object.keys(FRAMED_BLOB)) {
    test(`${transport}: an ordinary blob document with ${name}`, async (t) => {
      const blob = await framedVerdicts(transport, ordinaryBlob, name, t);
      assert.deepEqual(blob, { ...all(FRAMED_BLOB[name]), vault: false });
    });
    test(`${transport}: an ordinary page with ${name}`, async (t) => {
      const page = await framedVerdicts(transport, ordinaryPage, name, t);
      assert.deepEqual(page, { ...all(FRAMED_PAGE[name]), vault: false });
    });
  }

  test(`${transport}: mutation without the blob tree child check admits a same-process vault iframe`, async (t) => {
    const f = await at(transport, ordinaryBlob, t);
    if (transport === 'seven') {
      const connection = f.connection;
      connection.blobFrameProtected = () => false;
    } else {
      f.shield.blobFrameProtected = () => false;
    }
    f.state.children = cloneTree(FRAMING['a same-process vault iframe'].children);
    f.state.frames = () =>
      framedFrames(ordinaryBlob, FRAMING['a same-process vault iframe'].listed);
    const out = await verdicts(f);
    assert.deepEqual(out, all('answered'));
  });

  test(`${transport}: mutation without the securityOrigin child check admits an ordinary https child on a protected securityOrigin`, async (t) => {
    const f = await mutateBlobWalk(transport, ordinaryBlob, t, 'withoutOrigin');
    f.state.children = cloneTree(
      FRAMING['an ordinary https child on a protected securityOrigin'].children
    );
    f.state.frames = () =>
      framedFrames(
        ordinaryBlob,
        FRAMING['an ordinary https child on a protected securityOrigin'].listed
      );
    assert.deepEqual(await verdicts(f), all('answered'));
  });

  test(`${transport}: mutation without the nested-blob child judgement admits a nested protected blob child`, async (t) => {
    const f = await mutateBlobWalk(transport, ordinaryBlob, t, 'withoutBlob');
    f.state.children = cloneTree(FRAMING['a nested protected blob child'].children);
    f.state.frames = () =>
      framedFrames(ordinaryBlob, FRAMING['a nested protected blob child'].listed);
    assert.deepEqual(await verdicts(f), all('answered'));
  });

  test(`${transport}: mutation refusing non-http(s) and non-about children refuses a data child with an opaque origin`, async (t) => {
    const f = await mutateBlobWalk(transport, ordinaryBlob, t, 'refuseData');
    f.state.children = cloneTree(FRAMING['a data child with an opaque origin'].children);
    f.state.frames = () =>
      framedFrames(ordinaryBlob, FRAMING['a data child with an opaque origin'].listed);
    assert.deepEqual(await verdicts(f), all(REFUSED));
  });

  test(`${transport}: an identity-provider blob document is judged as its page`, async (t) => {
    const page = await judged(transport, 'https://ims-na1.adobelogin.com/doc', t);
    const blob = await judged(transport, `blob:https://ims-na1.adobelogin.com/${uuid}`, t);
    assert.deepEqual(blob, page);
  });

  for (const [url, expected] of TABS) {
    test(`${transport}: a tab on ${url}`, async (t) => {
      assert.deepEqual(await judged(transport, url, t), expected);
    });
  }

  for (const [name, expected] of Object.entries(EXPECTED)) {
    test(`${transport}: ${name}`, async (t) => {
      const out = await scenario(transport, name, t);
      if (expected === 'refused') {
        assert.ok(COMMANDS.every(([method]) => out[method].startsWith('slicc: refused: ')));
        assert.equal(out['DOM.getDocument'], REFUSED);
        return;
      }
      assert.deepEqual(out, out.attach ? { attach: expected } : all(expected));
    });
  }
}

async function sevenDebugger(t, { frames, lease = true }) {
  const fixture = await backend();
  t.after(fixture.close);
  if (frames) fixture.api.webNavigation.getAllFrames = async () => frames;
  if (lease) await fixture.lease();
  return fixture;
}

const reply = (message) => message?.error?.message ?? message?.error ?? 'answered';

async function enable(fixture) {
  await fixture.emit('Runtime.executionContextCreated', {
    context: {
      id: 1,
      uniqueId: 'ordinary-context',
      origin: 'https://ordinary.test',
      auxData: { isDefault: true, frameId: 'root' },
    },
  });
  return reply(await fixture.command('Debugger.enable'));
}

test('seven: Debugger.enable on an ordinary page with its frame list enables', async (t) => {
  const fixture = await sevenDebugger(t, { lease: false });
  assert.equal(await enable(fixture), 'answered');
});

test('seven: Debugger.enable on an ordinary page with an empty frame list stays refused', async (t) => {
  const fixture = await sevenDebugger(t, { frames: [], lease: false });
  assert.equal(await enable(fixture), UNSETTLED);
  assert.equal(
    fixture.calls.some(({ method }) => method === 'Debugger.enable'),
    false
  );
});

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport}: the content check keeps Debugger.getScriptSource on an ordinary blob document unsettled`, async (t) => {
    const f = await at(transport, ordinaryBlob, t);
    await assert.rejects(f.check('Debugger.getScriptSource'), new RegExp(`^Error: ${UNSETTLED}$`));
  });
}

test('six-bridge: Debugger.* on an ordinary page with an empty frame list is answered as on main', async (t) => {
  const f = await at('six-bridge', ordinaryPage, t);
  f.state.frames = () => [];
  assert.equal((await f.attempt('Debugger.enable', {})).error, undefined);
  assert.equal(
    (await f.attempt('Debugger.setBreakpointsActive', { active: true })).error,
    undefined
  );
  assert.equal((await f.attempt('Debugger.getScriptSource', { scriptId: '1' })).error, UNSETTLED);
});

test('six-bridge: Debugger content reads on an ordinary blob document stay unsettled', async (t) => {
  const f = await at('six-bridge', ordinaryBlob, t);
  assert.equal((await f.attempt('Debugger.enable', {})).error, undefined);
  assert.equal((await f.attempt('Debugger.getScriptSource', { scriptId: '1' })).error, UNSETTLED);
});
