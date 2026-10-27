import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const slicc = 'https://seven.sliccy.ai/';
const ordinary = 'https://other.test';
const targets = { seven: 'https://seven.sliccy.ai', vault: 'https://vault.sliccy.ai' };

const extId = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';
const leader = 'https://www.sliccy.ai/?slicc=leader';
const transports = ['seven', 'six-bridge'];

async function client(t, transport = 'seven') {
  const page = await chrome.visit(t, transport === 'six-bridge' ? leader : slicc);
  await page.evaluate(install, transport, extId);
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

async function stayed(page, sessionId, origin) {
  return page.evaluate(
    async ({ sid, origin }) => {
      await h.sleep(2500);
      const href = await h.evaluate(sid, 'location.href');
      return {
        detached: h.detached(sid),
        landed: typeof href === 'string' && href.startsWith(origin),
        answered: typeof href === 'string',
        refused: /^slicc: refused:/.test(href?.error ?? ''),
      };
    },
    { sid: sessionId, origin }
  );
}

for (const transport of transports) {
  for (const [target, origin] of Object.entries(targets)) {
    const name = transport === 'seven' ? target : `${target}-${transport}`;
    test(`${transport} C1 init script then location.href: runs on ${ordinary}, never on ${target}`, async (t) => {
      const page = await client(t, transport);
      const control = `c1-control-${name}`;
      const opened = await initScriptThenNavigate(page, control, `${ordinary}/landing`);
      assert.equal(await marked(page, opened.sessionId, control), control, 'control marker');
      assert.equal(await beaconed(control), true, 'control beacon');
      await page.evaluate((id) => h.close(id), opened.targetId);

      const tag = `c1-${name}`;
      const guarded = await initScriptThenNavigate(page, tag, `${origin}/landing?k=SECRET`);
      assert.deepEqual(
        await stayed(page, guarded.sessionId, origin),
        { detached: false, landed: false, answered: false, refused: true },
        'navigation replies'
      );
      assert.equal(await beaconed(tag, 3000), false, 'no beacon from the protected origin');
      const leaked = await page.evaluate(() =>
        JSON.stringify(h.content(h.events)).includes('SECRET')
      );
      assert.equal(leaked, false);
      await page.evaluate((id) => h.close(id), guarded.targetId);
    });

    test(`${transport} C2 init script then a 302 chain: runs on ${ordinary}, never on ${target}`, async (t) => {
      const page = await client(t, transport);
      const control = `c2-control-${name}`;
      const hop = (to) => `${ordinary}/redirect?to=${encodeURIComponent(to)}`;
      const opened = await initScriptThenNavigate(page, control, hop(hop(`${ordinary}/landing`)));
      assert.equal(await marked(page, opened.sessionId, control), control, 'control marker');
      assert.equal(await beaconed(control), true, 'control beacon');
      await page.evaluate((id) => h.close(id), opened.targetId);

      const tag = `c2-${name}`;
      const guarded = await initScriptThenNavigate(page, tag, hop(hop(`${origin}/landing`)));
      assert.deepEqual(
        await stayed(page, guarded.sessionId, origin),
        { detached: false, landed: false, answered: false, refused: true },
        'navigation replies'
      );
      assert.equal(await beaconed(tag, 3000), false, 'no beacon from the protected origin');
      await page.evaluate((id) => h.close(id), guarded.targetId);
    });

    test(`${transport} C3 window.open popup: ${ordinary} popup is attachable, ${target} popup is not`, async (t) => {
      const page = await client(t, transport);
      const answer = await page.evaluate(
        async ({ start, ordinary, origin, discovery }) => {
          if (discovery) await h.cdp.send('Target.setDiscoverTargets', { discover: true });
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
            const later = h.events.slice(count);
            const created = later
              .filter((event) => event.method === 'Target.targetCreated')
              .map((event) => event.params.targetInfo);
            const destroyed = later
              .filter((event) => event.method === 'Target.targetDestroyed')
              .map((event) => event.params.targetId);
            const leaked = later.some((event) =>
              /sliccy\.ai|SECRET/.test(JSON.stringify(event.params?.targetInfo ?? {}))
            );
            return { listed, created, destroyed, leaked };
          };
          const plain = await popup(`${ordinary}/popup`);
          const plainId = plain.listed[0]?.targetId;
          const attached = plainId
            ? await h.attempt('Target.attachToTarget', { targetId: plainId, flatten: true })
            : { error: 'none' };
          const openerId =
            plainId && discovery
              ? (await h.cdp.send('Target.getTargetInfo', { targetId: plainId })).targetInfo
                  .openerId
              : undefined;
          const guarded = await popup(`${origin}/popup?k=SECRET`);
          const guardedId = guarded.listed[0]?.targetId;
          guarded.attach = guardedId
            ? await h.attempt('Target.attachToTarget', { targetId: guardedId, flatten: true })
            : { error: 'not listed' };
          if (guardedId) await h.close(guardedId);
          const openerAlive = await h.evaluate(sessionId, '1 + 1');
          const openerDetached = h.detached(sessionId);
          const own = [sessionId, attached.result?.sessionId, guarded.attach.result?.sessionId];
          const attachedTo = h.events
            .filter(
              (event) =>
                event.method === 'Target.attachedToTarget' && !own.includes(event.params?.sessionId)
            )
            .map((event) => event.params?.targetInfo?.url);
          if (plainId) await h.close(plainId);
          await h.close(targetId);
          return {
            targetId,
            plain,
            attached,
            openerId,
            guarded,
            attachedTo,
            openerAlive,
            openerDetached,
          };
        },
        { start: `${ordinary}/start`, ordinary, origin, discovery: transport === 'seven' }
      );
      assert.equal(answer.plain.listed.length, 1, 'control popup is listed');
      if (transport === 'seven') {
        assert.equal(answer.plain.created.length, 1, 'control popup is announced');
        assert.equal(answer.openerId, answer.targetId, 'control popup reports its opener');
      }
      assert.match(answer.attached.result?.sessionId ?? '', /^\d+/, 'control popup attaches');
      assert.equal(answer.guarded.listed.length, 1, 'protected popup is listed for the guard');
      assert.match(
        answer.guarded.attach.error ?? '',
        /^slicc: refused: /,
        'protected popup cannot be attached'
      );
      assert.deepEqual(answer.attachedTo, [], 'no popup comes up attached');
      assert.equal(answer.openerAlive, 2, 'the opener session still answers');
      assert.equal(answer.openerDetached, false, 'the opener session is not detached');
      assert.equal(beacons('c3-popup').length, 0, 'the init script never runs in a popup');
      const refused = await page.evaluate(async () =>
        h.attempt('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        })
      );
      assert.ok(refused.error, 'Target.setAutoAttach is refused');
      if (transport === 'seven') {
        assert.match(refused.error, /^slicc: refused: /);
        return;
      }
      const shielded = await page.evaluate(async (start) => {
        const { targetId, sessionId } = await h.open(start);
        const answer = await h.attempt(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          sessionId
        );
        await h.close(targetId);
        return answer;
      }, `${ordinary}/start`);
      assert.equal(
        shielded.error,
        'slicc: refused: auto-attach is not supported by the extension bridge',
        'the six shield refuses auto-attach on an attached session'
      );
    });

    test(`${transport} C4 iframe: init script runs in a ${ordinary} iframe, never in a ${target} iframe`, async (t) => {
      const page = await client(t, transport);
      const control = `c4-control-${name}`;
      const ordinaryHost = new URL(ordinary).hostname;
      const protectedHost = new URL(origin).hostname;
      const inners = (host, mark) =>
        chrome.site.seen.slice(mark).filter((seen) => seen.host === host && seen.path === '/inner');
      const controlMark = chrome.site.seen.length;
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
      const deadline = Date.now() + 10000;
      const fromInner = () =>
        beacons(control).some((seen) => decodeURIComponent(seen.search ?? '').includes('/inner'));
      while (!fromInner() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(fromInner(), 'the iframe ran the script');
      assert.equal(inners(ordinaryHost, controlMark).length, 1, 'control iframe is requested once');
      await page.evaluate((id) => h.close(id), opened.targetId);

      const tag = `c4-${name}`;
      const guardedMark = chrome.site.seen.length;
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
      assert.deepEqual(
        inners(protectedHost, guardedMark),
        [],
        'protected iframe document is never requested'
      );
      assert.equal(guarded.alive, 2, 'the tab stays attached');
      assert.equal(guarded.detached, false, 'only the protected frame fails');
      await page.evaluate((id) => h.close(id), guarded.targetId);
    });

    test(`${transport} C4 whole tab: a blocked ${target} iframe keeps main-frame Runtime.evaluate and refuses screenshots and input of the tab`, async (t) => {
      const page = await client(t, transport);
      const run = await page.evaluate(
        async ({ start, origin, refusal }) => {
          const probe = async (src, sealed) => {
            const { targetId, sessionId } = await h.open(
              `${start}/frame?src=${encodeURIComponent(src)}`
            );
            await h.attempt('Page.bringToFront', {}, sessionId);
            const visible = await h.until(
              async () => (await h.evaluate(sessionId, 'document.visibilityState')) === 'visible'
            );
            const shot = () => h.attempt('Page.captureScreenshot', { format: 'png' }, sessionId);
            if (sealed) await h.until(async () => (await shot()).error === refusal);
            const evaluate = await h.evaluate(sessionId, '1 + 1');
            const screenshot = await shot();
            const mouse = await h.attempt(
              'Input.dispatchMouseEvent',
              { type: 'mouseMoved', x: 20, y: 20 },
              sessionId
            );
            const after = await h.evaluate(sessionId, '2 + 2');
            await h.close(targetId);
            return {
              visible,
              evaluate,
              after,
              screenshot: { error: screenshot.error, bytes: screenshot.result?.data?.length ?? 0 },
              mouse: { error: mouse.error, answered: Boolean(mouse.result) },
            };
          };
          return {
            control: await probe(`${start}/inner`, false),
            guarded: await probe(`${origin}/inner?k=SECRET`, true),
          };
        },
        { start: ordinary, origin, refusal: "slicc: refused: target is on seven's origin" }
      );
      t.diagnostic(`${transport} ${target} whole tab: ${JSON.stringify(run)}`);
      assert.equal(run.control.visible, true, 'control tab in front');
      assert.equal(run.control.evaluate, 2, 'control evaluate');
      assert.equal(run.control.screenshot.error, undefined, 'control screenshot');
      assert.ok(run.control.screenshot.bytes > 0, 'control screenshot bytes');
      assert.equal(run.control.mouse.error, undefined, 'control input');
      assert.equal(run.control.mouse.answered, true, 'control input');
      assert.equal(run.guarded.visible, true, 'guarded tab in front');
      assert.equal(run.guarded.evaluate, 2, 'main-frame Runtime.evaluate answers');
      assert.equal(run.guarded.after, 4, 'the session stays');
      assert.deepEqual(
        run.guarded.screenshot,
        { error: "slicc: refused: target is on seven's origin", bytes: 0 },
        'the screenshot of the tab is refused'
      );
      assert.deepEqual(
        run.guarded.mouse,
        { error: "slicc: refused: target is on seven's origin", answered: false },
        'input to the tab is refused'
      );
    });

    test(`${transport} C5 Fetch.enable '*': ${ordinary} documents pause and fulfill, ${target} never reaches the client`, async (t) => {
      const page = await client(t, transport);
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
          await h.sleep(2500);
          const released = h.detached(sessionId);
          const href = await h.evaluate(sessionId, 'location.href');
          await h.sleep(500);
          const leaked = h
            .content(h.events.slice(count))
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
            released,
            landed: typeof href === 'string' && href.startsWith(origin),
            leaked,
          };
        },
        { ordinary, origin }
      );
      assert.equal(answer.paused, true, 'control request paused toward the client');
      assert.equal(answer.fulfilled.error, undefined, 'control fulfill accepted');
      assert.equal(answer.title, 'fulfilled-c5', 'control fulfilled body renders');
      assert.match(answer.forged.error, /^slicc: refused: /, 'unknown request ids are refused');
      assert.equal(answer.released, false, 'the session stays');
      assert.equal(answer.landed, false, 'the protected document never commits');
      assert.deepEqual(answer.leaked, [], 'nothing about the protected request reaches the client');
    });

    test(`${transport} C6 cookies: ${ordinary} cookies read and write, ${target} cookies are refused or filtered`, async (t) => {
      const raw = await chrome.visit(t, `${origin}/cookie?name=c6${name}`);
      assert.ok(
        await raw.evaluate(() => document.cookie.includes('c6')),
        'protected cookie planted'
      );
      const page = await client(t, transport);
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
      if (answer.storage.error === undefined) {
        assert.ok(Array.isArray(answer.storage.result?.cookies), 'Storage.getCookies answered');
        assert.equal(
          answer.storage.result.cookies.some((c) => c.domain.includes('sliccy.ai')),
          false,
          'Storage.getCookies succeeded and drops protected cookies'
        );
        t.diagnostic('Storage.getCookies: filtered');
      } else {
        assert.match(
          answer.storage.error,
          /^slicc: refused: /,
          'Storage.getCookies failed only with the shield refusal'
        );
        t.diagnostic('Storage.getCookies: refused');
      }
      for (const key of [
        'refusedSet',
        'refusedDomain',
        'refusedMany',
        'refusedDelete',
        'refusedStorage',
      ]) {
        assert.match(answer[key].error ?? '', /^slicc: refused: /, key);
      }
      if (answer.refusedRead.error === undefined) {
        assert.equal(
          answer.refusedRead.result.cookies.some((c) => c.domain.includes('sliccy.ai')),
          false,
          'getCookies for a protected URL succeeded and returns no protected cookie'
        );
        t.diagnostic('Network.getCookies(protected): filtered');
      } else {
        assert.match(answer.refusedRead.error, /^slicc: refused: /, 'refusedRead');
        t.diagnostic('Network.getCookies(protected): refused');
      }
      assert.ok(
        await raw.evaluate(() => document.cookie.includes('c6')),
        'protected cookie untouched'
      );
    });
  }
}

