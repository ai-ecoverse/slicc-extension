import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { launch } from './chrome.mjs';
import { extId } from './extension-page.mjs';

async function prepare(paths) {
  const cdpPath = join(paths[0], 'cdp.js');
  const cdp = await readFile(cdpPath, 'utf8');
  const framesSite = '  async frames(tabId, { errors = false } = {}) {';
  const refuseSite = `    const refuse = () => {
      throw new Error('slicc: refused: unsettled frame list');
    };`;
  const reobserveSite = '  async reobserveStaleChildren(tabId, startedRevision) {';
  assert.ok(cdp.includes(framesSite), 'frames site');
  assert.ok(cdp.includes(refuseSite), 'refuse site');
  assert.ok(cdp.includes(reobserveSite), 'reobserve site');
  let next = cdp.replace(
    refuseSite,
    `    const refuse = (why = 'unlabeled') => {
      globalThis.__lastRefuseWhy = why;
      throw new Error('slicc: refused: unsettled frame list');
    };`
  );
  next = next
    .replace(
      'if (this.closed || !Number.isSafeInteger(tabId) || !tab) refuse();',
      "if (this.closed || !Number.isSafeInteger(tabId) || !tab) refuse('no-tab');"
    )
    .replace(
      'if (!generation || !this.debuggerGate.knownChildren(tab)) refuse();',
      "if (!generation) refuse('no-generation');\n        if (!this.debuggerGate.knownChildren(tab)) refuse('knownChildren');"
    )
    .replace(
      `        if (
          targets.size !== entries.length ||
          tab.debuggerChildInfo.size !== tab.debuggerChildren.size
        )
          refuse();`,
      `        if (targets.size !== entries.length) refuse('target-dup');\n        if (tab.debuggerChildInfo.size !== tab.debuggerChildren.size) refuse('child-size');`
    )
    .replace(
      'if (!Number.isSafeInteger(owner?.backendNodeId) || owner.backendNodeId <= 0) refuse();',
      "if (!Number.isSafeInteger(owner?.backendNodeId) || owner.backendNodeId <= 0) refuse('getFrameOwner');"
    )
    .replace(
      'if (new Set(owners.map((owner) => owner.backendNodeId)).size !== owners.length) refuse();',
      "if (new Set(owners.map((owner) => owner.backendNodeId)).size !== owners.length) refuse('owner-dup');"
    )
    .replace(
      `    ).catch(refuse);
    if (
      this.closed ||
      this.tabState(tabId) !== tab ||
      tab.debuggerRevision !== debuggerRevision ||
      tab.documents.frames.get(tab.mainFrameId)?.loaderId !== generation ||
      this.debuggerGate.childKey(tab) !== children ||
      !Array.isArray(frames) ||
      !frames.length
    )
      refuse();`,
      `    ).catch(() => refuse('bounded-or-inner'));
    if (
      this.closed ||
      this.tabState(tabId) !== tab ||
      tab.debuggerRevision !== debuggerRevision ||
      tab.documents.frames.get(tab.mainFrameId)?.loaderId !== generation ||
      this.debuggerGate.childKey(tab) !== children ||
      !Array.isArray(frames) ||
      !frames.length
    )
      refuse('post-bounded-revision');`
    )
    .replace(
      `      frames.some(
        (frame) =>
          !Number.isSafeInteger(frame.frameId) ||
          typeof frame.documentId !== 'string' ||
          !frame.documentId ||
          typeof frame.url !== 'string' ||
          !frame.url ||
          nativeFailed(frame, errors) ||
          (frame.documentLifecycle !== undefined && frame.documentLifecycle !== 'active')
      )
    )
      refuse();`,
      `      frames.some(
        (frame) =>
          !Number.isSafeInteger(frame.frameId) ||
          typeof frame.documentId !== 'string' ||
          !frame.documentId ||
          typeof frame.url !== 'string' ||
          !frame.url ||
          nativeFailed(frame, errors) ||
          (frame.documentLifecycle !== undefined && frame.documentLifecycle !== 'active')
      )
    )
      refuse('native-frames');`
    )
    .replace(
      `        if (seen.has(current.frameId)) refuse();
        seen.add(current.frameId);
        current = frames.find((candidate) => candidate.frameId === current.parentFrameId);
        if (!current) refuse();`,
      `        if (seen.has(current.frameId)) refuse('parent-cycle');
        seen.add(current.frameId);
        current = frames.find((candidate) => candidate.frameId === current.parentFrameId);
        if (!current) refuse('parent-missing');`
    )
    .replace(
      `      frame.loaderId !== generation
    )
      refuse();`,
      `      frame.loaderId !== generation
    )
      refuse('page-tree');`
    )
    .replace(
      `        (entry.childFrames !== undefined && !Array.isArray(entry.childFrames))
      )
        refuse();`,
      `        (entry.childFrames !== undefined && !Array.isArray(entry.childFrames))
      )
        refuse('local-tree');`
    )
    .replace(
      `      localFrames.length + remoteOwners.length !== frames.length
    )
      refuse();`,
      `      localFrames.length + remoteOwners.length !== frames.length
    )
      refuse('local-remote-count');`
    )
    .replace(
      'if (pages.length !== frames.filter((frame) => erroredFrame(frame)).length) refuse();',
      "if (pages.length !== frames.filter((frame) => erroredFrame(frame)).length) refuse('errorTaint-count');"
    );
  next = next.replace(
    framesSite,
    `  async frames(tabId, { errors = false } = {}) {
    const started = Date.now();
    const polls = (globalThis.__framesPolls ??= []);
    globalThis.__lastRefuseWhy = null;
    try {
      const result = await this.__framesMeasured(tabId, { errors });
      const tab = this.tabState(tabId);
      polls.push(this.__framesDiag(tabId, tab, true, Date.now() - started, errors, result));
      return result;
    } catch (error) {
      const tab = this.tabState(tabId);
      polls.push(
        this.__framesDiag(tabId, tab, false, Date.now() - started, errors, null, error)
      );
      throw error;
    }
  }
  __framesDiag(tabId, tab, ok, ms, errors, result, error) {
    const childInfo = [...(tab?.debuggerChildInfo?.entries() ?? [])].map(([id, info]) => ({
      id,
      type: info?.type,
      url: info?.url,
      generation: info?.generation,
      revision: info?.revision,
      urlHttp: typeof info?.url === 'string' && /^https?:\\/\\//.test(info.url),
      genMatch: info?.generation === tab?.documents.frames.get(tab.mainFrameId)?.loaderId,
      revMatch: info?.revision === tab?.debuggerRevision,
    }));
    return {
      ok,
      ms,
      errors: Boolean(errors),
      tabId,
      why: ok ? null : globalThis.__lastRefuseWhy,
      error: error ? String(error?.message ?? error) : null,
      debuggerRevision: tab?.debuggerRevision,
      frameEvents: tab?.frameEvents,
      pendingFrames: tab?.pendingFrames?.size ?? 0,
      startedFrames: tab?.startedFrames?.size ?? 0,
      childCount: tab?.debuggerChildren?.size ?? 0,
      childInfo,
      knownChildren: tab ? this.debuggerGate.knownChildren(tab) : false,
      unplaced: tab ? this.debuggerGate.unplaced(tab) : true,
      generation: tab?.documents.frames.get(tab.mainFrameId)?.loaderId,
      reobserveRunning: tab?.childReobserveRunning ?? null,
      reobservePending: tab?.childReobservePending ?? false,
      errorTaint: result?.errorTaint,
      erroredNative: Array.isArray(result?.frames)
        ? result.frames.filter((f) => f?.url?.startsWith?.('chrome-error:') || f?.errorOccurred)
            .length
        : null,
    };
  }
  async __framesMeasured(tabId, { errors = false } = {}) {`
  );
  next = next.replace(
    reobserveSite,
    `  async reobserveStaleChildren(tabId, startedRevision) {
    const diag = (globalThis.__reobserveDiag ??= { passes: 0, ms: [], empty: 0, stamps: 0 });
    const tab = this.tabState(tabId);
    if (!tab || tab.debuggerRevision !== startedRevision) return;
    const stale = [...tab.debuggerChildInfo.entries()].filter(
      ([, info]) => info.revision !== startedRevision
    );
    if (!stale.length) {
      diag.empty += 1;
      return;
    }
    const started = Date.now();
    diag.passes += 1;
    try {
      return await this.__reobserveMeasured(tabId, startedRevision);
    } finally {
      diag.ms.push(Date.now() - started);
    }
  }
  async __reobserveMeasured(tabId, startedRevision) {`
  );
  await writeFile(cdpPath, next);
}

