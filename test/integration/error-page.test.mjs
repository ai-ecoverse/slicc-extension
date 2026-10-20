import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const transports = ['seven', 'six-bridge'];
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const errorPage = 'chrome-error://chromewebdata/';
const seven = 'https://seven.sliccy.ai';
const vault = 'https://vault.sliccy.ai';
const ordinary = 'https://ordinary.test';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let serial = 0;

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

async function until(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    await sleep(50);
  }
  return undefined;
}

async function observe(t, url) {
  void chrome.cdp.events;
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url, background: true });
  t.after(() => chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined));
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await chrome.cdp.send('Page.enable', {}, sessionId);
  const observer = { targetId, sessionId };
  assert.ok(await loaded(observer, url), `the observer loads ${url}`);
  return observer;
}

async function frame(observer) {
  return (await chrome.cdp.send('Page.getFrameTree', {}, observer.sessionId)).frameTree.frame;
}

async function loaded(observer, url) {
  return until(async () => {
    const main = await frame(observer);
    if (main.url !== url || main.unreachableUrl) return false;
    const ready = await chrome.cdp.send(
      'Runtime.evaluate',
      { expression: 'document.readyState', returnByValue: true },
      observer.sessionId
    );
    return ready.result.value === 'complete';
  });
}

async function failedOnto(observer, url) {
  return until(async () => {
    const main = await frame(observer);
    return main.url === errorPage && main.unreachableUrl === url ? main : undefined;
  });
}

async function rawInfo(observer) {
  return (await chrome.cdp.send('Target.getTargetInfo', { targetId: observer.targetId }))
    .targetInfo;
}

async function failDocuments(observer) {
  const off = chrome.cdp.on((event) => {
    if (event.method !== 'Fetch.requestPaused' || event.sessionId !== observer.sessionId) return;
    void chrome.cdp
      .send(
        'Fetch.failRequest',
        { requestId: event.params.requestId, errorReason: 'BlockedByClient' },
        observer.sessionId
      )
      .catch(() => undefined);
  });
  await chrome.cdp.send(
    'Fetch.enable',
    { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] },
    observer.sessionId
  );
  return async () => {
    off();
    await chrome.cdp.send('Fetch.disable', {}, observer.sessionId).catch(() => undefined);
  };
}

async function restore(observer, url) {
  const mark = chrome.cdp.events.length;
  const { entries, currentIndex } = await chrome.cdp.send(
    'Page.getNavigationHistory',
    {},
    observer.sessionId
  );
  const index = entries.findIndex((item) => item.url === url);
  assert.ok(index >= 0, `the history holds ${url}`);
  await chrome.cdp.send(
    'Runtime.evaluate',
    { expression: `history.go(${index - currentIndex})` },
    observer.sessionId
  );
  assert.ok(await loaded(observer, url), `the observer sees ${url} restored`);
  const commit = chrome.cdp.events
    .slice(mark)
    .find(
      (event) =>
        event.sessionId === observer.sessionId &&
        event.method === 'Page.frameNavigated' &&
        !event.params.frame.parentId &&
        event.params.frame.url === url
    );
  return commit?.params.type;
}

async function attachByUrl(page, url) {
  return page.evaluate(async (url) => {
    const found = await h.until(async () => {
      const { targetInfos } = await h.cdp.send('Target.getTargets');
      return targetInfos.find((info) => info.url === url);
    });
    if (!found) return { error: `no target at ${url}` };
    const attached = await h.attempt('Target.attachToTarget', {
      targetId: found.targetId,
      flatten: true,
    });
    if (attached.error) return { targetId: found.targetId, error: attached.error };
    const { sessionId } = attached.result;
    await h.attempt('Page.enable', {}, sessionId);
    await h.attempt('Runtime.enable', {}, sessionId);
    const mark = h.events.length;
    globalThis.mark = mark;
    return { targetId: found.targetId, sessionId, sum: await h.evaluate(sessionId, '1+1') };
  }, url);
}