test('six-bridge C6.clear-cookies: Network.clearBrowserCookies and Storage.clearCookies are refused; protected cookie survives; ordinary cookie clears via deleteCookies', async (t) => {
  const origin = targets.seven;
  const raw = await chrome.visit(t, `${origin}/cookie?name=c6clear`);
  assert.ok(
    await raw.evaluate(() => document.cookie.includes('c6clear')),
    'protected cookie planted'
  );
  const page = await client(t, 'six-bridge');
  const answer = await page.evaluate(async (ordinary) => {
    const { targetId, sessionId } = await h.open(`${ordinary}/start`);
    const set = await h.attempt(
      'Network.setCookie',
      { name: 'c6plain', value: 'ok', url: `${ordinary}/` },
      sessionId
    );
    const clearBrowser = await h.attempt('Network.clearBrowserCookies', {}, sessionId);
    const clearStorage = await h.attempt('Storage.clearCookies', {}, sessionId);
    const afterRefuse = await h.attempt(
      'Network.getCookies',
      { urls: [`${ordinary}/`] },
      sessionId
    );
    const deletePlain = await h.attempt(
      'Network.deleteCookies',
      { name: 'c6plain', url: `${ordinary}/` },
      sessionId
    );
    const afterDelete = await h.attempt(
      'Network.getCookies',
      { urls: [`${ordinary}/`] },
      sessionId
    );
    await h.close(targetId);
    return { set, clearBrowser, clearStorage, afterRefuse, deletePlain, afterDelete };
  }, ordinary);
  assert.equal(answer.set.error, undefined, 'control setCookie');
  assert.match(answer.clearBrowser.error ?? '', /^slicc: refused: /, 'Network.clearBrowserCookies');
  assert.match(answer.clearStorage.error ?? '', /^slicc: refused: /, 'Storage.clearCookies');
  assert.ok(
    answer.afterRefuse.result.cookies.some((c) => c.name === 'c6plain'),
    'ordinary cookie survived the refused clears'
  );
  assert.equal(answer.deletePlain.error, undefined, 'control deleteCookies');
  assert.equal(
    answer.afterDelete.result.cookies.some((c) => c.name === 'c6plain'),
    false,
    'ordinary cookie cleared through deleteCookies'
  );
  assert.ok(
    await raw.evaluate(() => document.cookie.includes('c6clear')),
    'protected cookie untouched'
  );
});

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
            (e) =>
              (e.method === 'Target.targetCreated' || e.method === 'Target.targetInfoChanged') &&
              e.params.targetInfo.openerId === targetId
          )?.params.targetInfo
      );
      const popupInfo = (await h.cdp.send('Target.getTargetInfo', { targetId: popup.targetId }))
        .targetInfo;
      await h.sleep(800);
      await h.evaluate(
        sessionId,
        `window.w.location.href = ${JSON.stringify(`${vault}/became?k=SECRET`)}; true`
      );
      const destroyed = await h.until(async () =>
        h.events.find(
          (e) =>
            e.method === 'Target.targetInfoChanged' &&
            e.params.targetInfo.targetId === popup.targetId &&
            e.params.targetInfo.url.startsWith(vault)
        )
      );
      const popupDetached = await h.attempt('Target.attachToTarget', {
        targetId: popup.targetId,
        flatten: true,
      });
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
      const leaked = JSON.stringify(h.content(h.events)).includes('SECRET');
      await h.cdp.send('Target.setDiscoverTargets', { discover: false });
      return {
        version,
        blankInfo,
        created: Boolean(created),
        changed,
        popupInfo,
        targetId,
        destroyed: Boolean(destroyed),
        popupDetached,
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
  assert.equal(answer.destroyed, true, 'a tab that becomes protected is announced as protected');
  assert.equal(
    answer.popupDetached.error,
    "slicc: refused: target is on seven's origin",
    'and it can no longer be attached'
  );
  assert.equal(
    answer.refusedInfo.result.targetInfo.title,
    targets.vault,
    'its title is redacted to the origin'
  );
  assert.equal(
    answer.refusedInfo.result.targetInfo.url,
    targets.vault,
    'getTargetInfo shows the guard only the protected origin'
  );
  assert.equal(answer.listed, true, 'protected tabs stay listed as their origin');
  assert.equal(answer.distinct, true, 'each attach is its own session');
  assert.equal(answer.closedBoth, true, 'detachedFromTarget for every session on close');
  assert.equal(answer.gone, true, 'targetDestroyed on close');
  assert.equal(answer.leaked, false);
});

