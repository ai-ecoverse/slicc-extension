import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

async function patch(dir, file, from, to) {
  const path = join(dir, file);
  const source = await readFile(path, 'utf8');
  assert.ok(source.includes(from), `${file} site`);
  await writeFile(path, source.replace(from, to));
}

async function prepare(paths) {
  await patch(
    paths[0],
    'cdp.js',
    'function unsettled() {\n',
    'function unsettled() {\n  (globalThis.__unsettled ??= []).push(new Error().stack);\n'
  );
  await patch(
    paths[0],
    'six-sw.js',
    'function refuse(reason) {\n',
    'function refuse(reason) {\n  if (reason === UNSETTLED_REFUSAL) (globalThis.__unsettled ??= []).push(new Error().stack);\n'
  );
  const path = join(paths[0], 'background.js');
  const source = await readFile(path, 'utf8');
  await writeFile(
    path,
    `${source}
const diagFrames = chrome.webNavigation.getAllFrames.bind(chrome.webNavigation);
chrome.webNavigation.getAllFrames = async (details) => {
  const frames = await diagFrames(details);
  (globalThis.__seenFrames ??= []).push(frames);
  if (globalThis.__seenFrames.length > 4) globalThis.__seenFrames.shift();
  return frames;
};
`
  );
}

let chrome;
before(async () => {
  chrome = await launch({ prepare });
});
after(() => chrome?.close());

const transports = ['seven', 'six-bridge'];
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};

function head() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function summarize(answer) {
  if (answer?.error) return { status: 'refused', error: String(answer.error) };
  const result = answer?.result ?? {};
  if (typeof result.data === 'string') {
    return {
      status: 'answered',
      bytes: result.data.length,
      sha256: createHash('sha256').update(result.data).digest('hex').slice(0, 16),
    };
  }
  if (result.root?.nodeId != null) return { status: 'answered', nodeId: result.root.nodeId };
  if (result.outerHTML != null)
    return { status: 'answered', outerHTMLBytes: String(result.outerHTML).length };
  if (result.frameTree?.frame) {
    return {
      status: 'answered',
      frameUrl: result.frameTree.frame.url,
      origin: result.frameTree.frame.securityOrigin,
    };
  }
  if (Array.isArray(result.entries)) {
    const current = result.entries[result.currentIndex];
    return {
      status: 'answered',
      currentIndex: result.currentIndex,
      entryUrl: current?.url,
      entries: result.entries.map((e) => e?.url),
    };
  }
  if (result.result?.value !== undefined) return { status: 'answered', value: result.result.value };
  if (Array.isArray(result.documents))
    return { status: 'answered', documents: result.documents.length };
  if (Array.isArray(result.nodes)) return { status: 'answered', nodes: result.nodes.length };
  if (Array.isArray(result.computedStyle))
    return { status: 'answered', computedStyle: result.computedStyle.length };
  return { status: 'answered', keys: Object.keys(result).slice(0, 10) };
}

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

async function targetUrl(page, targetId) {
  return page.evaluate(async (targetId) => {
    const listed = await h.cdp.send('Target.getTargets');
    return listed.targetInfos?.find((entry) => entry.targetId === targetId)?.url ?? '';
  }, targetId);
}

async function openBlank(page) {
  return page.evaluate(async () => {
    const created = await h.attempt('Target.createTarget', { url: 'about:blank' });
    if (created.error || !created.result?.targetId) {
      return { error: created.error || JSON.stringify(created) };
    }
    const targetId = created.result.targetId;
    const attached = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
    if (attached.error || !attached.result?.sessionId) {
      await h.attempt('Target.closeTarget', { targetId });
      return {
        error: attached.error || JSON.stringify(attached),
        targetId,
      };
    }
    const sessionId = attached.result.sessionId;
    await h.attempt('Page.enable', {}, sessionId);
    return { targetId, sessionId };
  });
}

async function settleUrl(page, targetId, pred, ms = 10000) {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    last = await targetUrl(page, targetId);
    if (pred(last)) return { url: last, timedOut: false };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url: last, timedOut: true };
}

async function openViewSource(page, wrapped) {
  const opened = await openBlank(page);
  if (opened.error) return opened;
  const navigated = await page.evaluate(
    async ({ sessionId, wrapped }) => h.attempt('Page.navigate', { url: wrapped }, sessionId),
    { sessionId: opened.sessionId, wrapped }
  );
  if (navigated.error) {
    await page.evaluate(
      (targetId) => h.attempt('Target.closeTarget', { targetId }),
      opened.targetId
    );
    return { error: navigated.error, targetId: opened.targetId, navigate: navigated };
  }
  const settled = await settleUrl(
    page,
    opened.targetId,
    (url) => typeof url === 'string' && url.startsWith('view-source:')
  );
  await page.evaluate(
    (sessionId) => h.attempt('Target.detachFromTarget', { sessionId }),
    opened.sessionId
  );
  return {
    targetId: opened.targetId,
    url: settled.url,
    timedOut: settled.timedOut,
  };
}

