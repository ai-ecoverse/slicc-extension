import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { launch } from './chrome.mjs';
import { extId } from './extension-page.mjs';

const ALLOWED = new Set(['Page.getFrameTree', 'Target.getTargetInfo']);

async function prepareSpy(paths) {
  const backgroundPath = join(paths[0], 'background.js');
  const background = await readFile(backgroundPath, 'utf8');
  await writeFile(
    backgroundPath,
    `${background}
const reobserveSend = chrome.debugger.sendCommand.bind(chrome.debugger);
globalThis.__reobserveRecord = false;
globalThis.__reobserveMethods = [];
chrome.debugger.sendCommand = async (target, method, params) => {
  if (globalThis.__reobserveRecord) {
    globalThis.__reobserveMethods.push({
      method,
      sessionId: target?.sessionId ?? null,
      tabId: target?.tabId,
    });
  }
  return reobserveSend(target, method, params);
};
`
  );
  const cdpPath = join(paths[0], 'cdp.js');
  const cdp = await readFile(cdpPath, 'utf8');
  const site = '  async reobserveStaleChildren(tabId, startedRevision) {';
  assert.ok(cdp.includes(site), 'reobserve site');
  await writeFile(
    cdpPath,
    cdp.replace(
      site,
      `  async reobserveStaleChildren(tabId, startedRevision) {
    globalThis.__reobserveRecord = true;
    try {
      return await this.__reobserveStaleChildrenMeasured(tabId, startedRevision);
    } finally {
      globalThis.__reobserveRecord = false;
    }
  }
  async __reobserveStaleChildrenMeasured(tabId, startedRevision) {`
    )
  );
}

async function prepareMutation(paths) {
  await prepareSpy(paths);
  const path = join(paths[0], 'cdp.js');
  const source = await readFile(path, 'utf8');
  const site = '  async readChildReobserve(tabId, sessionId, info) {';
  assert.ok(source.includes(site), 'readChildReobserve site');
  await writeFile(
    path,
    source.replace(
      site,
      `  async readChildReobserve(tabId, sessionId, info) {
    await this.api.debugger.sendCommand({ tabId }, 'DOM.getDocument', {
      depth: -1,
      pierce: true,
    });
`
    )
  );
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

async function runRow(chrome, t, page) {
  const workerSession = await untilWorker(chrome);
  await workerEval(chrome, workerSession, 'globalThis.__reobserveMethods = []; true');
  const url = 'https://ordinary.test/doc?reobserve-dom-survive-seven';
  const target = await chrome.visit(t, url);
  await target.evaluate(() => {
    const mark = document.createElement('div');
    mark.id = 'reobserve-mark';
    mark.textContent = 'mark';
    document.body.append(mark);
  });
  const result = await page.evaluate(async (pageUrl) => {
    const listed = await sliccExtension.cdp.send('Target.getTargets');
    const info = listed.targetInfos.find((entry) => entry.url === pageUrl);
    if (!info) throw new Error('ordinary fixture target was not listed');
    const attached = await sliccExtension.cdp.send('Target.attachToTarget', {
      targetId: info.targetId,
      flatten: true,
    });
    if (!attached.sessionId) throw new Error('ordinary fixture target was not attached');
    const sessionId = attached.sessionId;
    const doc = await sliccExtension.cdp.send('DOM.getDocument', { depth: 0 }, sessionId);
    const selected = await sliccExtension.cdp.send(
      'DOM.querySelector',
      { nodeId: doc.root.nodeId, selector: '#reobserve-mark' },
      sessionId
    );
    if (!selected.nodeId) throw new Error('fixture mark was not found');
    await sliccExtension.cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const iframe = document.createElement('iframe');
          iframe.src = 'https://other.test/doc?REOBSERVE_DOM_SIBLING';
          document.body.append(iframe);
          return new Promise((resolve) => {
            iframe.onload = () => {
              iframe.src = 'https://other.test/doc?REOBSERVE_DOM_SIBLING_COMMIT';
              iframe.onload = () => resolve(true);
            };
          });
        })()`,
        awaitPromise: true,
      },
      sessionId
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    let described;
    try {
      described = await sliccExtension.cdp.send(
        'DOM.describeNode',
        { nodeId: selected.nodeId },
        sessionId
      );
    } catch (error) {
      described = { error: error.message };
    }
    return { described, nodeId: selected.nodeId };
  }, url);
  const methods = await workerEval(chrome, workerSession, 'globalThis.__reobserveMethods');
  return { methods, described: result.described, nodeId: result.nodeId };
}

function methodNames(methods) {
  return [...new Set((methods ?? []).map((entry) => entry.method))].sort();
}

test('seven: reobserve sends only Page.getFrameTree and Target.getTargetInfo; client nodeId survives', async (t) => {
  const chrome = await launch({ prepare: prepareSpy });
  t.after(() => chrome.close());
  const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
  const { methods, described } = await runRow(chrome, t, page);
  assert.equal(described.error, undefined, JSON.stringify(described));
  assert.equal(described.node?.nodeName, 'DIV');
  const names = methodNames(methods);
  assert.ok(names.length > 0, 'reobserve sent at least one debugger command');
  assert.deepEqual(
    names.filter((method) => !ALLOWED.has(method)),
    [],
    JSON.stringify(names)
  );
  assert.ok(names.includes('Page.getFrameTree'));
  assert.ok(names.includes('Target.getTargetInfo'));
});

test('mutation: DOM.getDocument in readChildReobserve is visible on the Chrome send spy', async (t) => {
  const chrome = await launch({ prepare: prepareMutation });
  t.after(() => chrome.close());
  const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
  const { methods } = await runRow(chrome, t, page);
  const names = methodNames(methods);
  assert.ok(
    names.includes('DOM.getDocument'),
    `expected DOM.getDocument in ${JSON.stringify(names)}`
  );
});