test('S7 sessions belong to their connection, each attach is its own session, and activateTarget focuses the tab', async (t) => {
  const page = await client(t);
  const other = await chrome.visit(t, slicc);
  const answer = await page.evaluate(async (ordinary) => {
    const { targetId, sessionId } = await h.open(`${ordinary}/start`);
    const second = await h.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const both = [
      await h.evaluate(sessionId, '1 + 1'),
      await h.evaluate(second.sessionId, '2 + 2'),
    ];
    const activated = await h.attempt('Target.activateTarget', { targetId });
    const active = (await h.cdp.send('Target.getTargets')).targetInfos.find(
      (i) => i.targetId === targetId
    )?.active;
    return { targetId, sessionId, second: second.sessionId, both, activated, active };
  }, ordinary);
  const stolen = await other.evaluate(
    async (sid) =>
      globalThis.sliccExtension.cdp
        .send('Runtime.evaluate', { expression: '1', returnByValue: true }, sid)
        .then(
          () => 'ran',
          (e) => e.message
        ),
    answer.sessionId
  );
  await page.evaluate((id) => h.close(id), answer.targetId);
  assert.notEqual(answer.second, answer.sessionId);
  assert.deepEqual(answer.both, [2, 4]);
  assert.equal(answer.activated.error, undefined);
  assert.equal(answer.active, true);
  assert.match(stolen, /No tab attached/, 'another connection cannot use the session');
});

