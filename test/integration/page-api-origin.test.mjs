import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { listen, trusted } from '../../extension/cdp.js';
import { launch } from './chrome.mjs';
import { extId } from './extension-page.mjs';

process.env.SLICC_CDP_PORTS = '9300-9309';

const CALL_MS = 4000;
const extensionId = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';

let chrome;

async function prepare([extPath]) {
  const path = join(extPath, 'cdp.js');
  const src = await readFile(path, 'utf8');
  const needle =
    "export function listen(port, extensionId, api) {\n  if (port.name !== 'slicc-fetch') return null;\n  if (!trusted(port.sender, extensionId)) {";
  if (!src.includes(needle)) throw new Error('listen patch point missing');
  await writeFile(
    path,
    src.replace(
      needle,
      "export function listen(port, extensionId, api) {\n  if (port.name !== 'slicc-fetch') return null;\n  try {\n    (globalThis.__pageApiPorts ??= []).push({\n      origin: port.sender?.origin ?? null,\n      url: port.sender?.url ?? null,\n      trusted: trusted(port.sender, extensionId),\n    });\n  } catch {}\n  if (!trusted(port.sender, extensionId)) {"
    )
  );
}

before(async () => {
  chrome = await launch({ prepare, args: ['--disable-popup-blocking'] });
});
after(() => chrome?.close());

async function swEval(expression) {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const sw = targetInfos.find(
    (info) => info.type === 'service_worker' && info.url?.startsWith(`chrome-extension://${extId}/`)
  );
  if (!sw) return null;
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: sw.targetId,
    flatten: true,
  });
  try {
    const answer = await chrome.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    );
    return answer.result?.value ?? null;
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }
}

async function clearPorts() {
  await swEval('globalThis.__pageApiPorts = []');
}

async function readPorts() {
  return (await swEval('globalThis.__pageApiPorts ?? []')) ?? [];
}

async function waitPage(url, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const hit = targetInfos.find((info) => info.type === 'page' && info.url === url);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function attach(targetId) {
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await chrome.cdp.send('Runtime.enable', {}, sessionId);
  return sessionId;
}

async function evalTarget(targetId, expression) {
  const sessionId = await attach(targetId);
  try {
    const answer = await chrome.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      sessionId
    );
    if (answer.exceptionDetails) {
      throw new Error(
        answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text
      );
    }
    return answer.result.value;
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }
}

const probeExpr = `async (timeoutMs) => {
  const out = {
    typeofApi: typeof globalThis.sliccExtension,
    windowOrigin: self.origin,
    locationOrigin: location.origin,
    href: location.href,
    version: globalThis.sliccExtension?.version ?? null,
    cdp: null,
    fetch: null,
    signIn: null,
  };
  const api = globalThis.sliccExtension;
  if (!api) return out;
  const race = (p) =>
    Promise.race([
      p.then(
        (value) => ({ status: 'resolved', value }),
        (error) => ({ status: 'rejected', error: String(error?.message ?? error) })
      ),
      new Promise((resolve) => setTimeout(() => resolve({ status: 'hung' }), timeoutMs)),
    ]);
  out.cdp = await race(api.cdp.send('Browser.getVersion'));
  out.fetch = await race(
    api.fetch(location.origin + '/').then(async (response) => ({
      status: response.status,
    }))
  );
  out.signIn = await race(api.signIn({ clientId: 'good', scopes: 'openid' }));
  return out;
}`;

async function probeTarget(targetId) {
  return evalTarget(targetId, `(${probeExpr})(${CALL_MS})`);
}

function portsFor(url) {
  return readPorts().then((all) => all.filter((row) => row.url === url && row.trusted));
}

