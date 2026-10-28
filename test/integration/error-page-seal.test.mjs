import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

const ordinary = 'https://ordinary.test/marker';
const origin = 'https://vault.sliccy.ai';
const errorPage = 'chrome-error://chromewebdata/';
const entries = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const unsettled = 'slicc: refused: navigation not settled, retry';
const FRAME_EVENTS = [
  'onBeforeNavigate',
  'onCommitted',
  'onDOMContentLoaded',
  'onCompleted',
  'onErrorOccurred',
  'onHistoryStateUpdated',
  'onReferenceFragmentUpdated',
  'onTabReplaced',
];

async function prepareExtension(paths) {
  const cdpPath = join(paths[0], 'cdp.js');
  const cdp = await readFile(cdpPath, 'utf8');
  const site = 'api.debugger.onEvent.addListener(this.onEvent);';
  assert.ok(cdp.includes(site), 'seven listener site');
  await writeFile(
    cdpPath,
    cdp
      .replace(
        '  async checkContent(tabId, method, params = {}) {',
        `  async checkContent(tabId, method, params = {}) {
    if (params.__sealProbe) globalThis.__sealProbeActive = tabId;`
      )
      .replace(
        site,
        `const lag = (fn) => (...args) => {
      const tabId = typeof args[0] === 'number' ? args[0] : args[0]?.tabId;
      if (globalThis.__sealLagTab === tabId) setTimeout(() => fn(...args), globalThis.__sealLagMs ?? 2000);
      else fn(...args);
    };
    this.onEvent = lag(this.onEvent);
    this.onUpdated = lag(this.onUpdated);
    this.onFrames = lag(this.onFrames);
    this.onSource = lag(this.onSource);
    ${site}`
      )
  );
  const sixPath = join(paths[0], 'six-sw.js');
  let six = await readFile(sixPath, 'utf8');
  const eventSite = 'chrome.debugger.onEvent.addListener(wrapped);';
  const updatedSite = 'chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {';
  const updatedEnd = `    releaseDebuggerAttachment(detachedTabId, "bridge").catch(() => {
    });
  }
});`;
  assert.ok(six.includes(eventSite) && six.includes(updatedSite) && six.includes(updatedEnd));
  six = six.replace(
    '  async checkContent(method, params = {}) {',
    `  async checkContent(method, params = {}) {
    if (params.__sealProbe) globalThis.__sealProbeActive = globalThis.__sealFlakeFrames ?? globalThis.__sealFlakeTree;`
  );
  six = six.replace(
    eventSite,
    `const sealWrapped = (...args) => {
      if (globalThis.__sealLagTab === args[0]?.tabId) setTimeout(() => wrapped(...args), globalThis.__sealLagMs ?? 2000);
      else wrapped(...args);
    };
    chrome.debugger.onEvent.addListener(sealWrapped);`
  );
  six = six.replace(
    'chrome.debugger.onEvent.removeListener(wrapped)',
    'chrome.debugger.onEvent.removeListener(sealWrapped)'
  );
  six = six.replace(updatedSite, `${updatedSite} const sealUpdate = () => {`);
  six = six.replace(
    updatedEnd,
    `    releaseDebuggerAttachment(detachedTabId, "bridge").catch(() => {
    });
  }
}; if (globalThis.__sealLagTab === tabId) setTimeout(sealUpdate, globalThis.__sealLagMs ?? 2000); else sealUpdate(); });`
  );
  await writeFile(
    sixPath,
    `for (const name of ${JSON.stringify(FRAME_EVENTS)}) {
  const event = chrome.webNavigation[name];
  const add = event.addListener.bind(event);
  const remove = event.removeListener.bind(event);
  const lagged = new Map();
  event.addListener = (fn, ...rest) => {
    const wrapped = (details) => {
      if (globalThis.__sealLagTab === details?.tabId) setTimeout(() => fn(details), globalThis.__sealLagMs ?? 2000);
      else fn(details);
    };
    lagged.set(fn, wrapped);
    return add(wrapped, ...rest);
  };
  event.removeListener = (fn) => remove(lagged.get(fn) ?? fn);
}
${six}`
  );
  const backgroundPath = join(paths[0], 'background.js');
  const background = await readFile(backgroundPath, 'utf8');
  await writeFile(
    backgroundPath,
    `${background}
const sealSend = chrome.debugger.sendCommand.bind(chrome.debugger);
const sealFrames = chrome.webNavigation.getAllFrames.bind(chrome.webNavigation);
globalThis.__sealAudit = [];
chrome.webNavigation.getAllFrames = async (details) => {
  if (globalThis.__sealFlakeFrames === details?.tabId && globalThis.__sealProbeActive === details?.tabId) {
    delete globalThis.__sealFlakeFrames;
    delete globalThis.__sealProbeActive;
    return [];
  }
  return sealFrames(details);
};
chrome.debugger.sendCommand = async (target, method, params) => {
  if (globalThis.__sealFlakeTree === target.tabId && globalThis.__sealProbeActive === target.tabId && method === 'Page.getFrameTree') {
    delete globalThis.__sealFlakeTree;
    delete globalThis.__sealProbeActive;
    throw new Error('Inspected target navigated or closed');
  }
  const hold = globalThis.__sealHold;
  if (hold?.armed && hold.tabId === target.tabId && method === 'Page.captureScreenshot') {
    hold.armed = false;
    hold.entered = true;
    hold.announce();
    await new Promise((resolve) => { hold.release = resolve; });
  }
  if (params?.__sealProbe) globalThis.__sealAudit.push({ probe: params.__sealProbe, method });
  return sealSend(target, method, params);
};`
  );
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

async function rawTab(chrome) {
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await chrome.cdp.send('Page.enable', {}, sessionId);
  return { targetId, sessionId };
}

async function navigate(chrome, tab, url, failed = false) {
  await chrome.cdp.send('Page.navigate', { url }, tab.sessionId);
  return settled(chrome, tab, url, failed);
}

async function settled(chrome, tab, url, failed) {
  return until(async () => {
    const { frameTree } = await chrome.cdp.send('Page.getFrameTree', {}, tab.sessionId);
    const frame = frameTree.frame;
    return failed
      ? frame.url === errorPage && frame.unreachableUrl === url && frame
      : frame.url === url && !frame.unreachableUrl && frame;
  });
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

async function attach(page, url) {
  return page.evaluate(async (url) => {
    const targetId = await h.until(async () => {
      const { targetInfos } = await h.cdp.send('Target.getTargets');
      return targetInfos.find((info) => info.url === url)?.targetId;
    });
    const { sessionId } = await h.cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await h.attempt('Page.enable', {}, sessionId);
    await h.attempt('Runtime.enable', {}, sessionId);
    await h.attempt('Network.enable', {}, sessionId);
    await h.attempt('DOM.enable', {}, sessionId);
    await h.attempt('CSS.enable', {}, sessionId);
    return { targetId, sessionId };
  }, url);
}

async function probes(page, sessionId, url, frameId, scoped = false) {
  return page.evaluate(
    async ({ sessionId, url, frameId, scoped }) => {
      const rows = [];
      async function read(method, params = {}) {
        const probe = crypto.randomUUID();
        const answer = await h.attempt(method, { ...params, __sealProbe: probe }, sessionId);
        rows.push({ method, probe, error: answer.error, answered: Boolean(answer.result) });
        if (method === 'Page.captureScreenshot')
          rows.at(-1).bytes = answer.result?.data?.length ?? 0;
        return answer.result;
      }
      if (scoped) {
        await read('Page.createIsolatedWorld', { frameId, worldName: 'seal-control' });
        await read('DOM.getFrameOwner', { frameId });
        await read('Accessibility.getFullAXTree', { frameId });
      } else {
        await read('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
        await read('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
        await read('Runtime.evaluate', {
          expression:
            'String(document.getElementById("reload-button")?.dataset?.url ?? "").split("/").pop()',
          returnByValue: true,
        });
        const object = await read('Runtime.evaluate', { expression: '({title: document.title})' });
        await read('Runtime.callFunctionOn', {
          objectId: object?.result?.objectId ?? '0.0.1',
          functionDeclaration: 'function(){return document.title}',
          returnByValue: true,
        });
        await read('Runtime.getProperties', { objectId: object?.result?.objectId ?? '0.0.1' });
        await read('Runtime.globalLexicalScopeNames');
        const promise = await read('Runtime.evaluate', {
          expression: 'Promise.resolve(document.title)',
        });
        await read('Runtime.awaitPromise', {
          promiseObjectId: promise?.result?.objectId ?? '0.0.2',
        });
        const doc = await read('DOM.getDocument', { depth: -1, pierce: true });
        await read('DOM.getOuterHTML', { nodeId: doc?.root?.nodeId ?? 1 });
        await read('CSS.getComputedStyleForNode', {
          nodeId: doc?.root?.children?.find((node) => node.nodeName === 'HTML')?.nodeId ?? 2,
        });
        await read('Accessibility.getFullAXTree');
        await read('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'a',
          code: 'KeyA',
          modifiers: 2,
        });
        await read('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'c',
          code: 'KeyC',
          modifiers: 2,
        });
      }
      await read('DOMSnapshot.captureSnapshot', { computedStyles: [] });
      await read('Page.captureScreenshot', { format: 'png' });
      await read('Page.getResourceContent', { frameId, url });
      await read('Page.searchInResource', { frameId, url, query: 'marker' });
      let frameTree;
      if (!scoped) {
        frameTree = await h.attempt('Page.getFrameTree', {}, sessionId);
        await read('Page.getResourceTree');
        await read('Page.captureSnapshot', { format: 'mhtml' });
        const pdf = await read('Page.printToPDF', { transferMode: 'ReturnAsStream' });
        await read('IO.read', { handle: pdf?.stream ?? 'seal-missing-stream' });
        if (pdf?.stream) await h.attempt('IO.close', { handle: pdf.stream }, sessionId);
      }
      const before = h.events.length;
      await read('Page.startScreencast', { format: 'jpeg', maxWidth: 16, maxHeight: 16 });
      await h.sleep(150);
      const frames = h.events
        .slice(before)
        .filter((event) => event.method === 'Page.screencastFrame').length;
      await h.attempt('Page.stopScreencast', {}, sessionId);
      return { rows, frames, frameTree };
    },
    { sessionId, url, frameId, scoped }
  );
}

async function metadata(page, client) {
  return page.evaluate(async ({ targetId }) => {
    const info = await h.attempt('Target.getTargetInfo', { targetId });
    const list = await h.attempt('Target.getTargets');
    const attached = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
    const event = h.events.findLast(
      (row) =>
        row.method === 'Target.attachedToTarget' &&
        row.params.sessionId === attached.result?.sessionId
    );
    if (attached.result)
      await h.attempt('Target.detachFromTarget', { sessionId: attached.result.sessionId });
    return {
      info: info.result?.targetInfo,
      listed: list.result?.targetInfos?.find((row) => row.targetId === targetId),
      attached: event?.params.targetInfo,
      error: attached.error,
    };
  }, client);
}

async function cleanMessages(page, id) {
  return page.evaluate((id) => h.messages.every((message) => !message.includes(id)), id);
}

function assertSealed(report) {
  if (report.frameTree) {
    assert.equal(report.frameTree.error, undefined, 'frame metadata answers');
    assert.equal(report.frameTree.result?.frameTree?.frame?.url, errorPage, 'error main frame');
    const text = JSON.stringify(report.frameTree.result);
    assert.ok(!text.includes('/controller/'), 'no protected path');
    assert.ok(!text.includes('FAKE'), 'no fake id');
    assert.ok(!text.includes('query-secret='), 'no protected query');
    assert.ok(!text.includes('fragment-secret-'), 'no protected fragment');
    assert.equal(report.frameTree.result.frameTree.frame.unreachableUrl, origin);
  }
  for (const row of report.rows) {
    assert.match(row.error ?? '', /^slicc: refused:/, row.method);
    assert.equal(row.answered, false, row.method);
  }
  assert.equal(report.frames, 0, 'cast replies');
}

async function auditRefusals(worker, report) {
  const audit = await worker.evaluate('globalThis.__sealAudit.splice(0)');
  const ids = new Set(report.rows.map((row) => row.probe));
  assert.equal(audit.filter((row) => ids.has(row.probe)).length, 0, 'refused forwarding');
}

async function recover(chrome, page, tab, client, failedUrl, mainError, hopUrl) {
  const before = (await chrome.cdp.send('Page.getFrameTree', {}, tab.sessionId)).frameTree.frame
    .loaderId;
  const reload = await page.evaluate(
    (sessionId) => h.attempt('Page.reload', {}, sessionId),
    client.sessionId
  );
  assert.equal(reload.error, undefined, 'reload');
  await until(async () => {
    const { frameTree } = await chrome.cdp.send('Page.getFrameTree', {}, tab.sessionId);
    return frameTree.frame.loaderId !== before;
  });
  if (mainError) {
    await settled(chrome, tab, failedUrl, true);
    const history = await chrome.cdp.send('Page.getNavigationHistory', {}, tab.sessionId);
    const entry = history.entries.findLast((item) => item.url.startsWith(ordinary));
    assert.ok(entry, 'recovery entry');
    const restored = await page.evaluate(
      ({ sessionId, entryId }) => h.attempt('Page.navigateToHistoryEntry', { entryId }, sessionId),
      { sessionId: client.sessionId, entryId: entry.id }
    );
    assert.equal(restored.error, undefined, 'history navigation');
    await settled(chrome, tab, entry.url, false);
  }
  const away = `${ordinary}?n=recovery`;
  const navigation = await page.evaluate(
    ({ sessionId, url }) => h.attempt('Page.navigate', { url }, sessionId),
    { sessionId: client.sessionId, url: away }
  );
  assert.equal(navigation.error, undefined, 'navigation');
  await settled(chrome, tab, away, false);
  const control = await page.evaluate(
    (sessionId) => h.evaluate(sessionId, 'document.title'),
    client.sessionId
  );
  assert.equal(control, 'marker', 'recovery control');
  if (mainError) {
    await page.evaluate(({ sessionId, url }) => h.attempt('Page.navigate', { url }, sessionId), {
      sessionId: client.sessionId,
      url: hopUrl,
    });
    await settled(chrome, tab, failedUrl, true);
  }
  const closed = await page.evaluate(
    (targetId) => h.attempt('Target.closeTarget', { targetId }),
    client.targetId
  );
  assert.equal(closed.result?.success, true, 'close');
}

async function embed(chrome, tab, failedUrl) {
  await chrome.cdp.send(
    'Runtime.evaluate',
    {
      expression: `document.body.appendChild(Object.assign(document.createElement('iframe'), {src:${JSON.stringify(failedUrl)}}))`,
    },
    tab.sessionId
  );
  const child = await until(async () => {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    return targetInfos.find((info) => info.type === 'iframe' && info.url === failedUrl);
  });
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: child.targetId,
    flatten: true,
  });
  try {
    await settled(chrome, { sessionId }, failedUrl, true);
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId });
  }
}