test('S7 createTarget refuses blob: and view-source: URLs over seven and the vault', async (t) => {
  const page = await client(t);
  const answer = await page.evaluate(async () => {
    const out = {};
    for (const url of [
      'blob:https://vault.sliccy.ai/abc',
      'view-source:https://vault.sliccy.ai/',
      'blob:https://seven.sliccy.ai/xyz',
      'view-source:https://seven.sliccy.ai/page',
      'https://sliccy.ai/',
    ]) {
      out[url] = (await h.attempt('Target.createTarget', { url })).error ?? 'created';
    }
    return out;
  });
  for (const [url, error] of Object.entries(answer)) {
    assert.equal(error, "slicc: refused: target is on seven's origin", url);
  }
});

for (const transport of transports) {
  const oneSession =
    transport === 'six-bridge' &&
    "six's bridge answers a repeat Target.attachToTarget on a tab with the same refcounted session, so one tab never holds two sessions";
  test(`${transport} C5 two sessions with Fetch on one tab both see an ordinary request in turn; a protected request reaches neither`, {
    skip: oneSession,
  }, async (t) => {
    const page = await client(t, transport);
    const answer = await page.evaluate(async (ordinary) => {
      const { targetId, sessionId } = await h.open(`${ordinary}/start`);
      const second = (await h.cdp.send('Target.attachToTarget', { targetId, flatten: true }))
        .sessionId;
      const seen = [];
      const off = h.cdp.on((e) => {
        if (e.method !== 'Fetch.requestPaused') return;
        seen.push([e.sessionId === sessionId ? 'first' : 'second', e.params.request.url]);
        h.attempt('Fetch.continueRequest', { requestId: e.params.requestId }, e.sessionId);
      });
      await h.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/data*' }] }, sessionId);
      await h.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/data*' }] }, second);
      const plain = await h.evaluate(
        sessionId,
        `fetch('${ordinary}/data?n=plain').then((r) => r.status, () => 'error')`
      );
      const guarded = await h.evaluate(
        sessionId,
        "fetch('https://vault.sliccy.ai/data?n=vault', { mode: 'no-cors' }).then((r) => r.type, () => 'error')"
      );
      off();
      await h.close(targetId);
      return { plain, guarded, seen };
    }, ordinary);
    assert.equal(answer.plain, 200);
    assert.deepEqual(
      answer.seen.filter(([, url]) => url.includes('n=plain')).map(([who]) => who),
      ['first', 'second'],
      'the request reaches each session in attach order'
    );
    assert.deepEqual(
      answer.seen.filter(([, url]) => url.includes('vault')),
      [],
      'the protected request is continued by the backend'
    );
    assert.notEqual(answer.guarded, 'error');
  });
}