test('a normal seven-label page keeps the page API', { timeout: 60000 }, async (t) => {
  await clearPorts();
  const url = 'https://seven.sliccy.ai/?page-api=control';
  const page = await chrome.visit(t, url);
  const report = await page.evaluate(
    new Function('timeoutMs', `return (${probeExpr})(timeoutMs)`),
    CALL_MS
  );
  assert.equal(report.typeofApi, 'object');
  assert.equal(report.windowOrigin, 'https://seven.sliccy.ai');
  assert.equal(report.cdp.status, 'resolved');
  assert.equal(report.fetch.status, 'resolved');
  assert.equal(report.signIn.status, 'resolved');
  assert.equal(report.signIn.value, 'dummy-ims-token');
  assert.equal(typeof report.version, 'string');
  const accepted = await portsFor(url);
  assert.ok(accepted.length > 0, 'control opens a trusted port');
});

test('the page API needs a real origin on a top-level document', { timeout: 60000 }, async (t) => {
  await clearPorts();
  const url = 'https://seven.sliccy.ai/page-api-doc?sandbox=1&who=top';
  await chrome.visit(t, url, { expectExtension: false });
  const target = await waitPage(url);
  assert.ok(target);
  const report = await probeTarget(target.targetId);
  assert.equal(report.windowOrigin, 'null');
  assert.equal(report.locationOrigin, 'https://seven.sliccy.ai');
  assert.equal(report.typeofApi, 'undefined');
  const accepted = await portsFor(url);
  assert.equal(accepted.length, 0);
});

