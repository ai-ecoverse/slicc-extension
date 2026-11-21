import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { listen } from '../../extension/cdp.js';
import { NOT_ALLOWED } from './fixtures/cdp-675-extension-backend.mjs';

const ordinary = 'https://ordinary.test/page';
const vault = 'https://vault.sliccy.ai/secret';
const sevenTok = 'https://seven.sliccy.ai/os/?token=SECRET';
const resultMarker = 'private-result-marker';
const schemes = ['view-source', 'blob', 'filesystem'];
const wrap = (scheme, inner) =>
  scheme === 'filesystem' ? `filesystem:${inner}/temporary/x` : `${scheme}:${inner}`;
const event = () => ({ addListener() {}, removeListener() {} });

function frame(url) {
  let securityOrigin = 'null';
  try {
    if (url.startsWith('blob:')) securityOrigin = new URL(url).origin;
    else if (!url.startsWith('view-source:') && !url.startsWith('filesystem:'))
      securityOrigin = new URL(url).origin;
  } catch {}
  return { id: 'ROOT', loaderId: 'L1', url, securityOrigin, mimeType: 'text/html' };
}
const tree = (url) => ({ frameTree: { frame: frame(url) } });

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

const CONTENT = [
  ['DOM.getDocument', {}],
  ['DOM.describeNode', { nodeId: 1 }],
  ['DOM.querySelector', { nodeId: 1, selector: 'body' }],
  ['DOM.getOuterHTML', { nodeId: 1 }],
  ['DOMSnapshot.captureSnapshot', { computedStyles: [] }],
  ['Page.captureScreenshot', {}],
  ['Page.printToPDF', {}],
  ['Accessibility.getFullAXTree', {}],
  ['CSS.getComputedStyleForNode', { nodeId: 1 }],
  ['Page.getFrameTree', {}],
  ['Page.getResourceTree', {}],
  ['Page.captureSnapshot', {}],
];