for (const transport of transports) {
  test(`${transport} C5 Network events and bodies of protected requests never reach the client; ordinary ones do`, async (t) => {
    const page = await client(t, transport);
    const answer = await page.evaluate(async (ordinary) => {
      const { targetId, sessionId } = await h.open(`${ordinary}/start`);
      await h.cdp.send('Network.enable', {}, sessionId);
      const mark = h.events.length;
      await h.evaluate(
        sessionId,
        `fetch('${ordinary}/hello?n=plain').then((r) => r.text(), () => 'error')`
      );
      await h.evaluate(
        sessionId,
        "fetch('https://vault.sliccy.ai/secret?n=vault', { mode: 'no-cors' }).then(() => 'ok', () => 'error')"
      );
      await h.sleep(500);
      const net = h.events.slice(mark).filter((e) => e.method.startsWith('Network.'));
      const plain = net.find(
        (e) => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('n=plain')
      );
      const body = plain
        ? await h.attempt(
            'Network.getResponseBody',
            { requestId: plain.params.requestId },
            sessionId
          )
        : { error: 'no plain request' };
      const unseen = await h.attempt(
        'Network.getResponseBody',
        { requestId: 'never-seen' },
        sessionId
      );
      await h.close(targetId);
      return {
        plain: Boolean(plain),
        body,
        unseen,
        leaked: net.filter((e) => JSON.stringify(e).includes('vault.sliccy.ai')).length,
      };
    }, ordinary);
    assert.equal(answer.plain, true, 'the ordinary request is visible');
    assert.equal(answer.body.error, undefined, 'its body can be read');
    assert.match(answer.unseen.error, /^slicc: refused: /);
    assert.equal(answer.leaked, 0, 'no Network event mentions the vault');
  });
}

