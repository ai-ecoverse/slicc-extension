import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { CDPClient } from '@ai-ecoverse/slicc-cdp';
import { PageSession } from '../../node_modules/@ai-ecoverse/slicc-cdp/src/page.js';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

const entries = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const errorPage = 'chrome-error://chromewebdata/';
const marker = 'FAKE-HOP-ID';

async function prepare(paths) {
  const path = join(paths[0], 'background.js');
  const source = await readFile(path, 'utf8');
  await writeFile(
    path,
    `const hopSend = chrome.debugger.sendCommand.bind(chrome.debugger);
chrome.debugger.sendCommand = async (target, method, params) => {
  if (params?.__hopTree) {
    globalThis.__hopEntered = true;
    await new Promise((resolve) => { globalThis.__hopRelease = resolve; });
  }
  return hopSend(target, method, params);
};\n${source}`
  );
}

async function worker(chrome) {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const target = targetInfos.find(
    (info) =>
      info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
  );
  assert.ok(target, 'worker target');
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  return {
    async evaluate(expression) {
      const answer = await chrome.cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId
      );
      assert.equal(answer.exceptionDetails, undefined, 'worker evaluation');
      return answer.result?.value;
    },
    close: () => chrome.cdp.send('Target.detachFromTarget', { sessionId }),
  };
}

async function fixture() {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push(request.headers.host);
    const protectedUrl = `http://vault.sliccy.ai:${server.address().port}/blocked-${marker}?q=${marker}#${marker}`;
    if (request.url === '/redirect')
      return response.writeHead(302, { location: protectedUrl }).end();
    const body =
      request.url === '/hop'
        ? `<meta http-equiv="refresh" content="0;url=${protectedUrl}">`
        : '<title>Recovered ordinary tab</title><h1>Recovered ordinary tab</h1>';
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://localhost:${port}`,
    protectedUrl: `http://vault.sliccy.ai:${port}/blocked-${marker}?q=${marker}#${marker}`,
    hits,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function observer(chrome, targetId) {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const target = targetInfos.find((info) => info.type === 'page' && info.url.endsWith('/seed'));
  assert.ok(target, `observer for ${targetId}`);
  return chrome.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
}

async function settled(chrome, sessionId, url, failed = false) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { frameTree } = await chrome.cdp.send('Page.getFrameTree', {}, sessionId);
    const frame = frameTree.frame;
    if (failed ? frame.url === errorPage && frame.unreachableUrl === url : frame.url === url)
      return frame;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('navigation did not settle');
}

function redacted(tree, protectedUrl) {
  assert.equal(tree.frameTree?.frame?.url, errorPage);
  assert.equal(tree.frameTree.frame.unreachableUrl, new URL(protectedUrl).origin);
  const text = JSON.stringify(tree);
  assert.ok(!text.includes(marker), 'no fake id in metadata');
  assert.ok(!text.includes('/blocked-'), 'no protected path in metadata');
  assert.ok(!text.includes('?q='), 'no protected query in metadata');
  assert.ok(!text.includes(`#${marker}`), 'no protected fragment in metadata');
}

async function adapter(page) {
  class Socket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(text) {
      const message = JSON.parse(text);
      page
        .evaluate(async (message) => {
          const answer = await h.attempt(message.method, message.params, message.sessionId);
          return {
            id: message.id,
            ...(answer.error ? { error: { message: answer.error } } : { result: answer.result }),
          };
        }, message)
        .then((answer) =>
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(answer) }))
        );
    }
    close() {
      this.dispatchEvent(new Event('close'));
    }
  }
  const client = new CDPClient(Socket);
  await client.open('ws://fixture.invalid');
  return client;
}