async function fixture(transport, { tabUrl, treeUrl, histUrl, tab }) {
  let reads = 0;
  const forwarded = [];
  const published = [];
  let historyReads = 0;
  let history = () => ({ currentIndex: 0, entries: [{ id: 1, url: histUrl }] });
  let treeNow = treeUrl;
  let read = (n) => {
    const base = typeof tab === 'function' ? tab(n) : tab || { url: tabUrl, status: 'complete' };
    return { id: 1, title: 't', ...base };
  };
  const send = async (method, params, target) => {
    forwarded.push(method);
    if (
      !target?.sessionId &&
      (method === 'Target.getTargets' || (method === 'Target.getTargetInfo' && params?.targetId))
    )
      throw new Error(NOT_ALLOWED);
    if (method === 'Page.getNavigationHistory') return history(++historyReads);
    if (method === 'Page.captureSnapshot') return { data: resultMarker };
    if (method === 'Page.captureScreenshot') return { data: resultMarker };
    if (method === 'Page.printToPDF') return { data: resultMarker };
    if (method === 'DOM.getDocument') return { root: { nodeId: 1, nodeName: 'HTML' } };
    if (method === 'DOM.describeNode') return { node: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 2 };
    if (method === 'DOM.getOuterHTML') return { outerHTML: '<body></body>' };
    if (method === 'DOMSnapshot.captureSnapshot') return { documents: [] };
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
    if (method === 'CSS.getComputedStyleForNode') return { computedStyle: [] };
    if (method === 'Page.getResourceTree')
      return tree(typeof treeNow === 'function' ? treeNow(forwarded) : treeNow);
    if (method === 'Page.getFrameTree')
      return tree(typeof treeNow === 'function' ? treeNow(forwarded) : treeNow);
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
    if (method === 'Runtime.evaluate') return { result: { value: 'null' } };
    if (method === 'Runtime.getIsolateId') return { id: 'isolate' };
    return {};
  };
  const readTab = async (id = 1) => {
    if (id !== 1) return { id, url: ordinary, status: 'complete' };
    reads += 1;
    return read(reads);
  };
  let command;
  let close = () => {};
  let control;
  let attachError = '';
  if (transport === 'seven') {
    const connection = listen(
      {
        name: 'slicc-fetch',
        sender: { id: 'fx', url: 'https://seven.sliccy.ai/', origin: 'https://seven.sliccy.ai' },
        onDisconnect: event(),
        postMessage: (m) => published.push(m),
      },
      'fx',
      {
        tabs: { get: readTab, query: async () => [] },
        webNavigation: {
          getAllFrames: async () => [{ frameId: 0, url: tabUrl, errorOccurred: false }],
        },
        debugger: {
          onEvent: event(),
          onDetach: event(),
          attach: async () => {},
          detach: async () => {},
          sendCommand: async (target, method, params) => send(method, params, target),
        },
      }
    );
    try {
      const { sessionId } = await connection.attach({ targetId: '1', flatten: true });
      control = { connection, sessionId };
      command = (method, params = {}) => connection.dispatch({ method, params, sessionId });
    } catch (e) {
      attachError = String(e.message);
      control = { connection };
    }
    close = () => connection.close();
  } else {
    const shield = new TabShield(
      send,
      () => {},
      new Bounded(200),
      readTab,
      async () => ({ id: 2, url: ordinary, status: 'complete' }),
      async () => [{ frameId: 0, url: tabUrl, errorOccurred: false }]
    );
    try {
      await shield.install();
      control = { shield };
      command = (method, params = {}) => shield.command(method, params, send);
    } catch (e) {
      attachError = String(e.message);
      control = { shield };
    }
  }
  return {
    attachError,
    attached: !attachError,
    command,
    close,
    control,
    forwarded,
    published,
    historyReads: () => historyReads,
    reads: () => reads,
    history(next) {
      history = next;
      historyReads = 0;
    },
    setTree(next) {
      treeNow = next;
    },
    resetTab(next) {
      read = next;
      reads = 0;
    },
    mutateRestoreEarlyReturn() {
      if (transport === 'seven') {
        const conn = control.connection;
        const orig = conn.committed.bind(conn);
        conn.committed = async function (tabId) {
          const raw = await readTab(tabId);
          const url = String(raw?.url ?? '');
          if (['view-source', 'blob', 'filesystem'].some((s) => url.startsWith(`${s}:`))) return;
          return orig(tabId);
        };
        return () => {
          conn.committed = orig;
        };
      }
      const shield = control.shield;
      const orig = shield.committed.bind(shield);
      shield.committed = async function () {
        const tab = await readTab(1);
        const url = String(tab?.url ?? '');
        if (['view-source', 'blob', 'filesystem'].some((s) => url.startsWith(`${s}:`))) return;
        return orig();
      };
      return () => {
        shield.committed = orig;
      };
    },
  };
}

