import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId, fixtureId } from './extension-page.mjs';

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
const WORLD = 'slicc: refused: that execution context belongs to a browser extension';
const UNSEEN =
  'slicc: refused: that execution context or object is not exposed to browser automation';
const PROFILED =
  'slicc: refused: a browser extension runs scripts in this page, and profiling it would expose them';
const FRAME =
  "slicc: refused: another browser extension has a frame in this tab, and Chrome doesn't let one extension debug another's frames";
const PROTECTED = "slicc: refused: target is on seven's origin";
const fixture = `chrome-extension://${fixtureId}`;

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

async function rawTarget(match) {
  for (let i = 0; i < 50; i++) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const found = targetInfos.find((info) => info.type === 'page' && match(info.url));
    if (found) return found.targetId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('raw target not found');
}

async function rawContexts(match) {
  const targetId = await rawTarget(match);
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const seen = [];
  const off = chrome.cdp.on(({ method, params, sessionId: from }) => {
    if (from === sessionId && method === 'Runtime.executionContextCreated') {
      seen.push(params.context);
    }
  });
  try {
    await chrome.cdp.send('Runtime.enable', {}, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return seen;
  } finally {
    off?.();
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }
}

async function rawEvaluate(match, expression) {
  const targetId = await rawTarget(match);
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const answer = await chrome.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    );
    return answer.result.value;
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }
}

async function rawIn(match, contextId, expression) {
  const targetId = await rawTarget(match);
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const answer = await chrome.cdp.send(
      'Runtime.evaluate',
      { expression, contextId, returnByValue: true },
      sessionId
    );
    return answer.result.value;
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }
}

async function opened(page, url) {
  return page.evaluate(async (url) => {
    const created = await h.attempt('Target.createTarget', { url });
    const targetId = created.result?.targetId;
    await h.until(async () => {
      const listed = await h.attempt('Target.getTargetInfo', { targetId });
      return listed.result?.targetInfo?.url === url;
    });
    await h.sleep(500);
    return targetId;
  }, url);
}

async function attached(page, targetId) {
  return page.evaluate(async (targetId) => {
    const attach = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
    return attach.result?.sessionId ?? attach;
  }, targetId);
}

function errors(results) {
  return Object.fromEntries(
    Object.entries(results).map(([key, value]) => [key, value?.error ?? 'ANSWERED'])
  );
}

