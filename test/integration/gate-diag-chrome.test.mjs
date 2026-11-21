import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { extId } from './extension-page.mjs';

const HOST = `const __h = (u) => { try { const x = new URL(String(u)); return x.protocol === 'chrome-error:' ? 'chrome-error' : x.host || x.protocol; } catch { return String(u ?? '').slice(0, 12); } };
const __log = (m, o) => globalThis.__diag?.push({ t: Math.round(performance.now() - (globalThis.__t0 ?? 0)), method: m, ...o });`;

const WRAPS = [
  [
    '  async readChildReobserve(tabId, sessionId, info) {',
    `  async readChildReobserve(tabId, sessionId, info) {
    const r = await this.__readChildReobserve(tabId, sessionId, info);
    const f = r.tree?.frame;
    __log('pass.read', { childSession: sessionId, targetId: info.target, treeOk: Boolean(f), treeUrl: __h(f?.url), unreachable: __h(f?.unreachableUrl), rootIsTarget: f?.id === info.target, parentId: f?.parentId, infoOk: Boolean(r.targetInfo), infoSame: r.targetInfo?.targetId === info.target, host: __h(r.targetInfo?.url) });
    return r;
  }
  async __readChildReobserve(tabId, sessionId, info) {`,
  ],
  [
    '  async childReobservePass(_tabId, targetInfo, tree, type, target) {',
    `  async childReobservePass(_tabId, targetInfo, tree, type, target) {
    const r = await this.__childReobservePass(_tabId, targetInfo, tree, type, target);
    __log('pass.judge', { targetId: target, type, result: r });
    return r;
  }
  async __childReobservePass(_tabId, targetInfo, tree, type, target) {`,
  ],
  [
    '  async stampChildReobserve(tabId, tab, startedRevision, parentTree, generation, read) {',
    `  async stampChildReobserve(tabId, tab, startedRevision, parentTree, generation, read) {
    const r = await this.__stampChildReobserve(tabId, tab, startedRevision, parentTree, generation, read);
    __log('pass.stamp', { targetId: read.info.target, result: r, source: read.targetInfo ? 'targetInfo' : 'tree', host: __h(read.targetInfo?.url ?? read.tree?.frame?.unreachableUrl ?? read.tree?.frame?.url) });
    return r;
  }
  async __stampChildReobserve(tabId, tab, startedRevision, parentTree, generation, read) {`,
  ],
  [
    '  async reobserveStaleChildren(tabId, startedRevision) {',
    `  async reobserveStaleChildren(tabId, startedRevision) {
    const before = this.tabState(tabId);
    __log('pass.start', { revision: startedRevision, stale: [...(before?.debuggerChildInfo?.values() ?? [])].filter((i) => i.revision !== startedRevision).map((i) => i.target) });
    try {
      return await this.__reobserveStaleChildren(tabId, startedRevision);
    } finally {
      const now = this.tabState(tabId);
      __log('pass.end', { revision: startedRevision, now: now?.debuggerRevision, children: [...(now?.debuggerChildInfo?.values() ?? [])].map((i) => [i.target, i.revision, __h(i.url)]) });
    }
  }
  async __reobserveStaleChildren(tabId, startedRevision) {`,
  ],
];

const BACKGROUND = `
globalThis.__diag = [];
globalThis.__t0 = performance.now();
globalThis.__mode = 'natural';
const __stamp = () => Math.round(performance.now() - globalThis.__t0);
const __raw = (source, method, params) => {
  if (!/^(Page\\.frame|Target\\.)/.test(method)) return;
  const p = params ?? {};
  globalThis.__diag.push({ t: __stamp(), session: source?.sessionId ?? null, method, frameId: p.frameId ?? p.frame?.id, reason: p.reason, targetId: p.targetInfo?.targetId ?? p.targetId, host: __h(p.targetInfo?.url ?? p.frame?.url) });
};
chrome.debugger.onEvent.addListener(__raw);
chrome.webNavigation.onCommitted.addListener((d) => {
  globalThis.__diag.push({ t: __stamp(), method: 'webNavigation.onCommitted', frameId: d.frameId });
});
const __delayOf = {
  event: (source, method, params) => {
    if (globalThis.__mode !== 'bumpThenSwap' || source?.sessionId) return 0;
    return method === 'Page.frameDetached' && params?.reason === 'swap' ? 200 : 0;
  },
  commit: (details) => {
    if (!(details?.frameId > 0)) return 0;
    if (globalThis.__mode === 'swapThenBump') return 150;
    if (globalThis.__mode === 'bumpThenSwap') return 40;
    return 0;
  },
};
function __wrap(target, delay, describe) {
  const add = target.addListener.bind(target);
  const remove = target.removeListener.bind(target);
  const wrapped = new Map();
  target.addListener = (fn) => {
    const next = (...args) => {
      const ms = delay(...args);
      const deliver = () => {
        globalThis.__diag.push({ t: __stamp(), method: 'deliver', ...describe(...args) });
        return fn(...args);
      };
      if (!ms) return deliver();
      setTimeout(deliver, ms);
    };
    wrapped.set(fn, next);
    return add(next);
  };
  target.removeListener = (fn) => remove(wrapped.get(fn) ?? fn);
}
__wrap(chrome.debugger.onEvent, __delayOf.event, (source, method, params) => ({
  what: method,
  session: source?.sessionId ?? null,
  frameId: params?.frameId,
  reason: params?.reason,
  targetId: params?.targetInfo?.targetId,
  host: __h(params?.targetInfo?.url),
}));
__wrap(chrome.webNavigation.onCommitted, __delayOf.commit, (details) => ({
  what: 'webNavigation.onCommitted',
  frameId: details?.frameId,
}));
`;

