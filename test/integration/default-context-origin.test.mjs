import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import table from '@ai-ecoverse/slicc-browsers/protected.json' with { type: 'json' };
import { build } from 'esbuild';
import { listen } from '../../extension/cdp.js';
import { protectedOrigins } from '../../extension/protected.mjs';
import { protectedRules } from '../../extension/protected-rules.js';
import { PROFILED, strictGuard } from '../../extension/shield.js';

const REFUSED = "slicc: refused: target is on seven's origin";
const VAULT = 'https://vault.sliccy.ai';
const BLANK = 'about:blank';
const ORDINARY = 'https://ordinary.test';
const FIELDS = new Set([
  'url',
  'type',
  'protected',
  'documentURL',
  'unreachableURL',
  'navigating',
  'previous',
  'opener',
  'contextOrigin',
]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rows = table.targets;
const UNMAPPED = [
  {
    row: {
      url: 'https://seven.sliccy.ai/path?secret=query#fragment',
      documentURL: 'chrome-error://chromewebdata/',
      unreachableURL: 'https://seven.sliccy.ai/path?secret=query#fragment',
      protected: false,
    },
    reason:
      'an error page is judged by the frame tree from its documentURL and unreachableURL, not by the target call',
  },
  {
    row: { url: 'http://127.0.0.1:5710/index.html', protected: true },
    reason: "the row needs the file's extra origins, which production does not configure",
  },
];

const bundled = await build({
  stdin: {
    contents:
      "export { TabShield, Bounded, urlProtected } from './six/extension/cdp-shield.ts';\n" +
      "export { isProtectedTab, isProtectedTarget } from './six/extension/protected-origins.ts';\n",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { TabShield, Bounded, isProtectedTab, isProtectedTarget, urlProtected } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

const FRAME_TREE_FIELDS = ['documentURL', 'unreachableURL', 'navigating'];
const FRAME_TREE = `the target call judges the url alone; ${FRAME_TREE_FIELDS.join(', ')} are judged by the frame tree's error-page handling of the root frame`;
const FRAME_TREE_ROWS = [
  {
    url: 'https://seven.sliccy.ai/path?secret=query#fragment',
    documentURL: 'chrome-error://chromewebdata/',
    unreachableURL: 'https://seven.sliccy.ai/other',
    protected: true,
  },
  {
    url: 'https://seven.sliccy.ai/path?secret=query#fragment',
    documentURL: 'chrome-error://chromewebdata/',
    unreachableURL: 'https://seven.sliccy.ai/path?secret=query#fragment',
    navigating: true,
    protected: true,
  },
  {
    url: 'https://seven.sliccy.ai/path?secret=query#fragment',
    documentURL: 'chrome-error://chromewebdata/',
    protected: true,
  },
  {
    url: 'https://seven.sliccy.ai/path?secret=query#fragment',
    documentURL: 'chrome-error://chromewebdata/',
    unreachableURL: 'https://seven.sliccy.ai/path?secret=query#fragment',
    previous: true,
    protected: true,
  },
  {
    url: 'https://seven.sliccy.ai/path?secret=query#fragment',
    documentURL: 'https://seven.sliccy.ai/path?secret=query#fragment',
    protected: true,
  },
].map((row) => ({ row, reason: FRAME_TREE }));
const OPAQUE = new Set(['', 'null', '://', 'about://']);

const guard = strictGuard(protectedOrigins(protectedRules), protectedRules);

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

function frame(id, url, parentId, origin) {
  return {
    id,
    ...(parentId ? { parentId } : {}),
    loaderId: `${id}-loader`,
    url,
    securityOrigin:
      origin ?? (url.startsWith('about:') || url.startsWith('data:') ? '://' : new URL(url).origin),
    mimeType: 'text/html',
  };
}

function tree(url, child) {
  return {
    frame: frame('root', url),
    childFrames: child ? [{ frame: frame('child', child, 'root', ORDINARY), resources: [] }] : [],
    resources: [],
  };
}

function context(id, frameId, origin, flag = true) {
  const aux = flag === 'absent' ? {} : { isDefault: flag };
  return {
    context: {
      id,
      uniqueId: `${frameId}-${id}`,
      origin,
      name: '',
      auxData: { ...aux, type: 'default', frameId },
    },
  };
}

const SHAPES = {
  'Page.getFrameTree': (result) => result?.frameTree?.frame?.id === 'root',
  'Page.createIsolatedWorld': (result) => typeof result?.executionContextId === 'number',
  'Profiler.enable': (result) =>
    result !== null && typeof result === 'object' && Object.keys(result).length === 0,
  'Runtime.enable': (result) =>
    result !== null && typeof result === 'object' && Object.keys(result).length === 0,
  'Runtime.disable': (result) =>
    result !== null && typeof result === 'object' && Object.keys(result).length === 0,
};

function outcome(method, reply) {
  if (reply === undefined) return 'NO REPLY';
  if (typeof reply.error === 'string') return reply.error;
  if (!('result' in reply)) return 'NO RESULT';
  return SHAPES[method](reply.result) ? 'ANSWERED' : `UNEXPECTED ${JSON.stringify(reply.result)}`;
}

async function open(transport, { url = BLANK, child, opener } = {}) {
  const published = [];
  let blocked = false;
  const events = bus();
  const tabs = new Map([[1, { id: 1, url, status: 'complete', windowId: 1 }]]);
  if (opener) {
    tabs.set(1, { ...tabs.get(1), openerTabId: 2 });
    tabs.set(2, { id: 2, url: opener, status: 'complete', windowId: 1 });
  }
  const readTab = async () => tabs.get(1);
  const readFrames = async () => [
    { frameId: 0, parentFrameId: -1, url, errorOccurred: false },
    ...(child ? [{ frameId: 1, parentFrameId: 0, url: child, errorOccurred: false }] : []),
  ];
  const send = async (method) => {
    if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree') {
      return { frameTree: tree(url, child) };
    }
    if (method === 'Page.getNavigationHistory') {
      return { currentIndex: 0, entries: [{ id: 1, url, userTypedURL: url, title: '' }] };
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'null' } };
    return {};
  };
  if (transport === 'seven') {
    const connection = listen(
      {
        name: 'slicc-fetch',
        sender: {
          id: 'fixture',
          url: 'https://seven.sliccy.ai/',
          origin: 'https://seven.sliccy.ai',
        },
        onDisconnect: bus(),
        postMessage(message) {
          published.push(message);
        },
      },
      'fixture',
      {
        tabs: {
          get: async (id) => {
            if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
            return tabs.get(id);
          },
          query: async () => [],
          onUpdated: bus(),
          onCreated: bus(),
          onRemoved: bus(),
          onActivated: bus(),
        },
        windows: { onRemoved: bus() },
        webNavigation: {
          getAllFrames: readFrames,
          getFrame: async () => ({ url, errorOccurred: false }),
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
    let session;
    try {
      ({ sessionId: session } = await connection.attach({ targetId: '1', flatten: true }));
    } catch (error) {
      connection.close();
      return { refused: String(error.message ?? error) };
    }
    let id = 1;
    const command = async (method, params = {}) => {
      const next = ++id;
      await connection.run({ id: next, method, params, sessionId: session });
      await connection.settled();
      const reply = published.findLast((message) => message.id === next);
      if (reply === undefined) return undefined;
      if (reply.error !== undefined) return { error: reply.error.message ?? String(reply.error) };
      return 'result' in reply ? { result: reply.result } : {};
    };
    const emit = async (method, params) => {
      await events.emit({ tabId: 1 }, method, params);
      await connection.settled();
    };
    await command('Page.enable');
    await command('Runtime.enable');
    await emit('Page.frameNavigated', { frame: frame('root', url) });
    if (child)
      await emit('Page.frameNavigated', { frame: frame('child', child, 'root', ORDINARY) });
    return {
      command,
      emit,
      published,
      replayed: () => connection.tabState(1)?.worlds.visible() ?? [],
      cut: () => published.some((message) => message.method === 'Target.detachedFromTarget'),
      close: () => connection.close(),
    };
  }
  if (await isProtectedTab(tabs.get(1), async (tabId) => tabs.get(tabId))) {
    return { refused: REFUSED };
  }
  const shield = new TabShield(
    send,
    () => {
      blocked = true;
    },
    new Bounded(200),
    readTab,
    async (tabId) => tabs.get(tabId),
    readFrames
  );
  await shield.install();
  const command = async (method, params = {}) => {
    try {
      return { result: await shield.command(method, params, send) };
    } catch (error) {
      return { error: String(error.message ?? error) };
    }
  };
  const emit = async (method, params) => {
    const delivered = await shield.onEvent(method, params);
    for (const message of delivered ?? []) published.push(message);
  };
  await command('Page.enable');
  await command('Runtime.enable');
  await emit('Page.frameNavigated', { frame: frame('root', url) });
  if (child) await emit('Page.frameNavigated', { frame: frame('child', child, 'root', ORDINARY) });
  return {
    command,
    emit,
    published,
    replayed: () => shield.visibleContexts(),
    cut: () => blocked,
    close: () => {},
  };
}

async function probe(fixture, id, frameId) {
  const cut = fixture.cut();
  const delivered = fixture.published.some(
    (message) =>
      message.method === 'Runtime.executionContextCreated' && message.params?.context?.id === id
  );
  const replayed = fixture.replayed().some((ctx) => ctx.id === id);
  const tree = await fixture.command('Page.getFrameTree');
  const scoped = await fixture.command('Page.createIsolatedWorld', { frameId });
  const profiled = await fixture.command('Profiler.enable');
  fixture.close();
  return {
    cut,
    delivered,
    replayed,
    tree: outcome('Page.getFrameTree', tree),
    scoped: outcome('Page.createIsolatedWorld', scoped),
    profiled: outcome('Profiler.enable', profiled),
  };
}

async function mainContext(transport, origin, { url = BLANK, flag = true } = {}) {
  const fixture = await open(transport, { url });
  assert.equal(fixture.refused, undefined, `${transport} attach ${url}`);
  await fixture.emit('Runtime.executionContextCreated', context(5, 'root', origin, flag));
  return probe(fixture, 5, 'root');
}

async function childContext(transport, origin) {
  const fixture = await open(transport, { url: 'https://ordinary.test/', child: BLANK });
  assert.equal(fixture.refused, undefined, transport);
  await fixture.emit('Runtime.executionContextCreated', context(6, 'child', origin));
  return probe(fixture, 6, 'child');
}

const sevenTarget = (row) =>
  guard.target({ url: row.url, opener: row.opener, previous: row.previous ?? false }) ||
  (typeof row.type === 'string' &&
    guard.target({ url: BLANK, opener: 'unprotected', type: row.type }));

const sixTarget = (row) => isProtectedTarget(row.url, row.previous ?? false, row.opener, row.type);

const targets = { seven: sevenTarget, 'six-bridge': sixTarget };

const earlier = {
  seven: (origin) => (OPAQUE.has(origin) ? false : guard.url(origin)),
  'six-bridge': (origin) => urlProtected(origin),
};

function expectedContext(transport, origin) {
  if (OPAQUE.has(origin)) return false;
  if (origin.toLowerCase().startsWith('about:')) return true;
  return earlier[transport](origin);
}

const listed = (list, row) => list.some(({ row: named }) => same(named, row));

const ADMITTED = {
  cut: false,
  delivered: true,
  replayed: true,
  tree: 'ANSWERED',
  scoped: 'ANSWERED',
  profiled: 'ANSWERED',
};
const CUT = {
  cut: true,
  delivered: false,
  replayed: false,
  tree: REFUSED,
  scoped: REFUSED,
  profiled: REFUSED,
};
const CHILD_ADMITTED = { ...ADMITTED, scoped: REFUSED };
const HIDDEN = {
  cut: false,
  delivered: false,
  replayed: false,
  tree: 'ANSWERED',
  scoped: 'ANSWERED',
  profiled: PROFILED,
};
const CHILD_KEPT = { seven: { ...HIDDEN, scoped: REFUSED }, 'six-bridge': CUT };
const ABSENT = {
  seven: { [BLANK]: ADMITTED, 'about://': HIDDEN },
  'six-bridge': { [BLANK]: CUT, 'about://': HIDDEN },
};

test('every target row of the pinned descriptor has only known fields, and every row the target call does not exercise fully is named', () => {
  assert.equal(rows.length, 109);
  for (const row of rows) {
    for (const key of Object.keys(row)) assert.ok(FIELDS.has(key), `unknown field ${key}`);
    if (FRAME_TREE_FIELDS.some((key) => key in row)) {
      assert.ok(listed(UNMAPPED, row) || listed(FRAME_TREE_ROWS, row), JSON.stringify(row));
    }
  }
  for (const { row, reason } of [...UNMAPPED, ...FRAME_TREE_ROWS]) {
    assert.ok(reason.length > 0);
    assert.ok(
      table.targets.some((entry) => same(entry, row)),
      JSON.stringify(row)
    );
  }
});

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport}: a default context's reported origin follows the shared descriptor rule, with every target row of the pinned descriptor`, async () => {
    const wrong = [];
    const contexts = [];
    for (const row of rows) {
      if (listed(UNMAPPED, row)) continue;
      const target = targets[transport](row);
      let verdict = target;
      if (row.contextOrigin !== undefined) {
        const judged = await mainContext(transport, row.contextOrigin, {
          url: target ? BLANK : row.url,
        });
        const expected = expectedContext(transport, row.contextOrigin);
        const want = expected ? CUT : { ...judged, cut: false, tree: 'ANSWERED' };
        if (!isDeepStrictEqual(judged, want)) contexts.push(JSON.stringify(row));
        verdict = verdict || judged.cut;
      }
      if (verdict !== row.protected) wrong.push(JSON.stringify(row));
    }
    assert.deepEqual(contexts, []);
    assert.deepEqual(wrong, []);
  });

  test(`${transport}: a main frame's default context reporting about:blank matches the descriptor verdict for its spelling`, async () => {
    assert.deepEqual(await mainContext(transport, VAULT), CUT);
    assert.deepEqual(await mainContext(transport, BLANK), CUT);
  });

  test(`${transport}: a main frame's default context reporting about:// matches the descriptor verdict for its spelling`, async () => {
    assert.deepEqual(await mainContext(transport, '://'), ADMITTED);
    assert.deepEqual(await mainContext(transport, 'about://'), { ...ADMITTED, delivered: false });
  });

  test(`${transport}: a child frame's default context reporting about:blank matches the descriptor verdict for its spelling`, async () => {
    assert.deepEqual(await childContext(transport, VAULT), CHILD_KEPT[transport]);
    assert.deepEqual(await childContext(transport, BLANK), CHILD_KEPT[transport]);
  });

  test(`${transport}: a child frame's default context reporting about:// matches the descriptor verdict for its spelling`, async () => {
    assert.deepEqual(await childContext(transport, '://'), CHILD_ADMITTED);
    assert.deepEqual(await childContext(transport, 'about://'), {
      ...CHILD_ADMITTED,
      delivered: false,
    });
  });

  test(`${transport}: a default context reporting an empty, null, opaque or ordinary origin is handled as before, and the opener rule is unchanged`, async () => {
    for (const origin of ['', 'null', '://', 'https://example.test']) {
      assert.deepEqual(await mainContext(transport, origin), ADMITTED, origin);
    }
    const opened = await open(transport, { opener: 'https://vault.sliccy.ai/' });
    assert.equal(opened.refused, REFUSED);
    const plain = await open(transport, { opener: 'https://ordinary.test/' });
    assert.equal(plain.refused, undefined);
    await plain.emit('Runtime.executionContextCreated', context(5, 'root', 'https://example.test'));
    assert.deepEqual(await probe(plain, 5, 'root'), ADMITTED);
  });
}

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport}: a main frame context without an isDefault flag is judged as it is today`, async () => {
    for (const origin of [BLANK, 'about://']) {
      assert.deepEqual(
        await mainContext(transport, origin, { flag: 'absent' }),
        ABSENT[transport][origin],
        origin
      );
    }
  });
}
