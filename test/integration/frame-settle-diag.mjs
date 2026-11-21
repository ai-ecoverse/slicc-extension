import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { launch } from './chrome.mjs';
import { extId } from './extension-page.mjs';

const instrument = `
const __diag = (globalThis.__diag ??= { tl: [], polls: [], conns: new Map() });
const __log = (ev, data) => {
  if (__diag.tl.length < 60000) __diag.tl.push({ t: Date.now(), ev, ...data });
};
const __short = (value) => (typeof value === 'string' ? value.slice(0, 120) : value);
const __childInfo = (tab) =>
  [...(tab?.debuggerChildInfo?.entries() ?? [])].map(([id, info]) => ({
    id: String(id).slice(0, 8),
    target: String(info?.target ?? '').slice(0, 8),
    type: info?.type,
    url: __short(info?.url),
    gen: info?.generation === tab?.documents?.frames?.get(tab.mainFrameId)?.loaderId,
    rev: info?.revision,
  }));
const __remember = (conn, tabId) => {
  if (Number.isSafeInteger(tabId) && conn.tabState(tabId)) __diag.conns.set(tabId, conn);
};
const __wrap = (name, before, after) => {
  const original = Connection.prototype[name];
  Connection.prototype[name] = function (...args) {
    const context = before ? before.call(this, ...args) : undefined;
    const started = Date.now();
    let result;
    try {
      result = original.apply(this, args);
    } catch (error) {
      if (after) after.call(this, args, context, { error, ms: Date.now() - started });
      throw error;
    }
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => {
          if (after) after.call(this, args, context, { value, ms: Date.now() - started });
          return value;
        },
        (error) => {
          if (after) after.call(this, args, context, { error, ms: Date.now() - started });
          throw error;
        }
      );
    }
    if (after) after.call(this, args, context, { value: result, ms: Date.now() - started });
    return result;
  };
};
__wrap(
  'frames',
  function (tabId) {
    __remember(this, tabId);
    const tab = this.tabState(tabId);
    return { rev: tab?.debuggerRevision, info: __childInfo(tab) };
  },
  function ([tabId], context, { error, ms }) {
    const tab = this.tabState(tabId);
    __diag.polls.push({
      t: Date.now(),
      tabId,
      ok: !error,
      ms,
      why: error ? (error.why ?? 'thrown:' + __short(String(error?.message ?? error))) : null,
      revStart: context.rev,
      rev: tab?.debuggerRevision,
      known: tab ? this.debuggerGate.knownChildren(tab) : null,
      infoStart: context.info,
      running: tab?.childReobserveRunning ?? null,
      pending: tab?.childReobservePending ?? null,
    });
    if (__diag.polls.length > 20000) __diag.polls.shift();
  }
);
__wrap(
  'onCommit',
  function (details) {
    const tab = this.tabState(details?.tabId);
    __remember(this, details?.tabId);
    return { rev: tab?.debuggerRevision };
  },
  function ([details], context) {
    const tab = this.tabState(details?.tabId);
    if (!tab) return;
    __log('commit', {
      tabId: details.tabId,
      frameId: details.frameId,
      url: __short(details.url),
      tt: details.transitionType,
      revBefore: context.rev,
      rev: tab.debuggerRevision,
      running: tab.childReobserveRunning ?? null,
      pending: tab.childReobservePending ?? null,
    });
  }
);
__wrap('watchChild', null, function ([tabId, method, p]) {
  __remember(this, tabId);
  const tab = this.tabState(tabId);
  __log(method, {
    tabId,
    session: String(p?.sessionId ?? '').slice(0, 8),
    target: String(p?.targetInfo?.targetId ?? '').slice(0, 8),
    type: p?.targetInfo?.type,
    url: __short(p?.targetInfo?.url),
    title: __short(p?.targetInfo?.title),
    rev: tab?.debuggerRevision,
  });
});
__wrap(
  'scheduleChildReobserve',
  function (tabId) {
    const tab = this.tabState(tabId);
    return { running: tab?.childReobserveRunning ?? null, pending: tab?.childReobservePending ?? null };
  },
  function ([tabId], context) {
    const tab = this.tabState(tabId);
    __log('schedule', { tabId, rev: tab?.debuggerRevision, ...context });
  }
);
__wrap(
  'runChildReobserve',
  function (tabId, started) {
    __log('run:start', { tabId, started });
    return { started };
  },
  function ([tabId, started], _context, { ms }) {
    const tab = this.tabState(tabId);
    __log('run:end', {
      tabId,
      started,
      ms,
      rev: tab?.debuggerRevision,
      running: tab?.childReobserveRunning ?? null,
      stale: __childInfo(tab).filter((c) => c.rev !== tab?.debuggerRevision).map((c) => c.id),
    });
  }
);
__wrap(
  'reobserveStaleChildren',
  function (tabId, started) {
    const tab = this.tabState(tabId);
    __diag.cur = tabId;
    __log('reobserve:start', { tabId, started, rev: tab?.debuggerRevision, info: __childInfo(tab) });
  },
  function ([tabId, started], _context, { ms, error }) {
    const tab = this.tabState(tabId);
    __log('reobserve:end', {
      tabId,
      started,
      ms,
      error: error ? __short(String(error?.message ?? error)) : null,
      rev: tab?.debuggerRevision,
      info: __childInfo(tab),
    });
  }
);
__wrap('childReobserveGeneration', null, function ([tab, parentTree], _c, { value }) {
  __log('generation', {
    tabId: __diag.cur,
    ok: Boolean(value),
    treeMain: String(parentTree?.frame?.id ?? '').slice(0, 8),
    main: String(tab?.mainFrameId ?? '').slice(0, 8),
    treeChildren: (parentTree?.childFrames ?? []).map((c) => ({
      id: String(c?.frame?.id ?? '').slice(0, 8),
      url: __short(c?.frame?.url),
    })),
  });
});
__wrap('readChildReobserve', null, function ([tabId, sessionId], _c, { value, ms }) {
  __log('read', {
    tabId,
    session: String(sessionId).slice(0, 8),
    ms,
    treeUrl: __short(value?.tree?.frame?.url),
    unreachable: __short(value?.tree?.frame?.unreachableUrl),
    treeId: String(value?.tree?.frame?.id ?? '').slice(0, 8),
    hasTree: Boolean(value?.tree),
    tiUrl: __short(value?.targetInfo?.url),
    tiType: value?.targetInfo?.type,
    tiTitle: __short(value?.targetInfo?.title),
    hasTi: Boolean(value?.targetInfo),
  });
});
__wrap('childUnderCurrentMain', null, function ([tab, parentTree, frameId, generation], _c, { value }) {
  __log('under', {
    tabId: __diag.cur,
    frameId: String(frameId ?? '').slice(0, 8),
    value,
    inTree: Boolean(frameIn(parentTree, frameId)),
    parent: String(tab?.frameParents?.get(frameId) ?? '').slice(0, 8),
    hasParent: Boolean(tab?.frameParents?.has(frameId)),
    main: String(tab?.mainFrameId ?? '').slice(0, 8),
    genOk: tab?.documents?.frames?.get(tab.mainFrameId)?.loaderId === generation,
  });
});
__wrap('childReobservePass', null, function ([, targetInfo, tree], _c, { value }) {
  __log('pass', {
    tabId: __diag.cur,
    target: String(targetInfo?.targetId ?? '').slice(0, 8),
    value,
    treeUrl: __short(tree?.frame?.url),
    tiUrl: __short(targetInfo?.url),
  });
});
__wrap('stampChildReobserve', null, function ([tabId, tab, started, , , read], _c, { value }) {
  __log('stamp', {
    tabId,
    session: String(read?.sessionId ?? '').slice(0, 8),
    started,
    rev: tab?.debuggerRevision,
    value,
  });
});
__wrap('onEvent', function (source, method, params) {
  if (
    !/^Target\\.|^Page\\.(frameAttached|frameDetached|frameNavigated|frameStartedLoading|frameStoppedLoading|navigatedWithinDocument|frameStartedNavigating)/.test(
      method
    ) ||
    !this.tabState(source?.tabId)
  )
    return;
  __log('ev:' + method, {
    tabId: source?.tabId,
    from: String(source?.sessionId ?? 'root').slice(0, 8),
    frameId: String(params?.frameId ?? params?.frame?.id ?? '').slice(0, 8),
    parent: String(params?.parentFrameId ?? params?.frame?.parentId ?? '').slice(0, 8),
    url: __short(params?.frame?.url ?? params?.url ?? params?.targetInfo?.url),
    unreachable: __short(params?.frame?.unreachableUrl),
    target: String(params?.targetInfo?.targetId ?? '').slice(0, 8),
  });
});
for (const name of ['onBeforeNavigate', 'onCommitted', 'onErrorOccurred', 'onCompleted']) {
  globalThis.chrome?.webNavigation?.[name]?.addListener((d) => {
    if (!__diag.conns.has(d.tabId)) return;
    __log('wn:' + name, {
      tabId: d.tabId,
      frameId: d.frameId,
      parent: d.parentFrameId,
      url: __short(d.url),
      error: d.error,
    });
  });
}
globalThis.__diagSnap = async (tabId) => {
  const conn = __diag.conns.get(tabId);
  const tab = conn?.tabState(tabId);
  const all = await globalThis.chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  return {
    t: Date.now(),
    rev: tab?.debuggerRevision,
    frameEvents: tab?.frameEvents,
    known: tab ? conn.debuggerGate.knownChildren(tab) : null,
    running: tab?.childReobserveRunning ?? null,
    pending: tab?.childReobservePending ?? null,
    info: __childInfo(tab),
    native: (all ?? []).map((f) => ({
      id: f.frameId,
      url: __short(f.url),
      err: f.errorOccurred,
      life: f.documentLifecycle,
    })),
  };
};
`;

