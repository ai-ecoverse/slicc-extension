import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

const vault = 'https://vault.sliccy.ai/marker';
const ordinary = 'https://ordinary.test/marker';
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const readExpr =
  'JSON.stringify({doc:window.__sliccDoc??null,href:location.href,tag:new URL(location.href).searchParams.get("n"),observedAt:Date.now(),restoredAt:window.__sliccRestoredAt??0,restored:window.__sliccRestored===true,type:(performance.getEntriesByType("navigation")[0]||{}).type||"",reasons:(performance.getEntriesByType("navigation")[0]||{}).notRestoredReasons||null})';

let chrome;

async function prepareExtension(paths) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = paths[0];
  const cdpPath = join(dir, 'cdp.js');
  const cdp = await readFile(cdpPath, 'utf8');
  const cdpFrom = `api.debugger.onEvent.addListener(this.onEvent);
    api.debugger.onDetach.addListener(this.onDetach);
    api.tabs.onUpdated?.addListener(this.onUpdated);`;
  const cdpTo = `const lag = (fn) => (...args) => { (globalThis.__sliccHistoryTrace ??= []).push({at:Date.now(),listener:fn.name,args}); const tabId = typeof args[0] === 'number' ? args[0] : args[0]?.tabId; if (!this.tabState(tabId)) return fn(...args); setTimeout(() => fn(...args), 2000); };
    api.debugger.onEvent.addListener(lag(this.onEvent));
    api.debugger.onDetach.addListener(this.onDetach);
    api.tabs.onUpdated?.addListener(lag(this.onUpdated));
    (globalThis.__sliccHistoryConnections ??= []).push(this);
    const historyRelease = this.release.bind(this);
    this.release = (tabId) => { (globalThis.__sliccHistoryTrace ??= []).push({at:Date.now(),release:tabId,stack:new Error().stack}); return historyRelease(tabId); };`;
  if (!cdp.includes(cdpFrom)) throw new Error('seven listener site changed');
  await writeFile(cdpPath, cdp.replace(cdpFrom, cdpTo));
  const sixPath = join(dir, 'six-sw.js');
  let six = await readFile(sixPath, 'utf8');
  const eventSite = 'chrome.debugger.onEvent.addListener(wrapped);';
  const updatedSite = 'chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {';
  const updatedEnd = `    releaseDebuggerAttachment(detachedTabId, "bridge").catch(() => {
    });
  }
});`;
  if (!six.includes(eventSite) || !six.includes(updatedSite) || !six.includes(updatedEnd)) {
    throw new Error('six listener site changed');
  }
  six = six.replace(
    eventSite,
    'chrome.debugger.onEvent.addListener((...args) => setTimeout(() => wrapped(...args), 2000));'
  );
  six = six.replace(
    updatedSite,
    'chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => { const historyUpdate = () => {'
  );
  six = six.replace(
    updatedEnd,
    `    releaseDebuggerAttachment(detachedTabId, "bridge").catch(() => {
    });
  }
}; if (tabShields.has(tabId)) setTimeout(historyUpdate, 2000); else historyUpdate(); });`
  );
  await writeFile(sixPath, six);
  const backgroundPath = join(dir, 'background.js');
  const background = await readFile(backgroundPath, 'utf8');
  await writeFile(
    backgroundPath,
    `${background}\n
const historyTabRead = chrome.tabs.get.bind(chrome.tabs);
chrome.tabs.get = async (tabId) => {
  const tab = await historyTabRead(tabId);
  const shown = globalThis.__sliccHistoryReported;
  return shown?.tabId === tabId ? {...tab, url:shown.url, pendingUrl:shown.pendingUrl, status:shown.status} : tab;
};
const historySend = chrome.debugger.sendCommand.bind(chrome.debugger);
chrome.debugger.sendCommand = async (target, method, params) => {
  const shown = globalThis.__sliccHistoryReported;
  if (shown?.tabId === target.tabId && shown.missingHistory && method === 'Page.getNavigationHistory') return {};
  const hold = globalThis.__sliccHistoryHold;
  const held = hold?.armed && hold.tabId === target.tabId && hold.method === method && (method !== 'Runtime.evaluate' || String(params?.expression).includes('window.__sliccDoc'));
  if (held) {
    hold.armed = false;
    hold.admittedAt = Date.now();
    hold.params = params;
    hold.announce();
    await new Promise((resolve) => { hold.release = resolve; });
    hold.forwardedAt = Date.now();
  }
  try {
    const answer = await historySend(target, method, params);
    if (held) {
      hold.finishedAt = Date.now();
      hold.result = answer;
    }
    return answer;
  } catch (error) {
    if (held) {
      hold.finishedAt = Date.now();
      hold.error = String(error?.message ?? error);
    }
    throw error;
  }
};
`
  );
}

