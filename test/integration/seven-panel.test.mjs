import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { openExtensionPage } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const os = 'https://www.sliccy.ai/os/';

const wwwTabs = `chrome.tabs.query({}).then((tabs) => tabs
  .map((tab) => ({ id: tab.id, url: tab.url || tab.pendingUrl || '', pinned: tab.pinned, active: tab.active }))
  .filter((tab) => tab.url.startsWith('https://www.sliccy.ai/')))`;
const shown = `({
  state: document.getElementById('cherry-status').dataset.state,
  src: document.getElementById('cherry-follower').getAttribute('src'),
  text: document.getElementById('cherry-status-text').textContent,
  action: document.getElementById('cherry-status-action').hidden ? null : document.getElementById('cherry-status-action').textContent,
})`;

async function panel(t) {
  const start = await chrome.visit(t, 'https://other.test/');
  return openExtensionPage(start, 'sidepanel.html');
}

function cookie(name, value, expires) {
  const cookie = { name, value, url: 'https://www.sliccy.ai/', path: '/', secure: true };
  return chrome.cdp.send('Storage.setCookies', {
    cookies: [expires === undefined ? cookie : { ...cookie, expires }],
  });
}

function openWww(url) {
  return chrome.cdp.send('Target.createTarget', { url });
}

async function closeWww() {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  for (const { targetId, type, url } of targetInfos) {
    if (type === 'page' && url.startsWith('https://www.sliccy.ai/')) {
      await chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
  }
}

test('with a six leader tab, the panel stays on six and opens no seven', async (t) => {
  await openWww('https://www.sliccy.ai/?slicc=leader');
  const side = await panel(t);
  t.after(closeWww);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const tabs = await side.evaluate(wwwTabs);
  assert.equal(tabs.length, 1, JSON.stringify(tabs));
  assert.match(tabs[0].url, /^https:\/\/www\.sliccy\.ai\/\?slicc=leader/);
  assert.notEqual((await side.evaluate(shown)).src, os);
});

test('after the upgrade, the panel frames seven in the leader tab it opened, and opening it again opens no other', async (t) => {
  await cookie('__Host-slicc-six-retired', '1');
  const side = await panel(t);
  t.after(closeWww);
  assert.ok(
    await side.until(
      `(() => { const s = ${shown}; return s.state === 'live' && s.src === ${JSON.stringify(os)}; })()`,
      20000
    ),
    JSON.stringify(await side.evaluate(shown))
  );
  const first = await side.evaluate(wwwTabs);
  assert.equal(first.length, 1, JSON.stringify(first));
  assert.equal(first[0].url, os);
  assert.equal(first[0].pinned, true);
  await side.close();

  for (let again = 0; again < 2; again++) {
    const reopened = await panel(t);
    assert.ok(
      await reopened.until(`${shown}.state === 'live'`, 20000),
      JSON.stringify(await reopened.evaluate(shown))
    );
    assert.deepEqual(
      (await reopened.evaluate(wwwTabs)).map((tab) => tab.id),
      [first[0].id],
      'no second leader tab'
    );
    await reopened.close();
  }
});

test('a seven tab the user opened becomes the leader, and the panel follows it', async (t) => {
  const { targetId } = await openWww(os);
  const side = await panel(t);
  t.after(closeWww);
  assert.ok(
    await side.until(`${shown}.state === 'live'`, 20000),
    JSON.stringify(await side.evaluate(shown))
  );
  const tabs = await side.evaluate(wwwTabs);
  assert.equal(tabs.length, 1, JSON.stringify(tabs));
  assert.equal(tabs[0].pinned, false, 'a seven tab is adopted as it is');
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  assert.equal(targetInfos.find((target) => target.targetId === targetId)?.url, os);
});

test('a seven that refuses the frame leaves the panel on Show SLICC tab, which brings the tab to the front', async (t) => {
  await cookie('seven-refuses', '1');
  t.after(() => cookie('seven-refuses', '', 1));
  const side = await panel(t);
  t.after(closeWww);
  assert.ok(
    await side.until(`${shown}.state === 'tab'`, 30000),
    JSON.stringify(await side.evaluate(shown))
  );
  assert.deepEqual(await side.evaluate(shown), {
    state: 'tab',
    src: os,
    text: 'SLICC runs in its tab. Reload that tab to use SLICC here, or open it.',
    action: 'Show SLICC tab',
  });
  await side.evaluate(`document.getElementById('cherry-status-action').click()`);
  assert.ok(
    await side.until(`${wwwTabs}.then((tabs) => tabs.length === 1 && tabs[0].active)`, 10000),
    JSON.stringify(await side.evaluate(wwwTabs))
  );
});