export async function prepare(paths) {
  const cdpPath = join(paths[0], 'cdp.js');
  const cdp = await readFile(cdpPath, 'utf8');
  const refuseSite = `    const refuse = () => {
      throw new Error('slicc: refused: unsettled frame list');
    };`;
  const knownSite = 'if (!generation || !this.debuggerGate.knownChildren(tab)) refuse();';
  assert.ok(cdp.includes(refuseSite), 'refuse site');
  assert.ok(cdp.includes(knownSite), 'known site');
  assert.equal(cdp.split(').catch(refuse);').length, 2, 'catch site');
  let next = cdp
    .replace(
      refuseSite,
      `    const refuse = (why) => {
      const error = new Error('slicc: refused: unsettled frame list');
      error.why = why;
      throw error;
    };`
    )
    .replace(
      knownSite,
      "if (!generation) refuse('no-generation');\n        if (!this.debuggerGate.knownChildren(tab)) refuse('knownChildren');"
    )
    .replace(
      ').catch(refuse);',
      ").catch((error) => refuse(error?.why ?? 'bounded:' + String(error?.message ?? error).slice(0, 120)));"
    );
  next = next
    .split('\n')
    .map((line, index) => line.replace('refuse();', `refuse('L${index + 1}');`))
    .join('\n');
  next += instrument;
  await writeFile(cdpPath, next);
}

