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
        const contexts = [];
        const sheets = [];
        const off = chrome.cdp.on(({ method, params, sessionId: from }) => {
          if (from !== sessionId) return;
          if (method === 'Runtime.executionContextCreated') contexts.push(params.context);
          if (method === 'CSS.styleSheetAdded') sheets.push(params.header);
        });
        try {
          await chrome.cdp.send('Runtime.enable', {}, sessionId);
          await chrome.cdp.send('CSS.enable', {}, sessionId);
          const context = contexts.find((item) => item.auxData?.frameId === owner.frameId);
          const sheet = sheets.find((item) => item.frameId === owner.frameId);
          assert.ok(context, 'the observer sees the child realm');
          assert.ok(sheet, 'the observer sees the child stylesheet');
          const { result } = await chrome.cdp.send(
            'Runtime.evaluate',
            { expression: 'document.body', contextId: context.id },
            sessionId
          );
          assert.ok(result.objectId, 'the observer sees the child object');
          return {
            document: owner.contentDocument.backendNodeId,
            marker: paragraph.backendNodeId,
            contextId: context.id,
            objectId: result.objectId,
            nodeId: paragraph.nodeId,
            styleSheetId: sheet.styleSheetId,
          };
        } finally {
          off();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }
  throw new Error('the protected frame never shared the page process');
}

for (const [transport, opaque] of Object.keys(entry).flatMap((name) => [
  [name, false],
  [name, true],
])) {
  test(`${transport} reads of a page sharing its process with a ${opaque ? 'opaque' : 'protected'} frame leave that frame out`, async (t) => {
    const page = await chrome.visit(t, entry[transport]);
    await page.evaluate(install, transport, extId);
    const tag = `${transport}-${Date.now()}`;
    const late = transport === 'six-bridge';
    const url = `https://ordinary.test/shared-frame?n=${tag}&delay=${late ? 3000 : 0}${opaque ? '&opaque' : ''}`;
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
          evaluate: [
            'Runtime.evaluate',
            {
              expression: 'document.body.innerHTML',
              contextId: ids.contextId,
              returnByValue: true,
            },
          ],
          topEvaluate: [
            'Runtime.evaluate',
            { expression: 'frames[1].document.body.innerHTML', returnByValue: true },
          ],
          properties: ['Runtime.getProperties', { objectId: ids.objectId }],
          function: [
            'Runtime.callFunctionOn',
            {
              objectId: ids.objectId,
              functionDeclaration: 'function() { return this.innerHTML }',
              returnByValue: true,
            },
          ],
          objects: ['Runtime.queryObjects', { prototypeObjectId: ids.objectId }],
          lexical: ['Runtime.globalLexicalScopeNames', { executionContextId: ids.contextId }],
          cssEnable: ['CSS.enable', {}],
          sheet: ['CSS.getStyleSheetText', { styleSheetId: ids.styleSheetId }],
          classes: ['CSS.collectClassNames', { styleSheetId: ids.styleSheetId }],
          media: ['CSS.getMediaQueries', {}],
          matched: ['CSS.getMatchedStylesForNode', { nodeId: ids.nodeId }],
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
    for (const name of [
      'evaluate',
      'topEvaluate',
      'lexical',
      'properties',
      'function',
      'objects',
      'matched',
      'cssEnable',
      'sheet',
      'classes',
      'media',
    ]) {
      assert.match(reads[name].error?.message ?? reads[name].error ?? '', /slicc: refused/, name);
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
