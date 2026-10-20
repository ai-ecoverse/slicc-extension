import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId, openExtensionPage } from './extension-page.mjs';

const vectors = JSON.parse(
  await readFile(
    new URL('../../node_modules/@ai-ecoverse/slicc-browsers/guard-vectors.json', import.meta.url)
  )
);
const row = (id) => vectors.vectors.find((vector) => vector.id === id);
const urls = {
  ...Object.fromEntries(
    Object.entries(vectors.targets)
      .filter(([, target]) => typeof target.url === 'string')
      .map(([name, target]) => [name, target.url])
  ),
  'own-extension-page': `chrome-extension://${extId}/secrets.html`,
};
const targetsOf = (id, own = true) => [...row(id).targets, ...(own ? ['own-extension-page'] : [])];

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const ordinary = 'https://ordinary.test';
const transports = ['seven', 'six-bridge'];
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
let counter = 0;

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

function tagged(label) {
  counter += 1;
  return `${ordinary}/doc?n=${label}-${Date.now()}-${counter}`;
}

async function rawTargets() {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  return targetInfos;
}

async function rawShows(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = (await rawTargets()).find(predicate);
    if (found || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function rawNavigates(page, url) {
  const tab = await page.tab();
  try {
    await tab.send('Page.navigate', { url });
    const deadline = Date.now() + 5000;
    for (;;) {
      const { targetInfo } = await tab.send('Target.getTargetInfo');
      if (targetInfo.url.startsWith(url)) return true;
      if (Date.now() > deadline) return targetInfo.url;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await tab.close().catch(() => undefined);
  }
}

async function rawCreates(url) {
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url });
  const shown = await rawShows((info) => info.targetId === targetId && info.url.startsWith(url));
  await chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
  return Boolean(shown);
}

async function browserUi() {
  const found = await rawShows((info) => info.type === 'browser_ui');
  assert.ok(found, 'live: the runner sees a browser_ui target');
  return found;
}

function navigateThroughGuard(page, start, control, target) {
  return page.evaluate(
    async ({ start, control, target }) => {
      const { targetId, sessionId } = await h.open(start);
      const before = await h.evaluate(sessionId, 'location.href');
      const guarded = await h.attempt('Page.navigate', { url: target }, sessionId);
      await h.sleep(2000);
      const stayed = await h.evaluate(sessionId, 'location.href');
      const allowed = await h.attempt('Page.navigate', { url: control }, sessionId);
      const landed = control.startsWith('view-source:')
        ? undefined
        : await h.until(async () => {
            const href = await h.evaluate(sessionId, 'location.href');
            return href === control ? href : undefined;
          });
      return { targetId, sessionId, before, guarded, stayed, allowed, landed };
    },
    { start, control, target }
  );
}

for (const transport of transports) {
  for (const name of targetsOf('C8.navigate')) {
    test(`${transport} C8.navigate ${name}: refused through the guard, an ordinary page navigates`, async (t) => {
      const page = await client(t, transport);
      const target = urls[name];
      const start = tagged('c8-nav');
      const control = tagged('c8-nav-control');
      const run = await navigateThroughGuard(page, start, control, target);
      assert.equal(run.before, start, 'the client page loaded');
      assert.match(String(run.guarded.error), /refused/, `Page.navigate ${target} is refused`);
      assert.equal(run.stayed, start, `the tab never committed ${target}`);
      assert.ok(run.allowed.result, `control: Page.navigate ${control} runs through the guard`);
      assert.equal(run.landed, control, 'control: the ordinary page committed');
      assert.equal(
        await rawNavigates(page, target),
        true,
        `live: ${target} loads without the guard`
      );
      await page.evaluate((id) => h.close(id), run.targetId);
    });
  }

  for (const name of targetsOf('C8.view-source')) {
    test(`${transport} C8.view-source ${name}: refused through the guard, view-source of an ordinary page navigates`, async (t) => {
      const page = await client(t, transport);
      const target = `view-source:${urls[name]}`;
      const start = tagged('c8-vs');
      const plain = tagged('c8-vs-control');
      const control = `view-source:${plain}`;
      const run = await navigateThroughGuard(page, start, control, target);
      assert.equal(run.before, start, 'the client page loaded');
      assert.match(String(run.guarded.error), /refused/, `Page.navigate ${target} is refused`);
      assert.equal(run.stayed, start, `the tab never committed ${target}`);
      assert.ok(run.allowed.result, `control: Page.navigate ${control} runs through the guard`);
      assert.ok(
        await rawShows((info) => info.url === control),
        'control: the tab committed view-source of the ordinary page'
      );
      assert.equal(
        await rawNavigates(page, target),
        true,
        `live: ${target} loads without the guard`
      );
      await page.evaluate((id) => h.close(id), run.targetId);
    });
  }

  for (const name of [...targetsOf('C8.create'), 'chrome-extension-page', 'file-root']) {
    test(`${transport} C8.create ${name}: Target.createTarget is refused, an ordinary page opens`, async (t) => {
      const page = await client(t, transport);
      const target = urls[name];
      const control = tagged('c8-create-control');
      const run = await page.evaluate(
        async ({ target, control }) => ({
          guarded: await h.attempt('Target.createTarget', { url: target }),
          allowed: await h.attempt('Target.createTarget', { url: control }),
        }),
        { target, control }
      );
      assert.match(
        String(run.guarded.error),
        /refused/,
        `Target.createTarget ${target} is refused`
      );
      assert.equal(run.guarded.result, undefined, 'no target id comes back');
      assert.match(String(run.allowed.result?.targetId), /./, 'control: an ordinary target opens');
      assert.ok(await rawShows((info) => info.url === control), 'control: the ordinary tab exists');
      assert.equal(await rawCreates(target), true, `live: ${target} opens without the guard`);
      await page.evaluate((id) => h.close(id), run.allowed.result.targetId);
    });
  }

  test(`${transport} C8.browser-ui-listed: getTargets, getTargetInfo and discovery hide browser_ui, an ordinary page is listed`, async (t) => {
    const page = await client(t, transport);
    const ui = await browserUi();
    const uiUrls = (await rawTargets())
      .filter((info) => info.type === 'browser_ui')
      .map((info) => info.url);
    const control = tagged('c8-listed-control');
    const run = await page.evaluate(
      async ({ control, uiId }) => {
        const { targetId, sessionId } = await h.open(control);
        const listed = await h.attempt('Target.getTargets', {});
        const before = h.events.length;
        const discover = await h.attempt('Target.setDiscoverTargets', { discover: true });
        await h.sleep(500);
        const discovered = h.events
          .slice(before)
          .filter((event) => event.method.startsWith('Target.'))
          .map((event) => event.params?.targetInfo ?? {});
        await h.attempt('Target.setDiscoverTargets', { discover: false });
        const sessionBefore = h.events.length;
        const discoverOnSession = await h.attempt(
          'Target.setDiscoverTargets',
          { discover: true },
          sessionId
        );
        await h.sleep(500);
        const discoveredOnSession = h.events
          .slice(sessionBefore)
          .filter((event) => event.method.startsWith('Target.'))
          .map((event) => event.params?.targetInfo ?? {});
        await h.attempt('Target.setDiscoverTargets', { discover: false }, sessionId);
        return {
          discoverOnSession,
          discoveredOnSession,
          targetId,
          listed: listed.result?.targetInfos ?? [],
          listError: listed.error,
          discover,
          discovered,
          uiInfo: await h.attempt('Target.getTargetInfo', { targetId: uiId }),
          uiInfoOnSession: await h.attempt('Target.getTargetInfo', { targetId: uiId }, sessionId),
          ownInfo: await h.attempt('Target.getTargetInfo', { targetId }),
          ownInfoOnSession: await h.attempt('Target.getTargetInfo', {}, sessionId),
        };
      },
      { control, uiId: ui.targetId }
    );
    const hidden = (info) =>
      info.type !== 'browser_ui' && info.targetId !== ui.targetId && !uiUrls.includes(info.url);
    assert.equal(run.listError, undefined, 'Target.getTargets answers');
    assert.ok(run.listed.every(hidden), 'Target.getTargets lists no browser_ui target');
    assert.ok(
      run.listed.some((info) => info.targetId === run.targetId && info.url === control),
      'control: Target.getTargets lists the ordinary page'
    );
    assert.ok(run.discovered.every(hidden), 'discovery announces no browser_ui target');
    assert.ok(run.discoveredOnSession.every(hidden), 'session discovery announces no browser_ui');
    if (transport === 'seven') {
      assert.deepEqual(run.discover.result, {}, 'seven runs target discovery');
      assert.ok(
        run.discovered.some((info) => info.url === control),
        'control: discovery announces the ordinary page'
      );
      assert.deepEqual(run.discoverOnSession.result, {}, 'seven runs discovery from a session too');
    } else {
      assert.match(
        String(run.discover.error),
        /^slicc: refused: /,
        'six refuses browser-wide discovery, so it has nothing to announce'
      );
      assert.ok(run.discoverOnSession.error, 'six has no discovery on a page session either');
      assert.deepEqual(run.discovered, [], 'six announced nothing');
    }
    assert.match(
      String(run.uiInfo.error),
      /^slicc: refused: Invalid targetId: [0-9A-F]+ is not a tab$/,
      'the guard itself refuses Target.getTargetInfo of the browser_ui target'
    );
    assert.equal(run.uiInfo.result, undefined, 'Target.getTargetInfo reveals no browser_ui target');
    assert.match(
      String(run.uiInfoOnSession.error),
      transport === 'seven'
        ? /^slicc: refused: Invalid targetId: [0-9A-F]+ is not a tab$/
        : /^slicc: refused: Target.getTargetInfo of another target is not supported/,
      'the guard itself refuses Target.getTargetInfo of the browser_ui target on a session'
    );
    assert.equal(run.uiInfoOnSession.result, undefined, 'nothing about it comes back');
    const own = transport === 'seven' ? run.ownInfo : run.ownInfoOnSession;
    assert.equal(own.result?.targetInfo?.url, control, 'control: the ordinary target is described');
    await page.evaluate((id) => h.close(id), run.targetId);
  });

  test(`${transport} C8.browser-ui-attach: attaching a browser_ui target is refused, an ordinary page attaches`, async (t) => {
    const page = await client(t, transport);
    const ui = await browserUi();
    const control = tagged('c8-attach-control');
    const run = await page.evaluate(
      async ({ control, uiId }) => {
        const { targetId } = await h.cdp.send('Target.createTarget', { url: control });
        return {
          targetId,
          guarded: await h.attempt('Target.attachToTarget', { targetId: uiId, flatten: true }),
          allowed: await h.attempt('Target.attachToTarget', { targetId, flatten: true }),
        };
      },
      { control, uiId: ui.targetId }
    );
    assert.match(String(run.guarded.error), /refused/, 'attaching a browser_ui target is refused');
    assert.equal(run.guarded.result, undefined, 'no session comes back');
    assert.match(String(run.allowed.result?.sessionId), /./, 'control: the ordinary page attaches');
    const live = await chrome.cdp.send('Target.attachToTarget', {
      targetId: ui.targetId,
      flatten: true,
    });
    assert.match(
      String(live.sessionId),
      /./,
      'live: the browser_ui target attaches without the guard'
    );
    await chrome.cdp.send('Target.detachFromTarget', { sessionId: live.sessionId });
    await page.evaluate((id) => h.close(id), run.targetId);
  });

  test(`${transport} the extension's own pages are refused for attach, an ordinary page attaches`, async (t) => {
    const page = await client(t, transport);
    const own = await chrome.cdp.send('Target.createTarget', { url: urls['own-extension-page'] });
    assert.ok(
      await rawShows(
        (info) => info.targetId === own.targetId && info.url === urls['own-extension-page']
      ),
      'live: the extension page opens'
    );
    const control = tagged('c8-own-control');
    const run = await page.evaluate(
      async ({ control, prefix }) => {
        const { targetId } = await h.cdp.send('Target.createTarget', { url: control });
        let targetInfos = [];
        const mine =
          (await h.until(async () => {
            targetInfos = (await h.cdp.send('Target.getTargets', {})).targetInfos;
            const hits = targetInfos.filter((info) => info.url.startsWith(prefix));
            return hits.length > 0 ? hits : undefined;
          }, 5000)) ?? [];
        const refused = [];
        for (const info of mine) {
          refused.push(
            await h.attempt('Target.attachToTarget', { targetId: info.targetId, flatten: true })
          );
        }
        return {
          targetId,
          urls: targetInfos.map((info) => info.url),
          mine: mine.length,
          refused,
          allowed: await h.attempt('Target.attachToTarget', { targetId, flatten: true }),
        };
      },
      { control, prefix: `chrome-extension://${extId}` }
    );
    assert.ok(run.mine > 0, `the guard lists the extension page as a tab: ${run.urls}`);
    for (const answer of run.refused) {
      assert.match(String(answer.error), /refused/, 'attaching the extension page is refused');
    }
    assert.match(String(run.allowed.result?.sessionId), /./, 'control: the ordinary page attaches');
    await chrome.cdp.send('Target.closeTarget', { targetId: own.targetId }).catch(() => undefined);
    await page.evaluate((id) => h.close(id), run.targetId);
  });
}

const ownPrefix = `chrome-extension://${extId}/`;
const relatives = {
  'root-relative capture popup': [
    '/capture-popup.html?req=x',
    `${ownPrefix}capture-popup.html?req=x`,
  ],
  'protocol-relative secrets page': [`//${extId}/secrets.html`, `${ownPrefix}secrets.html`],
  'path-relative secrets page': ['secrets.html', `${ownPrefix}secrets.html`],
};
const variants = {
  'about: alias': ['about:settings', /^chrome:\/\/settings\/ Settings$/],
  'upper case': ['CHROME://SETTINGS/', /^chrome:\/\/settings\/ Settings$/],
  'trailing dot': ['chrome://settings./', /^chrome:\/\/settings\.\/ /],
};

async function liveTabsCreate(t, url) {
  const ext = await openExtensionPage(await chrome.visit(t, entry.seven), 'secrets.html');
  try {
    return await ext.evaluate(`(async () => {
      const tab = await chrome.tabs.create({ url: ${JSON.stringify(url)}, active: false });
      const deadline = Date.now() + 5000;
      let seen = tab;
      while (!(seen.status === 'complete' && seen.url) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        seen = await chrome.tabs.get(tab.id);
      }
      await chrome.tabs.remove(tab.id).catch(() => undefined);
      return { url: seen.url, title: seen.title };
    })()`);
  } finally {
    await ext.close();
  }
}

async function ownTabs() {
  return (await rawTargets()).filter((info) => info.url.startsWith(ownPrefix));
}

for (const transport of transports) {
  for (const [name, [url, resolved]] of Object.entries(relatives)) {
    test(`${transport} P1-1 createTarget ${name}: refused, nothing of ours opens, an ordinary page opens`, async (t) => {
      const page = await client(t, transport);
      const before = (await ownTabs()).length;
      const control = tagged('p11-create-control');
      const run = await page.evaluate(
        async ({ url, control }) => ({
          tab: await h.attempt('Target.createTarget', { url }),
          window: await h.attempt('Target.createTarget', { url, newWindow: true }),
          allowed: await h.attempt('Target.createTarget', { url: control }),
        }),
        { url, control }
      );
      for (const answer of [run.tab, run.window]) {
        assert.match(String(answer.error), /^slicc: refused: a relative url/, `${url} is refused`);
        assert.equal(answer.result, undefined, 'no target id comes back');
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal((await ownTabs()).length, before, 'no page of the extension opened');
      assert.match(String(run.allowed.result?.targetId), /./, 'control: an ordinary target opens');
      assert.ok(await rawShows((info) => info.url === control), 'control: the ordinary tab exists');
      assert.equal(
        (await liveTabsCreate(t, url)).url,
        resolved,
        `live: chrome.tabs.create resolves ${url} to our own page`
      );
      await page.evaluate((id) => h.close(id), run.allowed.result.targetId);
    });

    test(`${transport} P1-1 Page.navigate ${name}: refused, an ordinary page navigates`, async (t) => {
      const page = await client(t, transport);
      const start = tagged('p11-nav');
      const control = tagged('p11-nav-control');
      const run = await navigateThroughGuard(page, start, control, url);
      assert.equal(run.before, start, 'the client page loaded');
      assert.match(String(run.guarded.error), /^slicc: refused: a relative url/, `${url} refused`);
      assert.equal(run.stayed, start, 'the tab stayed');
      assert.ok(run.allowed.result, 'control: Page.navigate of an ordinary page runs');
      assert.equal(run.landed, control, 'control: the ordinary page committed');
      await page.evaluate((id) => h.close(id), run.targetId);
    });
  }

  for (const [name, [url, landed]] of Object.entries(variants)) {
    test(`${transport} C8 ${name} ${url}: create and navigate are refused, an ordinary page passes`, async (t) => {
      const page = await client(t, transport);
      const control = tagged('c8-variant-control');
      const created = await page.evaluate(
        async ({ url, control }) => ({
          guarded: await h.attempt('Target.createTarget', { url }),
          allowed: await h.attempt('Target.createTarget', { url: control }),
        }),
        { url, control }
      );
      assert.match(String(created.guarded.error), /refused/, `Target.createTarget ${url} refused`);
      assert.equal(created.guarded.result, undefined, 'no target id comes back');
      assert.match(String(created.allowed.result?.targetId), /./, 'control: an ordinary target');
      const start = tagged('c8-variant-nav');
      const navControl = tagged('c8-variant-nav-control');
      const run = await navigateThroughGuard(page, start, navControl, url);
      assert.match(String(run.guarded.error), /refused/, `Page.navigate ${url} refused`);
      assert.equal(run.stayed, start, `the tab never committed ${url}`);
      assert.equal(run.landed, navControl, 'control: the ordinary page committed');
      const live = await liveTabsCreate(t, url);
      assert.match(
        `${live.url} ${live.title}`,
        landed,
        `live: chrome.tabs.create of ${url} opens a chrome: page: ${JSON.stringify(live)}`
      );
      await page.evaluate((id) => h.close(id), run.targetId);
      await page.evaluate((id) => h.close(id), created.allowed.result.targetId);
    });
  }

  test(`${transport} P1-2 closeTarget and getWindowForTarget refuse loose ids and protected tabs, an ordinary page closes`, async (t) => {
    const page = await client(t, transport);
    const secrets = await chrome.cdp.send('Target.createTarget', {
      url: `${ownPrefix}secrets.html`,
    });
    const settings = await chrome.cdp.send('Target.createTarget', { url: urls['chrome-settings'] });
    await rawShows((info) => info.targetId === secrets.targetId && info.url.startsWith(ownPrefix));
    await rawShows((info) => info.targetId === settings.targetId && info.url.startsWith('chrome:'));
    const control = tagged('p12-control');
    const methods =
      transport === 'seven'
        ? ['Target.closeTarget', 'Target.activateTarget']
        : ['Target.closeTarget', 'Browser.getWindowForTarget'];
    const run = await page.evaluate(
      async ({ control, extOrigin, methods }) => {
        let listed = [];
        const ids = await h.until(async () => {
          const { targetInfos } = await h.cdp.send('Target.getTargets', {});
          listed = targetInfos.map((info) => info.url);
          const found = targetInfos
            .filter(
              (info) => info.url.startsWith(extOrigin) || info.url.startsWith('chrome://settings')
            )
            .map((info) => info.targetId);
          return found.length >= 2 ? found : undefined;
        }, 5000);
        const answers = [];
        for (const id of ids) {
          for (const targetId of [id, `${id}zz`, ` ${id}`]) {
            for (const method of methods) {
              answers.push({ method, targetId, answer: await h.attempt(method, { targetId }) });
            }
          }
        }
        const { targetId } = await h.cdp.send('Target.createTarget', { url: control });
        await h.sleep(500);
        return {
          ids: ids ?? [],
          listed,
          answers,
          targetId,
          window: await h.attempt('Browser.getWindowForTarget', { targetId }),
          closed: await h.attempt('Target.closeTarget', { targetId }),
        };
      },
      { control, extOrigin: `chrome-extension://${extId}`, methods }
    );
    assert.ok(run.ids.length >= 2, `the guard lists both protected tabs: ${run.listed}`);
    for (const { method, targetId, answer } of run.answers) {
      assert.match(
        String(answer.error),
        /refused/,
        `${method} ${JSON.stringify(targetId)} is refused`
      );
      assert.equal(
        answer.result,
        undefined,
        `${method} ${JSON.stringify(targetId)} answers nothing`
      );
    }
    const live = (await rawTargets()).map((info) => info.targetId);
    assert.ok(live.includes(secrets.targetId), 'live: the secrets page is still open');
    assert.ok(live.includes(settings.targetId), 'live: chrome://settings is still open');
    if (transport === 'six-bridge') {
      assert.equal(typeof run.window.result?.windowId, 'number', 'control: the window is found');
    }
    assert.deepEqual(run.closed.result, { success: true }, 'control: the ordinary tab closes');
    assert.equal(
      await rawShows((info) => info.url === control, 1000),
      undefined,
      'control: the ordinary tab is gone'
    );
    for (const { targetId } of [secrets, settings]) {
      await chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
  });

  test(`${transport} P2 listing: protected tabs are listed by origin only, an ordinary page in full`, async (t) => {
    const page = await client(t, transport);
    const opened = [];
    for (const url of [
      `${ownPrefix}capture-popup.html?req=private`,
      'chrome://history/?q=private-search',
    ]) {
      const { targetId } = await chrome.cdp.send('Target.createTarget', { url });
      opened.push(targetId);
      assert.ok(
        await rawShows((info) => info.targetId === targetId && info.url.includes('private')),
        `live: ${url} is open with its full url`
      );
    }
    const control = tagged('p2-listing-control');
    const run = await page.evaluate(async (control) => {
      const { targetId } = await h.cdp.send('Target.createTarget', { url: control });
      await h.sleep(500);
      const { targetInfos } = await h.cdp.send('Target.getTargets', {});
      return { targetId, targetInfos };
    }, control);
    const leaked = run.targetInfos.filter((info) => /private/.test(`${info.url} ${info.title}`));
    assert.deepEqual(leaked, [], 'no listed url or title carries a privileged page path or query');
    assert.ok(
      run.targetInfos.some((info) => info.url === `chrome-extension://${extId}`),
      `the extension page is listed by its origin: ${run.targetInfos.map((i) => i.url)}`
    );
    assert.ok(
      run.targetInfos.some((info) => info.url === control),
      'control: the ordinary page is listed in full'
    );
    for (const targetId of opened) {
      await chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
    await page.evaluate((id) => h.close(id), run.targetId);
  });

  test(`${transport} P2 mentions: console text "File:", "Edge:" and "About:us" reaches the client, a protected url does not`, async (t) => {
    const page = await client(t, transport);
    const start = tagged('p2-mentions');
    const run = await page.evaluate(async (start) => {
      const { targetId, sessionId } = await h.open(start);
      await h.cdp.send('Runtime.enable', {}, sessionId);
      const before = h.events.length;
      for (const text of [
        'File:',
        'Edge:',
        'About:us',
        'File: report.pdf',
        'hello-control',
        'chrome://settings/passwords',
        'file:///etc/passwd',
      ]) {
        await h.cdp.send(
          'Runtime.evaluate',
          { expression: `console.log(${JSON.stringify(text)})` },
          sessionId
        );
      }
      await h.sleep(1000);
      const logged = h.events
        .slice(before)
        .filter((event) => event.method === 'Runtime.consoleAPICalled')
        .map((event) => event.params.args?.[0]?.value);
      return { targetId, logged };
    }, start);
    for (const text of ['File:', 'Edge:', 'About:us', 'File: report.pdf']) {
      assert.ok(run.logged.includes(text), `${text} reaches the client: ${run.logged}`);
    }
    assert.ok(run.logged.includes('hello-control'), 'control: plain text reaches the client');
    assert.ok(!run.logged.includes('chrome://settings/passwords'), 'a chrome: url is dropped');
    assert.ok(!run.logged.includes('file:///etc/passwd'), 'a file: url is dropped');
    await page.evaluate((id) => h.close(id), run.targetId);
  });

  test(`${transport} C8.newtab neighbours: only the new tab hosts are excepted, other chrome: and chrome-untrusted: hosts stay refused`, async (t) => {
    const page = await client(t, transport);
    const control = tagged('c8-newtab-neighbour-control');
    const run = await page.evaluate(
      async ({ control }) => {
        const answers = {};
        for (const url of [
          'chrome://new-tab-page.evil/',
          'chrome://newtab.evil/',
          'chrome-untrusted://other/',
          'chrome-untrusted://new-tab-page.evil/',
          'chrome://settings/',
          'chrome://history/',
        ]) {
          answers[url] = await h.attempt('Target.createTarget', { url });
        }
        return { answers, allowed: await h.attempt('Target.createTarget', { url: control }) };
      },
      { control }
    );
    for (const [url, answer] of Object.entries(run.answers)) {
      assert.match(String(answer.error), /refused/, `${url} is refused`);
      assert.equal(answer.result, undefined, `${url} opens nothing`);
    }
    assert.match(String(run.allowed.result?.targetId), /./, 'control: an ordinary page opens');
    await page.evaluate((id) => h.close(id), run.allowed.result.targetId);
  });
}

async function prefixRuns(base, url) {
  const { initScriptPrefix } = await import('../../extension/shield.js');
  const { protectedRules } = await import('../../extension/protected-rules.js');
  const tab = await base.tab();
  try {
    await tab.send('Page.enable');
    await tab.send('Page.navigate', { url });
    await tab.until((href) => location.href === href && document.readyState === 'complete', url);
    await tab.send('Runtime.evaluate', {
      expression:
        'new Promise((resolve) => { const f = document.createElement("iframe"); f.onload = () => resolve(true); document.body.append(f); })',
      awaitPromise: true,
    });
    const { frameTree } = await tab.send('Page.getFrameTree');
    const outcomes = {};
    for (const [name, frame] of [
      ['top', frameTree.frame],
      ['child', frameTree.childFrames?.[0]?.frame],
    ]) {
      const { executionContextId } = await tab.send('Page.createIsolatedWorld', {
        frameId: frame.id,
        worldName: `prefix-${name}`,
      });
      const answer = await tab.send('Runtime.evaluate', {
        expression: `${initScriptPrefix(protectedRules)}JSON.stringify({ ran: true, origin: self.origin, protocol: location.protocol })`,
        contextId: executionContextId,
        returnByValue: true,
      });
      outcomes[name] = answer.exceptionDetails
        ? String(answer.exceptionDetails.exception?.value ?? answer.exceptionDetails.text)
        : JSON.parse(answer.result.value);
    }
    return outcomes;
  } finally {
    await tab.close().catch(() => undefined);
  }
}

test('seven init-script prefix refuses an about:blank frame that inherits the extension origin, an ordinary one runs', async (t) => {
  const base = await chrome.visit(t, entry.seven);
  const own = await prefixRuns(base, `${ownPrefix}secrets.html`);
  assert.match(String(own.top), /slicc: refused/, 'the extension page itself is refused');
  assert.match(
    String(own.child),
    /slicc: refused/,
    `an about:blank child of the extension page is refused by self.origin: ${JSON.stringify(own.child)}`
  );
  const ordinary = await prefixRuns(base, tagged('prefix-control'));
  assert.deepEqual(
    ordinary.child,
    { ran: true, origin: 'https://ordinary.test', protocol: 'about:' },
    'control: an about:blank child of an ordinary page runs the script'
  );
  assert.equal(ordinary.top.ran, true, 'control: the ordinary page runs the script');
});
