import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport}: document writes, client Page switches and located node controls`, async (t) => {
    const entry =
      transport === 'seven' ? 'https://seven.sliccy.ai/' : 'https://www.sliccy.ai/?slicc=leader';
    const page = await chrome.visit(t, entry);
    await page.evaluate(install, transport, extId);
    const n = `${transport}-${Date.now()}`;
    const out = await page.evaluate(async (n) => {
      const out = {};
      const first = `https://ordinary.test/doc?n=${n}`;
      const second = `${first}-next`;
      const { targetId } = await h.cdp.send('Target.createTarget', { url: first });
      const { sessionId: s } = await h.cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      await h.until(async () => (await h.evaluate(s, 'document.readyState')) === 'complete');
      await h.evaluate(
        s,
        'document.body.insertAdjacentHTML("beforeend", "<button id=grokButton>control</button>")'
      );
      await h.cdp.send('DOM.enable', {}, s);
      const { root } = await h.cdp.send('DOM.getDocument', { depth: 0 }, s);
      const frameTree = await h.cdp.send('Page.getFrameTree', {}, s);
      out.replacement = await h.attempt(
        'Page.setDocumentContent',
        {
          frameId: frameTree.frameTree.frame.id,
          html: '<html><body id=grokReplacement>changed</body></html>',
        },
        s
      );
      const compiled = await h.cdp.send(
        'Runtime.compileScript',
        {
          expression: 'globalThis.__grokRunScript = true',
          sourceURL: '',
          persistScript: true,
        },
        s
      );
      out.script = await h.attempt('Runtime.runScript', { scriptId: compiled.scriptId }, s);
      out.absent = await h.evaluate(
        s,
        '!document.getElementById("grokReplacement") && !globalThis.__grokRunScript'
      );
      const one = await h.cdp.send(
        'DOM.querySelector',
        { nodeId: root.nodeId, selector: '#grokButton' },
        s
      );
      const all = await h.cdp.send(
        'DOM.querySelectorAll',
        { nodeId: root.nodeId, selector: '#grokButton' },
        s
      );
      const search = await h.cdp.send('DOM.performSearch', { query: '#grokButton' }, s);
      const searched = await h.cdp.send(
        'DOM.getSearchResults',
        { searchId: search.searchId, fromIndex: 0, toIndex: search.resultCount },
        s
      );
      const object = await h.cdp.send(
        'Runtime.evaluate',
        { expression: 'document.getElementById("grokButton")' },
        s
      );
      const requested = await h.cdp.send(
        'DOM.requestNode',
        { objectId: object.result.objectId },
        s
      );
      const described = await h.cdp.send('DOM.describeNode', { nodeId: one.nodeId }, s);
      const pushed = await h.cdp.send(
        'DOM.pushNodesByBackendIdsToFrontend',
        { backendNodeIds: [described.node.backendNodeId] },
        s
      );
      out.nodes = [];
      for (const nodeId of [
        one.nodeId,
        ...all.nodeIds,
        ...searched.nodeIds,
        requested.nodeId,
        ...pushed.nodeIds,
      ]) {
        for (const method of [
          'DOM.focus',
          'DOM.getBoxModel',
          'DOM.describeNode',
          'DOM.getOuterHTML',
          'DOM.scrollIntoViewIfNeeded',
          'DOM.getContentQuads',
        ]) {
          out.nodes.push({ method, nodeId, answer: await h.attempt(method, { nodeId }, s) });
        }
      }
      await h.cdp.send('Page.enable', {}, s);
      await h.cdp.send('Page.disable', {}, s);
      const start = h.events.length;
      await h.cdp.send(
        'Fetch.enable',
        { patterns: [{ urlPattern: second, resourceType: 'Document', requestStage: 'Request' }] },
        s
      );
      const navigating = h.attempt('Page.navigate', { url: second }, s);
      const paused = await h.until(() =>
        h.events
          .slice(start)
          .find(
            (e) =>
              e.sessionId === s &&
              e.method === 'Fetch.requestPaused' &&
              e.params.request.url === second
          )
      );
      out.pendingInput = await h.attempt(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key: 'x', text: 'x' },
        s
      );
      await h.cdp.send('Fetch.continueRequest', { requestId: paused.params.requestId }, s);
      out.navigation = await navigating;
      await h.until(
        async () =>
          (await h.evaluate(s, 'document.readyState === "complete" ? location.href : ""')) ===
          second
      );
      out.quietInput = await h.attempt(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key: 'x', text: 'x' },
        s
      );
      out.hiddenPageEvents = h.events
        .slice(start)
        .filter((e) => e.sessionId === s && e.method.startsWith('Page.')).length;
      await h.cdp.send('Page.enable', {}, s);
      const enabled = h.events.length;
      await h.cdp.send('Page.navigate', { url: `${first}-enabled` }, s);
      await h.until(() =>
        h.events.slice(enabled).some((e) => e.sessionId === s && e.method === 'Page.frameNavigated')
      );
      out.visiblePageEvents = h.events
        .slice(enabled)
        .filter((e) => e.sessionId === s && e.method.startsWith('Page.')).length;
      out.staleNode = await h.attempt('DOM.focus', { nodeId: one.nodeId }, s);
      out.staleSearch = await h.attempt(
        'DOM.getSearchResults',
        { searchId: search.searchId, fromIndex: 0, toIndex: 1 },
        s
      );
      const enabledUrl = `${first}-enabled`;
      await h.until(
        async () =>
          (await h.evaluate(s, 'document.readyState === "complete" ? location.href : ""')) ===
          enabledUrl
      );
      out.cancellations = [];
      for (const [kind, expression, terminal] of [
        [
          '204',
          'location.href="https://upstream.test/empty"; "issued"',
          'Page.frameStoppedLoading',
        ],
        [
          'removed-frame',
          'globalThis.__grokRemoved=false; const f=document.createElement("iframe"); f.src="https://upstream.test/noise?size=100000"; document.body.append(f); setTimeout(()=>{f.remove();globalThis.__grokRemoved=true},5); "issued"',
          'Page.frameDetached',
        ],
      ]) {
        const start = h.events.length;
        const control = await h.attempt(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: 10, y: 10 },
          s
        );
        await h.evaluate(s, expression);
        const ended = await h.until(() =>
          h.events.slice(start).some((e) => e.sessionId === s && e.method === terminal)
        );
        const recovered = await h.until(async () => {
          const href = await h.evaluate(
            s,
            'document.readyState === "complete" ? location.href : ""'
          );
          if (href !== enabledUrl) return undefined;
          const input = await h.attempt(
            'Input.dispatchMouseEvent',
            { type: 'mouseMoved', x: 10, y: 10 },
            s
          );
          return input.error === undefined ? { href, input } : undefined;
        });
        out.cancellations.push({ kind, control, ended, recovered });
      }
      await h.cdp.send('Target.closeTarget', { targetId });
      return out;
    }, n);
    console.log('document-command controls', JSON.stringify({ transport, ...out }));
    assert.match(out.replacement.error ?? '', /unbound document replacement/);
    assert.match(out.script.error ?? '', /unique context binding/);
    assert.equal(out.absent, true);
    assert.ok(out.nodes.length >= 24);
    for (const row of out.nodes) assert.equal(row.answer.error, undefined, JSON.stringify(row));
    assert.match(out.pendingInput.error ?? '', /slicc: refused:/);
    assert.equal(out.quietInput.error, undefined, JSON.stringify(out.quietInput));
    assert.equal(out.navigation.error, undefined, JSON.stringify(out.navigation));
    assert.equal(out.hiddenPageEvents, 0);
    assert.ok(out.visiblePageEvents > 0);
    assert.match(out.staleNode.error ?? '', /slicc: refused:/);
    assert.match(out.staleSearch.error ?? '', /slicc: refused:/);
    assert.equal(out.cancellations.length, 2);
    for (const row of out.cancellations) {
      assert.equal(row.control.error, undefined, JSON.stringify(row));
      assert.equal(row.ended, true, JSON.stringify(row));
      assert.ok(row.recovered, JSON.stringify(row));
      assert.equal(row.recovered.input.error, undefined, JSON.stringify(row));
    }
  });
}
