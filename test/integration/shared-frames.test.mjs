import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch({
    args: ['--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process'],
  });
});
after(() => chrome?.close());

const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};

function find(node, test) {
  if (!node || typeof node !== 'object') return undefined;
  if (test(node)) return node;
  for (const next of [
    ...(node.children ?? []),
    node.contentDocument,
    ...(node.shadowRoots ?? []),
  ]) {
    const hit = find(next, test);
    if (hit) return hit;
  }
  return undefined;
}

async function observe(url, tag) {
  let targetId;
  for (let i = 0; i < 50 && !targetId; i++) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    targetId = targetInfos.find((info) => info.type === 'page' && info.url === url)?.targetId;
    if (!targetId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(targetId, 'the page opened');
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    for (let i = 0; i < 100; i++) {
      const doc = await chrome.cdp
        .send('DOM.getDocument', { depth: -1, pierce: true }, sessionId)
        .then(
          (answer) => answer.root,
          () => undefined
        );
      const owner = find(
        doc,
        (node) =>
          node.nodeName === 'IFRAME' &&
          node.contentDocument &&
          JSON.stringify(node).includes(`frame-secret-${tag}`)
      );
      const text = find(owner?.contentDocument, (node) => node.nodeValue === `frame-secret-${tag}`);
      const paragraph = find(owner?.contentDocument, (node) =>
        (node.children ?? []).includes(text)
      );
      if (paragraph) {
        return { document: owner.contentDocument.backendNodeId, marker: paragraph.backendNodeId };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }
  throw new Error('the protected frame never shared the page process');
}

for (const transport of Object.keys(entry)) {
  test(`${transport} reads of a page sharing its process with a protected frame leave that frame out`, async (t) => {
    const page = await chrome.visit(t, entry[transport]);
    await page.evaluate(install, transport, extId);
    const tag = `${transport}-${Date.now()}`;
    const late = transport === 'six-bridge';
    const url = `https://ordinary.test/shared-frame?n=${tag}&delay=${late ? 3000 : 0}`;
    await chrome.cdp.send('Target.createTarget', { url });
    const early = late ? undefined : await observe(url, tag);
    const opened = await page.evaluate(async (url) => {
      const targetId = await h.until(async () => {
        const { targetInfos } = await h.cdp.send('Target.getTargets');
        return targetInfos.find((info) => info.url === url)?.targetId;
      });
      const { sessionId } = await h.cdp.send('Target.attachToTarget', { targetId, flatten: true });
      return { targetId, sessionId };
    }, url);
    const ids = early ?? (await observe(url, tag));
    const reads = await page.evaluate(
      async ({ sessionId, ids }) => {
        const start = h.events.length;
        for (const method of ['Page.enable', 'DOM.enable', 'Accessibility.enable']) {
          await h.attempt(method, {}, sessionId);
        }
        const out = {};
        const calls = {
          document: ['DOM.getDocument', { depth: -1, pierce: true }],
          flattened: ['DOM.getFlattenedDocument', { depth: -1, pierce: true }],
          snapshot: ['DOMSnapshot.captureSnapshot', { computedStyles: [] }],
          ax: ['Accessibility.getFullAXTree', {}],
          partial: [
            'Accessibility.getPartialAXTree',
            { backendNodeId: ids.marker, fetchRelatives: true },
          ],
          describe: ['DOM.describeNode', { backendNodeId: ids.document, depth: -1, pierce: true }],
          outer: ['DOM.getOuterHTML', { backendNodeId: ids.marker }],
          resolved: ['DOM.resolveNode', { backendNodeId: ids.marker }],
        };
        for (const [name, [method, params]] of Object.entries(calls)) {
          out[name] = await h.attempt(method, params, sessionId);
        }
        const fresh = await h.attempt('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
        out.selected = await h.attempt(
          'DOM.querySelectorAll',
          { nodeId: fresh.result?.root?.nodeId, selector: 'p' },
          sessionId
        );
        out.events = h.events.slice(start).filter((event) => event.sessionId === sessionId);
        return out;
      },
      { sessionId: opened.sessionId, ids }
    );
    for (const [name, value] of Object.entries(reads)) {
      assert.ok(
        !JSON.stringify(value).includes(`frame-secret-${tag}`),
        `${name} ${JSON.stringify(value).slice(0, 400)}`
      );
    }
    const document = JSON.stringify(reads.document);
    assert.ok(document.includes(`top-${tag}`), document.slice(0, 400));
    assert.ok(document.includes(`plain-${tag}`), document.slice(0, 400));
    assert.ok(JSON.stringify(reads.snapshot).includes(`plain-${tag}`));
    assert.ok(JSON.stringify(reads.ax).includes(`top-${tag}`));
    assert.equal(reads.selected.result?.nodeIds?.length, 1, JSON.stringify(reads.selected));
    await page.evaluate((targetId) => h.close(targetId), opened.targetId);
  });
}
