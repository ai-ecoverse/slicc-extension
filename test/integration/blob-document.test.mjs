import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { listen } from '../../extension/cdp.js';
import { protectedRules } from '../../extension/protected-rules.js';

const event = () => ({ addListener() {}, removeListener() {} });
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

function answers(method, state) {
  switch (method) {
    case 'Page.getFrameTree':
      return { frameTree: { frame: state.tree(), childFrames: state.children } };
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
      return { documents: [], strings: [] };
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
      async open() {
        ({ sessionId } = await connection.attach({ targetId: '1', flatten: true }));
      },
      commit(frame) {
        connection.watchFrame(1, connection.tabState(1), frame);
      },
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
    open: () => shield.install(),
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
  f.state.frames = () => chromeFrames(frames ?? tab);
  f.state.tree = () => root(tree ?? tab, origin ? { securityOrigin: origin } : {});
  f.state.children = children;
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
];

const EXPECTED = {
  'ordinary blob to vault page': REFUSED,
  'ordinary blob, vault page pending': REFUSED,
  'ordinary blob, frame tree already on the vault page': REFUSED,
  'ordinary blob, frame tree already on the next ordinary page': UNSETTLED,
  'ordinary blob, frame tree already on another ordinary blob': UNSETTLED,
  'ordinary blob, frame tree already on a vault blob': REFUSED,
  'ordinary blob, tab on a www blob, tree still on the ordinary blob': REFUSED,
  'ordinary blob, history already on a vault blob': 'refused',
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
