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

const entry = {
  seven: 'https://seven.sliccy.ai/frames',
  'six-bridge': 'https://www.sliccy.ai/frames?slicc=leader',
};
const ordinary = 'https://ordinary.test/';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function worker() {
  let sessionId;
  const run = async (expression) => {
    const answer = await chrome.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
      15000
    );
    if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails));
    return answer.result.value;
  };
  for (let i = 0; i < 50; i++) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const found = targetInfos.find(
      (info) =>
        info.type === 'service_worker' && info.url.startsWith(`chrome-extension://${extId}/`)
    );
    if (found) {
      ({ sessionId } = await chrome.cdp.send('Target.attachToTarget', {
        targetId: found.targetId,
        flatten: true,
      }));
      const ready = await run('typeof chrome?.tabs?.query').catch(() => undefined);
      if (ready === 'function') return run;
      await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    }
    await sleep(200);
  }
  throw new Error('the extension service worker never offered chrome.tabs');
}

async function frames(page) {
  const first = await page.evaluate(() => globalThis.painted());
  await sleep(600);
  const second = await page.evaluate(() => globalThis.painted());
  return second - first;
}

async function rendering(page) {
  const first = await page.evaluate(() => globalThis.painted());
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const now = await page.evaluate(() => globalThis.painted());
    if (now > first) return now - first;
  }
  return 0;
}

function placement(sw, url) {
  return sw(`(async () => {
    const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(url)} });
    const [front] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    return { tabId: tab.id, active: tab.active, front: front?.id };
  })()`);
}

function raise(sw, tabId) {
  return sw(`(async () => {
    const tab = await chrome.tabs.update(${tabId}, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  })()`);
}

async function front(sw, page, url, label) {
  const where = await placement(sw, url);
  assert.equal(where.active, true, `${label}: seven's tab is still the active tab of its window`);
  assert.equal(where.front, where.tabId, `${label}: nothing else is in front in seven's window`);
  assert.equal(
    await page.evaluate(() => document.visibilityState),
    'visible',
    `${label}: seven's document stays visible`
  );
  const advanced = await rendering(page);
  assert.ok(advanced > 0, `${label}: seven keeps rendering (${advanced} frames)`);
}

function drive(page, method, params, sessionId) {
  return page.evaluate(
    async (method, params, sessionId) => {
      const answer = await Promise.race([
        h.attempt(method, params, sessionId),
        h.sleep(8000).then(() => ({ error: `${method} timed out` })),
      ]);
      if (answer.error) return answer;
      const { data, ...rest } = answer.result ?? {};
      return { result: typeof data === 'string' ? { ...rest, bytes: data.length } : rest };
    },
    method,
    params,
    sessionId
  );
}

async function ok(page, method, params, sessionId, label = '') {
  const answer = await drive(page, method, params, sessionId);
  assert.equal(answer.error, undefined, `${label} ${method}: ${answer.error}`);
  return answer.result;
}

async function step(page, method, params, sessionId, label, visible) {
  if (visible) return ok(page, method, params, sessionId, label);
  const answer = await drive(page, method, params, sessionId);
  assert.ok(
    answer.result || answer.error === `${method} timed out`,
    `${label} ${method}: ${answer.error}`
  );
  return answer.result;
}

async function exercise(sw, page, url, label, created, visible) {
  await front(sw, page, url, `${label} createTarget`);
  const { sessionId } = await ok(page, 'Target.attachToTarget', {
    targetId: created.targetId,
    flatten: true,
  });
  await front(sw, page, url, `${label} attach`);
  await ok(page, 'Page.enable', {}, sessionId, label);
  await page.evaluate((sessionId, target) => h.land(sessionId, target), sessionId, ordinary);
  await front(sw, page, url, `${label} navigate`);
  const evaluated = await page.evaluate(
    (sessionId) => h.evaluate(sessionId, 'location.href'),
    sessionId
  );
  assert.equal(evaluated, ordinary);
  await front(sw, page, url, `${label} evaluate`);
  const shot = await step(
    page,
    'Page.captureScreenshot',
    { format: 'png' },
    sessionId,
    label,
    visible
  );
  if (visible) assert.ok(shot.bytes > 0, `${label}: the screenshot has pixels`);
  await front(sw, page, url, `${label} captureScreenshot`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await step(
      page,
      'Input.dispatchMouseEvent',
      { type, x: 20, y: 20, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 },
      sessionId,
      label,
      visible
    );
  }
  const keys = [
    ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', text: 'a' }],
    ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'a' }],
    ['Input.insertText', { text: 'slicc' }],
  ];
  for (const [method, params] of keys) await step(page, method, params, sessionId, label, visible);
  await front(sw, page, url, `${label} input`);
  return sessionId;
}

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport}: driving tabs and windows never hides seven's tab, only an explicit activate does`, async (t) => {
    const url = `${entry[transport]}${entry[transport].includes('?') ? '&' : '?'}run=${Date.now()}`;
    const page = await chrome.visit(t, url);
    await page.evaluate(install, transport, extId);
    const sw = await worker();
    const opened = [];
    t.after(() =>
      sw(
        `Promise.allSettled(${JSON.stringify(opened.map(Number))}.map((id) => chrome.tabs.remove(id))).then(() => true)`
      )
    );
    const seven = await placement(sw, url);
    await raise(sw, seven.tabId);
    await front(sw, page, url, `${transport} control`);

    const tab = await ok(page, 'Target.createTarget', { url: 'about:blank' });
    opened.push(tab.targetId);
    const driven = await exercise(sw, page, url, `${transport} tab`, tab, false);

    const win = await ok(page, 'Target.createTarget', { url: 'about:blank', newWindow: true });
    opened.push(win.targetId);
    const unfocused = await sw(
      `chrome.tabs.get(${Number(win.targetId)}).then((tab) => chrome.windows.get(tab.windowId)).then((w) => w.focused)`
    );
    assert.equal(unfocused, false, `${transport}: the new window opens unfocused`);
    await exercise(sw, page, url, `${transport} window`, win, true);

    const explicit = [['Page.bringToFront', {}, driven]];
    if (transport === 'seven')
      explicit.unshift(['Target.activateTarget', { targetId: tab.targetId }]);
    for (const [method, params, sessionId] of explicit) {
      await raise(sw, seven.tabId);
      await front(sw, page, url, `${transport} before ${method}`);
      await ok(page, method, params, sessionId, transport);
      const after = await placement(sw, url);
      assert.equal(after.active, false, `${transport}: ${method} brings the driven tab forward`);
      assert.equal(after.front, Number(tab.targetId));
      await sleep(300);
      assert.equal(
        await frames(page),
        0,
        `${transport}: after ${method} a hidden seven stops rendering`
      );
    }
  });
}

