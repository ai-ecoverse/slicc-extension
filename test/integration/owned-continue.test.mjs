import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

const entries = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const errorPage = 'chrome-error://chromewebdata/';

async function prepare(paths) {
  const path = join(paths[0], 'cdp.js');
  const source = await readFile(path, 'utf8');
  const site = '    this.closed = false;';
  assert.ok(source.includes(site));
  await writeFile(
    path,
    source.replace(
      site,
      `${site}
    (globalThis.__continueConnections ??= new Set()).add(this);`
    )
  );
  const backgroundPath = join(paths[0], 'background.js');
  const background = await readFile(backgroundPath, 'utf8');
  await writeFile(
    backgroundPath,
    `${background}
const continueSend = chrome.debugger.sendCommand.bind(chrome.debugger);
chrome.debugger.sendCommand = async (target, method, params) => {
  const gate = globalThis.__continueGate;
  if (gate?.tabId === target.tabId) {
    if (method === 'Page.getFrameTree') {
      gate.trees += 1;
      throw new Error('renderer unavailable during request pause');
    }
    if (method.startsWith('Fetch.')) gate.forwarded.push(method);
  }
  return continueSend(target, method, params);
};`
  );
}

async function worker(chrome) {
  const target = await until(async () => {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    return targetInfos.find(
      (info) =>
        info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
    );
  });
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
    if (request.url === '/hop')
      return response
        .writeHead(302, {
          location: `http://vault.sliccy.ai:${server.address().port}/blocked-private-marker?q=private-marker#private-marker`,
        })
        .end();
    if (request.url === '/auth')
      return response.writeHead(401, { 'www-authenticate': 'Basic realm="ordinary"' }).end();
    response
      .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      .end('<title>Recovered ordinary tab</title><h1>Recovered ordinary tab</h1>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://localhost:${port}`,
    protectedUrl: `http://vault.sliccy.ai:${port}/blocked-private-marker?q=private-marker#private-marker`,
    hits,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('fixture did not settle');
}

const rejected = [
  ['url override', 'Fetch.continueRequest', { url: 'http://localhost/' }],
  ['method override', 'Fetch.continueRequest', { method: 'POST' }],
  ['headers override', 'Fetch.continueRequest', { headers: [] }],
  ['postData override', 'Fetch.continueRequest', { postData: '' }],
  ['interceptResponse override', 'Fetch.continueRequest', { interceptResponse: false }],
  ['extra key', 'Fetch.continueRequest', { extra: true }],
  ['fulfillRequest', 'Fetch.fulfillRequest', { responseCode: 200, body: '' }],
  ['failRequest', 'Fetch.failRequest', { errorReason: 'BlockedByClient' }],
  ['body read', 'Fetch.getResponseBody', {}],
  [
    'auth reply',
    'Fetch.continueWithAuth',
    { authChallengeResponse: { response: 'Default' } },
    'auth',
  ],
  ['wrong session', 'Fetch.continueRequest', {}, 'other'],
  ['unknown request', 'Fetch.continueRequest', { requestId: 'UNKNOWN' }],
  ['auth hold', 'Fetch.continueRequest', {}, 'auth'],
  ['claimed hold', 'Fetch.continueRequest', {}, 'claimed'],
];

async function row(t, chrome, sw, site, transport, gate) {
  const [name, method, params, kind] = gate;
  const page = await chrome.visit(t, entries[transport]);
  await page.evaluate(install, transport, extId);
  const opened = await page.evaluate((url) => h.open(url), `${site.url}/seed`);
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const target = targetInfos.find(
    (info) => info.type === 'page' && info.url === `${site.url}/seed`
  );
  assert.ok(target, 'ordinary observer');
  const raw = await chrome.cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const tabId = Number(opened.targetId);
  const send = (method, params = {}, sessionId = opened.sessionId) =>
    page.evaluate(({ method, params, sessionId }) => h.attempt(method, params, sessionId), {
      method,
      params,
      sessionId,
    });
  try {
    await send('Page.navigate', { url: `${site.url}/hop` });
    await until(async () => {
      const { frameTree } = await chrome.cdp.send('Page.getFrameTree', {}, raw.sessionId);
      return (
        frameTree.frame.url === errorPage && frameTree.frame.unreachableUrl === site.protectedUrl
      );
    });
    const tree = await send('Page.getFrameTree');
    assert.equal(tree.error, undefined);
    assert.equal(tree.result?.frameTree?.frame?.url, errorPage);
    assert.equal(tree.result.frameTree.frame.unreachableUrl, new URL(site.protectedUrl).origin);
    assert.ok(!JSON.stringify(tree).includes('private-marker'), 'metadata stays redacted');
    const sealed = await send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    assert.match(sealed.error ?? '', /^slicc: refused:/);
    assert.equal(sealed.result, undefined);
    const second = await page.evaluate(
      (targetId) => h.cdp.send('Target.attachToTarget', { targetId, flatten: true }),
      opened.targetId
    );
    const enabled = await send('Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
      handleAuthRequests: kind === 'auth',
    });
    assert.equal(enabled.error, undefined);
    const destination = `${site.url}/${kind === 'auth' ? 'auth' : 'destination'}`;
    await page.evaluate(
      ({ sessionId, url }) => {
        globalThis.__continueNavigation = h.attempt('Page.navigate', { url }, sessionId);
        return true;
      },
      { sessionId: opened.sessionId, url: destination }
    );
    let pause = await until(() =>
      page.evaluate(
        ({ sessionId, url }) =>
          h.events.findLast(
            (event) =>
              event.method === 'Fetch.requestPaused' &&
              event.sessionId === sessionId &&
              event.params.request.url === url
          ),
        { sessionId: opened.sessionId, url: destination }
      )
    );
    assert.equal(pause.params.resourceType, 'Document');
    if (kind === 'auth') {
      await sw.evaluate(
        `chrome.debugger.sendCommand({tabId:${tabId}}, 'Fetch.continueRequest', {requestId:${JSON.stringify(pause.params.requestId)}})`
      );
      pause = await until(() =>
        page.evaluate(
          (sessionId) =>
            h.events.findLast(
              (event) => event.method === 'Fetch.authRequired' && event.sessionId === sessionId
            ),
          opened.sessionId
        )
      );
    }
    if (kind === 'claimed') {
      const claimed = await sw.evaluate(`(() => {
        const connection = [...globalThis.__continueConnections].find((entry) => entry.state.sessions.has(${JSON.stringify(opened.sessionId)}));
        const hold = connection.tabState(${tabId}).paused.get(${JSON.stringify(pause.params.requestId)});
        hold.claimed = true;
        return hold.owner;
      })()`);
      assert.equal(claimed, opened.sessionId);
    }
    await sw.evaluate(`globalThis.__continueGate = {tabId:${tabId}, trees:0, forwarded:[]}; true`);
    const answer = await send(
      method,
      { requestId: pause.params.requestId, ...params },
      kind === 'other' ? second.sessionId : opened.sessionId
    );
    const observed = await sw.evaluate('globalThis.__continueGate');
    await sw.evaluate('delete globalThis.__continueGate; true');
    if (name === 'plain owner continue') {
      assert.equal(answer.error, undefined, 'owned continuation answers');
      assert.equal(observed.trees, 0, 'no renderer tree needed');
      assert.deepEqual(observed.forwarded, ['Fetch.continueRequest']);
      const navigation = await page.evaluate(() => globalThis.__continueNavigation);
      assert.equal(navigation.error, undefined, 'navigation answers');
      await until(async () => {
        const { frameTree } = await chrome.cdp.send('Page.getFrameTree', {}, raw.sessionId);
        return frameTree.frame.url === destination && !frameTree.frame.unreachableUrl;
      });
      assert.equal(
        await page.evaluate(
          (sessionId) => h.evaluate(sessionId, 'document.title'),
          opened.sessionId
        ),
        'Recovered ordinary tab'
      );
    } else {
      assert.match(answer.error ?? '', /^slicc: refused:/, name);
      assert.equal(answer.result, undefined, name);
      assert.ok(observed.trees > 0, 'renderer check retained');
      assert.deepEqual(observed.forwarded, [], 'no answer or body read forwarded');
    }
    assert.equal(
      await page.evaluate(() => h.messages.every((message) => !message.includes('private-marker'))),
      true,
      'protected metadata stays redacted'
    );
  } finally {
    await sw.evaluate('delete globalThis.__continueGate; true');
    await chrome.cdp.send('Target.detachFromTarget', { sessionId: raw.sessionId });
    await page.evaluate((targetId) => h.close(targetId), opened.targetId);
    assert.ok(!site.hits.some((host) => host.startsWith('vault.')), 'no protected request served');
  }
}

test('an owned request can release an ordinary navigation', { timeout: 180000 }, async (t) => {
  process.env.SLICC_CDP_PORTS = '9300-9309';
  const site = await fixture();
  let chrome;
  let sw;
  try {
    chrome = await launch({ prepare });
    sw = await worker(chrome);
    for (const transport of ['seven', 'six-bridge']) {
      const gates = [['plain owner continue', 'Fetch.continueRequest', {}]];
      if (transport === 'seven') gates.push(...rejected);
      for (const gate of gates)
        await t.test(`${transport} ${gate[0]}`, (t) => row(t, chrome, sw, site, transport, gate));
    }
  } finally {
    await sw?.close();
    await chrome?.close();
    await site.close();
  }
});