async function heldRestore(page, transport, workerSession, variant) {
  const tag = `${transport}-held-${variant}`;
  const key = `__sliccHistoryWrite:${tag}`;
  const method = {
    read: 'Runtime.evaluate',
    write: 'Runtime.evaluate',
    pending: 'Runtime.evaluate',
    history: 'Runtime.evaluate',
    ax: 'DOM.resolveNode',
    dom: 'DOM.getDocument',
    screenshot: 'Page.captureScreenshot',
  }[variant];
  const expression =
    variant === 'write'
      ? `localStorage.setItem(${JSON.stringify(key)}, "written"); ${readExpr}`
      : readExpr;
  let params = method === 'Runtime.evaluate' ? { expression, returnByValue: true } : {};
  const tab = await historyTab(tag);
  const targetId = await clientTab(page, `${ordinary}?n=${tag}`);
  const { sessionId } = await page.evaluate(
    (targetId) => globalThis.h.cdp.send('Target.attachToTarget', { targetId, flatten: true }),
    targetId
  );
  const control = await page.evaluate(
    ([sessionId, expression]) => globalThis.h.evaluate(sessionId, expression),
    [sessionId, readExpr]
  );
  if (typeof control !== 'string') {
    const diagnostic = await chrome.cdp.send(
      'Runtime.evaluate',
      {
        expression:
          'JSON.stringify({trace:globalThis.__sliccHistoryTrace,connections:(globalThis.__sliccHistoryConnections || []).flatMap((c) => [...c.state.tabs.entries()].map(([id,t]) => ({id,mainFrameId:t.mainFrameId,contexts:t.worlds.visible(),documents:[...t.documents.contexts],frames:[...t.documents.frames]})))})',
        returnByValue: true,
      },
      workerSession
    );
    assert.fail(
      JSON.stringify({ transport, variant, control, diagnostic: diagnostic.result?.value })
    );
  }
  assert.equal(JSON.parse(control).doc, 'ordinary');
  let ax;
  const axMethods = [
    'DOM.resolveNode',
    'DOM.getBoxModel',
    'DOM.scrollIntoViewIfNeeded',
    'DOM.focus',
    'DOM.describeNode',
  ];
  if (variant === 'ax') {
    ax = await page.evaluate(
      async ([sessionId, methods]) => {
        const created = await globalThis.h.evaluate(
          sessionId,
          'document.body.innerHTML = "<button>AX binding control</button>"; true'
        );
        if (created !== true) throw new Error(JSON.stringify(created));
        const tree = await globalThis.h.cdp.send('Accessibility.getFullAXTree', {}, sessionId);
        const backendNodeId = tree.nodes.find(
          (node) => node.role?.value === 'button' && node.name?.value === 'AX binding control'
        )?.backendDOMNodeId;
        if (typeof backendNodeId !== 'number' || backendNodeId <= 0)
          throw new Error('AX button backend id missing');
        const controls = [];
        for (const method of methods) {
          await globalThis.h.cdp.send(method, { backendNodeId }, sessionId);
          controls.push(method);
        }
        return { backendNodeId, controls };
      },
      [sessionId, axMethods]
    );
    params = { backendNodeId: ax.backendNodeId };
  }
  const worker = async (expression) => {
    const answer = await chrome.cdp.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      workerSession
    );
    assert.equal(answer.exceptionDetails, undefined);
    return answer.result?.value;
  };
  await worker(
    `globalThis.__sliccHistoryHold = {tabId:${Number(targetId)}, method:${JSON.stringify(method)}, armed:true}; globalThis.__sliccHistoryHold.ready = new Promise((resolve) => { globalThis.__sliccHistoryHold.announce = resolve; }); true`
  );
  const reading = page.evaluate(
    async ([sessionId, method, params]) => {
      const issuedAt = Date.now();
      return globalThis.h.cdp
        .send(method, params, sessionId)
        .then((result) => ({
          issuedAt,
          returnedAt: Date.now(),
          result,
          value: result.result?.value,
        }))
        .catch((error) => ({
          issuedAt,
          returnedAt: Date.now(),
          error: String(error?.message ?? error),
        }));
    },
    [sessionId, method, params]
  );
  assert.equal(
    await worker(
      'Promise.race([globalThis.__sliccHistoryHold.ready.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))])'
    ),
    true
  );
  const direct = await chrome.cdp.send('Target.attachToTarget', {
    targetId: tab.targetId,
    flatten: true,
  });
  await chrome.cdp.send('Page.enable', {}, direct.sessionId);
  let restore;
  let timer;
  const restored = new Promise((resolve, reject) => {
    restore = resolve;
    timer = setTimeout(() => reject(new Error('restore event not observed')), 10000);
  });
  const off = chrome.cdp.on(({ method, params, sessionId: source }) => {
    if (
      source === direct.sessionId &&
      method === 'Page.frameNavigated' &&
      params.type === 'BackForwardCacheRestore'
    ) {
      restore({ at: Date.now(), frame: params.frame, type: params.type });
    }
  });
  try {
    const backIssuedAt = Date.now();
    await chrome.cdp.send(
      'Runtime.evaluate',
      { expression: 'history.back()', userGesture: true },
      direct.sessionId
    );
    const commit = await restored;
    let document;
    const deadline = Date.now() + 5000;
    do {
      const answer = await chrome.cdp.send(
        'Runtime.evaluate',
        { expression: readExpr, returnByValue: true },
        direct.sessionId
      );
      document = JSON.parse(answer.result.value);
    } while (!document.restored && Date.now() < deadline);
    assert.equal(document.doc, 'protected');
    assert.equal(document.restored, true);
    assert.equal(document.tag, tag);
    if (variant === 'pending' || variant === 'history') {
      await worker(
        `globalThis.__sliccHistoryReported = {tabId:${Number(targetId)}, url:${JSON.stringify(ordinary)}, pendingUrl:${JSON.stringify(variant === 'pending' ? vault : '')}, status:"complete", missingHistory:${variant === 'history'}}; true`
      );
    }
    await worker('globalThis.__sliccHistoryHold.release(); true');
    const client = await reading;
    const forwarded = await worker(
      '({admittedAt:globalThis.__sliccHistoryHold.admittedAt,forwardedAt:globalThis.__sliccHistoryHold.forwardedAt,finishedAt:globalThis.__sliccHistoryHold.finishedAt,uniqueContextId:globalThis.__sliccHistoryHold.params?.uniqueContextId,result:globalThis.__sliccHistoryHold.result,error:globalThis.__sliccHistoryHold.error})'
    );
    const storage = await chrome.cdp.send(
      'Runtime.evaluate',
      { expression: `localStorage.getItem(${JSON.stringify(key)})`, returnByValue: true },
      direct.sessionId
    );
    assert.equal(storage.exceptionDetails, undefined);
    if (ax) {
      ax.restored = await page.evaluate(
        async ([sessionId, backendNodeId, methods]) => {
          const answers = [];
          for (const method of methods)
            answers.push({
              method,
              ...(await globalThis.h.attempt(method, { backendNodeId }, sessionId)),
            });
          return answers;
        },
        [sessionId, ax.backendNodeId, axMethods]
      );
    }
    return {
      ax,
      transport,
      variant,
      method,
      browserTargetId: tab.targetId,
      targetId,
      sessionId,
      backIssuedAt,
      commit,
      document,
      client: { ...client, parsed: parsed(client) },
      forwarded,
      sideEffectAbsent: storage.result.value === null,
      marker: storage.result.value,
      protectedReads:
        method === 'Runtime.evaluate'
          ? parsed(client)?.doc === 'protected'
            ? 1
            : 0
          : client.result
            ? 1
            : 0,
    };
  } finally {
    clearTimeout(timer);
    off();
    await worker(
      'delete globalThis.__sliccHistoryReported; globalThis.__sliccHistoryHold?.release?.(); true'
    );
    await reading.catch(() => undefined);
    await page.evaluate(
      (sessionId) =>
        globalThis.h.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined),
      sessionId
    );
    await chrome.cdp
      .send('Target.detachFromTarget', { sessionId: direct.sessionId })
      .catch(() => undefined);
    await chrome.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
  }
}