async function openBlob(page, originUrl) {
  const opened = await openBlank(page);
  if (opened.error) return opened;
  const landed = await page.evaluate(
    async ({ sessionId, originUrl }) => {
      const nav = await h.attempt('Page.navigate', { url: originUrl }, sessionId);
      if (nav.error) return { error: nav.error };
      const href = await h.until(async () => {
        const value = await h.evaluate(
          sessionId,
          'document.readyState === "complete" ? location.href : ""'
        );
        return typeof value === 'string' && value.startsWith(originUrl.split('?')[0])
          ? value
          : undefined;
      });
      if (!href) return { error: 'origin navigate did not settle' };
      return { href };
    },
    { sessionId: opened.sessionId, originUrl }
  );
  if (landed.error) {
    await page.evaluate(
      (targetId) => h.attempt('Target.closeTarget', { targetId }),
      opened.targetId
    );
    return { error: landed.error, targetId: opened.targetId };
  }
  const made = await page.evaluate(
    async (sessionId) =>
      h.attempt(
        'Runtime.evaluate',
        {
          expression: `URL.createObjectURL(new Blob(['<!doctype html><body id=diag>ok</body>'],{type:'text/html'}))`,
          returnByValue: true,
          awaitPromise: true,
        },
        sessionId
      ),
    opened.sessionId
  );
  const blobUrl = made.result?.result?.value;
  if (typeof blobUrl !== 'string' || !blobUrl.startsWith('blob:')) {
    await page.evaluate(
      (targetId) => h.attempt('Target.closeTarget', { targetId }),
      opened.targetId
    );
    return { error: `createObjectURL failed: ${JSON.stringify(made)}`, targetId: opened.targetId };
  }
  const navigated = await page.evaluate(
    async ({ sessionId, blobUrl }) => h.attempt('Page.navigate', { url: blobUrl }, sessionId),
    { sessionId: opened.sessionId, blobUrl }
  );
  if (navigated.error) {
    await page.evaluate(
      (targetId) => h.attempt('Target.closeTarget', { targetId }),
      opened.targetId
    );
    return { error: navigated.error, targetId: opened.targetId, blobUrl };
  }
  const settled = await settleUrl(
    page,
    opened.targetId,
    (url) => typeof url === 'string' && url.startsWith('blob:')
  );
  await page.evaluate(
    (sessionId) => h.attempt('Target.detachFromTarget', { sessionId }),
    opened.sessionId
  );
  return {
    targetId: opened.targetId,
    url: settled.url,
    blobUrl,
    timedOut: settled.timedOut,
  };
}

async function probe(page, targetId) {
  return page.evaluate(async (targetId) => {
    const attached = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.result?.sessionId;
    const commands = {};
    if (sessionId) {
      for (const [method, params] of [
        ['Page.getNavigationHistory', {}],
        ['DOM.getDocument', { depth: 0 }],
        ['DOM.getOuterHTML', { nodeId: 1 }],
        ['Page.captureScreenshot', { format: 'png' }],
        ['Page.printToPDF', {}],
        ['Accessibility.getFullAXTree', {}],
        ['DOMSnapshot.captureSnapshot', { computedStyles: [] }],
        ['Runtime.evaluate', { expression: '1+1', returnByValue: true }],
        ['Page.getFrameTree', {}],
        ['CSS.getComputedStyleForNode', { nodeId: 1 }],
      ]) {
        commands[method] = await h.attempt(method, params, sessionId);
      }
      await h.attempt('Target.detachFromTarget', { sessionId });
    }
    return { attached, commands };
  }, targetId);
}

const METHODS = [
  ['Page.getNavigationHistory', {}],
  ['Runtime.evaluate', { expression: 'location.href', returnByValue: true }],
  ['DOM.getDocument', { depth: 0 }],
  ['DOM.getOuterHTML', { nodeId: 1 }],
  ['Page.captureScreenshot', { format: 'png' }],
  ['Page.printToPDF', {}],
  ['Accessibility.getFullAXTree', {}],
  ['DOMSnapshot.captureSnapshot', { computedStyles: [] }],
  ['Page.getFrameTree', {}],
  ['CSS.getComputedStyleForNode', { nodeId: 1 }],
];

