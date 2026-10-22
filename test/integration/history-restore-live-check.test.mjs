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
  'JSON.stringify({doc:window.__sliccDoc??null,href:location.href,restored:window.__sliccRestored===true,type:(performance.getEntriesByType("navigation")[0]||{}).type||"",reasons:(performance.getEntriesByType("navigation")[0]||{}).notRestoredReasons||null})';

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
  const cdpTo = `const lag = (fn) => (...args) => setTimeout(() => fn(...args), 2000);
    api.debugger.onEvent.addListener(lag(this.onEvent));
    api.debugger.onDetach.addListener(this.onDetach);
    api.tabs.onUpdated?.addListener(lag(this.onUpdated));`;
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
    'chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => setTimeout(() => {'
  );
  six = six.replace(
    updatedEnd,
    `    releaseDebuggerAttachment(detachedTabId, "bridge").catch(() => {
    });
  }
}, 2000));`
  );
  await writeFile(sixPath, six);
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

async function eligibility() {
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
    'JSON.stringify({doc:window.__sliccDoc??null,href:location.href,restored:window.__sliccRestored===true,type:(performance.getEntriesByType("navigation")[0]||{}).type||"",reasons:(performance.getEntriesByType("navigation")[0]||{}).notRestoredReasons||null})';
  const { sessionId } = await h.cdp.send('Target.attachToTarget', {
    targetId: String(tabId),
    flatten: true,
  });
  const read = () =>
    h.cdp
      .send('Runtime.evaluate', { expression: readExpr, returnByValue: true }, sessionId)
      .then((result) => ({ t: Date.now() - started, value: result?.result?.value ?? null }))
      .catch((error) => ({ t: Date.now() - started, error: String(error?.message ?? error) }));
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
    before,
    historyCommand,
    afterHistory,
    back: await back,
    during,
    late,
    seen,
  };
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
  timeout: 180000,
}, async (t) => {
  process.env.SLICC_CDP_PORTS = '9300-9309';
  chrome = await launch({ prepare: prepareExtension });
  const version = await chrome.cdp
    .send('Browser.getVersion')
    .catch((error) => ({ error: String(error) }));
  const woke = await chrome.visit(t, entry.seven);
  await woke.evaluate(install, 'seven', extId);
  const probe = await eligibility();
  const reports = [];
  for (const transport of ['seven', 'six-bridge']) {
    const page = await chrome.visit(t, entry[transport]);
    await page.evaluate(install, transport, extId);
    const tab = await historyTab(transport);
    const extensionTab = await page.evaluate(async (prefix) => {
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
    }, `${ordinary}?n=${transport}`);
    const run = await page.evaluate(burst, extensionTab);
    await page.evaluate(
      (sessionId) =>
        globalThis.h.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined),
      run.sessionId
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const direct = await browserRead(vault);
    let parsedAutopsy;
    if (typeof direct.value === 'string') {
      try {
        parsedAutopsy = JSON.parse(direct.value);
      } catch {
        parsedAutopsy = undefined;
      }
    }
    const autopsy = { ...direct, parsed: parsedAutopsy };
    reports.push(summarize(transport, run, autopsy));
    await chrome.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
  }
  assert.equal(JSON.parse(probe.reading).restored, true);
  assert.equal(reports.length, 2);
  assert.equal(version?.product?.startsWith('Chrome/'), true);
  const failures = [];
  for (const report of reports) {
    try {
      await t.test(report.transport, async () => {
        assert.equal(report.before?.doc, 'ordinary', report.transport);
        assert.equal(report.protectedReads, 0, report.transport);
        assert.equal(report.autopsy?.parsed?.doc, 'protected', report.transport);
        assert.equal(report.autopsy?.parsed?.restored, true, report.transport);
      });
    } catch {
      failures.push(report.transport);
    }
  }
  assert.deepEqual(failures, []);
});

after(() => chrome?.close());
