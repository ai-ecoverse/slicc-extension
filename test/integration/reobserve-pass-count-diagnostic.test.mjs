import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { extId } from './extension-page.mjs';

async function prepare(paths) {
  const path = join(paths[0], 'cdp.js');
  const source = await readFile(path, 'utf8');
  const site = '  async reobserveStaleChildren(tabId, startedRevision) {';
  assert.ok(source.includes(site), 'reobserve site');
  await writeFile(
    path,
    source.replace(
      site,
      `  async reobserveStaleChildren(tabId, startedRevision) {
    const diag = (globalThis.__reobserveDiag ??= {
      passes: 0,
      trees: 0,
      infos: 0,
      ms: [],
      skippedEmpty: 0,
    });
    const tab = this.tabState(tabId);
    if (!tab || tab.debuggerRevision !== startedRevision) return;
    const stale = [...tab.debuggerChildInfo.entries()].filter(
      ([, info]) => info.revision !== startedRevision
    );
    if (!stale.length) {
      diag.skippedEmpty += 1;
      return;
    }
    const started = Date.now();
    diag.passes += 1;
    diag.trees += 1 + stale.length;
    diag.infos += stale.length;
    try {
      return await this.__reobserveStaleChildrenBody(tabId, startedRevision);
    } finally {
      diag.ms.push(Date.now() - started);
    }
  }
  async __reobserveStaleChildrenBody(tabId, startedRevision) {`
    )
  );
  const patched = await readFile(path, 'utf8');
  assert.ok(patched.includes('__reobserveStaleChildrenBody'), 'body rename');
  assert.ok(patched.includes('globalThis.__reobserveDiag'), 'diag');
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

async function attachWorker(chrome) {
  const deadline = Date.now() + 15000;
  let worker;
  while (Date.now() < deadline && !worker) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    worker = targetInfos.find(
      (info) =>
        info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
    );
    if (!worker) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(worker, 'extension worker');
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  });
  return sessionId;
}

function summary(label, diag) {
  const ms = Array.isArray(diag?.ms) ? diag.ms : [];
  const avg = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0;
  return {
    label,
    passes: diag?.passes ?? 0,
    trees: diag?.trees ?? 0,
    infos: diag?.infos ?? 0,
    reads: (diag?.trees ?? 0) + (diag?.infos ?? 0),
    ms,
    avgMs: avg,
    skippedEmpty: diag?.skippedEmpty ?? 0,
  };
}

let chrome;
before(async () => {
  chrome = await launch({ prepare });
});
after(() => chrome?.close());

test('reobserve pass count: iframe row and five-child commits', { timeout: 180000 }, async (t) => {
  const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
  const workerSession = await attachWorker(chrome);
  await workerEval(
    chrome,
    workerSession,
    `globalThis.__reobserveDiag = { passes: 0, trees: 0, infos: 0, ms: [], skippedEmpty: 0 }; true`
  );

  const iframeUrl = 'https://ordinary.test/doc?reobserve-pass-count-iframe';
  const target = await chrome.visit(t, iframeUrl);
  await target.evaluate(() => {
    document.body.append(document.createElement('div'));
  });
  await page.evaluate(async (pageUrl) => {
    const listed = await sliccExtension.cdp.send('Target.getTargets');
    const info = listed.targetInfos.find((entry) => entry.url === pageUrl);
    if (!info) throw new Error('fixture target missing');
    const attached = await sliccExtension.cdp.send('Target.attachToTarget', {
      targetId: info.targetId,
      flatten: true,
    });
    await sliccExtension.cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const iframe = document.createElement('iframe');
          iframe.src = 'https://other.test/doc?REOBSERVE_PASS_A';
          document.body.append(iframe);
          return new Promise((resolve) => {
            iframe.onload = () => {
              iframe.src = 'https://other.test/doc?REOBSERVE_PASS_B';
              iframe.onload = () => resolve(true);
            };
          });
        })()`,
        awaitPromise: true,
      },
      attached.sessionId
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
  }, iframeUrl);
  const iframeDiag = summary(
    'iframe-row',
    await workerEval(chrome, workerSession, 'globalThis.__reobserveDiag')
  );
  console.log(`REOBSERVE_DIAG ${JSON.stringify(iframeDiag)}`);

  await workerEval(
    chrome,
    workerSession,
    `globalThis.__reobserveDiag = { passes: 0, trees: 0, infos: 0, ms: [], skippedEmpty: 0 }; true`
  );
  const multiUrl = 'https://ordinary.test/doc?reobserve-pass-count-multi';
  const multi = await chrome.visit(t, multiUrl);
  await multi.evaluate(() => {
    for (let i = 0; i < 5; i += 1) {
      const iframe = document.createElement('iframe');
      iframe.id = `child-${i}`;
      iframe.src = `https://other.test/doc?REOBSERVE_MULTI_LOAD_${i}`;
      document.body.append(iframe);
    }
  });
  await page.evaluate(async (pageUrl) => {
    const listed = await sliccExtension.cdp.send('Target.getTargets');
    const info = listed.targetInfos.find((entry) => entry.url === pageUrl);
    if (!info) throw new Error('multi target missing');
    const attached = await sliccExtension.cdp.send('Target.attachToTarget', {
      targetId: info.targetId,
      flatten: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await sliccExtension.cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const frames = [...document.querySelectorAll('iframe')];
          return frames.reduce(
            (chain, iframe, i) =>
              chain.then(
                () =>
                  new Promise((resolve) => {
                    iframe.onload = () => resolve();
                    iframe.src = 'https://other.test/doc?REOBSERVE_MULTI_COMMIT_' + i;
                  })
              ),
            Promise.resolve()
          );
        })()`,
        awaitPromise: true,
      },
      attached.sessionId
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }, multiUrl);
  const multiDiag = summary(
    'five-children-five-commits',
    await workerEval(chrome, workerSession, 'globalThis.__reobserveDiag')
  );
  console.log(`REOBSERVE_DIAG ${JSON.stringify(multiDiag)}`);

  assert.ok(iframeDiag.passes >= 1, `iframe row passes ${iframeDiag.passes}`);
  assert.ok(multiDiag.passes >= 1, `multi passes ${multiDiag.passes}`);
  console.log(
    `REOBSERVE_DIAG_SUMMARY fake N=5 commits coalesces to <=2 passes; chrome iframe-row passes=${iframeDiag.passes} reads=${iframeDiag.reads} avgMs=${iframeDiag.avgMs}; chrome five-children-five-commits passes=${multiDiag.passes} reads=${multiDiag.reads} avgMs=${multiDiag.avgMs}`
  );
});