export async function untilWorker(chrome) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const worker = targetInfos.find(
      (info) =>
        info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
    );
    if (worker) {
      const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
        targetId: worker.targetId,
        flatten: true,
      });
      return sessionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('extension worker missing');
}

export async function workerEval(chrome, sessionId, expression) {
  const answer = await chrome.cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  assert.equal(answer.exceptionDetails, undefined, expression);
  return answer.result?.value;
}

async function framed(chrome, t, host, i) {
  const visitStart = Date.now();
  const page = await chrome.visit(t, `https://${host}/`);
  const url = `https://ordinary.test/doc?error-frame-diag-${host}-${i}-${Date.now()}`;
  const target = await chrome.visit(t, url);
  const visitMs = Date.now() - visitStart;
  const targetId = await page.evaluate(async (pageUrl) => {
    const listed = await sliccExtension.cdp.send('Target.getTargets');
    const info = listed.targetInfos.find((entry) => entry.url === pageUrl);
    if (!info) throw new Error('ordinary fixture target was not listed');
    const attached = await sliccExtension.cdp.send('Target.attachToTarget', {
      targetId: info.targetId,
      flatten: true,
    });
    if (!attached.sessionId) throw new Error('ordinary fixture target was not attached');
    return info.targetId;
  }, url);
  const appended = Date.now();
  const loads = await target.evaluate(
    async (sources) => {
      const at = [];
      await Promise.all(
        sources.map(
          (src, index) =>
            new Promise((resolve) => {
              const iframe = document.createElement('iframe');
              iframe.onload = () => {
                at[index] = Date.now();
                resolve();
              };
              iframe.src = src;
              document.body.append(iframe);
            })
        )
      );
      return at;
    },
    [
      'https://127.0.0.1:1/ERROR_FRAME_CANARY?q=CANARY',
      `https://other.test/doc?ERROR_FRAME_SIBLING_CANARY=${host}-${i}-${Date.now()}`,
    ]
  );
  return { page, target, targetId, appended, loads, visitMs };
}

