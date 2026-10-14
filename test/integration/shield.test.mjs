import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const slicc = 'https://seven.sliccy.ai/';
const ordinary = 'https://other.test';
const targets = { seven: 'https://seven.sliccy.ai', vault: 'https://vault.sliccy.ai' };

function install() {
  const cdp = globalThis.sliccExtension.cdp;
  const events = [];
  cdp.on((event) => events.push(event));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const attempt = (method, params, sessionId) =>
    cdp.send(method, params, sessionId).then(
      (result) => ({ result }),
      (error) => ({ error: String(error?.message ?? error) })
    );
  async function evaluate(sessionId, expression) {
    let last;
    for (let i = 0; i < 80; i++) {
      last = await attempt(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true, userGesture: true },
        sessionId
      );
      if (last.result && !last.result.exceptionDetails) return last.result.result?.value;
      if (last.error && !last.error.includes('context')) return { error: last.error };
      await sleep(100);
    }
    return { error: JSON.stringify(last) };
  }
  async function until(fn, ms = 10000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value) return value;
      await sleep(100);
    }
    return undefined;
  }
  async function open(url) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    if (url) await land(sessionId, url);
    return { targetId, sessionId };
  }
  async function land(sessionId, url) {
    await cdp.send('Page.navigate', { url }, sessionId);
    return until(async () => {
      const href = await evaluate(
        sessionId,
        'document.readyState === "complete" ? location.href : ""'
      );
      return typeof href === 'string' && href.startsWith(url) ? href : undefined;
    });
  }
  function detached(sessionId) {
    return events.some(
      (event) =>
        event.method === 'Target.detachedFromTarget' && event.params?.sessionId === sessionId
    );
  }
  function beaconSource(tag) {
    return `fetch("https://upstream.test/beacon/" + ${JSON.stringify(tag)} + "?at=" + encodeURIComponent(location.href), { mode: "no-cors" }).catch(() => undefined); window.__slicc = ${JSON.stringify(tag)};`;
  }
  async function close(targetId) {
    await attempt('Target.closeTarget', { targetId });
  }
  globalThis.h = {
    cdp,
    events,
    sleep,
    attempt,
    evaluate,
    until,
    open,
    land,
    detached,
    beaconSource,
    close,
  };
  return true;
}

async function client(t) {
  const page = await chrome.visit(t, slicc);
  await page.evaluate(install);
  return page;
}

function beacons(tag) {
  return chrome.upstream.seen.filter((seen) => seen.path === `/beacon/${tag}`);
}

async function beaconed(tag, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (beacons(tag).length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function initScriptThenNavigate(page, tag, to) {
  return page.evaluate(
    async ({ tag, start, to }) => {
      const { targetId, sessionId } = await h.open(start);
      await h.cdp.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: h.beaconSource(tag) },
        sessionId
      );
      await h.attempt(
        'Runtime.evaluate',
        { expression: `location.href = ${JSON.stringify(to)}` },
        sessionId
      );
      return { targetId, sessionId };
    },
    { tag, start: `${ordinary}/start`, to }
  );
}

async function marked(page, sessionId, tag) {
  return page.evaluate(
    async ({ sessionId, tag }) =>
      h.until(async () => {
        const value = await h.evaluate(
          sessionId,
          'document.readyState === "complete" ? window.__slicc || "none" : ""'
        );
        return value === tag ? value : undefined;
      }),
    { sessionId, tag }
  );
}

async function settledOff(page, sessionId) {
  return page.evaluate(
    async (sid) => Boolean(await h.until(async () => h.detached(sid), 10000)),
    sessionId
  );
}