test('the page API needs a real origin in a popup from a framed document', {
  timeout: 90000,
}, async (t) => {
  await clearPorts();
  const opener =
    'https://seven.sliccy.ai/page-api-opener?child=' +
    encodeURIComponent('/?n=page-api-frame') +
    '&flags=' +
    encodeURIComponent('allow-scripts allow-forms allow-popups allow-modals');
  await chrome.visit(t, opener);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const frame = targetInfos.find(
    (info) => info.type === 'iframe' && info.url?.includes('n=page-api-frame')
  );
  assert.ok(frame, 'framed document target');
  const openUrl = 'https://seven.sliccy.ai/page-api-doc?who=popup-open';
  const opened = await evalTarget(
    frame.targetId,
    `(() => { const w = window.open(${JSON.stringify(openUrl)}, 'pageApiPopup'); return { opened: !!w, windowOrigin: self.origin }; })()`
  );
  assert.equal(opened.windowOrigin, 'null');
  assert.equal(opened.opened, true);
  let popup = null;
  for (let i = 0; i < 50; i++) {
    const listed = await chrome.cdp.send('Target.getTargets');
    popup = listed.targetInfos.find((info) => info.type === 'page' && info.url === openUrl);
    if (popup) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(popup, 'popup opened');
  const report = await probeTarget(popup.targetId);
  assert.equal(report.windowOrigin, 'null');
  assert.equal(report.typeofApi, 'undefined');
  const accepted = await portsFor(openUrl);
  assert.equal(accepted.length, 0);
  await chrome.cdp.send('Target.closeTarget', { targetId: popup.targetId }).catch(() => undefined);
});

test('a framed document reports how navigation leaves it', { timeout: 90000 }, async (t) => {
  const opener =
    'https://seven.sliccy.ai/page-api-opener?child=' +
    encodeURIComponent('/?n=page-api-nav') +
    '&flags=' +
    encodeURIComponent('allow-scripts allow-forms allow-popups allow-modals');
  await chrome.visit(t, opener);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const frame = targetInfos.find(
    (info) => info.type === 'iframe' && info.url?.includes('n=page-api-nav')
  );
  assert.ok(frame);
  const blankUrl = 'https://seven.sliccy.ai/page-api-doc?who=from-anchor';
  const viaAnchor = await evalTarget(
    frame.targetId,
    `(() => {
      const a = document.createElement('a');
      a.href = ${JSON.stringify(blankUrl)};
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.append(a);
      a.click();
      return { clicked: true, windowOrigin: self.origin };
    })()`
  );
  let anchorPopup = null;
  for (let i = 0; i < 40; i++) {
    const listed = await chrome.cdp.send('Target.getTargets');
    anchorPopup = listed.targetInfos.find((info) => info.type === 'page' && info.url === blankUrl);
    if (anchorPopup) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const topAssign = await evalTarget(
    frame.targetId,
    `(() => {
      try {
        location.href = 'https://seven.sliccy.ai/page-api-doc?who=top-nav';
        return { ok: true, windowOrigin: self.origin };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error), windowOrigin: self.origin };
      }
    })()`
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const { targetInfos: after } = await chrome.cdp.send('Target.getTargets');
  const topNavPage = after.find(
    (info) => info.type === 'page' && info.url?.includes('who=top-nav')
  );
  assert.equal(viaAnchor.windowOrigin, 'null');
  assert.equal(topAssign.windowOrigin, 'null');
  assert.equal(
    topNavPage,
    undefined,
    'top navigation from the framed document does not open a page'
  );
  if (anchorPopup) {
    const report = await probeTarget(anchorPopup.targetId);
    assert.equal(report.windowOrigin, 'null');
    assert.equal(report.typeofApi, 'undefined');
    await chrome.cdp
      .send('Target.closeTarget', { targetId: anchorPopup.targetId })
      .catch(() => undefined);
  }
  assert.ok(anchorPopup, 'target=_blank from the framed document opens a page');
});

test('excluded labels and the apex stay without the page API', { timeout: 30000 }, async (t) => {
  for (const url of [
    'https://vault.sliccy.ai/?page-api=vault',
    'https://sliccy.ai/?page-api=apex',
  ]) {
    const page = await chrome.visit(t, url);
    assert.equal(await page.evaluate(() => typeof globalThis.sliccExtension), 'undefined');
  }
});

test('www without a real origin is refused by the bridge pin', { timeout: 60000 }, async (t) => {
  const url = 'https://www.sliccy.ai/page-api-doc?sandbox=1&who=www';
  await chrome.visit(t, url, { expectExtension: false });
  const target = await waitPage(url);
  assert.ok(target);
  const pageReport = await probeTarget(target.targetId);
  assert.equal(pageReport.windowOrigin, 'null');
  assert.equal(pageReport.typeofApi, 'undefined');
  const bridge = await evalTarget(
    target.targetId,
    `(() => new Promise((resolve) => {
      const port = chrome.runtime.connect(${JSON.stringify(extId)}, { name: 'slicc.cdp-bridge' });
      const timer = setTimeout(() => resolve({ outcome: 'timeout' }), 3000);
      port.onMessage.addListener((msg) => {
        clearTimeout(timer);
        resolve({ outcome: 'message', kind: msg.kind, reason: msg.reason });
      });
      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        resolve({ outcome: 'disconnect' });
      });
      port.postMessage({ bridge: 1, channelId: crypto.randomUUID(), kind: 'handshake.hello' });
    }))()`
  );
  assert.equal(bridge.outcome, 'message');
  assert.equal(bridge.kind, 'handshake.rejected');
  assert.equal(bridge.reason, 'origin-not-allowed');
});

test('trusted requires a matching https origin', () => {
  const id = extensionId;
  const url = 'https://seven.sliccy.ai/play';
  assert.equal(trusted({ id, url, origin: 'https://seven.sliccy.ai' }, id), true);
  assert.equal(trusted({ id, url, origin: 'null' }, id), false);
  assert.equal(trusted({ id, url }, id), false);
  assert.equal(trusted({ id, url, origin: 'https://other.sliccy.ai' }, id), false);
  assert.equal(
    trusted({ id, url: 'http://seven.sliccy.ai/', origin: 'http://seven.sliccy.ai' }, id),
    false
  );
  assert.equal(
    trusted(
      { id, url: `chrome-extension://${id}/secrets.html`, origin: `chrome-extension://${id}` },
      id
    ),
    false
  );
  assert.equal(
    listen(
      {
        name: 'slicc-fetch',
        sender: { id, url, origin: 'null' },
        disconnect() {},
        onDisconnect: { addListener() {} },
      },
      id,
      {}
    ),
    null
  );
});
