import assert from 'node:assert/strict';
import { launch } from './chrome.mjs';
import { lens, plainFlags } from './http-fixture.mjs';

let serial = 0;
export const unique = (name) => `${name}-${Date.now()}-${++serial}`;
export const hosts = ['seven.sliccy.ai', 'www.sliccy.ai', 'a.b.sliccy.ai', 'sliccy.ai'];
export const ways = ['page-navigate', 'https-link', 'http-link', 'http-iframe', 'redirect'];
export const ports = ['', ':80', ':18080'];
export const elements = ['iframe', 'object', 'embed', 'frame'];

export function httpDocument(value) {
  if (!value?.startsWith('http://')) return false;
  const host = new URL(value).hostname;
  return host === 'sliccy.ai' || host.endsWith('.sliccy.ai');
}

export async function documentBrowser(prepare) {
  const chrome = await launch({
    prepare,
    hosts: ['a.b.sliccy.ai'],
    plain: [...hosts, 'vault.sliccy.ai', 'other.test', 'ordinary.test'],
    plainPorts: [80, 18080],
    args: [...plainFlags],
  });
  return { chrome, lens: lens(chrome) };
}

export function recorder(chrome) {
  const frames = new Map();
  const targets = [];
  const requests = new Map();
  const failures = [];
  const errors = [];
  const sessions = new Set();
  const storeFrame = (frame, sessionId) => {
    frames.set(`${frame.id}:${frame.loaderId}`, { ...frame, sessionId });
  };
  const off = chrome.cdp.on(({ method, params, sessionId }) => {
    if (
      method === 'Target.attachedToTarget' &&
      sessions.has(sessionId) &&
      params.targetInfo.type === 'iframe'
    ) {
      sessions.add(params.sessionId);
      Promise.all([
        chrome.cdp.send('Page.enable', {}, params.sessionId),
        chrome.cdp.send('Network.enable', {}, params.sessionId),
        chrome.cdp.send(
          'Target.setAutoAttach',
          {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
            filter: [{ type: 'iframe' }, { exclude: true }],
          },
          params.sessionId
        ),
      ])
        .then(() => chrome.cdp.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId))
        .catch((error) => errors.push(String(error)));
    }
    if (method === 'Target.detachedFromTarget') sessions.delete(params.sessionId);
    if (method === 'Page.frameNavigated') storeFrame(params.frame, sessionId);
    if (params.targetInfo?.url !== undefined) targets.push(params.targetInfo.url);
    if (method === 'Network.requestWillBeSent') {
      requests.set(params.requestId, params.request.url);
    }
    if (method === 'Network.loadingFailed') {
      failures.push({ ...params, url: requests.get(params.requestId) });
    }
  });
  async function snapshot() {
    const current = [];
    function visit(tree, sessionId) {
      current.push({ ...tree.frame, sessionId });
      for (const child of tree.childFrames ?? []) visit(child, sessionId);
    }
    for (const sessionId of sessions) {
      const { frameTree } = await chrome.cdp.send('Page.getFrameTree', {}, sessionId);
      visit(frameTree, sessionId);
    }
    return current;
  }
  return {
    frames,
    targets,
    requests,
    failures,
    errors,
    snapshot,
    watch: (sessionId) => sessions.add(sessionId),
    off,
  };
}

export function checkDocuments(result, expected = 'https') {
  assert.equal(result.http, 0, JSON.stringify(result));
  assert.ok(
    (expected === 'https' && result.outcome === 'failed') || result.outcome === expected,
    JSON.stringify(result)
  );
  assert.equal(httpDocument(result.href), false, JSON.stringify(result));
  assert.equal(result.targets.some(httpDocument), false, JSON.stringify(result));
  assert.equal((result.frameUrls ?? []).some(httpDocument), false, JSON.stringify(result));
  const requested = new URL(result.requested);
  const observed = new URL(result.unreachable ?? result.committed ?? result.attempted);
  assert.equal(observed.protocol, `${expected}:`, JSON.stringify(result));
  assert.equal(observed.hostname, requested.hostname, JSON.stringify(result));
  assert.equal(observed.port, requested.port, JSON.stringify(result));
  if (expected === 'http') {
    assert.ok(result.targetDocuments > 0, JSON.stringify(result));
    assert.equal(result.href, result.committed, JSON.stringify(result));
  }
}