async function scriptTo(page, sessionId, url) {
  await page.evaluate(
    ({ sessionId, url }) =>
      h.attempt(
        'Runtime.evaluate',
        { expression: `setTimeout(() => { location.href = ${JSON.stringify(url)}; }, 0)` },
        sessionId
      ),
    { sessionId, url }
  );
}

async function discovery(page, targetId) {
  return page.evaluate(async (targetId) => {
    const info = await h.attempt('Target.getTargetInfo', { targetId });
    const list = await h.attempt('Target.getTargets');
    return {
      info: info.result?.targetInfo ?? info,
      listed: list.result?.targetInfos?.find((item) => item.targetId === targetId),
    };
  }, targetId);
}

async function reach(page, targetId, sessionId) {
  return page.evaluate(
    async ({ targetId, sessionId }) => {
      const evaluated = await h.attempt(
        'Runtime.evaluate',
        { expression: 'location.href', returnByValue: true },
        sessionId
      );
      const attached = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
      const evaluatedAgain = attached.result
        ? await h.attempt(
            'Runtime.evaluate',
            { expression: 'location.href', returnByValue: true },
            attached.result.sessionId
          )
        : undefined;
      const closed = await h.attempt('Target.closeTarget', { targetId });
      return {
        href: evaluated.result?.result?.value,
        evaluateError: evaluated.error,
        attachError: attached.error,
        hrefAgain: evaluatedAgain?.result?.result?.value,
        closeError: closed.error,
        detached: h.detached(sessionId),
      };
    },
    { targetId, sessionId }
  );
}

function secrets(tag) {
  return `${seven}/doc/path-secret-${tag}?query-secret=${tag}#fragment-secret-${tag}`;
}

