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
      const cdpPath = join(paths[0], 'cdp.js');
      let cdp = await readFile(cdpPath, 'utf8');
      const host =
        'const __h = (u) => { try { const x = new URL(String(u)); return x.protocol === "chrome-error:" ? "chrome-error" : x.host || x.protocol; } catch { return String(u ?? "").slice(0, 12); } }; const __log = (m, o) => globalThis.__diag?.push({ t: Math.round(performance.now() - (globalThis.__t0 ?? 0)), method: m, ...o });';
      const wraps = [
        [
          '  async readChildReobserve(tabId, sessionId, info) {',
          `  async readChildReobserve(tabId, sessionId, info) {
    const r = await this.__readChildReobserve(tabId, sessionId, info);
    const f = r.tree?.frame;
    __log('pass.read', { tab: tabId, childSession: sessionId, targetId: info.target, treeOk: Boolean(r.tree), treeUrl: __h(f?.url), unreachable: __h(f?.unreachableUrl), parentFrameId: f?.parentId, frameId: f?.id, infoOk: Boolean(r.targetInfo), host: __h(r.targetInfo?.url), targetType: r.targetInfo?.type });
    const probe = async (source, method, params) => {
      try {
        const answer = await this.api.debugger.sendCommand(source, method, params);
        const ti = answer?.targetInfo;
        const list = answer?.targetInfos;
        return { ok: true, targetId: ti?.targetId === info.target ? 'same' : __h(ti?.targetId), type: ti?.type, host: __h(ti?.url), listed: Array.isArray(list) ? list.filter((e) => e.targetId === info.target).map((e) => [e.type, __h(e.url)]) : undefined };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error).slice(0, 160) };
      }
    };
    __log('probe.byTargetId', { childSession: sessionId, ...(await probe({ tabId }, 'Target.getTargetInfo', { targetId: info.target })) });
    __log('probe.childSession', { childSession: sessionId, ...(await probe({ tabId, sessionId }, 'Target.getTargetInfo', {})) });
    __log('probe.childSessionById', { childSession: sessionId, ...(await probe({ tabId, sessionId }, 'Target.getTargetInfo', { targetId: info.target })) });
    __log('probe.getTargets', { childSession: sessionId, ...(await probe({ tabId }, 'Target.getTargets', {})) });
    return r;
  }
  async __readChildReobserve(tabId, sessionId, info) {`,
        ],
        [
          '  childUnderCurrentMain(tab, parentTree, frameId, generation, childTree) {',
          `  childUnderCurrentMain(tab, parentTree, frameId, generation, childTree) {
    const listed = Boolean(frameIn(parentTree, frameId));
    const live = tab.frameParents?.get(frameId);
    const kept = tab.swappedParents?.get(frameId)?.parentId;
    const r = this.__childUnderCurrentMain(tab, parentTree, frameId, generation, childTree);
    __log('pass.member', { tab: tab.id, frameId, result: r, listed, live: live === tab.mainFrameId ? 'main' : live ?? null, kept: kept === tab.mainFrameId ? 'main' : kept ?? null, genOk: tab.documents.frames.get(tab.mainFrameId)?.loaderId === generation });
    return r;
  }
  __childUnderCurrentMain(tab, parentTree, frameId, generation, childTree) {`,
        ],
        [
          '  async childReobservePass(_tabId, targetInfo, tree) {',
          `  async childReobservePass(_tabId, targetInfo, tree) {
    const r = await this.__childReobservePass(_tabId, targetInfo, tree);
    __log('pass.judge', { tab: _tabId, targetId: targetInfo?.targetId, result: r });
    return r;
  }
  async __childReobservePass(_tabId, targetInfo, tree) {`,
        ],
        [
          '  async reobserveStaleChildren(tabId, startedRevision) {',
          `  async reobserveStaleChildren(tabId, startedRevision) {
    const tab0 = this.tabState(tabId);
    __log('pass.start', { tab: tabId, revision: startedRevision, now: tab0?.debuggerRevision, stale: [...(tab0?.debuggerChildInfo?.values() ?? [])].filter((i) => i.revision !== startedRevision).map((i) => i.target) });
    try {
      return await this.__reobserveStaleChildren(tabId, startedRevision);
    } finally {
      const tab1 = this.tabState(tabId);
      __log('pass.end', { tab: tabId, revision: startedRevision, now: tab1?.debuggerRevision, children: [...(tab1?.debuggerChildInfo?.values() ?? [])].map((i) => [i.target, i.revision, __h(i.url)]) });
    }
  }
  async __reobserveStaleChildren(tabId, startedRevision) {`,
        ],
        [
          '  scheduleChildReobserve(tabId) {',
          `  scheduleChildReobserve(tabId) {
    const tabS = this.tabState(tabId);
    __log('pass.schedule', { tab: tabId, revision: tabS?.debuggerRevision, running: tabS?.childReobserveRunning ?? null });
    return this.__scheduleChildReobserve(tabId);
  }
  __scheduleChildReobserve(tabId) {`,
        ],
      ];
      for (const [site, next] of wraps) {
        assert.ok(cdp.includes(site), site);
        cdp = cdp.replace(site, next);
      }
      await writeFile(cdpPath, `${cdp}\n${host}\n`);
      await writeFile(
        path,
        `${source}
globalThis.__diag = [];
const __t0 = performance.now();
globalThis.__t0 = __t0;
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
    const reasons = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await sliccExtension.frames(Number(targetId));
        return { attempt, ok: true };
      } catch (error) {
        last = error.message;
        reasons.push(last);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { ok: false, last, reasons: [...new Set(reasons)] };
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

test('diag: repeated error frame settling on both hosts', async (t) => {
  const evaluate = await worker();
  const rows = [];
  for (const host of ['seven.sliccy.ai', 'www.sliccy.ai']) {
    const page = await chrome.visit(t, `https://${host}/`);
    for (let rep = 0; rep < 32; rep += 1) {
      const url = `https://ordinary.test/doc?swap-repeat-${host}-${rep}`;
      const target = await chrome.visit(t, url);
      const targetId = await attach(page, url);
      await evaluate('globalThis.__diag = []; true');
      await frame(target);
      const polled = await poll(page, targetId);
      const events = await evaluate('globalThis.__diag');
      const changed = events.findLastIndex(
        (e) => e.method === 'Target.targetInfoChanged' && e.host === '127.0.0.1:1'
      );
      const committed = events.findIndex(
        (e) => e.method === 'webNavigation.onCommitted' && e.frameId > 0
      );
      const swapped = events.findLastIndex(
        (e) => e.method === 'Page.frameDetached' && e.reason === 'swap'
      );
      const forcing = changed >= 0 && committed >= 0 && changed < committed;
      rows.push({
        swapBeforeCommit: swapped >= 0 && committed >= 0 && swapped < committed,
        timeline: polled.ok && !forcing ? undefined : events,
        host,
        rep,
        forcing,
        ...polled,
      });
      await target.close?.().catch(() => undefined);
    }
  }
  for (const row of rows) report('row', row);
  for (const host of ['seven.sliccy.ai', 'www.sliccy.ai']) {
    for (const forcing of [true, false]) {
      const group = rows.filter((row) => row.host === host && row.forcing === forcing);
      report('summary', {
        host,
        variant: forcing ? 'forcing' : 'other',
        total: group.length,
        ok: group.filter((row) => row.ok).length,
        swapBeforeCommit: group.filter((row) => row.swapBeforeCommit).length,
      });
    }
  }
  assert.deepEqual(
    rows.filter((row) => !row.ok),
    []
  );
});