async function workerSession() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const worker = targetInfos.find(
      (info) =>
        info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
    );
    if (worker) {
      const attached = await chrome.cdp
        .send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
        .catch(() => undefined);
      if (attached?.sessionId) return attached.sessionId;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

let current;
async function sw(_session, expression) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    current ??= await workerSession();
    if (!current) return { exception: 'no worker session' };
    const answer = await chrome.cdp
      .send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, current)
      .catch(() => undefined);
    if (!answer) {
      current = undefined;
      continue;
    }
    if (answer.exceptionDetails)
      return { exception: answer.exceptionDetails.exception?.description };
    return answer.result.value;
  }
  return { exception: 'worker evaluate failed' };
}

async function extensionView(session, targetId) {
  return sw(
    session,
    `(async () => {
      const t = (await chrome.debugger.getTargets()).find((x) => x.tabId === Number(${JSON.stringify(targetId)}));
      if (!t?.tabId) return { target: t ?? null };
      const tab = await chrome.tabs.get(t.tabId);
      const frames = await chrome.webNavigation.getAllFrames({ tabId: t.tabId });
      return {
        target: { url: t.url, attached: t.attached, tabId: t.tabId },
        tab: { url: tab.url, pendingUrl: tab.pendingUrl, status: tab.status },
        frames,
      };
    })()`
  );
}

async function rawView(tabTarget) {
  const mapped = await sw(
    undefined,
    `(async () => (await chrome.debugger.getTargets()).find((x) => x.tabId === Number(${JSON.stringify(tabTarget)}))?.id ?? '')()`
  );
  const targetId = typeof mapped === 'string' && mapped ? mapped : tabTarget;
  const attached = await chrome.cdp
    .send('Target.attachToTarget', { targetId, flatten: true })
    .catch((e) => ({ error: String(e?.message ?? e) }));
  if (!attached.sessionId) return { mapped, attach: attached };
  const { sessionId } = attached;
  const out = {};
  for (const [m, p] of [
    ['Page.getFrameTree', {}],
    ['Page.getNavigationHistory', {}],
  ]) {
    out[m] = await chrome.cdp
      .send(m, p, sessionId)
      .catch((e) => ({ error: String(e?.message ?? e) }));
  }
  out['Target.getTargetInfo'] = await chrome.cdp
    .send('Target.getTargetInfo', { targetId })
    .catch((e) => ({ error: String(e?.message ?? e) }));
  await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  const strip = (node) =>
    node && {
      frame: {
        id: node.frame?.id,
        url: node.frame?.url,
        urlFragment: node.frame?.urlFragment,
        securityOrigin: node.frame?.securityOrigin,
        securityOriginDetails: node.frame?.securityOriginDetails,
        unreachableUrl: node.frame?.unreachableUrl,
        loaderId: node.frame?.loaderId,
        domainAndRegistry: node.frame?.domainAndRegistry,
        secureContextType: node.frame?.secureContextType,
      },
      childFrames: (node.childFrames ?? []).map(strip),
    };
  out['Page.getFrameTree'] = out['Page.getFrameTree'].error
    ? out['Page.getFrameTree']
    : strip(out['Page.getFrameTree'].frameTree);
  return out;
}

async function commands(page, session, targetId) {
  const sessionId = await page.evaluate(async (targetId) => {
    const attached = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
    return attached.result?.sessionId ?? JSON.stringify(attached);
  }, targetId);
  const rows = {};
  for (const [method, params] of METHODS) {
    await sw(session, 'globalThis.__unsettled = []; globalThis.__seenFrames = []; true');
    const answer = await page.evaluate(
      async ({ method, params, sessionId }) => h.attempt(method, params, sessionId),
      { method, params, sessionId }
    );
    const stacks = await sw(session, 'globalThis.__unsettled');
    const seenFrames = await sw(session, 'globalThis.__seenFrames');
    rows[method] = {
      ...summarize(answer),
      seenFrames,
      unsettledAt: (stacks ?? []).map((s) =>
        String(s)
          .split('\n')
          .slice(1, 7)
          .map((l) => l.trim())
      ),
    };
  }
  await page.evaluate(
    (sessionId) => h.attempt('Target.detachFromTarget', { sessionId }),
    sessionId
  );
  return rows;
}

async function openPage(page, url) {
  const opened = await openBlank(page);
  if (opened.error) return opened;
  await page.evaluate(
    async ({ sessionId, url }) => {
      await h.attempt('Page.navigate', { url }, sessionId);
      await h.until(async () => {
        const v = await h.evaluate(
          sessionId,
          'document.readyState === "complete" ? location.href : ""'
        );
        return v || undefined;
      });
    },
    { sessionId: opened.sessionId, url }
  );
  return opened;
}

