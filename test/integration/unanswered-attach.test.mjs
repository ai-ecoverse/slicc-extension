import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { UNANSWERED } from '../../extension/shield.js';
import { launch } from './chrome.mjs';
import { openExtensionPage } from './extension-page.mjs';

const PROTECTED = "slicc: refused: target is on seven's origin";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openTab(page, url) {
  const ext = await openExtensionPage(page, 'secrets.html');
  try {
    return String(
      await ext.evaluate(
        `chrome.tabs.create({ url: ${JSON.stringify(url)}, active: false }).then((tab) => tab.id)`
      )
    );
  } finally {
    await ext.close();
  }
}

async function childHosts(url) {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const page = targetInfos.find((target) => target.type === 'page' && target.url === url);
  return targetInfos
    .filter((target) => target.type === 'iframe' && target.parentId === page.targetId)
    .map((target) => new URL(target.url).hostname);
}

async function holdDialog(url) {
  let info;
  for (let n = 0; n < 50 && !info; n += 1) {
    info = (await chrome.cdp.send('Target.getTargets')).targetInfos.find(
      (target) => target.type === 'page' && target.url === url
    );
    if (!info) await pause(100);
  }
  assert.ok(info, `no raw target at ${url}`);
  await pause(500);
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: info.targetId,
    flatten: true,
  });
  await chrome.cdp.send(
    'Runtime.evaluate',
    { expression: 'setTimeout(() => alert("held"), 50), 1' },
    sessionId
  );
  await chrome.cdp.send('Target.detachFromTarget', { sessionId });
  await pause(500);
}

function attachFrom(page, targetId) {
  return page.evaluate(async (id) => {
    const started = Date.now();
    const answer = await globalThis.sliccExtension.cdp
      .send('Target.attachToTarget', { targetId: id, flatten: true })
      .then(
        (result) => ({ sessionId: result.sessionId }),
        (error) => ({ error: error.message })
      );
    return { ...answer, waited: Date.now() - started };
  }, targetId);
}

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

test('a tab whose page stopped answering behind a dialog is refused as not answering, and a fresh tab still attaches', {
  timeout: 120000,
}, async (t) => {
  const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
  const answer = await page.evaluate(async () => {
    const { cdp } = globalThis.sliccExtension;
    const attach = (targetId) =>
      cdp.send('Target.attachToTarget', { targetId, flatten: true }).then(
        (result) => ({ sessionId: result.sessionId }),
        (error) => ({ error: error.message })
      );
    const evaluate = async (sessionId, expression) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const { result } = await cdp.send(
            'Runtime.evaluate',
            { expression, returnByValue: true },
            sessionId
          );
          return result.value;
        } catch (error) {
          if (!String(error.message).includes('execution context')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      throw new Error('no execution context');
    };
    const stuck = await cdp.send('Target.createTarget', { url: 'https://other.test/' });
    const fresh = await cdp.send('Target.createTarget', { url: 'https://other.test/' });
    try {
      const first = await attach(stuck.targetId);
      const before = await evaluate(first.sessionId, 'location.host');
      await evaluate(first.sessionId, 'setTimeout(() => alert("held"), 50), 1');
      await cdp.send('Target.detachFromTarget', { sessionId: first.sessionId });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const started = Date.now();
      const again = await attach(stuck.targetId);
      const waited = Date.now() - started;
      const other = await attach(fresh.targetId);
      const elsewhere = await evaluate(other.sessionId, 'location.host');
      const activated = await cdp.send('Target.activateTarget', { targetId: stuck.targetId }).then(
        () => true,
        (error) => error.message
      );
      const closed = await cdp.send('Target.closeTarget', { targetId: stuck.targetId }).then(
        (result) => result.success,
        (error) => error.message
      );
      return { before, again, waited, elsewhere, activated, closed };
    } finally {
      for (const { targetId } of [stuck, fresh])
        await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
  });
  assert.equal(answer.before, 'other.test');
  assert.deepEqual(answer.again, { error: UNANSWERED }, JSON.stringify(answer));
  assert.ok(answer.waited < 20000, `the refusal took ${answer.waited} ms`);
  assert.equal(answer.elsewhere, 'other.test');
  assert.equal(answer.activated, true);
  assert.equal(answer.closed, true);
});

test('a protected tab with an open dialog is refused as protected, never as not answering', {
  timeout: 120000,
}, async (t) => {
  const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
  const url = 'https://vault.sliccy.ai/marker?dialog';
  const tabId = await openTab(page, url);
  t.after(() => page.evaluate((id) => chrome.tabs?.remove(Number(id)), tabId).catch(() => {}));
  const before = await attachFrom(page, tabId);
  assert.equal(before.error, PROTECTED, JSON.stringify(before));
  await holdDialog(url);
  const held = await attachFrom(page, tabId);
  assert.equal(held.error, PROTECTED, JSON.stringify(held));
  assert.ok(held.waited < 3000, `the protected refusal took ${held.waited} ms`);
});

test('an ordinary tab with a protected child frame and an open dialog is refused as not answering, with the same text as without the frame', {
  timeout: 120000,
}, async (t) => {
  const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
  const framed = 'https://other.test/shared-frame?n=dialog';
  const plain = 'https://other.test/shared-frame?n=dialog-plain&opaque';
  const ids = [];
  for (const url of [framed, plain]) ids.push(await openTab(page, url));
  t.after(async () => {
    const ext = await openExtensionPage(page, 'secrets.html').catch(() => null);
    for (const id of ids) await ext?.evaluate(`chrome.tabs.remove(${id}).catch(() => {})`);
    await ext?.close();
  });
  await pause(1500);
  const control = await attachFrom(page, ids[0]);
  assert.ok(
    control.sessionId,
    `the framed tab attaches without a dialog: ${JSON.stringify(control)}`
  );
  await page.evaluate(
    (sessionId) => globalThis.sliccExtension.cdp.send('Target.detachFromTarget', { sessionId }),
    control.sessionId
  );
  assert.ok((await childHosts(framed)).includes('vault.sliccy.ai'));
  assert.ok(!(await childHosts(plain)).includes('vault.sliccy.ai'));
  for (const url of [framed, plain]) await holdDialog(url);
  const [withFrame, without] = [await attachFrom(page, ids[0]), await attachFrom(page, ids[1])];
  assert.deepEqual({ error: withFrame.error }, { error: UNANSWERED }, JSON.stringify(withFrame));
  assert.equal(without.error, withFrame.error);
  assert.doesNotMatch(withFrame.error, /vault|frame-body|frame-secret|other\.test/);
});
