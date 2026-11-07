import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';

const transports = ['seven', 'six-bridge'];
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const extId = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';
const SEVEN_AUTO = 'slicc: refused: Target.setAutoAttach is not supported: attach to each target';
const SEVEN_RELATED =
  'slicc: refused: Target.autoAttachRelated is not supported: attach to each target';
const SIX_SESSION = 'slicc: refused: auto-attach is not supported by the extension bridge';
const SIX_SESSIONLESS = 'No tab attached for sessionId: (none). Attach to a target first.';
const AUTO = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
const AUTO_OFF = { autoAttach: false, waitForDebuggerOnStart: false, flatten: true };
const WORKER = `chrome-extension://${extId}/background.js`;

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

async function inSession(sessionId, expression) {
  const answer = await chrome.cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    sessionId
  );
  if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description);
  return answer.result?.value;
}

const HOOK = `(() => {
  if (typeof chrome?.debugger?.sendCommand !== 'function') return null;
  if (!globalThis.__sliccRouteProbe) {
    const sent = [];
    const send = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = async (target, method, params) => {
      sent.push({ method, params: params ?? {} });
      return send(target, method, params);
    };
    globalThis.__sliccRouteProbe = { id: crypto.randomUUID(), sent };
  }
  return { id: globalThis.__sliccRouteProbe.id, mark: globalThis.__sliccRouteProbe.sent.length };
})()`;

async function workers() {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  return targetInfos.filter((info) => info.type === 'service_worker' && info.url === WORKER);
}

async function hook(page) {
  for (let i = 0; i < 100; i++) {
    const live = await workers();
    if (live.length === 0) await page.evaluate(() => h.attempt('Target.getTargets'));
    if (live.length === 1) {
      const { targetId } = live[0];
      const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      const hooked = await inSession(sessionId, HOOK).catch(() => null);
      if (hooked) return { sessionId, ...hooked };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('the extension service worker never offered chrome.debugger');
}

async function mark(hooked) {
  const id = JSON.stringify(hooked.id);
  const next = await inSession(
    hooked.sessionId,
    `globalThis.__sliccRouteProbe?.id === ${id} ? globalThis.__sliccRouteProbe.sent.length : null`
  );
  assert.equal(typeof next, 'number');
  return { ...hooked, mark: next };
}

async function since(hooked) {
  const id = JSON.stringify(hooked.id);
  return inSession(
    hooked.sessionId,
    `globalThis.__sliccRouteProbe?.id === ${id} ? globalThis.__sliccRouteProbe.sent.slice(${hooked.mark}) : null`
  ).catch(() => null);
}

function assertRoute(version) {
  assert.equal(typeof version, 'object');
  assert.ok(version);
  assert.deepEqual(version.slicc, { route: 'extension' });
  assert.deepEqual(Object.keys(version.slicc), ['route']);
  assert.equal(version.protocolVersion, '1.3');
  assert.match(String(version.product), /^Chrome\//);
  assert.equal(typeof version.userAgent, 'string');
  assert.equal(typeof version.revision, 'string');
  assert.equal(typeof version.jsVersion, 'string');
}

for (const transport of transports) {
  test(`${transport} Browser.getVersion carries slicc.route extension and keeps the other fields`, async (t) => {
    const page = await client(t, transport);
    const version = await page.evaluate(async (needsSession) => {
      if (!needsSession) return h.attempt('Browser.getVersion');
      const { targetId, sessionId } = await h.open('https://ordinary.test/start');
      const answer = await h.attempt('Browser.getVersion', {}, sessionId);
      await h.close(targetId);
      return answer;
    }, transport === 'six-bridge');
    assert.equal(version.error, undefined, JSON.stringify(version));
    assertRoute(version.result);
  });

  test(`${transport} Target.setAutoAttach and autoAttachRelated refusals are pinned and never reach chrome.debugger`, async (t) => {
    const page = await client(t, transport);
    const hooked = await hook(page);
    const opened = await page.evaluate(async () => {
      const { targetId, sessionId } = await h.open('https://ordinary.test/start');
      return { targetId, sessionId };
    });
    const armed = await mark(hooked);
    const answer = await page.evaluate(
      async ({ sessionId, auto, autoOff }) => {
        const sessionless = await h.attempt('Target.setAutoAttach', auto);
        const related = await h.attempt('Target.autoAttachRelated', {
          targetId: '1',
          waitForDebuggerOnStart: false,
        });
        const onSession = await h.attempt('Target.setAutoAttach', auto, sessionId);
        const offSession = await h.attempt('Target.setAutoAttach', autoOff, sessionId);
        return { sessionless, related, onSession, offSession };
      },
      { sessionId: opened.sessionId, auto: AUTO, autoOff: AUTO_OFF }
    );
    const sent = await since(armed);
    assert.ok(Array.isArray(sent), 'debugger probe stayed attached');
    const refusedMethods = sent.filter(
      (row) =>
        row.method === 'Target.autoAttachRelated' ||
        (row.method === 'Target.setAutoAttach' && row.params?.autoAttach === true)
    );
    assert.deepEqual(refusedMethods, [], JSON.stringify(refusedMethods));
    await page.evaluate((targetId) => h.close(targetId), opened.targetId);
    if (transport === 'seven') {
      assert.equal(answer.sessionless.error, SEVEN_AUTO);
      assert.equal(answer.onSession.error, SEVEN_AUTO);
      assert.equal(answer.offSession.error, SEVEN_AUTO);
      assert.equal(answer.related.error, SEVEN_RELATED);
      assert.equal(
        sent.some((row) => row.method === 'Target.setAutoAttach'),
        false,
        JSON.stringify(sent)
      );
      return;
    }
    assert.equal(answer.sessionless.error, SIX_SESSIONLESS);
    assert.equal(answer.onSession.error, SIX_SESSION);
    assert.equal(answer.offSession.error, undefined, JSON.stringify(answer.offSession));
    assert.equal(answer.related.error, SIX_SESSIONLESS);
    assert.equal(
      sent.some((row) => row.method === 'Target.setAutoAttach' && row.params?.autoAttach === false),
      true,
      'six forwards autoAttach:false on a session'
    );
  });
}