for (const [name, origin] of Object.entries(targets)) {
  test(`C1 init script then location.href: runs on ${ordinary}, never on ${name}`, async (t) => {
    const page = await client(t);
    const control = `c1-control-${name}`;
    const opened = await initScriptThenNavigate(page, control, `${ordinary}/landing`);
    assert.equal(await marked(page, opened.sessionId, control), control, 'control marker');
    assert.equal(await beaconed(control), true, 'control beacon');
    await page.evaluate((id) => h.close(id), opened.targetId);

    const tag = `c1-${name}`;
    const guarded = await initScriptThenNavigate(page, tag, `${origin}/landing?k=SECRET`);
    assert.equal(await settledOff(page, guarded.sessionId), true, 'session released');
    assert.equal(await beaconed(tag, 3000), false, 'no beacon from the protected origin');
    const leaked = await page.evaluate(() => JSON.stringify(h.events).includes('SECRET'));
    assert.equal(leaked, false);
    await page.evaluate((id) => h.close(id), guarded.targetId);
  });

  test(`C2 init script then a 302 chain: runs on ${ordinary}, never on ${name}`, async (t) => {
    const page = await client(t);
    const control = `c2-control-${name}`;
    const hop = (to) => `${ordinary}/redirect?to=${encodeURIComponent(to)}`;
    const opened = await initScriptThenNavigate(page, control, hop(hop(`${ordinary}/landing`)));
    assert.equal(await marked(page, opened.sessionId, control), control, 'control marker');
    assert.equal(await beaconed(control), true, 'control beacon');
    await page.evaluate((id) => h.close(id), opened.targetId);

    const tag = `c2-${name}`;
    const guarded = await initScriptThenNavigate(page, tag, hop(hop(`${origin}/landing`)));
    assert.equal(await settledOff(page, guarded.sessionId), true, 'session released');
    assert.equal(await beaconed(tag, 3000), false, 'no beacon from the protected origin');
    await page.evaluate((id) => h.close(id), guarded.targetId);
  });

  test(`C3 window.open popup: ${ordinary} popup is attachable, ${name} popup is not`, async (t) => {
    const page = await client(t);
    const answer = await page.evaluate(
      async ({ start, ordinary, origin }) => {
        await h.cdp.send('Target.setDiscoverTargets', { discover: true });
        const { targetId, sessionId } = await h.open(start);
        await h.cdp.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: h.beaconSource('c3-popup') },
          sessionId
        );
        const popup = async (url) => {
          const before = new Set(
            (await h.cdp.send('Target.getTargets')).targetInfos.map((info) => info.targetId)
          );
          const count = h.events.length;
          await h.evaluate(sessionId, `Boolean(window.open(${JSON.stringify(url)}, "_blank"))`);
          await h.sleep(1500);
          const listed = (await h.cdp.send('Target.getTargets')).targetInfos.filter(
            (info) => !before.has(info.targetId)
          );
          const created = h.events
            .slice(count)
            .filter((event) => event.method === 'Target.targetCreated')
            .map((event) => event.params.targetInfo);
          return { listed, created };
        };
        const plain = await popup(`${ordinary}/popup`);
        const plainId = plain.listed[0]?.targetId;
        const attached = plainId
          ? await h.attempt('Target.attachToTarget', { targetId: plainId, flatten: true })
          : { error: 'none' };
        const openerId = plainId
          ? (await h.cdp.send('Target.getTargetInfo', { targetId: plainId })).targetInfo.openerId
          : undefined;
        const guarded = await popup(`${origin}/popup?k=SECRET`);
        const attachedTo = h.events
          .filter((event) => event.method === 'Target.attachedToTarget')
          .map((event) => event.params?.targetInfo?.url);
        if (plainId) await h.close(plainId);
        await h.close(targetId);
        return { targetId, plain, attached, openerId, guarded, attachedTo };
      },
      { start: `${ordinary}/start`, ordinary, origin }
    );
    assert.equal(answer.plain.listed.length, 1, 'control popup is listed');
    assert.equal(answer.plain.created.length, 1, 'control popup is announced');
    assert.equal(answer.openerId, answer.targetId, 'control popup reports its opener');
    assert.match(answer.attached.result?.sessionId ?? '', /^\d+/, 'control popup attaches');
    assert.deepEqual(answer.guarded.listed, [], 'protected popup is not listed');
    assert.deepEqual(answer.guarded.created, [], 'protected popup is not announced');
    assert.deepEqual(answer.attachedTo, [], 'no popup comes up attached');
    assert.equal(beacons('c3-popup').length, 0, 'the init script never runs in a popup');
    const refused = await page.evaluate(async () =>
      h.attempt('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
    );
    assert.match(refused.error, /^slicc: refused: /);
  });

  test(`C4 iframe: init script runs in a ${ordinary} iframe, never in a ${name} iframe`, async (t) => {
    const page = await client(t);
    const control = `c4-control-${name}`;
    const opened = await page.evaluate(
      async ({ tag, start }) => {
        const { targetId, sessionId } = await h.open(`${start}/start`);
        await h.cdp.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: h.beaconSource(tag) },
          sessionId
        );
        await h.land(sessionId, `${start}/frame?src=${encodeURIComponent(`${start}/inner`)}`);
        return { targetId, sessionId };
      },
      { tag: control, start: ordinary }
    );
    assert.equal(await beaconed(control), true, 'control beacon');
    const frames = beacons(control).map((seen) => decodeURIComponent(seen.search ?? ''));
    assert.ok(
      frames.some((at) => at.includes('/inner')),
      'the iframe ran the script'
    );
    await page.evaluate((id) => h.close(id), opened.targetId);

    const tag = `c4-${name}`;
    const guarded = await page.evaluate(
      async ({ tag, start, origin }) => {
        const { targetId, sessionId } = await h.open(`${start}/start`);
        await h.cdp.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: h.beaconSource(tag) },
          sessionId
        );
        await h.land(
          sessionId,
          `${start}/frame?src=${encodeURIComponent(`${origin}/inner?k=SECRET`)}`
        );
        await h.sleep(1500);
        const alive = await h.evaluate(sessionId, '1 + 1');
        return { targetId, sessionId, alive, detached: h.detached(sessionId) };
      },
      { tag, start: ordinary, origin }
    );
    assert.equal(await beaconed(tag), true, 'the top document still runs the script');
    const fromFrame = beacons(tag).filter((seen) =>
      decodeURIComponent(seen.search ?? '').includes('/inner')
    );
    assert.deepEqual(fromFrame, [], 'no beacon from the protected iframe');
    assert.equal(guarded.alive, 2, 'the tab stays attached');
    assert.equal(guarded.detached, false);
    await page.evaluate((id) => h.close(id), guarded.targetId);
  });

  test(`C5 Fetch.enable '*': ${ordinary} documents pause and fulfill, ${name} never reaches the client`, async (t) => {
    const page = await client(t);
    const answer = await page.evaluate(
      async ({ ordinary, origin }) => {
        const { targetId, sessionId } = await h.open(`${ordinary}/start`);
        await h.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
        const pausedFor = (url) =>
          h.events.find(
            (event) =>
              event.method === 'Fetch.requestPaused' &&
              event.sessionId === sessionId &&
              event.params.request.url.startsWith(url)
          );
        await h.attempt(
          'Runtime.evaluate',
          { expression: `location.href = ${JSON.stringify(`${ordinary}/c5`)}` },
          sessionId
        );
        const plain = await h.until(async () => pausedFor(`${ordinary}/c5`));
        const fulfilled = plain
          ? await h.attempt(
              'Fetch.fulfillRequest',
              {
                requestId: plain.params.requestId,
                responseCode: 200,
                responseHeaders: [{ name: 'content-type', value: 'text/html' }],
                body: btoa('<!doctype html><title>fulfilled-c5</title>'),
              },
              sessionId
            )
          : { error: 'never paused' };
        const title = await h.until(async () => {
          const value = await h.evaluate(sessionId, 'document.title');
          return value === 'fulfilled-c5' ? value : undefined;
        });
        const count = h.events.length;
        const forged = await h.attempt(
          'Fetch.fulfillRequest',
          { requestId: 'interception-job-1.0', responseCode: 200, body: '' },
          sessionId
        );
        await h.attempt(
          'Runtime.evaluate',
          { expression: `location.href = ${JSON.stringify(`${origin}/c5?k=SECRET`)}` },
          sessionId
        );
        const released = await h.until(async () => h.detached(sessionId));
        await h.sleep(500);
        const leaked = h.events
          .slice(count)
          .filter(
            (event) =>
              JSON.stringify(event).includes('SECRET') ||
              (event.method === 'Fetch.requestPaused' &&
                event.params.request.url.startsWith(origin))
          );
        await h.close(targetId);
        return {
          paused: Boolean(plain),
          fulfilled,
          title,
          forged,
          released: Boolean(released),
          leaked,
        };
      },
      { ordinary, origin }
    );
    assert.equal(answer.paused, true, 'control request paused toward the client');
    assert.equal(answer.fulfilled.error, undefined, 'control fulfill accepted');
    assert.equal(answer.title, 'fulfilled-c5', 'control fulfilled body renders');
    assert.match(answer.forged.error, /^slicc: refused: /, 'unknown request ids are refused');
    assert.equal(answer.released, true, 'session released on the protected navigation');
    assert.deepEqual(answer.leaked, [], 'nothing about the protected request reaches the client');
  });

  test(`C6 cookies: ${ordinary} cookies read and write, ${name} cookies are refused or filtered`, async (t) => {
    const raw = await chrome.visit(t, `${origin}/cookie?name=c6${name}`);
    assert.ok(await raw.evaluate(() => document.cookie.includes('c6')), 'protected cookie planted');
    const page = await client(t);
    const answer = await page.evaluate(
      async ({ ordinary, origin, name }) => {
        const { targetId, sessionId } = await h.open(`${ordinary}/start`);
        const set = await h.attempt(
          'Network.setCookie',
          { name: 'c6plain', value: 'ok', url: `${ordinary}/` },
          sessionId
        );
        const read = await h.attempt('Network.getCookies', { urls: [`${ordinary}/`] }, sessionId);
        const all = await h.attempt('Network.getAllCookies', {}, sessionId);
        const storage = await h.attempt('Storage.getCookies', {}, sessionId);
        const refusedSet = await h.attempt(
          'Network.setCookie',
          { name: 'x', value: '1', url: `${origin}/` },
          sessionId
        );
        const refusedDomain = await h.attempt(
          'Network.setCookie',
          { name: 'x', value: '1', domain: '.sliccy.ai', path: '/' },
          sessionId
        );
        const refusedMany = await h.attempt(
          'Network.setCookies',
          { cookies: [{ name: 'x', value: '1', url: `${origin}/` }] },
          sessionId
        );
        const refusedDelete = await h.attempt(
          'Network.deleteCookies',
          { name: `c6${name}`, url: `${origin}/` },
          sessionId
        );
        const refusedRead = await h.attempt(
          'Network.getCookies',
          { urls: [`${origin}/`] },
          sessionId
        );
        const refusedStorage = await h.attempt(
          'Storage.setCookies',
          { cookies: [{ name: 'x', value: '1', domain: new URL(origin).hostname }] },
          sessionId
        );
        await h.attempt(
          'Network.deleteCookies',
          { name: 'c6plain', url: `${ordinary}/` },
          sessionId
        );
        await h.close(targetId);
        return {
          set,
          read,
          all,
          storage,
          refusedSet,
          refusedDomain,
          refusedMany,
          refusedDelete,
          refusedRead,
          refusedStorage,
        };
      },
      { ordinary, origin, name }
    );
    assert.equal(answer.set.error, undefined, 'control setCookie');
    assert.ok(
      answer.read.result.cookies.some((c) => c.name === 'c6plain'),
      'control getCookies'
    );
    assert.ok(
      answer.all.result.cookies.some((c) => c.name === 'c6plain'),
      'control getAllCookies'
    );
    assert.equal(
      answer.all.result.cookies.some((c) => c.domain.includes('sliccy.ai')),
      false,
      'getAllCookies drops protected cookies'
    );
    if (answer.storage.result) {
      assert.equal(
        answer.storage.result.cookies.some((c) => c.domain.includes('sliccy.ai')),
        false,
        'Storage.getCookies drops protected cookies'
      );
    }
    for (const key of [
      'refusedSet',
      'refusedDomain',
      'refusedMany',
      'refusedDelete',
      'refusedRead',
      'refusedStorage',
    ]) {
      assert.match(answer[key].error ?? '', /^slicc: refused: /, key);
    }
    assert.ok(
      await raw.evaluate(() => document.cookie.includes('c6')),
      'protected cookie untouched'
    );
  });
}

