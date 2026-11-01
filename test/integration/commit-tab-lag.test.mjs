import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { listen } from '../../extension/cdp.js';

const ordinary = 'https://ordinary.test/recovered';
const protectedUrl = 'https://vault.sliccy.ai/blocked';
const frame = (url) => ({ id: 'ROOT', url, securityOrigin: new URL(url).origin });
const tree = (url) => ({ frameTree: { frame: frame(url) } });
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

async function fixture(transport) {
  let shown = ordinary;
  let reads = 0;
  const forwarded = [];
  let read = () => ({ id: 1, url: shown, status: 'complete' });
  const readTab = async () => {
    reads += 1;
    return read(reads);
  };
  const send = async (method) => {
    forwarded.push(method);
    return method === 'Page.getFrameTree' ? tree(ordinary) : {};
  };
  let command;
  let commit;
  let matching;
  let close = () => {};
  let failed;
  let owner;
  if (transport === 'seven') {
    const connection = listen(
      {
        name: 'slicc-fetch',
        sender: { id: 'fixture', url: 'https://seven.sliccy.ai/' },
        onDisconnect: event(),
        postMessage() {},
      },
      'fixture',
      {
        tabs: { get: readTab, query: async () => [] },
        debugger: {
          onEvent: event(),
          onDetach: event(),
          attach: async () => {},
          detach: async () => {},
          sendCommand: async (_target, method) => send(method),
        },
      }
    );
    assert.ok(connection);
    const { sessionId } = await connection.attach({ targetId: '1', flatten: true });
    const tab = connection.tabState(1);
    failed = () => connection.state.failed.set(1, protectedUrl);
    failed();
    commit = (url) => connection.watchFrame(1, tab, frame(url));
    commit(ordinary);
    assert.equal(connection.state.failed.has(1), false);
    matching = () => {
      tab.pageUrl = protectedUrl;
    };
    command = (method = 'Page.getFrameTree', params = {}) =>
      connection.dispatch({ method, params, sessionId });
    owner = () => {
      failed();
      tab.paused.set('owned', {
        method: 'Fetch.requestPaused',
        owner: sessionId,
        claimed: false,
        params: { requestId: 'owned', request: { url: ordinary } },
      });
    };
    close = () => connection.close();
  } else {
    const failedDocuments = new Bounded(200);
    failedDocuments.set(protectedUrl, true);
    const shield = new TabShield(send, () => {}, failedDocuments, readTab);
    await shield.install();
    commit = (url) => shield.onEvent('Page.frameNavigated', { frame: frame(url) });
    commit(ordinary);
    matching = () => {
      shield.frames.set('ROOT', [protectedUrl, new URL(protectedUrl).origin]);
    };
    command = (method = 'Page.getFrameTree', params = {}) => shield.command(method, params, send);
    owner = () => {
      shield.forwarded.set('owned', true);
      shield.pausedUrls.set('owned', ordinary);
    };
  }
  shown = protectedUrl;
  return {
    command,
    commit,
    matching,
    owner,
    close,
    forwarded,
    reset(next) {
      read = next;
      reads = 0;
      forwarded.length = 0;
    },
    reads: () => reads,
  };
}

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport}: a committed ordinary document waits for fresh tab admission`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.reset((reads) => ({ id: 1, url: reads <= 3 ? protectedUrl : ordinary, status: 'complete' }));
    const result = await f.command();
    assert.deepEqual(result, tree(ordinary));
    assert.ok(f.reads() >= 4);
    assert.equal(
      f.forwarded.filter((method) => method === 'Page.getFrameTree').length,
      transport === 'seven' ? 1 : 2
    );
  });

  test(`${transport}: an unchanged protected tab exhausts the bound without forwarding`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.reset(() => ({ id: 1, url: protectedUrl, status: 'complete' }));
    const start = Date.now();
    await assert.rejects(f.command(), /^Error: slicc: refused:/);
    assert.ok(Date.now() - start >= 200);
    assert.ok(Date.now() - start < 600);
    assert.ok(f.reads() > 1);
    assert.deepEqual(f.forwarded, transport === 'seven' ? [] : ['Page.getFrameTree']);
  });

  test(`${transport}: matching protected tab and commit refuse without another read`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.matching();
    f.reset(() => ({ id: 1, url: protectedUrl, status: 'complete' }));
    await assert.rejects(f.command(), /^Error: slicc: refused:/);
    assert.equal(f.reads(), 1);
  });

  test(`${transport}: a protected navigation during the wait is never forwarded`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.reset((reads) => {
      if (reads === 2) f.commit(protectedUrl);
      return { id: 1, url: reads >= 3 ? ordinary : protectedUrl, status: 'complete' };
    });
    await assert.rejects(f.command(), /^Error: slicc: refused:/);
    assert.deepEqual(f.forwarded, transport === 'seven' ? [] : ['Page.getFrameTree']);
  });

  test(`${transport}: plain owned continue does not wait for tabs to catch up`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.owner();
    f.reset(() => ({ id: 1, url: protectedUrl, pendingUrl: ordinary, status: 'loading' }));
    await f.command('Fetch.continueRequest', { requestId: 'owned' });
    assert.ok(f.reads() <= 2);
    assert.deepEqual(f.forwarded, ['Fetch.continueRequest']);
  });
}
