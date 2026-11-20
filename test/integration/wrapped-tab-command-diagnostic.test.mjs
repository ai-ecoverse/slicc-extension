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

const CASES = [
  {
    id: 'view-source-ordinary',
    kind: 'view-source',
    host: 'ordinary.test',
    open: (page) =>
      openViewSource(page, `view-source:https://ordinary.test/doc?n=diag-${Date.now()}`),
  },
  {
    id: 'view-source-vault',
    kind: 'view-source',
    host: 'vault.sliccy.ai',
    open: (page) => openViewSource(page, 'view-source:https://vault.sliccy.ai/'),
  },
  {
    id: 'view-source-seven-token',
    kind: 'view-source',
    host: 'seven.sliccy.ai+token',
    open: (page) => openViewSource(page, 'view-source:https://seven.sliccy.ai/os/?token=SECRET'),
  },
  {
    id: 'blob-ordinary',
    kind: 'blob',
    host: 'ordinary.test',
    open: (page) => openBlob(page, `https://ordinary.test/doc?n=diag-blob-${Date.now()}`),
  },
  {
    id: 'blob-vault',
    kind: 'blob',
    host: 'vault.sliccy.ai',
    open: (page) => openBlob(page, 'https://vault.sliccy.ai/'),
  },
  {
    id: 'blob-seven-token',
    kind: 'blob',
    host: 'seven.sliccy.ai+token',
    open: (page) => openBlob(page, 'https://seven.sliccy.ai/os/?token=SECRET'),
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
      const opened = await c.open(page);
      if (opened.error) {
        report.rows.push({
          transport,
          id: c.id,
          kind: c.kind,
          host: c.host,
          openError: opened.error,
          settledUrl: opened.url,
          blobUrl: opened.blobUrl,
        });
        if (opened.targetId)
          await page
            .evaluate((targetId) => h.attempt('Target.closeTarget', { targetId }), opened.targetId)
            .catch(() => {});
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
      await page
        .evaluate((targetId) => h.attempt('Target.closeTarget', { targetId }), opened.targetId)
        .catch(() => {});
    }
  }

  console.log('WRAPPED_TAB_COMMAND_MATRIX_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('WRAPPED_TAB_COMMAND_MATRIX_END');
});