let chrome;
before(async () => {
  chrome = await launch({
    prepare: async (paths) => {
      const cdpPath = join(paths[0], 'cdp.js');
      let cdp = await readFile(cdpPath, 'utf8');
      for (const [site, next] of WRAPS) {
        assert.ok(cdp.includes(site), site);
        cdp = cdp.replace(site, next);
      }
      await writeFile(cdpPath, `${cdp}\n${HOST}\n`);
      const path = join(paths[0], 'background.js');
      const source = await readFile(path, 'utf8');
      await writeFile(path, `${source}\n${HOST}\n${BACKGROUND}`);
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

async function frame(target, host, rep) {
  await target.evaluate(
    async (sources) => {
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
    },
    [
      'https://127.0.0.1:1/ERROR_FRAME_CANARY?q=CANARY',
      `https://other.test/doc?ERROR_FRAME_SIBLING_CANARY=${host}-${rep}`,
    ]
  );
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
    const reasons = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await sliccExtension.frames(Number(targetId));
        return { attempt, ok: true };
      } catch (error) {
        reasons.push(error.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { ok: false, reasons: [...new Set(reasons)] };
  }, targetId);
}

function order(events) {
  const delivered = events.filter((e) => e.method === 'deliver');
  const change = delivered.findLastIndex(
    (e) => e.what === 'Target.targetInfoChanged' && e.host === '127.0.0.1:1'
  );
  const canary = delivered[change]?.targetId;
  const bump = delivered.findIndex((e) => e.what === 'webNavigation.onCommitted' && e.frameId > 0);
  const swap = delivered.findIndex(
    (e) => e.what === 'Page.frameDetached' && e.reason === 'swap' && e.frameId === canary
  );
  if (change < 0 || bump < 0) return 'incomplete';
  if (bump < change) return 'bump-change';
  if (swap < 0) return 'change-bump-noswap';
  return swap < bump ? 'change-swap-bump' : 'change-bump-swap';
}

function report(label, value) {
  console.log(`GATEDIAG ${label} ${JSON.stringify(value)}`);
}

const MODES = [
  ['natural', 22],
  ['swapThenBump', 20],
  ['bumpThenSwap', 20],
];

test('gate: error frame settling on both hosts in every order', async (t) => {
  const evaluate = await worker();
  const rows = [];
  for (const host of ['seven.sliccy.ai', 'www.sliccy.ai']) {
    const page = await chrome.visit(t, `https://${host}/`);
    let rep = 0;
    for (const [mode, count] of MODES) {
      for (let i = 0; i < count; i += 1, rep += 1) {
        await evaluate(`globalThis.__mode = 'natural'; true`);
        const url = `https://ordinary.test/doc?gate-${host}-${rep}`;
        const target = await chrome.visit(t, url);
        const targetId = await attach(page, url);
        await evaluate(`globalThis.__diag = []; globalThis.__mode = ${JSON.stringify(mode)}; true`);
        await frame(target, host, rep);
        const polled = await poll(page, targetId);
        await evaluate(`globalThis.__mode = 'natural'; true`);
        const events = await evaluate('globalThis.__diag');
        const stamps = events.filter((e) => e.method === 'pass.stamp' && e.result === true);
        rows.push({
          host,
          rep,
          mode,
          order: order(events),
          stamped: stamps.length,
          stampedTargetInfo: stamps.filter((e) => e.source === 'targetInfo').length,
          stampedTree: stamps.filter((e) => e.source === 'tree').length,
          canaryStamped: stamps.some((e) => e.host === '127.0.0.1:1'),
          ...polled,
          timeline: polled.ok ? undefined : events,
        });
        await target.close?.().catch(() => undefined);
      }
    }
  }
  for (const row of rows) report('row', row);
  const groups = new Map();
  for (const row of rows) {
    for (const key of [`${row.host} ${row.mode} ${row.order}`, `${row.host} ${row.mode}`]) {
      const entry = groups.get(key) ?? {
        total: 0,
        ok: 0,
        stamped: 0,
        stampedTargetInfo: 0,
        stampedTree: 0,
        canaryStamped: 0,
      };
      entry.total += 1;
      if (row.ok) entry.ok += 1;
      entry.stamped += row.stamped;
      entry.stampedTargetInfo += row.stampedTargetInfo;
      entry.stampedTree += row.stampedTree;
      if (row.canaryStamped) entry.canaryStamped += 1;
      groups.set(key, entry);
    }
  }
  for (const [key, entry] of groups) report('summary', { key, ...entry });
  for (const host of ['seven.sliccy.ai', 'www.sliccy.ai']) {
    const mine = rows.filter((row) => row.host === host);
    report('host', { host, total: mine.length, ok: mine.filter((row) => row.ok).length });
  }
  assert.deepEqual(
    rows.filter((row) => !row.ok).map(({ host, rep, mode, order }) => ({ host, rep, mode, order })),
    []
  );
});
