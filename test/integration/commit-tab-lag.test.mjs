import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { listen } from '../../extension/cdp.js';

const ordinary = 'https://ordinary.test/recovered';
const protectedUrl = 'https://vault.sliccy.ai/blocked';
const errorPage = 'chrome-error://chromewebdata/';
const resultMarker = 'private-result-marker';
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
  const published = [];
  let retryCalls = 0;
  let onOpener = () => {};
  let onForward = () => {};
  let read = () => ({ id: 1, url: shown, status: 'complete' });
  let historyReads = 0;
  let history = () => ({ currentIndex: 0, entries: [{ id: 1, url: ordinary }] });
  let treeUrl = ordinary;
  let frames = () => [{ frameId: 'ROOT', parentFrameId: -1, url: ordinary, errorOccurred: false }];
  const readTab = async (id = 1) => {
    if (id !== 1) {
      onOpener();
      return { id, url: ordinary, status: 'complete' };
    }
    reads += 1;
    return read(reads);
  };
  const send = async (method) => {
    forwarded.push(method);
    onForward(method);
    if (method === 'Page.captureSnapshot') return { data: resultMarker };
    if (method === 'Page.getNavigationHistory') return history(++historyReads);
    const url = typeof treeUrl === 'function' ? treeUrl(forwarded) : treeUrl;
    return method === 'Page.getFrameTree' ? (typeof url === 'string' ? tree(url) : url) : {};
  };
  let command;
  let commit;
  let matching;
  let close = () => {};
  let failed;
  let owner;
  let start;
  let control;
  let attempt;
  if (transport === 'seven') {
    const connection = listen(
      {
        name: 'slicc-fetch',
        sender: { id: 'fixture', url: 'https://seven.sliccy.ai/' },
        onDisconnect: event(),
        postMessage(message) {
          published.push(message);
        },
      },
      'fixture',
      {
        tabs: { get: readTab, query: async () => [] },
        webNavigation: { getAllFrames: async () => frames() },
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
    control = { connection, tab };
    const retry = connection.retryTab.bind(connection);
    connection.retryTab = (...args) => {
      retryCalls += 1;
      return retry(...args);
    };
    attempt = async (method, params = {}) => {
      await connection.run({ id: 991, method, params, sessionId });
      return published.findLast((message) => message.id === 991);
    };
    failed = () => connection.state.failed.set(1, protectedUrl);
    failed();
    commit = (url) => connection.watchFrame(1, tab, frame(url));
    start = () => connection.onEvent({ tabId: 1 }, 'Page.frameStartedLoading', { frameId: 'ROOT' });
    commit(ordinary);
    assert.equal(connection.state.failed.has(1), false);
    matching = () => {
      tab.pageUrl = protectedUrl;
    };
    command = (method = 'Network.enable', params = {}) =>
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
    close = () => {
      connection.closed = false;
      connection.close();
    };
  } else {
    const failedDocuments = new Bounded(200);
    failedDocuments.set(protectedUrl, true);
    const shield = new TabShield(
      send,
      () => {},
      failedDocuments,
      readTab,
      undefined,
      async () => frames()
    );
    await shield.install();
    control = { shield, failedDocuments };
    const retry = shield.retryShown.bind(shield);
    shield.retryShown = (...args) => {
      retryCalls += 1;
      return retry(...args);
    };
    commit = (url) => shield.onEvent('Page.frameNavigated', { frame: frame(url) });
    start = () => shield.onEvent('Page.frameStartedLoading', { frameId: 'ROOT' });
    commit(ordinary);
    matching = () => {
      shield.frames.set('ROOT', [protectedUrl, new URL(protectedUrl).origin]);
    };
    command = (method = 'Network.enable', params = {}) => shield.command(method, params, send);
    attempt = async (method, params = {}) => {
      let message;
      try {
        message = { id: 991, result: await command(method, params) };
      } catch (error) {
        message = { id: 991, error: String(error.message) };
      }
      published.push(message);
      return message;
    };
    owner = () => {
      shield.forwarded.set('owned', true);
      shield.pausedUrls.set('owned', ordinary);
    };
  }
  shown = protectedUrl;
  return {
    command,
    attempt,
    control,
    published,
    retries: () => retryCalls,
    onOpener(next) {
      onOpener = next;
    },
    onForward(next) {
      onForward = next;
    },
    hint(url) {
      if (transport === 'seven') control.tab.pageUrl = url;
      else control.shield.frames.set('ROOT', [url]);
    },
    pending() {
      (control.tab ?? control.shield).pendingFrames.add('ROOT');
    },
    started() {
      (control.tab ?? control.shield).startedFrames.add('ROOT');
    },
    start,
    commit,
    matching,
    owner,
    close,
    forwarded,
    reset(next) {
      read = next;
      reads = 0;
      forwarded.length = 0;
      published.length = 0;
      retryCalls = 0;
    },
    history(next) {
      history = next;
      historyReads = 0;
    },
    historyReads: () => historyReads,
    browserTree(url) {
      treeUrl = url;
    },
    frames(next) {
      frames = next;
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
    assert.deepEqual(result, {});
    assert.ok(f.reads() >= 4);
    assert.equal(f.forwarded.filter((method) => method === 'Network.enable').length, 1);
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
    f.reset((reads) => ({
      id: 1,
      url: reads === 1 ? protectedUrl : ordinary,
      pendingUrl: reads === 1 ? ordinary : '',
      status: 'complete',
    }));
    await assert.rejects(f.command(), /^Error: slicc: refused:/);
    assert.equal(f.reads(), 1);
    assert.equal(f.retries(), 0);
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

  test(`${transport}: stale protected pending url requires a fresh passing read`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.reset((reads) => ({
      id: 1,
      url: ordinary,
      pendingUrl: reads <= 3 ? protectedUrl : '',
      status: 'complete',
    }));
    assert.deepEqual(await f.command(), {});
    assert.ok(f.reads() >= 4);
  });

  test(`${transport}: fresh ordinary tab and stale protected history both must pass`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.reset(() => ({ id: 1, url: ordinary, status: 'loading' }));
    f.history((reads) => ({
      currentIndex: 0,
      entries: [{ id: 1, url: reads <= 3 ? protectedUrl : ordinary }],
    }));
    assert.deepEqual(await f.command(), {});
    assert.ok(f.reads() >= 4);
    assert.ok(f.historyReads() >= 4);
  });

  for (const later of ['tab', 'history']) {
    test(`${transport}: a later passing ${later} cannot publish an already produced result`, async (t) => {
      const f = await fixture(transport);
      t.after(f.close);
      f.reset(() => ({ id: 1, url: ordinary, status: 'complete' }));
      assert.equal((await f.attempt('Page.captureSnapshot')).result?.data, resultMarker);
      let ran = 0;
      let changed = false;
      f.onForward((method) => {
        if (method === 'Page.captureSnapshot') ran += 1;
      });
      f.reset(() => {
        if (ran && later === 'tab' && !changed) {
          queueMicrotask(() => {
            changed = true;
          });
          return { id: 1, url: protectedUrl, status: 'complete' };
        }
        return { id: 1, url: ordinary, status: 'complete' };
      });
      f.history(() => {
        const url = ran && !changed ? protectedUrl : ordinary;
        if (ran && later === 'history' && !changed)
          queueMicrotask(() => {
            changed = true;
          });
        return { currentIndex: 0, entries: [{ id: 1, url }] };
      });
      const reply = await f.attempt('Page.captureSnapshot');
      assert.match(reply.error ?? '', /^slicc: refused:/);
      assert.equal(reply.result, undefined);
      assert.equal(ran, 1);
      assert.equal(changed, true);
      assert.equal(f.forwarded.filter((method) => method === 'Page.captureSnapshot').length, 1);
      assert.equal(f.retries(), 0);
      assert.equal(f.historyReads(), later === 'history' ? 1 : 0);
      assert.equal(
        f.published.some((message) => 'result' in message),
        false
      );
      assert.equal(JSON.stringify(f.published).includes(resultMarker), false);
    });
  }

  test(`${transport}: persistently protected history refuses without forwarding the command`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.reset(() => ({ id: 1, url: ordinary, status: 'loading' }));
    f.history(() => ({ currentIndex: 0, entries: [{ id: 1, url: protectedUrl }] }));
    await assert.rejects(f.command(), /^Error: slicc: refused:/);
    assert.ok(f.reads() > 1);
    assert.equal(f.forwarded.filter((method) => method === 'Network.enable').length, 0);
  });

  test(`${transport}: missing history remains immediately fail closed`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.reset(() => ({ id: 1, url: ordinary, status: 'loading' }));
    f.history(() => ({}));
    await assert.rejects(f.command(), /navigation not settled/);
    assert.equal(f.reads(), 1);
  });

  for (const condition of ['pending', 'started']) {
    test(`${transport}: only ${condition} frames exclude admission retry`, async (t) => {
      const f = await fixture(transport);
      t.after(f.close);
      f[condition]();
      f.reset((reads) => ({
        id: 1,
        url: reads === 1 ? protectedUrl : ordinary,
        status: 'complete',
      }));
      await assert.rejects(f.command(), /^Error: slicc: refused:/);
      assert.equal(f.reads(), 1);
      assert.equal(f.retries(), 0);
      assert.equal(f.forwarded.filter((method) => method === 'Network.enable').length, 0);
    });
  }

  for (const hint of [errorPage, '']) {
    test(`${transport}: ${hint ? 'error-page' : 'absent'} hint excludes retry on its own`, async (t) => {
      const f = await fixture(transport);
      t.after(f.close);
      f.hint(hint);
      f.reset((reads) => ({
        id: 1,
        url: reads === 1 ? protectedUrl : ordinary,
        status: 'complete',
      }));
      await assert.rejects(f.command(), /^Error: slicc: refused:/);
      assert.equal(f.reads(), 1);
      assert.equal(f.retries(), 0);
      assert.equal(f.forwarded.filter((method) => method === 'Network.enable').length, 0);
    });
  }

  test(`${transport}: masked error view excludes retry independently`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    if (transport === 'seven') {
      f.control.connection.state.failed.set(1, protectedUrl);
      f.onOpener(() => f.commit(ordinary));
    }
    f.browserTree({ frameTree: { frame: { ...frame(errorPage), unreachableUrl: protectedUrl } } });
    f.reset((reads) => ({
      id: 1,
      url: reads === 1 ? protectedUrl : ordinary,
      pendingUrl: reads === 1 ? 'https://vault.sliccy.ai/other' : '',
      status: 'complete',
      ...(transport === 'seven' ? { openerTabId: 2 } : {}),
    }));
    await assert.rejects(f.command(), /^Error: slicc: refused:/);
    if (transport === 'seven') assert.equal(f.control.connection.state.failed.has(1), false);
    assert.equal(f.reads(), 1);
    assert.equal(f.retries(), 0);
    assert.equal(f.forwarded.filter((method) => method === 'Network.enable').length, 0);
  });

  if (transport === 'seven') {
    test('seven: a failure record alone excludes retry', async (t) => {
      const f = await fixture(transport);
      t.after(f.close);
      f.control.connection.state.failed.set(1, protectedUrl);
      f.reset((reads) => ({
        id: 1,
        url: reads === 1 ? protectedUrl : ordinary,
        status: 'complete',
      }));
      await assert.rejects(f.command(), /^Error: slicc: refused:/);
      assert.equal(f.reads(), 1);
      assert.equal(f.retries(), 0);
      assert.equal(f.forwarded.filter((method) => method === 'Network.enable').length, 0);
    });

    test('seven: absent tab state is refused without retry', async (t) => {
      const f = await fixture(transport);
      t.after(f.close);
      f.control.connection.state.tabs.delete(1);
      f.reset(() => ({ id: 1, url: protectedUrl, status: 'complete' }));
      await assert.rejects(f.command(), /^Error: slicc: refused:/);
      assert.equal(f.reads(), 1);
      assert.equal(f.retries(), 0);
    });

    for (const state of ['closed', 'replaced']) {
      test(`seven: tab state ${state} during the wait is not forwarded`, async (t) => {
        const f = await fixture(transport);
        t.after(f.close);
        f.reset((reads) => {
          if (reads === 2) {
            if (state === 'closed') f.control.connection.closed = true;
            else f.control.connection.state.tabs.set(1, { ...f.control.tab });
          }
          return { id: 1, url: reads === 1 ? protectedUrl : ordinary, status: 'complete' };
        });
        await assert.rejects(f.command(), /^Error: slicc: refused:/);
        assert.equal(f.reads(), 2);
        assert.equal(f.retries(), 1);
        assert.equal(f.forwarded.filter((method) => method === 'Network.enable').length, 0);
      });
    }

    test('seven: Page.enable rechecks admission and never enters return checks', async (t) => {
      const f = await fixture(transport);
      t.after(f.close);
      f.reset((reads) => ({
        id: 1,
        url: reads <= 3 ? protectedUrl : ordinary,
        status: 'complete',
      }));
      assert.deepEqual(await f.command('Page.enable'), {});
      assert.equal(f.retries(), 1);
      assert.equal(f.historyReads(), 1);
      assert.equal(f.forwarded.filter((method) => method === 'Page.enable').length, 0);
    });
  } else {
    test('six-bridge: blocked during the wait is not forwarded', async (t) => {
      const f = await fixture(transport);
      t.after(f.close);
      f.reset((reads) => {
        if (reads === 2) f.control.shield.blockedFlag = true;
        return { id: 1, url: reads === 1 ? protectedUrl : ordinary, status: 'complete' };
      });
      await assert.rejects(f.command(), /^Error: slicc: refused:/);
      assert.equal(f.reads(), 2);
      assert.equal(f.retries(), 1);
      assert.equal(f.forwarded.filter((method) => method === 'Network.enable').length, 0);
    });
  }

  test(`${transport}: navigation starting during a retry stops it`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.reset((reads) => {
      if (reads === 2) f.start();
      return { id: 1, url: reads >= 2 ? ordinary : protectedUrl, status: 'complete' };
    });
    await assert.rejects(f.command(), /^Error: slicc: refused:/);
    assert.ok(f.reads() <= 2);
  });

  test(`${transport}: protected content evidence is not retried from a commit hint`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.reset(() => ({ id: 1, url: ordinary, status: 'complete' }));
    f.browserTree(protectedUrl);
    await assert.rejects(f.command('Page.getFrameTree'), /^Error: slicc: refused:/);
    assert.ok(f.reads() <= 2);
  });

  test(`${transport}: a failed protected frame inventory still refuses immediately`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.reset(() => ({ id: 1, url: ordinary, status: 'complete' }));
    f.frames(() => [
      { frameId: 'ROOT', parentFrameId: -1, url: protectedUrl, errorOccurred: true },
    ]);
    await assert.rejects(f.command('Page.getFrameTree'), /^Error: slicc: refused:/);
    assert.ok(f.reads() <= 2);
  });

  for (const method of ['Page.captureSnapshot', 'DOM.getDocument', 'Runtime.evaluate']) {
    test(`${transport}: ${method} retains its later protected-document check`, async (t) => {
      const f = await fixture(transport);
      t.after(f.close);
      f.reset(() => ({ id: 1, url: ordinary, status: 'complete' }));
      f.browserTree((methods) =>
        methods.filter((method) => method === 'Page.getFrameTree').length >= 2
          ? protectedUrl
          : ordinary
      );
      await assert.rejects(f.command(method), /^Error: slicc: refused:/);
      assert.equal(f.forwarded.filter((seen) => seen === method).length, 0);
    });
  }

  test(`${transport}: missing live tab is not retried`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.reset(() => undefined);
    await assert.rejects(f.command(), /^Error: slicc: refused:/);
    assert.equal(f.reads(), 1);
    assert.deepEqual(f.forwarded, []);
  });

  test(`${transport}: protected command destinations are not retried`, async (t) => {
    const f = await fixture(transport);
    t.after(f.close);
    f.reset(() => ({ id: 1, url: ordinary, status: 'complete' }));
    await assert.rejects(
      f.command('Page.navigate', { url: protectedUrl }),
      /^Error: slicc: refused:/
    );
    assert.equal(f.reads(), 1);
    assert.deepEqual(f.forwarded, []);
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