async function warm(page, sessionId) {
  return page.evaluate(async (sessionId) => {
    const answers = [];
    for (let i = 0; i < 10; i++) {
      answers.push(
        await h.attempt('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift' }, sessionId),
        await h.attempt('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift' }, sessionId)
      );
    }
    answers.push(await h.attempt('Page.captureScreenshot', { format: 'png' }, sessionId));
    return answers.map((answer) => answer.error ?? null);
  }, sessionId);
}

async function flaky(page, worker, client) {
  const tabId = Number(client.targetId);
  const rows = [];
  for (const [arm, method, params] of [
    ['__sealFlakeTree', 'Runtime.evaluate', { expression: 'document.title', returnByValue: true }],
    ['__sealFlakeFrames', 'Page.captureScreenshot', { format: 'png' }],
    ['__sealFlakeFrames', 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA' }],
  ]) {
    await worker.evaluate(`globalThis.${arm} = ${tabId}; true`);
    const answer = await page.evaluate(
      async ({ sessionId, method, params }) => {
        const probe = crypto.randomUUID();
        const first = await h.attempt(method, { ...params, __sealProbe: probe }, sessionId);
        const again = await h.attempt(method, params, sessionId);
        return {
          probe,
          first: { error: first.error, answered: Boolean(first.result) },
          again: { error: again.error, answered: Boolean(again.result) },
        };
      },
      { sessionId: client.sessionId, method, params }
    );
    rows.push({
      method,
      ...answer,
      spent: await worker.evaluate(`globalThis.${arm} === undefined`),
    });
  }
  return rows;
}

async function row(chrome, page, worker, transport, variant) {
  const id = `FAKE${transport.replace('-', '')}${variant}`;
  const failedUrl = `${origin}/controller/${id}`;
  const startUrl = `${ordinary}?n=${transport}-${variant}`;
  const hopUrl = `https://ordinary.test/refused-hop?n=${transport}-${variant}`;
  chrome.site.refusedLoads.set(`${transport}-${variant}`, failedUrl);
  const tab = await rawTab(chrome);
  let pending;
  try {
    if (variant === 'history' || variant === 'lagged') await navigate(chrome, tab, failedUrl, true);
    const root = await navigate(chrome, tab, startUrl);
    const framed = variant === 'frame' || variant === 'cached';
    if (variant === 'frame') await embed(chrome, tab, failedUrl);
    const client = await attach(page, startUrl);
    if (variant === 'unsettled') {
      const rows = await flaky(page, worker, client);
      await recover(chrome, page, tab, client, failedUrl, false, hopUrl);
      const audit = await worker.evaluate('globalThis.__sealAudit.splice(0)');
      for (const probe of rows) {
        assert.deepEqual(probe.first, { error: unsettled, answered: false }, probe.method);
        assert.equal(probe.again.error, undefined, probe.method);
        assert.equal(probe.again.answered, true, probe.method);
        assert.equal(probe.spent, true, probe.method);
        assert.equal(
          audit.filter((row) => row.probe === probe.probe).length,
          0,
          `${probe.method} forwarding`
        );
      }
      return;
    }
    let lag;
    if (variant === 'cached') {
      await worker.evaluate(`(async () => {
        const target = {tabId:${Number(client.targetId)}};
        await chrome.debugger.sendCommand(target, 'Fetch.disable', {});
        await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', {autoAttach:false, waitForDebuggerOnStart:false, flatten:true});
        return true;
      })()`);
      const answers = await warm(page, client.sessionId);
      assert.deepEqual(answers, Array(answers.length).fill(null), 'warm replies');
      await worker.evaluate(
        `globalThis.__sealLagMs = 6000; globalThis.__sealLagTab = ${Number(client.targetId)}; true`
      );
      lag = Date.now();
      await embed(chrome, tab, failedUrl);
      const report = await page.evaluate(async (sessionId) => {
        const parent = await h.evaluate(sessionId, '1 + 1');
        const before = h.events.length;
        const rows = [];
        for (const [method, params] of [
          ['Page.captureScreenshot', { format: 'png' }],
          ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20 }],
          ['Page.startScreencast', { format: 'jpeg', maxWidth: 16, maxHeight: 16 }],
        ]) {
          const probe = crypto.randomUUID();
          const answer = await h.attempt(method, { ...params, __sealProbe: probe }, sessionId);
          rows.push({ method, probe, error: answer.error, answered: Boolean(answer.result) });
        }
        await h.sleep(150);
        const frames = h.events
          .slice(before)
          .filter((event) => event.method === 'Page.screencastFrame').length;
        await h.attempt('Page.stopScreencast', {}, sessionId);
        return { parent, rows, frames };
      }, client.sessionId);
      assert.ok(Date.now() - lag < 6000, 'cached reads ran inside the listener lag');
      assert.equal(report.parent, 2, 'main frame remains readable');
      assertSealed(report);
      await auditRefusals(worker, report);
      await worker.evaluate(`(async () => {
        delete globalThis.__sealLagTab;
        const target = {tabId:${Number(client.targetId)}};
        await chrome.debugger.sendCommand(target, 'Fetch.enable', {patterns:[{urlPattern:'*', resourceType:'Document', requestStage:'Request'}]});
        await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', {autoAttach:true, waitForDebuggerOnStart:true, flatten:true});
        return true;
      })()`);
      await recover(chrome, page, tab, client, failedUrl, false, hopUrl);
      return;
    }
    if (variant === 'control') {
      const controlUrl = `https://ordinary.test/seal-control?n=${transport}`;
      await page.evaluate(({ sessionId, url }) => h.land(sessionId, url), {
        sessionId: client.sessionId,
        url: controlUrl,
      });
      await settled(chrome, tab, controlUrl, false);
      const report = await probes(
        page,
        client.sessionId,
        'https://ordinary.test/seal-resource.js',
        root.id
      );
      await recover(chrome, page, tab, client, failedUrl, false, hopUrl);
      for (const probe of report.rows) assert.equal(probe.error, undefined, probe.method);
      assert.ok(report.rows.find((probe) => probe.method === 'Page.captureScreenshot').bytes > 0);
      return;
    }
    if (variant === 'hop') {
      const navigation = await page.evaluate(
        ({ sessionId, url }) => h.attempt('Page.navigate', { url }, sessionId),
        {
          sessionId: client.sessionId,
          url: hopUrl,
        }
      );
      assert.match(
        navigation.result?.errorText ?? navigation.error ?? '',
        /ERR_BLOCKED_BY_CLIENT|slicc: refused:/,
        'hop'
      );
      await settled(chrome, tab, failedUrl, true);
    }
    if (variant === 'history') {
      await page.evaluate(
        (sessionId) =>
          h.attempt(
            'Runtime.evaluate',
            {
              expression: 'history.back()',
              returnByValue: true,
            },
            sessionId
          ),
        client.sessionId
      );
      await settled(chrome, tab, failedUrl, true);
    }
    if (variant === 'lagged') {
      const answers = await warm(page, client.sessionId);
      assert.deepEqual(answers, Array(answers.length).fill(null), 'warm pending reply');
      await worker.evaluate(`globalThis.__sealLagTab = ${Number(client.targetId)};
        globalThis.__sealHold = {tabId:${Number(client.targetId)}, armed:true};
        globalThis.__sealEntered = new Promise((resolve) => { globalThis.__sealHold.announce = resolve; }); true`);
      await page.evaluate((sessionId) => {
        globalThis.__sealPending = h.attempt(
          'Page.captureScreenshot',
          { format: 'png' },
          sessionId
        );
        return true;
      }, client.sessionId);
      await worker
        .evaluate(
          'Promise.race([globalThis.__sealEntered.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 10000))])'
        )
        .then((entered) => assert.equal(entered, true, 'pending entry'));
      await chrome.cdp
        .send('Runtime.evaluate', { expression: 'history.back()' }, tab.sessionId)
        .catch((error) => {
          assert.match(error.message, /navigated|destroyed/i, 'restore');
        });
      await settled(chrome, tab, failedUrl, true);
      await worker.evaluate('globalThis.__sealHold.release(); true');
      pending = await page.evaluate(async () => {
        const answer = await globalThis.__sealPending;
        return {
          error: answer.error,
          answered: Boolean(answer.result),
          bytes: answer.result?.data?.length ?? 0,
        };
      });
    }
    let frameId = root.id;
    if (framed) {
      const { root: dom } = await chrome.cdp.send(
        'DOM.getDocument',
        { depth: -1, pierce: true },
        tab.sessionId
      );
      function find(node) {
        if (node.nodeName === 'IFRAME') return node.frameId;
        return (node.children ?? []).map(find).find(Boolean);
      }
      frameId = find(dom);
      assert.ok(frameId, 'child frame');
      const parent = await page.evaluate(
        (sessionId) => h.evaluate(sessionId, '1 + 1'),
        client.sessionId
      );
      assert.equal(parent, 2, 'parent control');
    }
    const report = await probes(page, client.sessionId, errorPage, frameId, framed);
    const info = framed ? undefined : await metadata(page, client);
    let scoped;
    if (framed) {
      scoped = await page.evaluate(
        async ({ frameId, sessionId }) => [
          await h.attempt('Target.attachToTarget', { targetId: frameId, flatten: true }),
          await h.attempt(
            'Target.setAutoAttach',
            { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
            sessionId
          ),
        ],
        { frameId, sessionId: client.sessionId }
      );
    }
    const receivedClean = await cleanMessages(page, id);
    await worker.evaluate('delete globalThis.__sealLagTab; true');
    await recover(chrome, page, tab, client, failedUrl, !framed, hopUrl);
    assert.equal(await cleanMessages(page, id), true, 'recovery replies');
    if (pending) {
      assert.match(pending.error ?? '', /^slicc: refused:/, 'pending reply');
      assert.equal(pending.answered, false, 'pending reply');
      assert.equal(pending.bytes, 0, 'pending size');
    }
    assertSealed(report);
    await auditRefusals(worker, report);
    assert.equal(receivedClean, true, 'client replies');
    if (info) {
      assert.equal(info.error, undefined, 'attach');
      for (const target of [info.info, info.listed, info.attached]) {
        assert.equal(target?.url, origin, 'target url');
        assert.equal(target?.title, origin, 'target title');
      }
    }
    if (scoped)
      for (const answer of scoped)
        assert.match(answer.error ?? '', /^slicc: refused:/, 'child session');
  } finally {
    await worker.evaluate(
      'delete globalThis.__sealLagTab; delete globalThis.__sealLagMs; delete globalThis.__sealFlakeTree; delete globalThis.__sealFlakeFrames; globalThis.__sealHold?.release?.(); delete globalThis.__sealHold; true'
    );
    await chrome.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
  }
}

test('error page admission', { timeout: 300000 }, async (t) => {
  process.env.SLICC_CDP_PORTS = '9300-9309';
  const chrome = await launch({ prepare: prepareExtension });
  let sw;
  try {
    const first = await chrome.visit(t, entries.seven);
    await first.evaluate(install, 'seven', extId);
    sw = await worker(chrome);
    for (const transport of ['seven', 'six-bridge']) {
      const page = transport === 'seven' ? first : await chrome.visit(t, entries[transport]);
      if (transport !== 'seven') await page.evaluate(install, transport, extId);
      for (const variant of [
        'control',
        'hop',
        'history',
        'frame',
        'lagged',
        'cached',
        'unsettled',
      ]) {
        await t.test(`${transport} ${variant}`, { timeout: 60000 }, () =>
          row(chrome, page, sw, transport, variant)
        );
      }
    }
  } finally {
    await sw?.close().catch(() => undefined);
    await chrome.close();
  }
});