async function landed(sw, target) {
  for (let i = 0; i < 50; i++) {
    const found = await sw(
      `chrome.tabs.query({}).then((tabs) => tabs.find((tab) => (tab.url || tab.pendingUrl) === ${JSON.stringify(target)})?.id ?? null)`
    );
    if (found !== null) return found;
    await sleep(200);
  }
  throw new Error(`${target} never opened`);
}

const popups = [
  ['window.open', (target) => `(window.open(${JSON.stringify(target)}), true)`],
  [
    'a target=_blank link',
    (target) =>
      `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(target)}; a.target = '_blank'; document.body.append(a); a.click(); return true; })()`,
  ],
  ['a popup window', (target) => `(window.open(${JSON.stringify(target)}, '', 'popup'), true)`],
  [
    'a popup window as large as seven',
    (target) =>
      `(window.open(${JSON.stringify(target)}, '', 'popup,left=0,top=0,width=' + screen.availWidth + ',height=' + screen.availHeight), true)`,
  ],
];

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport}: a driven page's popups and target=_blank links open behind seven's tab`, async (t) => {
    const url = `${entry[transport]}${entry[transport].includes('?') ? '&' : '?'}run=${Date.now()}`;
    const page = await chrome.visit(t, url);
    await page.evaluate(install, transport, extId);
    const sw = await worker();
    const opened = [];
    t.after(() =>
      sw(
        `Promise.allSettled(${JSON.stringify(opened.map(Number))}.map((id) => chrome.tabs.remove(id))).then(() => true)`
      )
    );
    const seven = await placement(sw, url);
    await raise(sw, seven.tabId);
    await front(sw, page, url, `${transport} control`);
    const tab = await ok(page, 'Target.createTarget', { url: 'about:blank' });
    opened.push(tab.targetId);
    const { sessionId } = await ok(page, 'Target.attachToTarget', {
      targetId: tab.targetId,
      flatten: true,
    });
    await ok(page, 'Page.enable', {}, sessionId, transport);
    await page.evaluate((sessionId, target) => h.land(sessionId, target), sessionId, ordinary);
    await front(sw, page, url, `${transport} driven`);
    for (const [index, [label, source]] of popups.entries()) {
      const target = `${ordinary}landing?popup=${index}`;
      const answer = await page.evaluate(
        (sessionId, expression) => h.evaluate(sessionId, expression),
        sessionId,
        source(target)
      );
      assert.equal(answer, true, `${transport} ${label}: ${JSON.stringify(answer)}`);
      opened.push(await landed(sw, target));
      await front(sw, page, url, `${transport} ${label}`);
    }
  });
}

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport}: a client cannot minimize seven's window, and may minimize a window seven is not in`, async (t) => {
    const url = `${entry[transport]}${entry[transport].includes('?') ? '&' : '?'}run=${Date.now()}`;
    const page = await chrome.visit(t, url);
    await page.evaluate(install, transport, extId);
    const sw = await worker();
    const opened = [];
    t.after(() =>
      sw(
        `Promise.allSettled(${JSON.stringify(opened.map(Number))}.map((id) => chrome.tabs.remove(id))).then(() => true)`
      )
    );
    const seven = await placement(sw, url);
    await raise(sw, seven.tabId);
    await front(sw, page, url, `${transport} control`);
    const own = await sw(`chrome.tabs.get(${seven.tabId}).then((tab) => tab.windowId)`);
    const tab = await ok(page, 'Target.createTarget', { url: 'about:blank' });
    opened.push(tab.targetId);
    const found = await drive(page, 'Browser.getWindowForTarget', { targetId: tab.targetId });
    if (found.result)
      assert.equal(found.result.windowId, own, `${transport}: the tab is in seven's window`);
    const answer = await drive(page, 'Browser.setWindowBounds', {
      windowId: own,
      bounds: { windowState: 'minimized' },
    });
    assert.ok(answer.error, `${transport}: minimizing seven's window is refused`);
    await front(sw, page, url, `${transport} minimizing seven's window`);
    if (transport !== 'six-bridge') return;
    const win = await ok(page, 'Target.createTarget', { url: 'about:blank', newWindow: true });
    opened.push(win.targetId);
    const { windowId } = await ok(page, 'Browser.getWindowForTarget', { targetId: win.targetId });
    assert.notEqual(windowId, own);
    await ok(page, 'Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await front(sw, page, url, `${transport} minimized other window`);
  });
}