async function row(t, chrome, site, transport, variant, ownClient = false) {
  const page = await chrome.visit(t, entries[transport]);
  await page.evaluate(install, transport, extId);
  const opened = await page.evaluate((url) => h.open(url), `${site.url}/seed`);
  const raw = await observer(chrome, opened.targetId);
  let client;
  try {
    const send = (method, params = {}) =>
      page.evaluate(({ method, params, sessionId }) => h.attempt(method, params, sessionId), {
        method,
        params,
        sessionId: opened.sessionId,
      });
    if (ownClient) {
      client = await adapter(page);
      const session = new PageSession(client);
      await session.attach(opened.targetId);
      await session.navigate(`${site.url}/hop`).catch(() => undefined);
      await settled(chrome, raw.sessionId, site.protectedUrl, true);
      await assert.rejects(session.evaluate('document.title'), /slicc: refused:/);
      const tree = await client.send('Page.getFrameTree', {}, session.sessionId);
      redacted(tree, site.protectedUrl);
      await session.navigate(`${site.url}/destination`);
      await settled(chrome, raw.sessionId, `${site.url}/destination`);
      assert.equal(await session.evaluate('document.title'), 'Recovered ordinary tab');
      assert.ok(
        JSON.stringify(await session.accessibilitySnapshot()).includes('Recovered ordinary tab')
      );
      return;
    }
    if (variant === 'direct') {
      const blocked = await send('Page.navigate', { url: site.protectedUrl });
      assert.match(blocked.error ?? '', /^slicc: refused:/);
      await settled(chrome, raw.sessionId, `${site.url}/seed`);
    } else {
      let pending;
      if (variant === 'pending') {
        const sw = await worker(chrome);
        try {
          await sw.evaluate('globalThis.__hopEntered = false; true');
          await page.evaluate((sessionId) => {
            globalThis.__hopPending = h.attempt(
              'Page.getFrameTree',
              { __hopTree: true },
              sessionId
            );
            return true;
          }, opened.sessionId);
          const deadline = Date.now() + 10000;
          while (!(await sw.evaluate('globalThis.__hopEntered'))) {
            assert.ok(Date.now() < deadline, 'pending tree entered');
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await chrome.cdp.send('Page.navigate', { url: `${site.url}/hop` }, raw.sessionId);
          await settled(chrome, raw.sessionId, site.protectedUrl, true);
          await sw.evaluate('globalThis.__hopRelease(); true');
          pending = await page.evaluate(() => globalThis.__hopPending);
        } finally {
          await sw.evaluate('globalThis.__hopRelease?.(); true');
          await sw.close();
        }
      } else {
        await send('Page.navigate', { url: `${site.url}/${variant}` });
        await settled(chrome, raw.sessionId, site.protectedUrl, true);
      }
      const info = await page.evaluate(
        (targetId) => h.cdp.send('Target.getTargetInfo', { targetId }),
        opened.targetId
      );
      assert.equal(info.targetInfo.url, new URL(site.protectedUrl).origin);
      assert.equal(info.targetInfo.title, new URL(site.protectedUrl).origin);
      assert.ok(!JSON.stringify(info).includes(marker), 'target metadata is redacted');
      const tree = pending ?? (await send('Page.getFrameTree'));
      assert.equal(tree.error, undefined, 'frame tree answers');
      redacted(tree.result, site.protectedUrl);
      const sealed = await page.evaluate(async (sessionId) => {
        const rows = [];
        for (const [method, params] of [
          ['Runtime.evaluate', { expression: 'document.title', returnByValue: true }],
          ['DOM.getDocument', { depth: -1, pierce: true }],
          ['Accessibility.getFullAXTree', {}],
          ['DOMSnapshot.captureSnapshot', { computedStyles: [] }],
          ['Page.captureSnapshot', { format: 'mhtml' }],
          ['Page.captureScreenshot', { format: 'png' }],
          ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }],
        ]) {
          const answer = await h.attempt(method, params, sessionId);
          rows.push({ method, error: answer.error, answered: Boolean(answer.result) });
        }
        return rows;
      }, opened.sessionId);
      for (const probe of sealed) {
        assert.match(probe.error ?? '', /^slicc: refused:/, probe.method);
        assert.equal(probe.answered, false, probe.method);
      }
    }
    const navigation = await send('Page.navigate', { url: `${site.url}/destination` });
    assert.equal(navigation.error, undefined, 'recovery navigation answers');
    await settled(chrome, raw.sessionId, `${site.url}/destination`);
    const evaluated = await send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    assert.equal(evaluated.error, undefined);
    assert.equal(evaluated.result?.result?.value, 'Recovered ordinary tab');
    assert.equal(
      await page.evaluate((id) => h.messages.every((message) => !message.includes(id)), marker),
      true,
      'no fake id reaches the client'
    );
  } finally {
    client?.close();
    await chrome.cdp.send('Target.detachFromTarget', { sessionId: raw.sessionId });
    await page.evaluate((targetId) => h.close(targetId), opened.targetId);
    assert.ok(!site.hits.some((host) => host.startsWith('vault.')), 'no protected request served');
  }
}

test('a blocked hop tab recovers', { timeout: 180000 }, async (t) => {
  process.env.SLICC_CDP_PORTS = '9300-9309';
  const site = await fixture();
  let chrome;
  try {
    chrome = await launch({ prepare });
    for (const transport of ['seven', 'six-bridge']) {
      for (const variant of ['hop', 'redirect', 'direct', 'pending'])
        await t.test(`${transport} ${variant}`, (t) => row(t, chrome, site, transport, variant));
      await t.test(`${transport} package client`, (t) =>
        row(t, chrome, site, transport, 'hop', true)
      );
    }
  } finally {
    await chrome?.close();
    await site.close();
  }
});
