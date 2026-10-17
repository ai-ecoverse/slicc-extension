import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

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
        return {
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
    if (run.discover.result) {
      assert.ok(
        run.discovered.some((info) => info.url === control),
        'control: discovery announces the ordinary page'
      );
    }
    for (const answer of [run.uiInfo, run.uiInfoOnSession]) {
      assert.equal(answer.result, undefined, 'Target.getTargetInfo reveals no browser_ui target');
      assert.ok(answer.error, 'Target.getTargetInfo of a browser_ui target fails');
    }
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
        const { targetInfos } = await h.cdp.send('Target.getTargets', {});
        const mine = targetInfos.filter((info) => info.url.startsWith(prefix));
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
