import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

function bounded(promise, ms, name) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} exceeded ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

for (const mode of ['holder-death', 'session-loss', 'worker-restart']) {
  test(`675 extension browser rescue ${mode}`, {
    skip: process.env.SLICC_675_STAGE1_DIAGNOSTIC !== '1',
    timeout: 90000,
  }, async (t) => {
    const row = {
      mode,
      route: 'extension',
      scope: 'Real extension attachment lifecycle; not bios/Rust/shipped acceptance',
      noObserverDebugger: true,
      noObserverResume: true,
      boundMs: mode === 'worker-restart' ? 45000 : 5500,
      events: [],
    };
    t.after(async () => {
      if (!process.env.SLICC_PROOF_TRACE_DIR) return;
      await mkdir(process.env.SLICC_PROOF_TRACE_DIR, { recursive: true });
      await writeFile(
        join(process.env.SLICC_PROOF_TRACE_DIR, `cdp-675-extension-rescue-${mode}.json`),
        JSON.stringify(row, null, 2)
      );
    });
    let continuePage;
    const server = createServer((request, response) => {
      if (request.url.startsWith('/continued')) {
        continuePage?.();
        response.writeHead(204).end();
        return;
      }
      response
        .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
        .end(
          '<!doctype html><title>Owned pause rescue</title><script>globalThis.continued = 1; fetch("/continued", {cache:"no-store"});</script>'
        );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const url = `http://127.0.0.1:${server.address().port}/page`;
    const previous = process.env.SLICC_HARNESS_EXTENSION;
    process.env.SLICC_HARNESS_EXTENSION = '0';
    let chrome;
    try {
      chrome = await launch({
        prepare: async (paths) => {
          paths.splice(1);
          const background = join(paths[0], 'background.js');
          const source = await readFile(background, 'utf8');
          const site = 'void debuggerRescue(chrome).ready.catch(() => undefined);';
          assert.ok(source.includes(site));
          await writeFile(
            background,
            source.replace(
              site,
              `
const unitWorker = crypto.randomUUID();
const nativeSend = chrome.debugger.sendCommand.bind(chrome.debugger);
const nativeDetach = chrome.debugger.detach.bind(chrome.debugger);
let auditQueue = Promise.resolve();
async function note(target, method, phase) {
  auditQueue = auditQueue.then(async () => {
    const stored = await chrome.storage.session.get(['__675audit', 'slicc:debugger:675']);
    const audit = stored.__675audit ?? [];
    audit.push({ worker: unitWorker, method, phase, tabId: target.tabId, at: Date.now(), owner: stored['slicc:debugger:675']?.[String(target.tabId)] ?? null });
    await chrome.storage.session.set({ __675audit: audit });
  });
  await auditQueue;
}
async function audited(target, method, send) {
  await note(target, method, 'requested');
  try {
    const result = await send();
    await note(target, method, 'completed');
    return result;
  } catch (error) {
    await note(target, method, 'rejected');
    throw error;
  }
}
chrome.debugger.detach = (target) => audited(target, 'detach', () => nativeDetach(target));
chrome.debugger.sendCommand = (target, method, params) => {
  const send = () => nativeSend(target, method, params);
  return ['Debugger.pause', 'Debugger.resume', 'Debugger.disable'].includes(method) ? audited(target, method, send) : send();
};
${site}`
            )
          );
        },
      });
    } finally {
      if (previous === undefined) delete process.env.SLICC_HARNESS_EXTENSION;
      else process.env.SLICC_HARNESS_EXTENSION = previous;
    }
    t.after(() => chrome.close());
    const off = chrome.cdp.on(({ method, params }) => {
      if (
        method.startsWith('Target.') &&
        (params.targetInfo?.url?.includes(extId) || params.targetId === row.workerTarget)
      ) {
        row.events.push({
          method,
          at: performance.now(),
          targetId: params.targetId ?? params.targetInfo?.targetId,
        });
      }
    });
    t.after(off);
    await chrome.cdp.send('Target.setDiscoverTargets', { discover: true });
    const holder = await chrome.visit(t, 'https://seven.sliccy.ai/');
    await holder.evaluate(install);
    const { targetId } = await chrome.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: observer } = await chrome.cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await chrome.cdp.send('Page.enable', {}, observer);
    const initial = new Promise((resolve) => {
      continuePage = resolve;
    });
    await chrome.cdp.send('Page.navigate', { url }, observer);
    await bounded(initial, 5500, 'initial ordinary fixture');
    const attached = await holder.evaluate(async (url) => {
      const { targetInfos } = await h.cdp.send('Target.getTargets');
      const target = targetInfos.find((info) => info.url === url);
      if (!target) throw new Error('ordinary tab undiscovered');
      const { sessionId } = await h.cdp.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      });
      await h.cdp.send('Debugger.enable', {}, sessionId);
      await h.cdp.send(
        'Debugger.setInstrumentationBreakpoint',
        { instrumentation: 'beforeScriptExecution' },
        sessionId
      );
      globalThis.__675Pause = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no verified normal pause')), 10000);
        const off = h.cdp.on((event) => {
          if (event.method !== 'Debugger.paused' || event.sessionId !== sessionId) return;
          clearTimeout(timer);
          off();
          resolve({
            reason: event.params.reason,
            callFrames: event.params.callFrames?.length ?? 0,
          });
        });
      });
      return { targetId: target.targetId, sessionId };
    }, url);
    const continued = new Promise((resolve) => {
      continuePage = resolve;
    });
    await chrome.cdp.send('Page.reload', {}, observer);
    row.pause = await holder.evaluate(() => __675Pause);
    assert.notEqual(row.pause.reason, 'instrumentation');
    assert.ok(row.pause.callFrames > 0);
    row.debuggerEventsBeforeDeath = await holder.evaluate(() =>
      h.events.filter((event) => event.method.startsWith('Debugger.')).map((event) => event.method)
    );
    row.startedAt = performance.now();
    row.startedEpoch = Date.now();
    if (mode === 'holder-death') await holder.close();
    if (mode === 'session-loss') {
      await holder.evaluate(
        (sessionId) => h.cdp.send('Target.detachFromTarget', { sessionId }),
        attached.sessionId
      );
    }
    if (mode === 'worker-restart') {
      const { targetInfos } = await chrome.cdp.send('Target.getTargets');
      const worker = targetInfos.find(
        (info) =>
          info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
      );
      assert.ok(worker, 'extension worker exists at the owned pause');
      row.workerTarget = worker.targetId;
      const destroyed = new Promise((resolve) => {
        const off = chrome.cdp.on(({ method, params }) => {
          if (method === 'Target.targetDestroyed' && params.targetId === worker.targetId) {
            off();
            resolve();
          }
        });
        t.after(off);
      });
      await chrome.cdp.send('ServiceWorker.enable', {}, observer);
      await chrome.cdp.send('ServiceWorker.stopAllWorkers', {}, observer);
      await bounded(destroyed, 5500, 'actual extension worker termination');
      row.workerActuallyStopped = true;
      row.workerStoppedMs = performance.now() - row.startedAt;
      assert.ok(row.workerStoppedMs < 2000, 'worker death precedes the live five-second deadline');
      row.rescueMechanism = 'persisted journal at startup, with a 30-second repeating alarm wakeup';
      row.knownLimit =
        'An alarm may be delayed by Chrome; a simultaneous protected pause and dead worker has no hard five-second guarantee.';
    }
    await bounded(continued, row.boundMs, 'page continues without observer resume');
    row.continuedMs = performance.now() - row.startedAt;
    assert.ok(row.continuedMs < row.boundMs);
    const marker = await chrome.cdp.send(
      'Runtime.evaluate',
      { expression: 'globalThis.continued', returnByValue: true },
      observer
    );
    assert.equal(marker.result?.value, 1);
    const reloaded = new Promise((resolve) => {
      continuePage = resolve;
    });
    await chrome.cdp.send('Page.reload', {}, observer);
    await bounded(reloaded, 5500, 'reload without surviving instrumentation');
    row.nextReloadContinued = true;
    const { targetInfos: workers } = await chrome.cdp.send('Target.getTargets');
    const auditWorker = workers.find(
      (info) =>
        info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
    );
    assert.ok(auditWorker, 'worker available for private rescue audit after continuation');
    const { sessionId: auditSession } = await chrome.cdp.send('Target.attachToTarget', {
      targetId: auditWorker.targetId,
      flatten: true,
    });
    const audit = await chrome.cdp.send(
      'Runtime.evaluate',
      {
        expression: 'chrome.storage.session.get("__675audit").then(value => value.__675audit)',
        awaitPromise: true,
        returnByValue: true,
      },
      auditSession
    );
    assert.equal(audit.exceptionDetails, undefined);
    row.privateAudit = audit.result.value;
    row.rescueCompleted = row.privateAudit.filter(
      (entry) =>
        ['Debugger.resume', 'Debugger.disable', 'detach'].includes(entry.method) &&
        entry.phase === 'completed' &&
        entry.at >= row.startedEpoch
    );
    assert.ok(
      row.rescueCompleted.length > 0,
      'private guard control completed, never observer resume'
    );
    row.chromeVersion = await chrome.cdp.send('Browser.getVersion');
    await chrome.cdp.send('Target.detachFromTarget', { sessionId: auditSession });
    if (mode === 'worker-restart') {
      const { targetInfos } = await chrome.cdp.send('Target.getTargets');
      row.newWorkerTarget = targetInfos.find(
        (info) =>
          info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
      )?.targetId;
      assert.ok(row.newWorkerTarget, 'alarm woke a new worker');
      assert.notEqual(row.newWorkerTarget, row.workerTarget);
      row.debuggerEventsAfterRestart = await holder.evaluate(() =>
        h.events
          .filter((event) => event.method.startsWith('Debugger.'))
          .map((event) => event.method)
      );
      assert.deepEqual(
        row.debuggerEventsAfterRestart,
        row.debuggerEventsBeforeDeath,
        'restart publishes no additional script, pause or resume event'
      );
    }
  });
}