for (const transport of transports) {
  test(`${transport} C5 an answered pause cannot be answered again, and a pause Chrome dropped cannot be answered`, async (t) => {
    const page = await client(t, transport);
    const answer = await page.evaluate(async (ordinary) => {
      const { targetId, sessionId } = await h.open(`${ordinary}/start`);
      const paused = [];
      const off = h.cdp.on((e) => {
        if (e.method === 'Fetch.requestPaused' && e.sessionId === sessionId) paused.push(e.params);
      });
      await h.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/data*' }] }, sessionId);
      const pausedFor = (n) =>
        h.until(async () => paused.find((p) => p.request.url.includes(`n=${n}`)));
      const fetchIn = (n) =>
        h.evaluate(
          sessionId,
          `window.__r${n} = fetch('${ordinary}/data?n=${n}').then((r) => r.text(), () => 'error'); true`
        );
      const result = (n) => h.evaluate(sessionId, `window.__r${n}`);
      await fetchIn('continue');
      const first = await pausedFor('continue');
      const control = await h.attempt(
        'Fetch.continueRequest',
        { requestId: first.requestId },
        sessionId
      );
      const again = await h.attempt(
        'Fetch.continueRequest',
        { requestId: first.requestId },
        sessionId
      );
      const thenFulfill = await h.attempt(
        'Fetch.fulfillRequest',
        { requestId: first.requestId, responseCode: 200, body: btoa('late') },
        sessionId
      );
      const continued = await result('continue');
      await fetchIn('fulfill');
      const second = await pausedFor('fulfill');
      const fulfilled = await h.attempt(
        'Fetch.fulfillRequest',
        {
          requestId: second.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'access-control-allow-origin', value: '*' }],
          body: btoa('fulfilled-once'),
        },
        sessionId
      );
      const refulfilled = await h.attempt(
        'Fetch.fulfillRequest',
        { requestId: second.requestId, responseCode: 200, body: btoa('twice') },
        sessionId
      );
      const failed = await h.attempt(
        'Fetch.failRequest',
        { requestId: second.requestId, errorReason: 'Failed' },
        sessionId
      );
      const body = await result('fulfill');
      await h.evaluate(
        sessionId,
        `window.__abort = new AbortController(); window.__rdropped = fetch('${ordinary}/data?n=dropped', { signal: window.__abort.signal }).then((r) => r.text(), (e) => 'aborted'); true`
      );
      const third = await pausedFor('dropped');
      await h.evaluate(sessionId, 'window.__abort.abort(); true');
      await h.sleep(1000);
      const dropped = await h.attempt(
        'Fetch.continueRequest',
        { requestId: third.requestId },
        sessionId
      );
      const alive = await h.evaluate(sessionId, '1 + 1');
      off();
      await h.close(targetId);
      return {
        control,
        again,
        thenFulfill,
        continued,
        fulfilled,
        refulfilled,
        failed,
        body,
        dropped,
        alive,
      };
    }, ordinary);
    assert.equal(answer.control.error, undefined, 'control: the first continue works');
    assert.equal(answer.continued, 'real-continue', 'control: the continued request completes');
    assert.match(answer.again.error ?? '', /^slicc: refused: /, 'a second continue is refused');
    assert.match(
      answer.thenFulfill.error ?? '',
      /^slicc: refused: /,
      'a fulfill after continue is refused'
    );
    assert.equal(answer.fulfilled.error, undefined, 'control: the first fulfill works');
    assert.equal(answer.body, 'fulfilled-once', 'control: the fulfilled body arrives once');
    assert.match(
      answer.refulfilled.error ?? '',
      /^slicc: refused: /,
      'a second fulfill is refused'
    );
    assert.match(answer.failed.error ?? '', /^slicc: refused: /, 'a fail after fulfill is refused');
    assert.match(
      answer.dropped.error ?? '',
      /^slicc: refused: /,
      'a pause Chrome dropped is refused'
    );
    assert.equal(answer.alive, 2, 'the session still answers');
  });
}

