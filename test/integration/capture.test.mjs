import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId, openExtensionPage } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const popup = `chrome-extension://${extId}/capture-popup.html`;
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reqOf(requestId) {
  const json = JSON.stringify({
    requestId,
    kind: 'camera',
    mode: 'photo',
    mimeType: 'image/png',
    warmupMs: 0,
  });
  return Buffer.from(json).toString('base64url');
}

const watch = `(() => {
  globalThis.__gum = 0;
  const media = navigator.mediaDevices;
  const original = media.getUserMedia.bind(media);
  media.getUserMedia = (...args) => {
    globalThis.__gum += 1;
    return original(...args);
  };
  window.close = () => undefined;
})()`;

async function rawPopup(base, url) {
  const tab = await base.tab();
  await tab.send('Page.enable');
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: watch });
  await tab.send('Page.navigate', { url });
  await sleep(2500);
  const { result } = await tab.send('Runtime.evaluate', {
    expression:
      'JSON.stringify({ gum: globalThis.__gum ?? -1, label: document.getElementById("label")?.textContent, href: location.href })',
    returnByValue: true,
  });
  await tab.close().catch(() => undefined);
  return JSON.parse(result.value);
}

async function requester(base) {
  const ext = await openExtensionPage(base, 'secrets.html');
  await ext.evaluate(`(() => {
    globalThis.__replies = [];
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.source === 'capture-popup') globalThis.__replies.push(msg);
    });
    return true;
  })()`);
  return ext;
}

async function popupUrls() {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  return targetInfos.map((info) => info.url).filter((url) => url.startsWith(popup));
}

test('the extension service worker opens the capture popup for its own request, and the capture runs', async (t) => {
  const base = await chrome.visit(t, entry.seven);
  const ext = await requester(base);
  const requestId = `legit-${Date.now()}`;
  await ext.evaluate(
    `chrome.runtime.sendMessage({ type: 'capture-open-window', url: chrome.runtime.getURL('capture-popup.html?req=${reqOf(requestId)}'), requestId: ${JSON.stringify(requestId)} }).then(() => true, () => true)`
  );
  let seen = [];
  const deadline = Date.now() + 5000;
  while (seen.length === 0 && Date.now() < deadline) {
    seen = await popupUrls();
    await sleep(50);
  }
  const reply = await ext.until(
    `globalThis.__replies.find((m) => m.requestId === ${JSON.stringify(requestId)})`,
    20000
  );
  assert.equal(reply?.ok, true, `the popup captured a photo: ${JSON.stringify(reply)}`);
  assert.match(String(reply.bytesBase64), /^iVBOR/, 'the photo is a png');
  assert.ok(reply.width > 0 && reply.height > 0, 'the photo has a size');
  assert.equal(seen.length, 1, `the popup was seen: ${seen}`);
  const opened = new URL(seen[0]);
  assert.equal(opened.searchParams.get('req'), null, 'the popup url carries no request');
  assert.match(String(opened.searchParams.get('claim')), /^[0-9a-f-]{36}$/, 'only a claim token');
  const replay = await rawPopup(base, seen[0]);
  assert.equal(replay.gum, 0, 'a replayed claim starts no capture');
  assert.equal(replay.label, 'invalid capture request', 'the replayed popup refuses');
  await ext.close();
});

test('a page opening the capture popup with its own request causes no capture', async (t) => {
  const base = await chrome.visit(t, entry.seven);
  const ext = await requester(base);
  const requestId = `forged-${Date.now()}`;
  for (const url of [
    `${popup}?req=${reqOf(requestId)}`,
    `${popup}?claim=00000000-0000-4000-8000-000000000000`,
    `${popup}?claim=${requestId}&req=${reqOf(requestId)}`,
  ]) {
    const run = await rawPopup(base, url);
    assert.equal(run.href, url, `live: ${url} loaded`);
    assert.equal(run.gum, 0, `${url} starts no getUserMedia`);
    assert.equal(run.label, 'invalid capture request', `${url} shows the refusal`);
  }
  const ordinary = await rawPopup(base, `${popup}?claim=x`);
  assert.equal(ordinary.gum, 0, 'a junk claim starts nothing either');
  await sleep(500);
  assert.deepEqual(
    await ext.evaluate('globalThis.__replies'),
    [],
    'no capture result or failure was broadcast'
  );
  await ext.close();
});

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport} a CDP client cannot open the capture popup or cause any capture, an ordinary page opens`, async (t) => {
    const page = await chrome.visit(t, entry[transport]);
    const ext = await requester(page);
    await page.evaluate(install, transport, extId);
    const req = reqOf(`cdp-${Date.now()}`);
    const before = (await popupUrls()).length;
    const run = await page.evaluate(
      async ({ urls, control }) => {
        const answers = [];
        for (const url of urls) {
          answers.push(await h.attempt('Target.createTarget', { url }));
          answers.push(await h.attempt('Target.createTarget', { url, newWindow: true }));
        }
        return { answers, allowed: await h.attempt('Target.createTarget', { url: control }) };
      },
      {
        urls: [
          `/capture-popup.html?req=${req}`,
          `capture-popup.html?req=${req}`,
          `//${extId}/capture-popup.html?req=${req}`,
          `${popup}?req=${req}`,
        ],
        control: 'https://ordinary.test/doc?n=capture-control',
      }
    );
    for (const answer of run.answers) {
      assert.match(String(answer.error), /refused/, 'opening the capture popup is refused');
      assert.equal(answer.result, undefined, 'no target id comes back');
    }
    await sleep(2000);
    assert.equal((await popupUrls()).length, before, 'no capture popup opened');
    assert.deepEqual(await ext.evaluate('globalThis.__replies'), [], 'no capture ran');
    assert.match(String(run.allowed.result?.targetId), /./, 'control: an ordinary page opens');
    await page.evaluate((id) => h.close(id), run.allowed.result.targetId);
    await ext.close();
  });
}
