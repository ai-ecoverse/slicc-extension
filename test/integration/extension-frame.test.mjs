import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId, fixtureId } from './extension-page.mjs';

const transports = ['seven', 'six-bridge'];
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const FRAME =
  "slicc: refused: another browser extension has a frame in this tab, and Chrome doesn't let one extension debug another's frames; reload the tab, which clears that frame until the extension adds it again, or drive the tab through the linked slicc CLI";
const fixture = `chrome-extension://${fixtureId}`;
const frameUrl = `${fixture}/frame.html`;

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

async function opened(page, url) {
  return page.evaluate(async (url) => {
    const created = await h.attempt('Target.createTarget', { url });
    const targetId = created.result?.targetId;
    await h.until(async () => {
      const listed = await h.attempt('Target.getTargetInfo', { targetId });
      return listed.result?.targetInfo?.url === url;
    });
    await h.sleep(500);
    return targetId;
  }, url);
}

async function attached(page, targetId) {
  return page.evaluate(async (targetId) => {
    const attach = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
    return attach.result?.sessionId ?? attach;
  }, targetId);
}

async function fixtureFramePresent() {
  for (let i = 0; i < 50; i++) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    if (targetInfos.some((info) => info.type === 'iframe' && info.url.startsWith(`${fixture}/`))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function carries(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.includes(fixture) || text.includes(frameUrl) || text.includes(fixtureId);
}

for (const transport of transports) {
  test(`${transport} a clean tab still attaches`, async (t) => {
    const page = await client(t, transport);
    const url = `https://ordinary.test/doc?n=extension-frame-clean-${transport}`;
    const targetId = await opened(page, url);
    const sessionId = await attached(page, targetId);
    assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
    const origin = await page.evaluate(
      (sessionId) => h.evaluate(sessionId, 'self.origin'),
      sessionId
    );
    assert.equal(origin, 'https://ordinary.test');
    await page.evaluate((targetId) => h.close(targetId), targetId);
  });

  test(`${transport} a tab holding another extension's iframe is refused on attach with the recovery wording, and the refusal path leaks nothing about the frame or the page`, async (t) => {
    const page = await client(t, transport);
    const url = `https://ordinary.test/doc?n=extension-frame-refuse-${transport}&fixture-frame`;
    const targetId = await opened(page, url);
    assert.equal(await fixtureFramePresent(), true, 'fixture iframe is present before attach');
    const refused = await attached(page, targetId);
    assert.equal(refused?.error, FRAME, JSON.stringify(refused));
    assert.equal(Object.keys(refused).sort().join(','), 'error', JSON.stringify(refused));
    assert.ok(!carries(refused.error), JSON.stringify(refused));
    assert.ok(!carries(refused), JSON.stringify(refused));
    await page.evaluate((targetId) => h.close(targetId), targetId);
  });
}
