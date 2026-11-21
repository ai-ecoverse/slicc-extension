import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { extId } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch({
    prepare: async (paths) => {
      const path = join(paths[0], 'background.js');
      const source = await readFile(path, 'utf8');
      await writeFile(
        path,
        `${source}
globalThis.__diag = [];
const __t0 = performance.now();
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!/^(Page\\.frame|Target\\.)/.test(method)) return;
  const p = params ?? {};
  globalThis.__diag.push({
    t: Math.round(performance.now() - __t0),
    tab: source?.tabId,
    session: source?.sessionId ?? null,
    method,
    frameId: p.frameId ?? p.frame?.id,
    parentFrameId: p.parentFrameId ?? p.frame?.parentId,
    loaderId: p.frame?.loaderId,
    reason: p.reason,
    type: p.type,
    targetId: p.targetInfo?.targetId ?? p.targetId,
    targetType: p.targetInfo?.type,
    childSession: p.sessionId,
    host: (() => { try { return new URL(p.targetInfo?.url ?? p.frame?.url ?? '').host; } catch { return ''; } })(),
  });
});
chrome.webNavigation.onCommitted.addListener((d) => {
  globalThis.__diag.push({
    t: Math.round(performance.now() - __t0),
    tab: d.tabId,
    method: 'webNavigation.onCommitted',
    frameId: d.frameId,
    documentId: d.documentId,
  });
});
`
      );
    },
  });
});
after(() => chrome?.close());

async function worker() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const found = targetInfos.find(
      (info) =>
        info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
    );
    if (found) {
      const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
        targetId: found.targetId,
        flatten: true,
      });
      return async (expression) => {
        const answer = await chrome.cdp.send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true },
          sessionId
        );
        assert.equal(answer.exceptionDetails, undefined, JSON.stringify(answer.exceptionDetails));
        return answer.result?.value;
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('worker missing');
}

const SOURCES = [
  'https://127.0.0.1:1/ERROR_FRAME_CANARY?q=CANARY',
  'https://other.test/doc?ERROR_FRAME_SIBLING_CANARY=diag',
];

async function frame(target) {
  await target.evaluate(async (sources) => {
    await Promise.all(
      sources.map(
        (src) =>
          new Promise((resolve) => {
            const iframe = document.createElement('iframe');
            iframe.onload = resolve;
            iframe.src = src;
            document.body.append(iframe);
          })
      )
    );
  }, SOURCES);
}

async function attach(page, url) {
  return page.evaluate(async (url) => {
    const listed = await sliccExtension.cdp.send('Target.getTargets');
    const info = listed.targetInfos.find((entry) => entry.url === url);
    await sliccExtension.cdp.send('Target.attachToTarget', {
      targetId: info.targetId,
      flatten: true,
    });
    return info.targetId;
  }, url);
}

async function poll(page, targetId) {
  return page.evaluate(async (targetId) => {
    let last;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await sliccExtension.frames(Number(targetId));
        return { attempt, ok: true };
      } catch (error) {
        last = error.message;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { ok: false, last };
  }, targetId);
}

const TREES = `(async (prefix) => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((entry) => (entry.url || '').startsWith(prefix));
  const root = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getFrameTree', {}).catch((e) => ({ error: e.message }));
  const flat = (node, out = []) => {
    if (!node?.frame) return out;
    out.push({ id: node.frame.id, parentId: node.frame.parentId, loaderId: node.frame.loaderId });
    for (const child of node.childFrames ?? []) flat(child, out);
    return out;
  };
  const sessions = [...new Set(globalThis.__diag.filter((e) => e.tab === tab.id && e.method === 'Target.attachedToTarget').map((e) => e.childSession))];
  const children = [];
  for (const sessionId of sessions) {
    const tree = await chrome.debugger.sendCommand({ tabId: tab.id, sessionId }, 'Page.getFrameTree', {}).catch((e) => ({ error: e.message }));
    children.push({ sessionId, root: tree?.frameTree?.frame ? { id: tree.frameTree.frame.id, parentId: tree.frameTree.frame.parentId ?? null, loaderId: tree.frameTree.frame.loaderId, error: (tree.frameTree.frame.url || '').startsWith('chrome-error:') } : tree });
  }
  return { tabId: tab.id, root: flat(root.frameTree), children };
})`;

function report(label, value) {
  console.log(`SWAPDIAG ${label} ${JSON.stringify(value)}`);
}

test('diag: swap and remove of an OOPIF error child', async (t) => {
  const evaluate = await worker();
  report('ua', await evaluate('navigator.userAgent'));
  for (let rep = 0; rep < 6; rep += 1) {
    const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
    const url = `https://ordinary.test/doc?swap-diag-${rep}`;
    const target = await chrome.visit(t, url);
    const targetId = await attach(page, url);
    await evaluate('globalThis.__diag = []; true');
    await frame(target);
    report(`rep${rep} poll`, await poll(page, targetId));
    report(`rep${rep} trees-before-remove`, await evaluate(`${TREES}(${JSON.stringify(url)})`));
    report(`rep${rep} events-attach`, await evaluate('globalThis.__diag'));
    await evaluate('globalThis.__diag = []; true');
    await target.evaluate(() => {
      document.querySelector('iframe[src*="127.0.0.1"]').remove();
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    report(`rep${rep} events-remove`, await evaluate('globalThis.__diag'));
    report(`rep${rep} trees-after-remove`, await evaluate(`${TREES}(${JSON.stringify(url)})`));
  }
});

test('diag: main cross-document navigation and frame ids', async (t) => {
  const evaluate = await worker();
  const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
  const url = 'https://ordinary.test/doc?swap-diag-nav';
  const target = await chrome.visit(t, url);
  const targetId = await attach(page, url);
  await evaluate('globalThis.__diag = []; true');
  await frame(target);
  report('nav poll', await poll(page, targetId));
  report('nav trees-before', await evaluate(`${TREES}(${JSON.stringify(url)})`));
  await evaluate('globalThis.__diag = []; true');
  const next = 'https://ordinary.test/doc?swap-diag-nav-second';
  await target.goto(next);
  await target.until((href) => location.href === href && document.readyState === 'complete', next);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  report('nav events-navigate', await evaluate('globalThis.__diag'));
  report('nav trees-after-navigate', await evaluate(`${TREES}(${JSON.stringify(next)})`));
  await evaluate('globalThis.__diag = []; true');
  await frame(target);
  report('nav poll-second', await poll(page, targetId));
  report('nav events-reframe', await evaluate('globalThis.__diag'));
  report('nav trees-after-reframe', await evaluate(`${TREES}(${JSON.stringify(next)})`));
});