test('browser-wide and origin-keyed commands are refused; the same commands work on an ordinary origin', async (t) => {
  const page = await client(t);
  const answer = await page.evaluate(async (ordinary) => {
    const { targetId, sessionId } = await h.open(`${ordinary}/start`);
    const control = {
      usage: await h.attempt('Storage.getUsageAndQuota', { origin: ordinary }, sessionId),
      fetchEnable: await h.attempt(
        'Fetch.enable',
        { patterns: [{ urlPattern: `${ordinary}/*` }] },
        sessionId
      ),
    };
    const refused = {};
    for (const [method, params, sid] of [
      ['Target.exposeDevToolsProtocol', { targetId }, undefined],
      ['Target.sendMessageToTarget', { targetId, message: '{}' }, undefined],
      ['Target.attachToBrowserTarget', {}, undefined],
      ['Tracing.start', {}, sessionId],
      ['Extensions.loadUnpacked', { path: '/x' }, sessionId],
      ['Network.clearBrowserCookies', {}, sessionId],
      ['Storage.clearCookies', {}, sessionId],
      ['Browser.resetPermissions', {}, sessionId],
      ['Browser.grantPermissions', { permissions: ['geolocation'] }, sessionId],
      ['Security.setIgnoreCertificateErrors', { ignore: true }, sessionId],
      ['Fetch.enable', {}, undefined],
      ['Storage.getUsageAndQuota', { origin: 'https://seven.sliccy.ai' }, sessionId],
      [
        'Storage.clearDataForOrigin',
        { origin: 'https://vault.sliccy.ai', storageTypes: 'all' },
        sessionId,
      ],
      [
        'DOMStorage.getDOMStorageItems',
        { storageId: { securityOrigin: 'https://vault.sliccy.ai', isLocalStorage: true } },
        sessionId,
      ],
      ['IndexedDB.requestDatabaseNames', { securityOrigin: 'https://seven.sliccy.ai' }, sessionId],
      ['CacheStorage.requestCacheNames', { storageKey: 'https://vault.sliccy.ai/' }, sessionId],
      ['Fetch.enable', { patterns: [{ urlPattern: 'https://vault.sliccy.ai/*' }] }, sessionId],
      ['Page.navigate', { url: 'https://seven.sliccy.ai/' }, sessionId],
      ['Network.getResponseBody', { requestId: 'never-seen' }, sessionId],
      ['IO.read', { handle: '1' }, sessionId],
    ]) {
      refused[`${method} ${JSON.stringify(params)}`] = await h.attempt(method, params, sid);
    }
    await h.close(targetId);
    return { control, refused };
  }, ordinary);
  assert.equal(answer.control.usage.error, undefined, 'control Storage.getUsageAndQuota');
  assert.equal(answer.control.fetchEnable.error, undefined, 'control Fetch.enable');
  for (const [key, value] of Object.entries(answer.refused)) {
    assert.match(value.error ?? '', /^slicc: refused: /, key);
  }
});