const unparseable = "slicc: refused: slicc can't parse this URL, so it could be a protected page";

for (const transport of transports) {
  test(`${transport} C8.unparseable: cookie commands naming a URL that does not parse are refused; the same commands work on an ordinary URL`, async (t) => {
    const raw = await chrome.visit(t, `${targets.seven}/cookie?name=c8unparse`);
    assert.ok(
      await raw.evaluate(() => document.cookie.includes('c8unparse')),
      'protected cookie planted'
    );
    const page = await client(t, transport);
    const answer = await page.evaluate(
      async ({ ordinary, seven }) => {
        const { targetId, sessionId } = await h.open(`${ordinary}/start`);
        const bad = [
          'https://exa%20mple.sliccy.ai/',
          'https://exa mple.sliccy.ai/',
          'http://[::1/',
        ];
        const refused = {};
        for (const url of bad) {
          for (const [method, params] of [
            ['Network.getCookies', { urls: [url] }],
            ['Network.getCookies', { urls: [`${ordinary}/`, url] }],
            ['Network.setCookie', { name: 'c8bad', value: 'x', url }],
            ['Network.setCookies', { cookies: [{ name: 'c8bad', value: 'x', url }] }],
            ['Network.deleteCookies', { name: 'c8unparse', url }],
            ['Storage.setCookies', { cookies: [{ name: 'c8bad', value: 'x', url }] }],
          ]) {
            refused[`${method} ${JSON.stringify(params)}`] = await h.attempt(
              method,
              params,
              sessionId
            );
          }
        }
        const control = {
          set: await h.attempt(
            'Network.setCookie',
            { name: 'c8plain', value: 'ok', url: `${ordinary}/` },
            sessionId
          ),
          read: await h.attempt('Network.getCookies', { urls: [`${ordinary}/`] }, sessionId),
          seven: await h.attempt('Network.getCookies', { urls: [`${seven}/`] }, sessionId),
          empty: await h.attempt('Network.getCookies', { urls: [''] }, sessionId),
          remove: await h.attempt(
            'Network.deleteCookies',
            { name: 'c8plain', url: `${ordinary}/` },
            sessionId
          ),
          after: await h.attempt('Network.getCookies', { urls: [`${ordinary}/`] }, sessionId),
        };
        await h.close(targetId);
        return { refused, control };
      },
      { ordinary, seven: targets.seven }
    );
    for (const [key, value] of Object.entries(answer.refused)) {
      assert.equal(value.error, unparseable, key);
    }
    assert.equal(answer.control.set.error, undefined, 'control setCookie');
    assert.ok(
      answer.control.read.result.cookies.some((c) => c.name === 'c8plain'),
      'control getCookies reads the ordinary cookie'
    );
    assert.equal(answer.control.seven.error, undefined, 'a protected URL that parses is answered');
    assert.equal(
      answer.control.seven.result.cookies.some((c) => c.name === 'c8unparse'),
      false,
      'the protected cookie is dropped from a parsed protected URL'
    );
    assert.equal(answer.control.empty.error, undefined, 'the empty URL stays exempt');
    assert.equal(answer.control.remove.error, undefined, 'control deleteCookies');
    assert.equal(
      answer.control.after.result.cookies.some((c) => c.name === 'c8plain'),
      false,
      'control deleteCookies removed the ordinary cookie'
    );
    assert.ok(
      await raw.evaluate(() => document.cookie.includes('c8unparse')),
      'protected cookie untouched'
    );
  });
}