async function rawFrameEval(urlPrefix, expression) {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const target = targetInfos.find((i) => i.type === 'iframe' && i.url.startsWith(urlPrefix));
  if (!target)
    return { error: 'no iframe target', targets: targetInfos.map((i) => [i.type, i.url]) };
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const answer = await chrome.cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  return answer.result?.value ?? answer;
}

const BLOB = `URL.createObjectURL(new Blob(['<!doctype html><body id=diag>ok</body>'],{type:'text/html'}))`;

test('blob settle diagnostic', { timeout: 600000 }, async (t) => {
  let version = 'unknown';
  try {
    const v = await chrome.cdp.send('Browser.getVersion');
    version = `${v.product ?? ''} ${v.revision ?? ''}`.trim();
  } catch {}
  const report = { head: head(), chrome: version, rows: [] };
  const session = undefined;
  try {
    for (const transport of transports) {
      const page = await client(t, transport);
      const close = (targetId) =>
        page
          .evaluate((targetId) => h.attempt('Target.closeTarget', { targetId }), targetId)
          .catch(() => {});

      const base = await openPage(page, `https://ordinary.test/doc?n=base-${Date.now()}`);
      if (!base.error) {
        await page.evaluate(
          (s) => h.attempt('Target.detachFromTarget', { sessionId: s }),
          base.sessionId
        );
        report.rows.push({
          transport,
          id: 'ordinary-page',
          raw: await rawView(base.targetId),
          extension: await extensionView(session, base.targetId),
          commands: await commands(page, session, base.targetId),
        });
        await close(base.targetId);
      } else report.rows.push({ transport, id: 'ordinary-page', error: base.error });

      for (const [id, origin] of [
        ['blob-ordinary', `https://ordinary.test/doc?n=blob-${Date.now()}`],
        ['blob-http', `http://upstream.test/hello?n=blob-${Date.now()}`],
      ]) {
        const opened = await openBlob(page, origin);
        if (opened.error) {
          report.rows.push({ transport, id, error: opened.error });
          if (opened.targetId) await close(opened.targetId);
          continue;
        }
        report.rows.push({
          transport,
          id,
          blobUrl: opened.blobUrl,
          settledUrl: opened.url,
          raw: await rawView(opened.targetId),
          extension: await extensionView(session, opened.targetId),
          commands: await commands(page, session, opened.targetId),
          rawAfter: await rawView(opened.targetId),
        });
        await close(opened.targetId);
      }

      const framed = await openPage(page, `https://ordinary.test/doc?n=frame-${Date.now()}`);
      if (!framed.error) {
        const made = await page.evaluate(
          async ({ sessionId, BLOB }) =>
            h.evaluate(
              sessionId,
              `new Promise((r) => { const f = document.createElement('iframe'); f.onload = () => r(f.src); f.src = ${BLOB}; document.body.append(f); })`
            ),
          { sessionId: framed.sessionId, BLOB }
        );
        await page.evaluate(
          (s) => h.attempt('Target.detachFromTarget', { sessionId: s }),
          framed.sessionId
        );
        report.rows.push({
          transport,
          id: 'ordinary-page-blob-iframe',
          made,
          raw: await rawView(framed.targetId),
          extension: await extensionView(session, framed.targetId),
          commands: await commands(page, session, framed.targetId),
        });
        await close(framed.targetId);
      }

      const vaultFramed = await openPage(page, `https://ordinary.test/doc?n=vframe-${Date.now()}`);
      if (!vaultFramed.error) {
        await page.evaluate(
          async ({ sessionId }) =>
            h.evaluate(
              sessionId,
              `new Promise((r) => { const f = document.createElement('iframe'); f.onload = () => r(true); f.src = 'https://vault.sliccy.ai/doc'; document.body.append(f); setTimeout(() => r(false), 5000); })`
            ),
          { sessionId: vaultFramed.sessionId }
        );
        await page.evaluate(
          (s) => h.attempt('Target.detachFromTarget', { sessionId: s }),
          vaultFramed.sessionId
        );
        const moved = await rawFrameEval(
          'https://vault.sliccy.ai/',
          `(() => { const u = ${BLOB}; setTimeout(() => { location.href = u; }, 0); return u; })()`
        );
        await new Promise((r) => setTimeout(r, 1500));
        report.rows.push({
          transport,
          id: 'ordinary-page-vault-blob-iframe',
          moved,
          raw: await rawView(vaultFramed.targetId),
          extension: await extensionView(session, vaultFramed.targetId),
          commands: await commands(page, session, vaultFramed.targetId),
        });
        await close(vaultFramed.targetId);
      }
    }
  } catch (error) {
    report.error = String(error?.stack ?? error);
  }
  console.log('BLOB_SETTLE_DIAGNOSTIC_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('BLOB_SETTLE_DIAGNOSTIC_END');
});