for (const transport of transports) {
  test(`${transport}: a protected navigation that fails onto an error page keeps the target's previous decision and lists it as the protected origin`, async (t) => {
    const tag = `recover-${transport}-${++serial}`;
    const start = `${ordinary}/doc?n=${tag}`;
    const failing = secrets(tag);
    const observer = await observe(t, start);
    const page = await client(t, transport);
    if (transport === 'seven')
      await page.evaluate(() => h.cdp.send('Target.setDiscoverTargets', { discover: true }));
    const attached = await attachByUrl(page, start);
    assert.equal(attached.sum, 2, JSON.stringify(attached));
    await scriptTo(page, attached.sessionId, failing);
    assert.ok(await failedOnto(observer, failing), 'the observer sees the error commit');
    assert.equal((await rawInfo(observer)).url, failing, 'Chrome reports the failed url');
    await sleep(500);
    const seen = await discovery(page, attached.targetId);
    assert.equal(seen.info.url, seven, JSON.stringify(seen));
    assert.equal(seen.info.title, seven, JSON.stringify(seen));
    assert.equal(seen.listed?.url, seven, JSON.stringify(seen));
    assert.equal(seen.listed?.title, seven, JSON.stringify(seen));
    const after = await page.evaluate(
      async ({ sessionId, targetId, tag }) => {
        const events = h.events.slice(globalThis.mark);
        const changed = events
          .filter((e) => e.params?.targetInfo?.targetId === targetId)
          .map((e) => e.params.targetInfo);
        const href = await h.evaluate(sessionId, 'location.href');
        const blank = await h.attempt('Page.navigate', { url: 'about:blank' }, sessionId);
        const landed = await h.until(
          async () => (await h.evaluate(sessionId, 'location.href')) === 'about:blank'
        );
        return {
          changed,
          href,
          blank,
          landed: Boolean(landed),
          detached: h.detached(sessionId),
          leaked: JSON.stringify(events).includes(`secret-${tag}`),
        };
      },
      { sessionId: attached.sessionId, targetId: attached.targetId, tag }
    );
    assert.equal(after.leaked, false, 'no path, query or fragment secret reaches the client');
    assert.equal(after.detached, false, 'the allowed session stays attached');
    assert.equal(after.href, errorPage, 'the allowed tab still answers on its error page');
    assert.equal(after.blank.error, undefined, JSON.stringify(after.blank));
    assert.equal(after.landed, true, 'the allowed tab recovers to about:blank');
    if (transport === 'seven') {
      const protectedChanges = after.changed.filter((info) => info.url.includes('sliccy.ai'));
      assert.ok(protectedChanges.length > 0, JSON.stringify(after.changed));
      for (const info of protectedChanges) {
        assert.deepEqual([info.url, info.title], [seven, seven], JSON.stringify(info));
      }
    }
  });

  test(`${transport} control: an ordinary failed navigation keeps Chrome's own failed url and title`, async (t) => {
    const tag = `control-${transport}-${++serial}`;
    const start = `${ordinary}/doc?n=${tag}`;
    const failing = `http://127.0.0.1:1/${tag}`;
    const observer = await observe(t, start);
    const page = await client(t, transport);
    const attached = await attachByUrl(page, start);
    assert.equal(attached.sum, 2, JSON.stringify(attached));
    await scriptTo(page, attached.sessionId, failing);
    assert.ok(await failedOnto(observer, failing), 'the observer sees the error commit');
    await sleep(500);
    const raw = await rawInfo(observer);
    const seen = await discovery(page, attached.targetId);
    assert.equal(seen.info.url, raw.url, JSON.stringify({ raw, seen }));
    assert.equal(seen.info.url, failing, JSON.stringify({ raw, seen }));
    assert.equal(seen.listed?.url, failing, JSON.stringify(seen));
    assert.notEqual(seen.info.title, '', 'an ordinary error page keeps its title');
    const href = await page.evaluate(
      (sessionId) => h.evaluate(sessionId, 'location.href'),
      attached.sessionId
    );
    assert.equal(href, errorPage);
  });

  for (const protectedSeed of [true, false]) {
    const kind = protectedSeed ? 'protected' : 'control: an ordinary';
    test(`${transport} ${kind} document restored from history after an error page is ${protectedSeed ? 'never drivable' : 'drivable'}`, async (t) => {
      const tag = `restore-${transport}-${protectedSeed}-${++serial}`;
      const seed = `${protectedSeed ? vault : ordinary}/doc?n=${tag}-seed`;
      const start = `${ordinary}/doc?n=${tag}`;
      const failing = secrets(tag);
      const observer = await observe(t, seed);
      await chrome.cdp.send('Page.navigate', { url: start }, observer.sessionId);
      assert.ok(await loaded(observer, start));
      const page = await client(t, transport);
      const attached = await attachByUrl(page, start);
      assert.equal(attached.sum, 2, JSON.stringify(attached));
      await scriptTo(page, attached.sessionId, failing);
      assert.ok(await failedOnto(observer, failing), 'the observer sees the error commit');
      await sleep(300);
      const type = await restore(observer, seed);
      t.diagnostic(`restore commit: ${type}`);
      await sleep(300);
      const reached = await reach(page, attached.targetId, attached.sessionId);
      const present = await until(async () => (await rawInfo(observer)).url === seed);
      if (protectedSeed) {
        assert.equal(reached.href, undefined, JSON.stringify(reached));
        assert.ok(reached.evaluateError, JSON.stringify(reached));
        assert.match(reached.attachError ?? '', /^slicc: refused: /, JSON.stringify(reached));
        assert.equal(reached.hrefAgain, undefined, JSON.stringify(reached));
        assert.match(reached.closeError ?? '', /^slicc: refused: /, JSON.stringify(reached));
        assert.ok(present, 'the protected tab is not closed by the client');
      } else {
        assert.equal(reached.href, seed, JSON.stringify(reached));
        assert.equal(reached.attachError, undefined, JSON.stringify(reached));
        assert.equal(reached.hrefAgain, seed, JSON.stringify(reached));
        assert.equal(reached.closeError, undefined, JSON.stringify(reached));
      }
    });

    test(`${transport} ${kind} held tab ${protectedSeed ? 'stays locked' : 'stays drivable'} after a later failed navigation commits an error page`, async (t) => {
      const tag = `sticky-${transport}-${protectedSeed}-${++serial}`;
      const seed = `${protectedSeed ? vault : ordinary}/doc?n=${tag}-seed`;
      const start = `${ordinary}/doc?n=${tag}`;
      const failing = protectedSeed ? secrets(tag) : `${ordinary}/doc/failed-${tag}`;
      const observer = await observe(t, seed);
      await chrome.cdp.send('Page.navigate', { url: start }, observer.sessionId);
      assert.ok(await loaded(observer, start));
      const page = await client(t, transport);
      const attached = await attachByUrl(page, start);
      assert.equal(attached.sum, 2, JSON.stringify(attached));
      await scriptTo(
        page,
        attached.sessionId,
        protectedSeed ? secrets(`${tag}-first`) : `http://127.0.0.1:1/${tag}`
      );
      assert.ok(
        await failedOnto(
          observer,
          protectedSeed ? secrets(`${tag}-first`) : `http://127.0.0.1:1/${tag}`
        ),
        'the observer sees the first error commit'
      );
      await sleep(300);
      await restore(observer, seed);
      await sleep(300);
      const stop = await failDocuments(observer);
      await chrome.cdp.send('Page.navigate', { url: failing }, observer.sessionId);
      assert.ok(await failedOnto(observer, failing), 'the observer sees the later error commit');
      await stop();
      await sleep(500);
      const seen = await discovery(page, attached.targetId);
      const reached = await reach(page, attached.targetId, attached.sessionId);
      const present = await until(async () => (await rawInfo(observer)).url === failing);
      if (protectedSeed) {
        if (transport === 'six-bridge')
          assert.equal(JSON.stringify(seen).includes('secret-'), false, JSON.stringify(seen));
        assert.equal(reached.href, undefined, JSON.stringify(reached));
        assert.ok(reached.evaluateError, JSON.stringify(reached));
        assert.match(reached.attachError ?? '', /^slicc: refused: /, JSON.stringify(reached));
        assert.equal(reached.hrefAgain, undefined, JSON.stringify(reached));
        assert.match(reached.closeError ?? '', /^slicc: refused: /, JSON.stringify(reached));
        assert.ok(present, 'the protected tab is not closed by the client');
      } else {
        assert.equal(reached.href, errorPage, JSON.stringify(reached));
        assert.equal(reached.attachError, undefined, JSON.stringify(reached));
        assert.equal(reached.hrefAgain, errorPage, JSON.stringify(reached));
        assert.equal(reached.closeError, undefined, JSON.stringify(reached));
      }
    });
  }

  test(`${transport}: a protected document committed after the client let go is not unlocked by an earlier failed url`, async (t) => {
    const tag = `stale-${transport}-${++serial}`;
    const start = `${ordinary}/doc?n=${tag}`;
    const failing = secrets(tag);
    const observer = await observe(t, start);
    const page = await client(t, transport);
    const attached = await attachByUrl(page, start);
    assert.equal(attached.sum, 2, JSON.stringify(attached));
    await scriptTo(page, attached.sessionId, failing);
    assert.ok(await failedOnto(observer, failing), 'the observer sees the error commit');
    await sleep(300);
    await page.evaluate(
      (sessionId) => h.attempt('Target.detachFromTarget', { sessionId }),
      attached.sessionId
    );
    await sleep(300);
    const real = `${vault}/doc?n=${tag}-real`;
    await chrome.cdp.send('Page.navigate', { url: real }, observer.sessionId);
    assert.ok(await loaded(observer, real), 'a real protected document commits');
    const stop = await failDocuments(observer);
    await chrome.cdp.send('Page.navigate', { url: failing }, observer.sessionId);
    assert.ok(await failedOnto(observer, failing), 'the same protected url fails again');
    await stop();
    await sleep(500);
    const reached = await reach(page, attached.targetId, attached.sessionId);
    assert.match(reached.attachError ?? '', /^slicc: refused: /, JSON.stringify(reached));
    assert.equal(reached.hrefAgain, undefined, JSON.stringify(reached));
    assert.match(reached.closeError ?? '', /^slicc: refused: /, JSON.stringify(reached));
  });
}