async function settled(sessionId, prefix) {
  const deadline = Date.now() + 15000;
  let last = '';
  while (Date.now() < deadline) {
    const answer = await chrome.cdp.send(
      'Runtime.evaluate',
      { expression: 'document.readyState + "\\n" + location.href', returnByValue: true },
      sessionId
    );
    last = answer.result?.value ?? '';
    const [state, href] = String(last).split('\n');
    if (state === 'complete' && href?.startsWith(prefix)) return href;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return `TIMEOUT ${last}`;
}

async function clientTab(page, prefix) {
  return page.evaluate(async (prefix) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const listed = await globalThis.h.cdp.send('Target.getTargets');
      const found = (listed.targetInfos ?? []).find((info) =>
        String(info.url ?? '').startsWith(prefix)
      );
      if (found) return found.targetId;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return '';
  }, prefix);
}

async function historyTab(tag) {
  const { targetId } = await chrome.cdp.send('Target.createTarget', {
    url: `${vault}?n=${tag}`,
    background: true,
  });
  let sessionId;
  const attach = async () => {
    ({ sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  };
  const detach = async () => {
    if (!sessionId) return;
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    sessionId = undefined;
  };
  await attach();
  const loadedVault = await settled(sessionId, vault);
  await detach();
  await attach();
  await chrome.cdp.send('Page.navigate', { url: `${ordinary}?n=${tag}` }, sessionId);
  const loadedOrdinary = await settled(sessionId, ordinary);
  await detach();
  return { targetId, loadedVault, loadedOrdinary };
}

async function browserRead(urlPrefix) {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const page = targetInfos.find((info) => info.type === 'page' && info.url?.startsWith(urlPrefix));
  if (!page)
    return {
      missing: true,
      urls: targetInfos.filter((info) => info.type === 'page').map((info) => info.url),
    };
  let sessionId;
  try {
    ({ sessionId } = await chrome.cdp.send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    }));
    const answer = await chrome.cdp.send(
      'Runtime.evaluate',
      { expression: readExpr, returnByValue: true },
      sessionId
    );
    return {
      url: page.url,
      value: answer.result?.value ?? null,
      error: answer.exceptionDetails?.text ?? null,
    };
  } catch (error) {
    return { url: page.url, error: String(error?.message ?? error) };
  } finally {
    if (sessionId) {
      await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    }
  }
}