async function untilWorker(chrome) {
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

async function workerEval(chrome, sessionId, expression) {
  const answer = await chrome.cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  assert.equal(answer.exceptionDetails, undefined, expression);
  return answer.result?.value;
}

async function framed(chrome, t, host) {
  const page = await chrome.visit(t, `https://${host}/`);
  const url = `https://ordinary.test/doc?www-frames-diag-${host}-${Date.now()}`;
  const target = await chrome.visit(t, url);
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
  await target.evaluate(async () => {
    await Promise.all(
      [
        'https://127.0.0.1:1/ERROR_FRAME_CANARY?q=CANARY',
        'https://other.test/doc?ERROR_FRAME_SIBLING_CANARY=www-diag',
      ].map(
        (src) =>
          new Promise((resolve) => {
            const iframe = document.createElement('iframe');
            iframe.onload = resolve;
            iframe.src = src;
            document.body.append(iframe);
          })
      )
    );
  });
  return { page, targetId };
}

async function snapshot(page, targetId, attempts) {
  return page.evaluate(
    async ({ targetId, attempts }) => {
      const polls = [];
      let last;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const started = Date.now();
        try {
          last = { snapshot: await sliccExtension.frames(Number(targetId)) };
          polls.push({ attempt, ok: true, ms: Date.now() - started });
          break;
        } catch (error) {
          last = { error: error.message };
          polls.push({ attempt, ok: false, ms: Date.now() - started, error: error.message });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ...last, polls };
    },
    { targetId, attempts }
  );
}

test('www frames refuse diagnostic 10x with 100-poll budget', { timeout: 600000 }, async (t) => {
  const chrome = await launch({ prepare });
  t.after(() => chrome.close());
  const workerSession = await untilWorker(chrome);
  const runs = [];
  for (let i = 0; i < 10; i += 1) {
    await workerEval(
      chrome,
      workerSession,
      `globalThis.__framesPolls = []; globalThis.__reobserveDiag = { passes: 0, ms: [], empty: 0, stamps: 0 }; globalThis.__lastRefuseWhy = null; true`
    );
    const started = Date.now();
    const { page, targetId } = await framed(chrome, t, 'www.sliccy.ai');
    const reply = await snapshot(page, targetId, 100);
    const framesPolls = await workerEval(chrome, workerSession, 'globalThis.__framesPolls');
    const reobserve = await workerEval(chrome, workerSession, 'globalThis.__reobserveDiag');
    const fails = (framesPolls ?? []).filter((p) => !p.ok);
    const whys = Object.fromEntries(
      [...new Set(fails.map((p) => p.why ?? 'null'))].map((why) => [
        why,
        fails.filter((p) => (p.why ?? 'null') === why).length,
      ])
    );
    const run = {
      i,
      totalMs: Date.now() - started,
      settled: Boolean(reply.snapshot),
      clientPolls: reply.polls?.length ?? 0,
      framesOk: (framesPolls ?? []).filter((p) => p.ok).length,
      framesFail: fails.length,
      whys,
      lastFail: fails.at(-1) ?? null,
      firstOk: (framesPolls ?? []).find((p) => p.ok) ?? null,
      reobserve,
      knownChildrenTrail: (framesPolls ?? []).map((p) => p.knownChildren),
      childUrlTrail: (framesPolls ?? []).map((p) =>
        (p.childInfo ?? []).map((c) => ({
          url: c.url,
          urlHttp: c.urlHttp,
          genMatch: c.genMatch,
          revMatch: c.revMatch,
        }))
      ),
    };
    runs.push(run);
    console.log(`WWW_FRAMES_DIAG ${JSON.stringify(run)}`);
  }
  const settled = runs.filter((r) => r.settled).length;
  const beyond30 = runs.filter((r) => r.settled && r.clientPolls > 30).length;
  const beyond10 = runs.filter((r) => r.settled && r.clientPolls > 10).length;
  const never = runs.filter((r) => !r.settled).length;
  const whyAll = {};
  for (const run of runs) {
    for (const [why, n] of Object.entries(run.whys ?? {})) whyAll[why] = (whyAll[why] ?? 0) + n;
  }
  const summary = {
    settled,
    never,
    beyond10Polls: beyond10,
    beyond30Polls: beyond30,
    clientPollsWhenSettled: runs.filter((r) => r.settled).map((r) => r.clientPolls),
    totalMs: runs.map((r) => r.totalMs),
    reobservePasses: runs.map((r) => r.reobserve?.passes ?? 0),
    reobserveMs: runs.map((r) => r.reobserve?.ms ?? []),
    reobserveEmpty: runs.map((r) => r.reobserve?.empty ?? 0),
    whyAll,
    lastFailWhy: runs.map((r) => r.lastFail?.why ?? null),
    lastFailKnownChildren: runs.map((r) => r.lastFail?.knownChildren ?? null),
    lastFailPending: runs.map((r) => r.lastFail?.pendingFrames ?? null),
    lastFailUnplaced: runs.map((r) => r.lastFail?.unplaced ?? null),
    lastFailChildCount: runs.map((r) => r.lastFail?.childCount ?? null),
    lastFailChildUrls: runs.map((r) => (r.lastFail?.childInfo ?? []).map((c) => c.url)),
  };
  console.log(`WWW_FRAMES_DIAG_SUMMARY ${JSON.stringify(summary)}`);
  assert.ok(runs.length === 10);
});