test('S7-3: getTargetInfo, discovery events, becomes-protected targetDestroyed, detachedFromTarget, getVersion', async (t) => {
  const page = await client(t);
  const answer = await page.evaluate(
    async ({ ordinary, vault }) => {
      const version = await h.cdp.send('Browser.getVersion');
      const blank = await h.cdp.send('Target.createTarget', { url: 'about:blank' });
      const blankInfo = (await h.cdp.send('Target.getTargetInfo', { targetId: blank.targetId }))
        .targetInfo;
      await h.close(blank.targetId);
      await h.cdp.send('Target.setDiscoverTargets', { discover: true });
      const { targetId, sessionId } = await h.open(`${ordinary}/start`);
      const created = h.events.find(
        (e) => e.method === 'Target.targetCreated' && e.params.targetInfo.targetId === targetId
      );
      const mark = h.events.length;
      await h.land(sessionId, `${ordinary}/second`);
      await h.evaluate(sessionId, 'history.pushState({}, "", "/pushed"); true');
      await h.sleep(800);
      const changed = h.events
        .slice(mark)
        .filter(
          (e) =>
            e.method === 'Target.targetInfoChanged' && e.params.targetInfo.targetId === targetId
        )
        .map((e) => e.params.targetInfo.url);
      await h.evaluate(
        sessionId,
        `window.w = window.open(${JSON.stringify(`${ordinary}/popup`)}, "_blank"); true`
      );
      const popup = await h.until(
        async () =>
          h.events.find(
            (e) => e.method === 'Target.targetCreated' && e.params.targetInfo.openerId === targetId
          )?.params.targetInfo
      );
      const popupInfo = (await h.cdp.send('Target.getTargetInfo', { targetId: popup.targetId }))
        .targetInfo;
      await h.sleep(800);
      const popupSession = await h.cdp.send('Target.attachToTarget', {
        targetId: popup.targetId,
        flatten: true,
      });
      await h.evaluate(
        sessionId,
        `window.w.location.href = ${JSON.stringify(`${vault}/became?k=SECRET`)}; true`
      );
      const destroyed = await h.until(async () =>
        h.events.find(
          (e) => e.method === 'Target.targetDestroyed' && e.params.targetId === popup.targetId
        )
      );
      const popupDetached = await h.until(async () => h.detached(popupSession.sessionId));
      const refusedInfo = await h.attempt('Target.getTargetInfo', { targetId: popup.targetId });
      const listed = (await h.cdp.send('Target.getTargets')).targetInfos.some(
        (i) => i.targetId === popup.targetId
      );
      const second = await h.cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await h.cdp.send('Target.closeTarget', { targetId });
      const closedBoth = await h.until(
        async () => h.detached(sessionId) && h.detached(second.sessionId)
      );
      const gone = await h.until(async () =>
        h.events.find(
          (e) => e.method === 'Target.targetDestroyed' && e.params.targetId === targetId
        )
      );
      const leaked = JSON.stringify(h.events).includes('SECRET');
      await h.cdp.send('Target.setDiscoverTargets', { discover: false });
      return {
        version,
        blankInfo,
        created: Boolean(created),
        changed,
        popupInfo,
        targetId,
        destroyed: Boolean(destroyed),
        popupDetached: Boolean(popupDetached),
        refusedInfo,
        listed,
        distinct: second.sessionId !== sessionId,
        closedBoth: Boolean(closedBoth),
        gone: Boolean(gone),
        leaked,
      };
    },
    { ordinary, vault: targets.vault }
  );
  assert.match(answer.version.product, /^Chrome\/\d+\./);
  assert.equal(answer.version.protocolVersion, '1.3');
  assert.equal(answer.blankInfo.type, 'page');
  assert.equal(answer.blankInfo.url, 'about:blank');
  assert.equal(answer.blankInfo.openerId, undefined);
  assert.equal(answer.created, true, 'targetCreated');
  assert.ok(
    answer.changed.some((url) => url.endsWith('/second')),
    'targetInfoChanged on navigation'
  );
  assert.ok(
    answer.changed.some((url) => url.endsWith('/pushed')),
    'targetInfoChanged on pushState'
  );
  assert.equal(answer.popupInfo.openerId, answer.targetId, 'openerId from openerTabId');
  assert.equal(answer.destroyed, true, 'a tab that becomes protected is destroyed');
  assert.equal(answer.popupDetached, true, 'and its session detached');
  assert.equal(answer.refusedInfo.error, "slicc: refused: target is on seven's origin");
  assert.equal(answer.listed, false);
  assert.equal(answer.distinct, true, 'each attach is its own session');
  assert.equal(answer.closedBoth, true, 'detachedFromTarget for every session on close');
  assert.equal(answer.gone, true, 'targetDestroyed on close');
  assert.equal(answer.leaked, false);
});