export async function navigateDocument(context, t, options = {}) {
  const {
    host = hosts[0],
    port = '',
    way = 'page-navigate',
    element = way === 'http-iframe' ? 'iframe' : undefined,
    warm = true,
    from,
    scheme = 'http',
    path = '/',
    token,
  } = options;
  const { chrome, lens } = context;
  const panel = await lens.extension(t);
  const record = recorder(chrome);
  const n = token ?? unique('document');
  const receiver = `https://upstream.test/hello?n=receiver-${n}`;
  const url = `${scheme}://${host}${port}${path}?${new URLSearchParams({ n, url: receiver })}`;
  const page = await panel.tab();
  let observer;
  try {
    const entryScheme = way === 'https-link' && !element ? 'https' : 'http';
    const entryUrl = new URL(from ?? `${entryScheme}://other.test/`);
    entryUrl.searchParams.set('n', unique('entry'));
    const entry = entryUrl.href;
    await page.goto(entry);
    const setup = await page.evaluate(() => location.href);
    assert.equal(setup, entry);
    assert.equal(new URL(setup).protocol, new URL(entry).protocol);
    const { frameTree } = await page.send('Page.getFrameTree');
    assert.equal(frameTree.frame.url, entry);
    observer = await chrome.cdp.send('Target.attachToTarget', {
      targetId: frameTree.frame.id,
      flatten: true,
    });
    record.watch(observer.sessionId);
    await chrome.cdp.send('Page.enable', {}, observer.sessionId);
    await chrome.cdp.send('Network.enable', {}, observer.sessionId);
    await chrome.cdp.send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'iframe' }, { exclude: true }],
      },
      observer.sessionId
    );
    if (warm) await lens.running(panel);
    else await lens.stop(panel);
    if (element === 'frame') {
      await page.send('Page.navigate', {
        url: `http://other.test/document-frameset?${new URLSearchParams({ src: url, n: unique('frameset') })}`,
      });
    } else if (element) {
      await page.evaluate(
        (kind, src) => {
          const child = document.createElement(kind);
          if (kind !== 'iframe') child.type = 'text/html';
          if (kind === 'object') child.data = src;
          else if (kind === 'fencedframe') child.config = new FencedFrameConfig(src);
          else child.src = src;
          child.width = '400';
          child.height = '200';
          document.body.appendChild(child);
        },
        element,
        url
      );
    } else if (way === 'page-navigate') await page.send('Page.navigate', { url });
    else if (way === 'redirect') {
      await page.send('Page.navigate', {
        url: `https://other.test/redirect?${new URLSearchParams({ to: url, n: unique('redirect') })}`,
      });
    } else {
      await page.evaluate((href) => {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = 'open';
        document.body.appendChild(link);
        setTimeout(() => link.click());
      }, url);
    }
    const wanted = (frame) => {
      const url = frame.unreachableUrl ?? frame.url;
      if (!URL.canParse(url)) return false;
      const value = new URL(url);
      return value.hostname === host && value.searchParams.get('n') === n;
    };
    const deadline = Date.now() + 10000;
    let frame;
    let failure;
    while (Date.now() < deadline) {
      frame = [...record.frames.values()].find(wanted);
      failure = record.failures.find((failed) => failed.url && wanted({ url: failed.url }));
      if (frame || failure) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (failure) await new Promise((resolve) => setTimeout(resolve, 100));
    const current = await record.snapshot();
    if (element) {
      assert.ok(
        current.some(
          (frame) => URL.canParse(frame.url) && new URL(frame.url).hostname === 'other.test'
        )
      );
      assert.ok(
        current
          .filter(
            (frame) => URL.canParse(frame.url) && new URL(frame.url).hostname === 'other.test'
          )
          .every(
            (frame) =>
              new URL(frame.url).protocol ===
              (element === 'frame' ? 'http:' : new URL(entry).protocol)
          )
      );
    }
    frame = current.find(wanted) ?? [...record.frames.values()].find(wanted);
    assert.deepEqual(record.errors, []);
    assert.ok(frame || failure, `document ${url}: ${JSON.stringify(current)}`);
    let href = null;
    if (frame) {
      const { executionContextId } = await chrome.cdp.send(
        'Page.createIsolatedWorld',
        { frameId: frame.id, worldName: 'document-row' },
        frame.sessionId
      );
      const answer = await chrome.cdp.send(
        'Runtime.evaluate',
        { expression: 'location.href', contextId: executionContextId, returnByValue: true },
        frame.sessionId
      );
      assert.equal(answer.exceptionDetails, undefined);
      href = answer.result.value;
    }
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    record.targets.push(...targetInfos.map((target) => target.url));
    const documents = [...record.frames.values()];
    const failed = !frame || frame.url === 'chrome-error://chromewebdata/';
    const result = {
      requested: url,
      setup,
      element,
      committed: frame?.url ?? null,
      unreachable: frame?.unreachableUrl,
      attempted: failure?.url,
      href,
      documents: documents.length,
      targetDocuments: documents.filter(wanted).length,
      http: documents.filter((frame) => httpDocument(frame.url)).length,
      outcome: failed ? 'failed' : new URL(frame.url).protocol.slice(0, -1),
      empty: frame ? 0 : 1,
      targets: record.targets,
      frameUrls: current.map((frame) => frame.url),
      failures: record.failures,
    };
    if (!failed) {
      assert.equal(new URL(frame.url).hostname, host);
      assert.equal(href, frame.url);
      if (!element) assert.ok(targetInfos.some((target) => target.url === frame.url));
    }
    return result;
  } finally {
    record.off();
    if (observer) {
      await chrome.cdp
        .send('Target.detachFromTarget', { sessionId: observer.sessionId })
        .catch(() => undefined);
    }
    await page.close().catch(() => undefined);
  }
}

export async function documentCell(context, t, options, trials = 5) {
  const counts = {
    documents: 0,
    targetDocuments: 0,
    http: 0,
    https: 0,
    failed: 0,
    empty: 0,
    ordinaryHttp: 0,
  };
  const outcomes = new Set();
  for (let trial = 0; trial < trials; trial++) {
    const result = await navigateDocument(context, t, options);
    checkDocuments(result, options.expected ?? 'https');
    counts.documents += result.documents;
    counts.targetDocuments += result.targetDocuments;
    counts.http += result.http;
    counts.empty += result.empty;
    if (result.outcome === 'http') counts.ordinaryHttp += 1;
    else counts[result.outcome] += 1;
    outcomes.add(
      `${result.committed ?? 'no-document'}|${result.unreachable ?? result.attempted ?? ''}`.replace(
        /\?.*$/,
        ''
      )
    );
  }
  return { ...counts, outcomes: [...outcomes] };
}
