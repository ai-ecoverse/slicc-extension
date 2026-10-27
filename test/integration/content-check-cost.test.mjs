import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { seven, six } from './content-check-baseline.mjs';
import { extId } from './extension-page.mjs';

async function prepare(paths) {
  for (const [file, baseline, args] of [
    ['cdp.js', seven, 'tabId, method, params'],
    ['six-sw.js', six, 'method, params'],
  ]) {
    let method = baseline.replace('checkContent(', 'beforeContent(');
    if (file === 'six-sw.js') {
      method = method
        .replace('private async', 'async')
        .replace(
          'this.readErrorFrames()',
          `this.readFrames().then((frames) => !Array.isArray(frames) || frames.length === 0 || frames.some((frame) => frame.errorOccurred === true && urlProtected(frame.url)))`
        );
      const compiled = stripTypeScriptTypes(`class Baseline {\n${method}\n}`);
      method = compiled.slice(compiled.indexOf('{') + 1, compiled.lastIndexOf('}'));
    }
    const path = join(paths[0], file);
    const source = await readFile(path, 'utf8');
    const site = '  async checkContent(';
    assert.ok(source.includes(site), `${file} check site`);
    await writeFile(
      path,
      source.replace(
        site,
        `${method}\n  async checkContent(${args}) {\n    return globalThis.__costBefore ? this.beforeContent(${args}) : this.afterContent(${args});\n  }\n  async afterContent(`
      )
    );
  }
  const path = join(paths[0], 'background.js');
  const source = await readFile(path, 'utf8');
  await writeFile(
    path,
    `${source}
const costSend = chrome.debugger.sendCommand.bind(chrome.debugger);
const costFrames = chrome.webNavigation.getAllFrames.bind(chrome.webNavigation);
globalThis.__costProbes = { tree: 0, frames: 0 };
chrome.debugger.sendCommand = async (target, method, params) => {
  if (method === 'Page.getFrameTree') globalThis.__costProbes.tree += 1;
  return costSend(target, method, params);
};
chrome.webNavigation.getAllFrames = async (details) => {
  globalThis.__costProbes.frames += 1;
  return costFrames(details);
};`
  );
}

async function measure(page, sessionId) {
  return page.evaluate(async (sessionId) => {
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      await h.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: 20 + i, y: 20 },
        sessionId
      );
    }
    const movesMs = performance.now() - start;
    let frames = 0;
    let bytes = 0;
    const acknowledgements = [];
    const stop = h.cdp.on((event) => {
      if (event.sessionId !== sessionId || event.method !== 'Page.screencastFrame') return;
      frames += 1;
      bytes += event.params.data?.length ?? 0;
      acknowledgements.push(
        h.cdp.send('Page.screencastFrameAck', { sessionId: event.params.sessionId }, sessionId)
      );
    });
    try {
      await h.cdp.send(
        'Page.startScreencast',
        { format: 'jpeg', maxWidth: 160, maxHeight: 120, everyNthFrame: 1 },
        sessionId
      );
      const castStart = performance.now();
      await h.sleep(3000);
      const castMs = performance.now() - castStart;
      await h.cdp.send('Page.stopScreencast', {}, sessionId);
      await Promise.all(acknowledgements);
      return { movesMs, frames, castMs, fps: (frames * 1000) / castMs, bytes };
    } finally {
      stop();
    }
  }, sessionId);
}

test('content check cost before and after on an ordinary tab', { timeout: 180000 }, async (t) => {
  process.env.SLICC_CDP_PORTS = '9300-9309';
  const chrome = await launch({ prepare });
  let workerSession;
  try {
    const first = await chrome.visit(t, 'https://seven.sliccy.ai/');
    await first.evaluate(install, 'seven', extId);
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const worker = targetInfos.find(
      (info) =>
        info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
    );
    assert.ok(worker, 'extension worker');
    ({ sessionId: workerSession } = await chrome.cdp.send('Target.attachToTarget', {
      targetId: worker.targetId,
      flatten: true,
    }));
    const configure = async (before) => {
      const answer = await chrome.cdp.send(
        'Runtime.evaluate',
        {
          expression: `globalThis.__costBefore = ${before}; globalThis.__costProbes = {tree:0,frames:0}; true`,
          returnByValue: true,
        },
        workerSession
      );
      assert.equal(answer.exceptionDetails, undefined);
    };
    const counts = async () => {
      const answer = await chrome.cdp.send(
        'Runtime.evaluate',
        { expression: 'globalThis.__costProbes', returnByValue: true },
        workerSession
      );
      assert.equal(answer.exceptionDetails, undefined);
      return answer.result.value;
    };
    for (const transport of ['seven', 'six-bridge']) {
      const page =
        transport === 'seven'
          ? first
          : await chrome.visit(t, 'https://www.sliccy.ai/?slicc=leader');
      if (transport !== 'seven') await page.evaluate(install, transport, extId);
      const client = await page.evaluate(async () => {
        const client = await h.open('https://ordinary.test/marker');
        await h.cdp.send('Page.bringToFront', {}, client.sessionId);
        await h.evaluate(
          client.sessionId,
          `(() => {
          const box = document.createElement('div');
          box.style.cssText = 'position:fixed;width:100px;height:100px;top:10px;left:10px;background:red';
          document.body.appendChild(box);
          let n = 0;
          function tick() { box.style.transform = 'translateX(' + (++n % 80) + 'px)'; requestAnimationFrame(tick); }
          requestAnimationFrame(tick);
          return true;
        })()`
        );
        await h.sleep(500);
        return client;
      });
      try {
        const report = {};
        for (const [phase, before] of [
          ['before', true],
          ['after', false],
        ]) {
          await configure(before);
          report[phase] = { ...(await measure(page, client.sessionId)), probes: await counts() };
          assert.ok(report[phase].frames > 0, `${transport} ${phase} cast frames`);
          assert.ok(report[phase].bytes > 0, `${transport} ${phase} cast sizes`);
        }
        t.diagnostic(`content-check-cost ${transport}: ${JSON.stringify(report)}`);
        assert.ok(
          report.after.probes.tree < report.before.probes.tree,
          'cached checks use fewer frame-tree round trips'
        );
      } finally {
        await page.evaluate((targetId) => h.close(targetId), client.targetId);
      }
    }
  } finally {
    if (workerSession)
      await chrome.cdp
        .send('Target.detachFromTarget', { sessionId: workerSession })
        .catch(() => undefined);
    await chrome.close();
  }
});
