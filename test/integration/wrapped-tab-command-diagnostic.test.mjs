import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch();
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
    const entry = result.entries[result.currentIndex];
    return {
      status: 'answered',
      currentIndex: result.currentIndex,
      entryUrl: entry?.url,
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

async function rawOpen(url) {
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await chrome.cdp.send('Page.enable', {}, sessionId);
  await chrome.cdp.send('Page.navigate', { url }, sessionId);
  for (let i = 0; i < 100; i++) {
    const info = await chrome.cdp.send('Target.getTargetInfo', { targetId });
    const now = info.targetInfo?.url ?? '';
    if (now === url || (url.startsWith('view-source:') && now.startsWith('view-source:'))) {
      await new Promise((r) => setTimeout(r, 400));
      return { targetId, sessionId, url: now };
    }
    if (url.startsWith('blob:') && now.startsWith('blob:')) {
      await new Promise((r) => setTimeout(r, 400));
      return { targetId, sessionId, url: now };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const info = await chrome.cdp.send('Target.getTargetInfo', { targetId });
  return { targetId, sessionId, url: info.targetInfo?.url ?? '', timedOut: true };
}

async function rawBlob(originUrl) {
  const opened = await rawOpen(originUrl);
  const made = await chrome.cdp.send(
    'Runtime.evaluate',
    {
      expression: `URL.createObjectURL(new Blob(['<!doctype html><body id=diag>ok</body>'],{type:'text/html'}))`,
      returnByValue: true,
      awaitPromise: true,
    },
    opened.sessionId
  );
  const blobUrl = made.result?.value;
  if (typeof blobUrl !== 'string' || !blobUrl.startsWith('blob:')) {
    await chrome.cdp.send('Target.closeTarget', { targetId: opened.targetId }).catch(() => {});
    return { error: `createObjectURL failed: ${JSON.stringify(made)}`, originUrl };
  }
  await chrome.cdp.send('Page.navigate', { url: blobUrl }, opened.sessionId);
  for (let i = 0; i < 100; i++) {
    const info = await chrome.cdp.send('Target.getTargetInfo', { targetId: opened.targetId });
    const now = info.targetInfo?.url ?? '';
    if (now.startsWith('blob:')) {
      await new Promise((r) => setTimeout(r, 400));
      await chrome.cdp
        .send('Target.detachFromTarget', { sessionId: opened.sessionId })
        .catch(() => {});
      return { targetId: opened.targetId, blobUrl, url: now, originUrl };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const info = await chrome.cdp.send('Target.getTargetInfo', { targetId: opened.targetId });
  await chrome.cdp.send('Target.detachFromTarget', { sessionId: opened.sessionId }).catch(() => {});
  return {
    targetId: opened.targetId,
    blobUrl,
    url: info.targetInfo?.url ?? '',
    originUrl,
    timedOut: true,
  };
}

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
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

const CASES = [
  {
    id: 'view-source-ordinary',
    kind: 'view-source',
    host: 'ordinary.test',
    open: async () => rawOpen(`view-source:https://ordinary.test/doc?n=diag-${Date.now()}`),
  },
  {
    id: 'view-source-vault',
    kind: 'view-source',
    host: 'vault.sliccy.ai',
    open: async () => rawOpen('view-source:https://vault.sliccy.ai/'),
  },
  {
    id: 'view-source-seven-token',
    kind: 'view-source',
    host: 'seven.sliccy.ai+token',
    open: async () => rawOpen('view-source:https://seven.sliccy.ai/os/?token=SECRET'),
  },
  {
    id: 'blob-ordinary',
    kind: 'blob',
    host: 'ordinary.test',
    open: async () => rawBlob(`https://ordinary.test/doc?n=diag-blob-${Date.now()}`),
  },
  {
    id: 'blob-vault',
    kind: 'blob',
    host: 'vault.sliccy.ai',
    open: async () => rawBlob('https://vault.sliccy.ai/'),
  },
  {
    id: 'blob-seven-token',
    kind: 'blob',
    host: 'seven.sliccy.ai+token',
    open: async () => rawBlob('https://seven.sliccy.ai/os/?token=SECRET'),
  },
];

test('wrapped tab command matrix', async (t) => {
  let version = 'unknown';
  try {
    const v = await chrome.cdp.send('Browser.getVersion');
    version = `${v.product ?? ''} ${v.revision ?? ''}`.trim();
  } catch {}
  const report = { head: head(), chrome: version, rows: [] };

  for (const transport of transports) {
    const page = await client(t, transport);
    for (const c of CASES) {
      const opened = await c.open();
      if (opened.error) {
        report.rows.push({
          transport,
          id: c.id,
          kind: c.kind,
          host: c.host,
          openError: opened.error,
        });
        continue;
      }
      const probed = await probe(page, opened.targetId);
      const row = {
        transport,
        id: c.id,
        kind: c.kind,
        host: c.host,
        settledUrl: opened.url,
        blobUrl: opened.blobUrl,
        timedOut: opened.timedOut || false,
        attach: probed.attached?.error
          ? { status: 'refused', error: String(probed.attached.error) }
          : probed.attached?.result?.sessionId
            ? { status: 'answered' }
            : { status: 'refused', error: JSON.stringify(probed.attached) },
        commands: {},
      };
      for (const [method, answer] of Object.entries(probed.commands || {})) {
        row.commands[method] = summarize(answer);
      }
      report.rows.push(row);
      await chrome.cdp.send('Target.closeTarget', { targetId: opened.targetId }).catch(() => {});
    }
  }

  console.log('WRAPPED_TAB_COMMAND_MATRIX_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('WRAPPED_TAB_COMMAND_MATRIX_END');
});