async function restoredDocument(urlPrefix) {
  const deadline = Date.now() + 8000;
  let last;
  while (Date.now() < deadline) {
    last = await browserRead(urlPrefix);
    let parsed;
    if (typeof last.value === 'string') {
      try {
        parsed = JSON.parse(last.value);
      } catch {
        parsed = undefined;
      }
    }
    if (parsed?.doc === 'protected' && parsed?.restored === true) {
      return { setup: false, url: last.url, value: last.value, parsed };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { setup: true, detail: JSON.stringify(last) };
}

async function eligibility() {
  const readings = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const probe = await eligibilityAttempt();
    const state = parsed({ value: probe.reading });
    if (state?.doc === 'protected' && state.restored === true) return probe;
    readings.push({ attempt, reading: probe.reading });
  }
  assert.fail(`setup: bfcache not available after 3 attempts (${JSON.stringify(readings)})`);
}

async function eligibilityAttempt() {
  const tab = await historyTab('probe');
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: tab.targetId,
    flatten: true,
  });
  try {
    await chrome.cdp.send(
      'Runtime.evaluate',
      { expression: 'history.back()', returnByValue: true },
      sessionId
    );
    const deadline = Date.now() + 8000;
    let last;
    while (Date.now() < deadline) {
      const answer = await chrome.cdp.send(
        'Runtime.evaluate',
        { expression: readExpr, returnByValue: true },
        sessionId
      );
      last = answer.result?.value ?? null;
      if (typeof last === 'string' && last.includes('vault.sliccy.ai')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { tab, reading: last };
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    await chrome.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
  }
}

async function burst(tabId) {
  const h = globalThis.h;
  const started = Date.now();
  const readExpr =
    'JSON.stringify({doc:window.__sliccDoc??null,href:location.href,tag:new URL(location.href).searchParams.get("n"),observedAt:Date.now(),restoredAt:window.__sliccRestoredAt??0,restored:window.__sliccRestored===true,type:(performance.getEntriesByType("navigation")[0]||{}).type||"",reasons:(performance.getEntriesByType("navigation")[0]||{}).notRestoredReasons||null})';
  const { sessionId } = await h.cdp.send('Target.attachToTarget', {
    targetId: String(tabId),
    flatten: true,
  });
  await h.evaluate(sessionId, readExpr);
  const read = () => {
    const issuedAt = Date.now();
    return h.cdp
      .send('Runtime.evaluate', { expression: readExpr, returnByValue: true }, sessionId)
      .then((result) => ({
        t: Date.now() - started,
        issuedAt,
        returnedAt: Date.now(),
        method: 'Runtime.evaluate',
        value: result?.result?.value ?? null,
      }))
      .catch((error) => ({
        t: Date.now() - started,
        issuedAt,
        returnedAt: Date.now(),
        method: 'Runtime.evaluate',
        error: String(error?.message ?? error),
      }));
  };
  const before = await read();
  const history = await h.cdp
    .send('Page.getNavigationHistory', {}, sessionId)
    .then((result) => result)
    .catch((error) => ({ error: String(error?.message ?? error) }));
  const entries = Array.isArray(history?.entries) ? history.entries : [];
  const prior = entries.find((item) => String(item?.url ?? '').includes('vault.sliccy.ai'));
  let historyCommand;
  if (prior) {
    historyCommand = await h.cdp
      .send('Page.navigateToHistoryEntry', { entryId: prior.id }, sessionId)
      .then((result) => ({ result }))
      .catch((error) => ({ error: String(error?.message ?? error) }));
  } else {
    historyCommand = { error: 'no vault history entry visible to the client', entries };
  }
  const afterHistory = await read();
  const back = h.cdp
    .send(
      'Runtime.evaluate',
      { expression: 'history.back()', userGesture: true, returnByValue: true },
      sessionId
    )
    .then((result) => ({ t: Date.now() - started, value: result?.result?.value ?? null }))
    .catch((error) => ({ t: Date.now() - started, error: String(error?.message ?? error) }));
  const reads = [];
  for (let i = 0; i < 30; i++) {
    reads.push(read());
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const seen = [];
  const watch = (async () => {
    for (let i = 0; i < 40; i++) {
      const sample = await h.cdp
        .send('Target.getTargetInfo', { targetId: String(tabId) })
        .then((result) => ({ t: Date.now() - started, url: result?.targetInfo?.url ?? '' }))
        .catch((error) => ({ t: Date.now() - started, error: String(error?.message ?? error) }));
      seen.push(sample);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  const during = await Promise.all(reads);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const late = await read();
  await watch;
  return {
    sessionId,
    targetId: String(tabId),
    started,
    before,
    historyCommand,
    afterHistory,
    back: await back,
    during,
    late,
    seen,
  };
}

async function blockedHop(tabId) {
  const h = globalThis.h;
  const started = Date.now();
  const readExpr =
    'JSON.stringify({doc:window.__sliccDoc??null,href:location.href,restored:window.__sliccRestored===true,type:(performance.getEntriesByType("navigation")[0]||{}).type||"",reasons:(performance.getEntriesByType("navigation")[0]||{}).notRestoredReasons||null})';
  const { sessionId } = await h.cdp.send('Target.attachToTarget', {
    targetId: String(tabId),
    flatten: true,
  });
  await h.evaluate(sessionId, readExpr);
  const read = () =>
    h.cdp
      .send('Runtime.evaluate', { expression: readExpr, returnByValue: true }, sessionId)
      .then((result) => ({ t: Date.now() - started, value: result?.result?.value ?? null }))
      .catch((error) => ({ t: Date.now() - started, error: String(error?.message ?? error) }));
  const bounded = (attempt) =>
    Promise.race([
      attempt,
      new Promise((resolve) =>
        setTimeout(() => resolve({ t: Date.now() - started, error: 'timeout' }), 2000)
      ),
    ]);
  const before = await bounded(read());
  const hopped = await bounded(
    h.cdp
      .send(
        'Runtime.evaluate',
        {
          expression: 'location.assign("https://vault.sliccy.ai/marker?hop=1")',
          userGesture: true,
          returnByValue: true,
        },
        sessionId
      )
      .then((result) => ({ t: Date.now() - started, value: result?.result?.value ?? null }))
      .catch((error) => ({ t: Date.now() - started, error: String(error?.message ?? error) }))
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const step = (expression) =>
    bounded(
      h.cdp
        .send('Runtime.evaluate', { expression, userGesture: true, returnByValue: true }, sessionId)
        .then((result) => ({ t: Date.now() - started, value: result?.result?.value ?? null }))
        .catch((error) => ({ t: Date.now() - started, error: String(error?.message ?? error) }))
    );
  const back = await step('history.go(-1)');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const backAgain = await step('history.go(-1)');
  const during = [];
  for (let i = 0; i < 6; i++) during.push(await bounded(read()));
  return { sessionId, before, hopped, back, backAgain, during };
}

function parsed(row) {
  if (!row || typeof row.value !== 'string') return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

function summarize(name, run, autopsy) {
  const rows = [run.before, run.afterHistory, ...run.during, run.late].map((row, index) => ({
    index,
    ...row,
    parsed: parsed(row),
  }));
  const hits = rows.filter((row) => row.parsed?.doc === 'protected');
  const restoredHits = hits.filter((row) => row.parsed?.restored === true);
  let outcome = 'not-observed';
  if (restoredHits.length > 0) outcome = 'vulnerable';
  else if (hits.length > 0) outcome = 'protected-document';
  else if (autopsy?.parsed?.restored === true || autopsy?.parsed?.type === 'back_forward') {
    outcome = hits.length > 0 ? 'vulnerable' : 'restored-commands-blocked';
  }
  return {
    transport: name,
    targetId: run.targetId,
    sessionId: run.sessionId,
    started: run.started,
    outcome,
    protectedReads: hits.length,
    restoredReads: restoredHits.length,
    historyCommand: run.historyCommand,
    back: run.back,
    before: parsed(run.before),
    afterHistory: parsed(run.afterHistory),
    late: { ...run.late, parsed: parsed(run.late) },
    firstHit: hits[0] ?? null,
    rows: rows.map((row) => ({
      t: row.t,
      issuedAt: row.issuedAt,
      returnedAt: row.returnedAt,
      observedAt: row.parsed?.observedAt,
      restoredAt: row.parsed?.restoredAt,
      tag: row.parsed?.tag,
      method: row.method,
      error: row.error,
      doc: row.parsed?.doc,
      href: row.parsed?.href,
      restored: row.parsed?.restored,
      type: row.parsed?.type,
    })),
    samples: (run.seen ?? []).filter((sample, index) => index % 4 === 0),
    autopsy,
  };
}

test('a restored history entry is admitted only after a live tab check', {
  timeout: 240000,
}, async (t) => {
  process.env.SLICC_CDP_PORTS = '9300-9309';
  chrome = await launch({ prepare: prepareExtension });
  const version = await chrome.cdp
    .send('Browser.getVersion')
    .catch((error) => ({ error: String(error) }));
  const woke = await chrome.visit(t, entry.seven);
  await woke.evaluate(install, 'seven', extId);
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const workerTarget = targetInfos.find(
    (info) =>
      info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
  );
  assert.ok(workerTarget);
  const { sessionId: workerSession } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: workerTarget.targetId,
    flatten: true,
  });
  const probe = await eligibility();
  const reports = [];
  const heldReports = [];
  const hops = [];
  for (const transport of ['seven', 'six-bridge']) {
    const page = await chrome.visit(t, entry[transport]);
    await page.evaluate(install, transport, extId);
    for (const variant of ['read', 'write', 'ax', 'dom', 'screenshot', 'pending', 'history']) {
      const held = await heldRestore(page, transport, workerSession, variant);
      heldReports.push(held);
      console.log(`history-check held ${JSON.stringify(held)}`);
    }
    const browserEvents = [];
    const stopObserving = chrome.cdp.on(({ method, params }) => {
      if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
        browserEvents.push({
          at: Date.now(),
          method,
          targetId: params.targetInfo?.targetId,
          url: params.targetInfo?.url,
        });
      }
    });
    t.after(stopObserving);
    const tab = await historyTab(transport);
    const extensionTab = await clientTab(page, `${ordinary}?n=${transport}`);
    if (transport === 'six-bridge') {
      const hopTab = await historyTab('six-bridge-hop');
      const hopExtensionTab = await clientTab(page, `${ordinary}?n=six-bridge-hop`);
      const hopRun = await page.evaluate(blockedHop, hopExtensionTab);
      const hopRows = [hopRun.before, ...(hopRun.during ?? [])].map((row) => parsed(row));
      hops.push({
        before: parsed(hopRun.before),
        hopped: hopRun.hopped,
        back: hopRun.back,
        backAgain: hopRun.backAgain,
        protectedReads: hopRows.filter((row) => row?.doc === 'protected').length,
        samples: (hopRun.during ?? []).map((row) => parsed(row)?.doc ?? row?.error ?? 'unread'),
      });
      await page.evaluate(
        (sessionId) =>
          globalThis.h.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined),
        hopRun.sessionId
      );
      await chrome.cdp
        .send('Target.closeTarget', { targetId: hopTab.targetId })
        .catch(() => undefined);
    }
    const run = await page.evaluate(burst, extensionTab);
    console.log(`history-check burst ${transport} ${JSON.stringify(run)}`);
    await page.evaluate(
      (sessionId) =>
        globalThis.h.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined),
      run.sessionId
    );
    const direct = await restoredDocument(vault);
    if (direct.setup) {
      assert.fail(`setup: the restored document was not established (${direct.detail})`);
    }
    const autopsy = { url: direct.url, value: direct.value, parsed: direct.parsed };
    reports.push({
      ...summarize(transport, run, autopsy),
      browserTargetId: tab.targetId,
      browserEvents: browserEvents.filter((event) => event.targetId === tab.targetId),
    });
    stopObserving();
    await chrome.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
  }
  assert.equal(JSON.parse(probe.reading).restored, true);
  assert.equal(reports.length, 2);
  for (const report of reports) {
    console.log(`history-check result ${JSON.stringify(report)}`);
  }
  for (const report of reports) {
    await t.test(report.transport, () => {
      for (const held of heldReports.filter((row) => row.transport === report.transport)) {
        assert.equal(held.protectedReads, 0, JSON.stringify(held));
        assert.equal(held.sideEffectAbsent, true, JSON.stringify(held));
        if (held.variant === 'ax') {
          assert.deepEqual(held.ax.controls, [
            'DOM.resolveNode',
            'DOM.getBoxModel',
            'DOM.scrollIntoViewIfNeeded',
            'DOM.focus',
            'DOM.describeNode',
          ]);
          assert.equal(held.ax.restored.length, held.ax.controls.length);
          for (const answer of held.ax.restored) {
            assert.match(answer.error ?? '', /slicc: refused:/, JSON.stringify(answer));
            assert.equal(answer.result, undefined, JSON.stringify(answer));
          }
        }
        if (held.variant === 'write') {
          assert.ok(held.forwarded.uniqueContextId, JSON.stringify(held));
          assert.equal(
            parsed({ value: held.forwarded.result?.result?.value })?.doc === 'protected',
            false,
            JSON.stringify(held)
          );
        }
      }
      const leaks = report.rows.filter((row) => row.doc === 'protected');
      if (leaks.length > 0) {
        console.log(
          `history-check leak ${report.transport} ${JSON.stringify(
            leaks.map((row) => ({ t: row.t, method: row.method, href: row.href }))
          )}`
        );
      }
      assert.equal(report.before?.doc, 'ordinary');
      assert.equal(report.before?.tag, report.transport);
      assert.equal(report.protectedReads, 0, `${report.transport}: ${JSON.stringify(leaks)}`);
      assert.equal(report.autopsy?.parsed?.doc, 'protected');
      assert.equal(report.autopsy?.parsed?.tag, report.transport);
      assert.equal(report.autopsy?.parsed?.restored, true);
    });
  }
  await chrome.cdp
    .send('Target.detachFromTarget', { sessionId: workerSession })
    .catch(() => undefined);
  assert.equal(hops.length, 1);
  for (const hop of hops) {
    const detail = JSON.stringify({
      before: hop.before,
      hopped: hop.hopped,
      back: hop.back,
      backAgain: hop.backAgain,
      samples: hop.samples,
    });
    assert.equal(hop.before?.doc, 'ordinary', detail);
    assert.equal(hop.protectedReads, 0, detail);
  }
  assert.equal(version?.product?.startsWith('Chrome/'), true);
});

after(() => chrome?.close());