function compact(list) {
  const out = [];
  for (const item of list) {
    const key = JSON.stringify({ ...item, t: undefined, n: undefined, ms: undefined });
    const last = out.at(-1);
    if (last && last.key === key) {
      last.n += 1;
      last.tLast = item.t;
    } else out.push({ key, n: 1, ...item });
  }
  return out.map(({ key, ...rest }) => rest);
}

async function chromeView(chrome, target) {
  const [{ targetInfos }, tree] = await Promise.all([
    chrome.cdp.send('Target.getTargets'),
    target.send('Page.getFrameTree').catch(() => null),
  ]);
  return {
    iframes: targetInfos
      .filter((info) => info.type === 'iframe')
      .filter((info) => /CANARY/.test(info.url))
      .map((info) => ({
        id: info.targetId.slice(0, 8),
        url: info.url.slice(0, 80),
        title: info.title.slice(0, 40),
        attached: info.attached,
      })),
    local: (tree?.frameTree?.childFrames ?? []).map((c) => ({
      id: c.frame.id.slice(0, 8),
      url: c.frame.url.slice(0, 60),
      unreachable: c.frame.unreachableUrl?.slice(0, 60),
    })),
  };
}

async function probeRep(chrome, t, sw, host, i) {
  const { page, target, targetId, appended, loads, visitMs } = await framed(chrome, t, host, i);
  const tabId = Number(targetId);
  const polls = [];
  let settledAt = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const reply = await page.evaluate(async (id) => {
      const started = Date.now();
      try {
        await sliccExtension.frames(id);
        return { ok: true, t: Date.now(), ms: Date.now() - started };
      } catch (error) {
        return { ok: false, t: Date.now(), ms: Date.now() - started, error: error.message };
      }
    }, tabId);
    const [snap, view] = await Promise.all([
      workerEval(chrome, sw, `globalThis.__diagSnap(${tabId})`),
      chromeView(chrome, target),
    ]);
    const last = await workerEval(
      chrome,
      sw,
      `(globalThis.__diag.polls.filter((p) => p.tabId === ${tabId}).at(-1) ?? null)`
    );
    polls.push({
      a: attempt,
      t: reply.t - appended,
      ms: reply.ms,
      ok: reply.ok,
      why: last?.why ?? null,
      snap: { ...snap, t: undefined },
      view,
    });
    if (reply.ok) {
      settledAt = attempt;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { tabId, appended, loads, visitMs, polls, settledAt };
}

async function quietRep(chrome, t, host, i) {
  const { page, targetId, appended, loads, visitMs } = await framed(chrome, t, host, i);
  const tabId = Number(targetId);
  const reply = await page.evaluate(async (id) => {
    const polls = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const started = Date.now();
      try {
        await sliccExtension.frames(id);
        polls.push({ a: attempt, t: Date.now(), ms: Date.now() - started, ok: true });
        break;
      } catch (error) {
        polls.push({ a: attempt, t: Date.now(), ms: Date.now() - started, ok: false });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return polls;
  }, tabId);
  const settled = reply.find((p) => p.ok);
  return {
    tabId,
    appended,
    loads,
    visitMs,
    polls: reply.map((p) => ({ ...p, t: p.t - appended })),
    settledAt: settled ? settled.a : null,
  };
}

function shapeTimeline(tl, tabId, appended) {
  return tl
    .filter((e) => e.tabId === tabId)
    .map((e) => ({ ...e, t: e.t - appended, tabId: undefined }));
}

export async function scenario(t, host, mode) {
  const launched = Date.now();
  const chrome = await launch({ prepare });
  const launchMs = Date.now() - launched;
  t.after(() => chrome.close());
  let sw = mode === 'probe' ? await untilWorker(chrome) : null;
  const reps = [];
  for (let i = 0; i < 10; i += 1) {
    await t.test(`${mode} ${host} rep ${i}`, async (st) => {
      const load = loadavg()[0];
      const rep =
        mode === 'probe'
          ? await probeRep(chrome, st, sw, host, i)
          : await quietRep(chrome, st, host, i);
      reps.push({ i, load, ...rep });
    });
  }
  sw ??= await untilWorker(chrome);
  const tl = await workerEval(chrome, sw, 'globalThis.__diag.tl');
  const swPolls = await workerEval(chrome, sw, 'globalThis.__diag.polls');
  for (const rep of reps) {
    const settledPoll = rep.settledAt == null ? null : rep.polls.find((p) => p.a === rep.settledAt);
    const timeline = shapeTimeline(tl, rep.tabId, rep.appended);
    const whys = compact(
      swPolls
        .filter((p) => p.tabId === rep.tabId)
        .map((p) => ({
          t: p.t - rep.appended,
          ok: p.ok,
          why: p.why,
          rev: p.rev,
          known: p.known,
          info: p.infoStart.map((c) => `${c.id}:${c.rev}:${c.gen ? 'g' : 'G'}:${c.url}`),
          running: p.running,
          pending: p.pending,
        }))
    );
    const out = {
      mode,
      host,
      i: rep.i,
      launchMs,
      load: rep.load,
      visitMs: rep.visitMs,
      loads: rep.loads.map((x) => x - rep.appended),
      settledAt: rep.settledAt,
      within30: rep.settledAt != null && rep.settledAt < 30,
      settleMs: settledPoll ? settledPoll.t : null,
      fromLastOnload: settledPoll ? settledPoll.t - (Math.max(...rep.loads) - rep.appended) : null,
      lastPollT: rep.polls.at(-1)?.t,
      whys,
      timeline,
      polls: mode === 'probe' ? compact(rep.polls.map((p) => ({ ...p, a: undefined }))) : undefined,
    };
    console.log(`FRAME_SETTLE_DIAG ${JSON.stringify(out)}`);
  }
  const settled = reps.filter((r) => r.settledAt != null);
  console.log(
    `FRAME_SETTLE_SUMMARY ${JSON.stringify({
      mode,
      host,
      launchMs,
      reps: reps.length,
      settled: settled.length,
      within30: settled.filter((r) => r.settledAt < 30).length,
      settledAt: reps.map((r) => r.settledAt),
      settleMs: reps.map((r) => {
        const p = r.settledAt == null ? null : r.polls.find((x) => x.a === r.settledAt);
        return p ? p.t : null;
      }),
    })}`
  );
  assert.equal(reps.length, 10);
}