for (const transport of ['seven', 'six-bridge']) {
  for (const scheme of schemes) {
    const ord = wrap(scheme, ordinary);
    const protVault = wrap(scheme, vault);
    const protSeven = wrap(scheme, sevenTok);

    test(`${transport}: settled ordinary ${scheme} answers ${scheme === 'blob' ? 'Runtime' : 'content'} and reads history`, async (t) => {
      const f = await fixture(transport, { tabUrl: ord, treeUrl: ord, histUrl: ord });
      t.after(f.close);
      assert.equal(f.attached, true);
      const before = f.historyReads();
      if (scheme === 'blob') {
        assert.deepEqual(await f.command('Runtime.getIsolateId'), { id: 'isolate' });
        assert.ok(f.historyReads() > before, 'history read asserted');
        return;
      }
      assert.deepEqual(await f.command('Page.captureSnapshot'), { data: resultMarker });
      assert.ok(f.historyReads() > before, 'history read asserted');
      for (const [method, params] of CONTENT) {
        const result = await f.command(method, params);
        assert.equal(result?.error, undefined, method);
      }
    });

    for (const [label, hist] of [
      ['missing payload', () => ({})],
      ['empty entries', () => ({ currentIndex: 0, entries: [] })],
      ['index out of range', () => ({ currentIndex: 9, entries: [{ id: 1, url: ord }] })],
      ['empty entry url', () => ({ currentIndex: 0, entries: [{ id: 1, url: '' }] })],
      ['about:blank entry', () => ({ currentIndex: 0, entries: [{ id: 1, url: 'about:blank' }] })],
      [
        'throw',
        () => {
          throw new Error('no history');
        },
      ],
    ]) {
      test(`${transport}: ${scheme} refuses when history is ${label}`, async (t) => {
        const f = await fixture(transport, { tabUrl: ord, treeUrl: ord, histUrl: ord });
        t.after(f.close);
        assert.equal(f.attached, true);
        f.history(hist);
        await assert.rejects(f.command('Page.captureSnapshot'), /slicc: refused:/);
        assert.equal(
          f.published.some((m) => m.result?.data === resultMarker),
          false
        );
      });
    }

    for (const [name, prot] of [
      ['vault', protVault],
      ['seven+token', protSeven],
    ]) {
      test(`${transport}: ${scheme} x ${name} lagging tabs+tree refuse content via history`, async (t) => {
        const f = await fixture(transport, { tabUrl: ord, treeUrl: ord, histUrl: prot });
        t.after(f.close);
        assert.equal(f.attached, true, 'attach on ordinary wrap');
        for (const [method, params] of CONTENT) {
          await assert.rejects(f.command(method, params), /slicc: refused:/, method);
        }
      });

      for (const lag of [1, 3]) {
        test(`${transport}: ${scheme} x ${name} tabs lag ${lag} still refuses content`, async (t) => {
          const f = await fixture(transport, {
            tabUrl: ord,
            treeUrl: ord,
            histUrl: prot,
            tab: (n) => ({ url: n <= lag ? ord : ord, status: 'complete' }),
          });
          t.after(f.close);
          assert.equal(f.attached, true);
          await assert.rejects(f.command('DOM.getDocument'), /slicc: refused:/);
          await assert.rejects(f.command('Page.captureScreenshot'), /slicc: refused:/);
        });
      }
    }

    test(`${transport}: ${scheme} mirror lag tree protected history ordinary refuses attach`, async (t) => {
      const f = await fixture(transport, {
        tabUrl: ord,
        treeUrl: protVault,
        histUrl: ord,
      });
      t.after(f.close);
      if (transport === 'seven') {
        assert.match(f.attachError, /slicc: refused:/);
      } else {
        assert.match(f.attachError, /slicc: refused:/);
      }
    });

    test(`${transport}: ${scheme} mirror lag after attach refuses content on protected tree`, async (t) => {
      const f = await fixture(transport, { tabUrl: ord, treeUrl: ord, histUrl: ord });
      t.after(f.close);
      assert.equal(f.attached, true);
      f.setTree(protVault);
      await assert.rejects(f.command('DOM.getDocument'), /slicc: refused:/);
      await assert.rejects(f.command('Page.captureScreenshot'), /slicc: refused:/);
      await assert.rejects(f.command('Page.getFrameTree'), /slicc: refused:/);
    });

    test(`${transport}: ${scheme} mutation restore early return opens history gap`, async (t) => {
      const f = await fixture(transport, { tabUrl: ord, treeUrl: ord, histUrl: protVault });
      t.after(f.close);
      assert.equal(f.attached, true);
      await assert.rejects(f.command('Page.captureScreenshot'), /slicc: refused:/);
      const restore = f.mutateRestoreEarlyReturn();
      t.after(restore);
      assert.deepEqual(await f.command('Page.captureScreenshot'), { data: resultMarker });
    });
  }

  test(`${transport}: wrapped pendingUrl no longer skips history`, async (t) => {
    const ord = wrap('view-source', ordinary);
    const prot = wrap('view-source', vault);
    const f = await fixture(transport, {
      tabUrl: ord,
      treeUrl: ord,
      histUrl: prot,
      tab: () => ({ url: ord, pendingUrl: 'about:blank', status: 'loading' }),
    });
    t.after(f.close);
    assert.equal(f.attached, true);
    await assert.rejects(f.command('Page.captureScreenshot'), /slicc: refused:/);
  });
}