for (const transport of transports) {
  test(`${transport} C8.unparseable: creating or navigating to a URL that does not parse cleanly is refused; an ordinary URL opens`, async (t) => {
    const page = await client(t, transport);
    const answer = await page.evaluate(async (ordinary) => {
      const { targetId, sessionId } = await h.open(`${ordinary}/start`);
      const bad = [
        'https://exa%20mple.other.test/',
        'https://exa mple.other.test/',
        'https://exa%20mple.sliccy.ai/',
        'http://\u200d.other.test/',
        'view-source:https://exa%20mple.other.test/',
      ];
      const refused = {};
      for (const url of bad) {
        refused[`create ${url}`] = await h.attempt('Target.createTarget', { url });
        refused[`navigate ${url}`] = await h.attempt('Page.navigate', { url }, sessionId);
      }
      const created = await h.attempt('Target.createTarget', { url: `${ordinary}/start?c8` });
      const navigated = await h.attempt(
        'Page.navigate',
        { url: `${ordinary}/start?c8n` },
        sessionId
      );
      const blank = await h.attempt('Target.createTarget', { url: '' });
      for (const id of [created.result?.targetId, blank.result?.targetId, targetId]) {
        if (id) await h.close(id);
      }
      return { refused, created, navigated, blank };
    }, ordinary);
    for (const [key, value] of Object.entries(answer.refused)) {
      assert.equal(value.error, unparseable, key);
    }
    assert.match(String(answer.created.result?.targetId), /./, 'control: an ordinary target opens');
    assert.equal(answer.navigated.error, undefined, 'control: an ordinary navigation runs');
    assert.match(String(answer.blank.result?.targetId), /./, 'the empty URL stays exempt');
  });
}