for (const transport of transports) {
  test(`${transport} control: an ordinary page with another extension's content script is drivable, and a client's own isolated world works`, async (t) => {
    const page = await client(t, transport);
    const url = `https://ordinary.test/doc?n=worlds-control-${transport}`;
    const targetId = await opened(page, url);
    const marker = await rawEvaluate(
      (href) => href === url,
      'document.documentElement.dataset.sliccFixture'
    );
    assert.equal(marker, fixtureId, 'the fixture content script runs in the page');
    const sessionId = await attached(page, targetId);
    assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
    const run = await page.evaluate(async (sessionId) => {
      const enable = await h.attempt('Runtime.enable', {}, sessionId);
      const page = await h.attempt('Page.enable', {}, sessionId);
      const product = await h.evaluate(sessionId, '6 * 7');
      const tree = await h.attempt('Page.getFrameTree', {}, sessionId);
      const frameId = tree.result?.frameTree?.frame?.id;
      const world = await h.attempt(
        'Page.createIsolatedWorld',
        { frameId, worldName: 'client-world' },
        sessionId
      );
      const contextId = world.result?.executionContextId;
      const own = await h.attempt(
        'Runtime.evaluate',
        { expression: 'typeof document.title + " " + (40 + 2)', contextId, returnByValue: true },
        sessionId
      );
      const handle = await h.attempt(
        'Runtime.evaluate',
        { expression: '({ answer: 42 })', contextId },
        sessionId
      );
      const props = await h.attempt(
        'Runtime.getProperties',
        { objectId: handle.result?.result?.objectId, ownProperties: true },
        sessionId
      );
      const call = await h.attempt(
        'Runtime.callFunctionOn',
        {
          functionDeclaration: 'function () { return this.answer; }',
          objectId: handle.result?.result?.objectId,
          returnByValue: true,
        },
        sessionId
      );
      const doc = await h.attempt('DOM.getDocument', {}, sessionId);
      const snapshot = await h.attempt(
        'DOMSnapshot.captureSnapshot',
        { computedStyles: [] },
        sessionId
      );
      const ax = await h.attempt('Accessibility.getFullAXTree', {}, sessionId);
      const box = await h.evaluate(
        sessionId,
        'new Promise((resolve) => { const b = document.createElement("button"); b.textContent = "go"; b.style.cssText = "position:fixed;left:10px;top:10px;width:80px;height:40px"; b.onclick = () => { globalThis.clicked = true; }; document.body.append(b); setTimeout(() => resolve(true), 50); })'
      );
      for (const type of ['mousePressed', 'mouseReleased']) {
        await h.attempt(
          'Input.dispatchMouseEvent',
          { type, x: 40, y: 30, button: 'left', clickCount: 1 },
          sessionId
        );
      }
      const clicked = await h.evaluate(sessionId, 'globalThis.clicked === true');
      const node = await h.attempt(
        'DOM.resolveNode',
        { backendNodeId: doc.result?.root?.backendNodeId },
        sessionId
      );
      return {
        snapshot: Array.isArray(snapshot.result?.documents) ? 'ok' : snapshot,
        ax: Array.isArray(ax.result?.nodes) ? 'ok' : ax,
        box,
        clicked,
        node: typeof node.result?.object?.objectId === 'string' ? 'ok' : node,
        enable,
        page,
        product,
        own: own.result?.result?.value ?? own,
        props: props.result?.result?.find((p) => p.name === 'answer')?.value?.value ?? props,
        call: call.result?.result?.value ?? call,
        doc: doc.result?.root?.nodeName ?? doc,
        detached: h.detached(sessionId),
      };
    }, sessionId);
    assert.deepEqual(run.enable, { result: {} });
    assert.equal(run.product, 42);
    assert.equal(run.own, 'string 42');
    assert.equal(run.props, 42);
    assert.equal(run.call, 42);
    assert.equal(run.doc, '#document');
    assert.equal(run.snapshot, 'ok');
    assert.equal(run.ax, 'ok');
    assert.equal(run.box, true);
    assert.equal(run.clicked, true);
    assert.equal(run.node, 'ok');
    assert.equal(run.detached, false);
    await page.evaluate((targetId) => h.close(targetId), targetId);
  });

  test(`${transport} another extension's isolated world is never listed, and no selector, handle or profiler reaches it, before or after Runtime.enable`, async (t) => {
    const page = await client(t, transport);
    const url = `https://ordinary.test/doc?n=worlds-foreign-${transport}`;
    const targetId = await opened(page, url);
    const contexts = await rawContexts((href) => href === url);
    const foreign = contexts.find((c) => c.origin === fixture);
    assert.ok(foreign, `the fixture world exists: ${JSON.stringify(contexts)}`);
    const sessionId = await attached(page, targetId);
    assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
    const run = await page.evaluate(
      async ({ sessionId, foreign }) => {
        const secret = 'String(globalThis.sliccFixtureSecret)';
        const probes = async () => {
          const out = {};
          out.contextId = await h.attempt(
            'Runtime.evaluate',
            { expression: secret, contextId: foreign.id, returnByValue: true },
            sessionId
          );
          out.uniqueContextId = await h.attempt(
            'Runtime.evaluate',
            { expression: secret, uniqueContextId: foreign.uniqueId, returnByValue: true },
            sessionId
          );
          out.executionContextId = await h.attempt(
            'Runtime.callFunctionOn',
            {
              functionDeclaration: `function () { return ${secret}; }`,
              executionContextId: foreign.id,
              returnByValue: true,
            },
            sessionId
          );
          out.compile = await h.attempt(
            'Runtime.compileScript',
            {
              expression: secret,
              sourceURL: '',
              persistScript: false,
              executionContextId: foreign.id,
            },
            sessionId
          );
          out.binding = await h.attempt(
            'Runtime.addBinding',
            { name: 'sliccProbe', executionContextName: foreign.name },
            sessionId
          );
          const mine = await h.attempt('Runtime.evaluate', { expression: '({})' }, sessionId);
          const isolate = String(mine.result?.result?.objectId ?? '0.0.0').split('.')[0];
          const promise = await h.attempt(
            'Runtime.evaluate',
            { expression: `Promise.resolve(${secret})`, contextId: foreign.id },
            sessionId
          );
          const error = await h.attempt(
            'Runtime.evaluate',
            { expression: `new Error(${secret})`, contextId: foreign.id },
            sessionId
          );
          const object = await h.attempt(
            'Runtime.evaluate',
            { expression: `({ secret: ${secret} })`, contextId: foreign.id },
            sessionId
          );
          const handle = (answer, n) =>
            answer.result?.result?.objectId ?? `${isolate}.${foreign.id}.${n}`;
          out.awaitPromise = await h.attempt(
            'Runtime.awaitPromise',
            { promiseObjectId: handle(promise, 1), returnByValue: true },
            sessionId
          );
          out.getExceptionDetails = await h.attempt(
            'Runtime.getExceptionDetails',
            { errorObjectId: handle(error, 2) },
            sessionId
          );
          out.getProperties = await h.attempt(
            'Runtime.getProperties',
            { objectId: handle(object, 3), ownProperties: true },
            sessionId
          );
          out.callFunctionOn = await h.attempt(
            'Runtime.callFunctionOn',
            {
              functionDeclaration: 'function () { return this.secret; }',
              objectId: handle(object, 3),
              returnByValue: true,
            },
            sessionId
          );
          out.argument = await h.attempt(
            'Runtime.callFunctionOn',
            {
              functionDeclaration: 'function (o) { return o && o.secret; }',
              objectId: mine.result?.result?.objectId,
              arguments: [{ objectId: handle(object, 3) }],
              returnByValue: true,
            },
            sessionId
          );
          const doc = await h.attempt('DOM.getDocument', {}, sessionId);
          out.resolveNode = await h.attempt(
            'DOM.resolveNode',
            { backendNodeId: doc.result?.root?.backendNodeId, executionContextId: foreign.id },
            sessionId
          );
          const tree = await h.attempt('Page.getFrameTree', {}, sessionId);
          out.worldName = await h.attempt(
            'Page.createIsolatedWorld',
            { frameId: tree.result?.frameTree?.frame?.id, worldName: foreign.name },
            sessionId
          );
          out.malformed = await h.attempt(
            'Runtime.getProperties',
            { objectId: 'not-an-object' },
            sessionId
          );
          out.unknown = await h.attempt(
            'Runtime.evaluate',
            { expression: '1', contextId: 987654, returnByValue: true },
            sessionId
          );
          return out;
        };
        const before = await probes();
        const enable = await h.attempt('Runtime.enable', {}, sessionId);
        await h.sleep(500);
        const after = await probes();
        const listed = h.events
          .filter(
            (event) =>
              event.sessionId === sessionId && event.method === 'Runtime.executionContextCreated'
          )
          .map((event) => event.params.context);
        const leaked = h.events.filter(
          (event) =>
            event.sessionId === sessionId &&
            JSON.stringify(event.params ?? {}).includes(foreign.uniqueId)
        ).length;
        const profilers = {};
        for (const method of ['Debugger.enable', 'Profiler.enable', 'HeapProfiler.enable']) {
          profilers[method] = await h.attempt(method, {}, sessionId);
        }
        const product = await h.evaluate(sessionId, '6 * 7');
        return {
          before,
          after,
          enable,
          listed,
          leaked,
          profilers,
          product,
          detached: h.detached(sessionId),
        };
      },
      { sessionId, foreign }
    );
    for (const phase of ['before', 'after']) {
      const got = errors(run[phase]);
      for (const key of [
        'contextId',
        'uniqueContextId',
        'executionContextId',
        'compile',
        'binding',
        'resolveNode',
        'worldName',
      ]) {
        assert.equal(got[key], WORLD, `${phase} ${key}: ${JSON.stringify(run[phase][key])}`);
      }
      for (const key of [
        'awaitPromise',
        'getExceptionDetails',
        'getProperties',
        'callFunctionOn',
        'argument',
      ]) {
        assert.equal(got[key], WORLD, `${phase} ${key}: ${got[key]}`);
      }
      assert.equal(got.malformed, UNSEEN, phase);
      assert.equal(got.unknown, UNSEEN, phase);
    }
    assert.deepEqual(run.enable, { result: {} });
    assert.ok(
      run.listed.some((c) => c.auxData?.isDefault === true && c.origin === 'https://ordinary.test'),
      JSON.stringify(run.listed)
    );
    assert.ok(
      run.listed.every((c) => !c.origin.startsWith('chrome-extension:')),
      JSON.stringify(run.listed)
    );
    assert.ok(
      run.listed.every((c) => c.id !== foreign.id),
      JSON.stringify(run.listed)
    );
    assert.equal(run.leaked, 0);
    for (const [method, answer] of Object.entries(run.profilers)) {
      assert.equal(answer.error, PROFILED, method);
    }
    assert.equal(run.product, 42);
    assert.equal(run.detached, false);
    const bound = await page.evaluate(
      (sessionId) => h.attempt('Runtime.addBinding', { name: 'sliccUnscoped' }, sessionId),
      sessionId
    );
    assert.deepEqual(bound, { result: {} });
    await rawIn(
      (href) => href === url,
      foreign.id,
      'console.log("slicc-fixture-console"); if (typeof globalThis.sliccUnscoped === "function") globalThis.sliccUnscoped("slicc-fixture-binding"); Promise.reject(new Error("slicc-fixture-error")); 1'
    );
    const reach = await rawIn(
      (href) => href === url,
      foreign.id,
      'typeof globalThis.sliccUnscoped'
    );
    const main = await page.evaluate(
      (sessionId) =>
        h.evaluate(
          sessionId,
          'typeof globalThis.sliccUnscoped + " " + typeof globalThis.sliccFixtureSecret'
        ),
      sessionId
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tied = await page.evaluate(
      (sessionId) =>
        h.events.filter(
          (event) =>
            event.sessionId === sessionId &&
            JSON.stringify(event.params ?? {}).includes('slicc-fixture')
        ).length,
      sessionId
    );
    console.log(`${transport} unscoped binding in the fixture world: ${reach}`);
    assert.equal(tied, 0);
    assert.equal(reach, 'undefined');
    assert.equal(main, 'function undefined');
    await page.evaluate((targetId) => h.close(targetId), targetId);
  });

  test(`${transport} the guard's own isolated world is never listed and refuses every selector, while a page without another extension keeps its profilers`, async (t) => {
    const page = await client(t, transport);
    const targetId = await page.evaluate(async () => {
      const created = await h.attempt('Target.createTarget', { url: 'about:blank' });
      return created.result?.targetId;
    });
    const sessionId = await attached(page, targetId);
    assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
    const mark = `about:blank#ours-${transport}`;
    const moved = await page.evaluate(
      ({ sessionId, mark }) => h.attempt('Page.navigate', { url: mark }, sessionId),
      { sessionId, mark }
    );
    assert.equal(typeof moved.result?.frameId, 'string', JSON.stringify(moved));
    const contexts = await rawContexts((href) => href === mark);
    const ours = contexts.filter((c) => c.name === 'slicc-navigate');
    assert.ok(ours.length > 0, `the guard's world exists: ${JSON.stringify(contexts)}`);
    const run = await page.evaluate(
      async ({ sessionId, ours }) => {
        const probes = async () => {
          const out = [];
          for (const world of ours) {
            out.push(
              await h.attempt(
                'Runtime.evaluate',
                { expression: '1', contextId: world.id, returnByValue: true },
                sessionId
              ),
              await h.attempt(
                'Runtime.evaluate',
                { expression: '1', uniqueContextId: world.uniqueId, returnByValue: true },
                sessionId
              )
            );
          }
          return out;
        };
        const before = await probes();
        await h.attempt('Runtime.enable', {}, sessionId);
        await h.attempt('Page.enable', {}, sessionId);
        const tree = await h.attempt('Page.getFrameTree', {}, sessionId);
        const reserved = await h.attempt(
          'Page.createIsolatedWorld',
          { frameId: tree.result?.frameTree?.frame?.id, worldName: 'slicc-navigate' },
          sessionId
        );
        await h.attempt('Page.navigate', { url: 'about:blank#again' }, sessionId);
        await h.sleep(500);
        const after = await probes();
        const listed = h.events
          .filter(
            (event) =>
              event.sessionId === sessionId && event.method === 'Runtime.executionContextCreated'
          )
          .map((event) => event.params.context);
        const debug = await h.attempt('Debugger.enable', {}, sessionId);
        await h.attempt('Debugger.disable', {}, sessionId);
        return {
          before,
          after,
          listed,
          reserved,
          debug,
          product: await h.evaluate(sessionId, '6 * 7'),
        };
      },
      { sessionId, ours }
    );
    for (const answer of [...run.before, ...run.after]) assert.equal(answer.error, WORLD);
    assert.ok(run.listed.length > 0, JSON.stringify(run.listed));
    assert.ok(
      run.listed.every((c) => c.name !== 'slicc-navigate'),
      JSON.stringify(run.listed)
    );
    assert.equal(run.reserved.error, 'slicc: refused: that world name is reserved for the guard');
    assert.equal(run.debug.error, undefined, JSON.stringify(run.debug));
    assert.equal(run.product, 42);
    await page.evaluate((targetId) => h.close(targetId), targetId);
  });

  test(`${transport} a tab holding another extension's frame is refused with one honest text, a frame added later ends the session once, and the tab attaches again once the frame is gone`, async (t) => {
    const page = await client(t, transport);
    const framed = `https://ordinary.test/doc?n=worlds-frame-${transport}&fixture-frame`;
    const framedId = await opened(page, framed);
    const refused = await attached(page, framedId);
    assert.equal(refused?.error, FRAME, JSON.stringify(refused));
    await page.evaluate((targetId) => h.close(targetId), framedId);

    const url = `https://ordinary.test/doc?n=worlds-later-${transport}`;
    const targetId = await opened(page, url);
    const sessionId = await attached(page, targetId);
    assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
    const first = await page.evaluate(
      async ({ sessionId, fixture }) => {
        const before = await h.evaluate(sessionId, '6 * 7');
        await h.attempt(
          'Runtime.evaluate',
          {
            expression: `new Promise((resolve) => { const f = document.createElement('iframe'); f.src = ${JSON.stringify(`${fixture}/frame.html`)}; f.onload = () => resolve(true); document.body.append(f); setTimeout(() => resolve(false), 3000); })`,
            awaitPromise: true,
          },
          sessionId
        );
        await h.until(() => h.detached(sessionId));
        await h.sleep(1500);
        const detaches = h.events.filter(
          (event) =>
            event.method === 'Target.detachedFromTarget' && event.params?.sessionId === sessionId
        ).length;
        const after = await h.attempt(
          'Runtime.evaluate',
          { expression: '1', returnByValue: true },
          sessionId
        );
        return { before, detaches, after };
      },
      { sessionId, fixture }
    );
    assert.equal(first.before, 42);
    assert.equal(first.detaches, 1);
    assert.match(String(first.after.error), /No tab attached/);
    const again = await attached(page, targetId);
    assert.equal(again?.error, FRAME, JSON.stringify(again));
    const removed = await rawEvaluate(
      (href) => href === url,
      'new Promise((resolve) => { document.querySelectorAll("iframe").forEach((f) => f.remove()); setTimeout(() => resolve(document.querySelectorAll("iframe").length), 300); })'
    );
    assert.equal(removed, 0);
    const back = await attached(page, targetId);
    assert.equal(typeof back, 'string', JSON.stringify(back));
    const product = await page.evaluate((sessionId) => h.evaluate(sessionId, '6 * 7'), back);
    assert.equal(product, 42);
    await page.evaluate((targetId) => h.close(targetId), targetId);
  });

  test(`${transport} a tab whose main frame is another extension's page is still refused at attach, after an ordinary control`, async (t) => {
    const page = await client(t, transport);
    const url = `https://ordinary.test/doc?n=worlds-main-${transport}`;
    const control = await attached(page, await opened(page, url));
    assert.equal(typeof control, 'string', JSON.stringify(control));
    const created = await page.evaluate(
      (url) => h.attempt('Target.createTarget', { url }),
      `${fixture}/frame.html`
    );
    assert.equal(created.error, PROTECTED);
    const known = await page.evaluate(async () => {
      const { result } = await h.attempt('Target.getTargets', {});
      return (result?.targetInfos ?? []).map((info) => info.targetId);
    });
    const { targetId: raw } = await chrome.cdp.send('Target.createTarget', {
      url: `${fixture}/frame.html`,
    });
    try {
      await rawTarget((href) => href === `${fixture}/frame.html`);
      const listed = await page.evaluate(async (known) => {
        const { result } = await h.attempt('Target.getTargets', {});
        return (result?.targetInfos ?? []).find(
          (info) => info.type === 'page' && !known.includes(info.targetId)
        );
      }, known);
      assert.ok(listed, 'the extension tab is listed');
      assert.ok(!listed.title.includes('fixture'), JSON.stringify(listed));
      const refused = await attached(page, listed.targetId);
      assert.ok(
        [PROTECTED, FRAME].includes(refused?.error) || String(refused?.error).startsWith(PROTECTED),
        JSON.stringify(refused)
      );
    } finally {
      await chrome.cdp.send('Target.closeTarget', { targetId: raw }).catch(() => undefined);
    }
  });
}
