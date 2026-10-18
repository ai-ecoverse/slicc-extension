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

const transports = ['seven', 'six-bridge'];
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const extension = `chrome-extension://${extId}`;
const refused = "slicc: refused: target is on seven's origin";

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

async function rawOrigin(targetId) {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  if (!targetInfos.some((info) => info.targetId === targetId)) return `no target ${targetId}`;
  return rawEvaluate(targetId, 'self.origin');
}

async function rawEvaluate(targetId, expression) {
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

async function rawUrl(targetId, url) {
  for (let i = 0; i < 50; i++) {
    const href = await rawEvaluate(
      targetId,
      'document.readyState === "complete" ? location.href : ""'
    ).catch(() => '');
    if (href === url) return url;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

async function flow(page, start) {
  const opened = await page.evaluate(async (start) => {
    const created = await h.attempt('Target.createTarget', { url: start });
    const targetId = created.result?.targetId;
    if (!targetId) return { created };
    const attach = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attach.result?.sessionId;
    if (!sessionId) return { attach };
    await h.until(async () => {
      const href = await h.evaluate(sessionId, 'location.href');
      return typeof href === 'string' && href.startsWith(start);
    });
    globalThis.blank = { targetId, sessionId };
    return { created, targetId, sessionId };
  }, start);
  if (!opened.sessionId) return opened;
  const ordinary = 'https://ordinary.test/doc?n=blank-origin';
  const plan = [
    ['createTarget'],
    ['Runtime.enable', 'Runtime.enable', {}],
    ['Page.enable', 'Page.enable', {}],
    ['about:blank', 'Page.navigate', { url: 'about:blank' }],
    ['about:blank#x', 'Page.navigate', { url: 'about:blank#x' }],
    ['ABOUT:blank', 'Page.navigate', { url: ' ABOUT:blank' }],
    ['about:BLANK', 'Page.navigate', { url: 'about:BLANK' }],
    ['view-source:about:blank', 'Page.navigate', { url: 'view-source:about:blank' }],
    ['about:srcdoc', 'Page.navigate', { url: 'about:srcdoc' }],
    ['about:blank?x', 'Page.navigate', { url: 'about:blank?x' }],
    ['ordinary', 'Page.navigate', { url: ordinary }, ordinary],
    ['back to ordinary', 'Page.navigate', { url: ordinary }, ordinary],
    ['child about:blank', 'Page.navigate', { url: 'about:blank', child: ordinary }],
    ['about:blank from ordinary', 'Page.navigate', { url: 'about:blank' }],
    [
      'unreachable',
      'Page.navigate',
      { url: 'http://127.0.0.1:1/' },
      'chrome-error://chromewebdata/',
    ],
    ['about:blank from an error page', 'Page.navigate', { url: 'about:blank' }],
  ];
  const steps = [];
  for (const [label, method, params, wait] of plan) {
    const step = await page.evaluate(
      async ({ label, method, params, wait }) => {
        const { sessionId } = globalThis.blank;
        let sent = params;
        if (params?.child) {
          await h.evaluate(
            sessionId,
            `new Promise((resolve) => { const f = document.createElement('iframe'); f.onload = resolve; f.src = ${JSON.stringify(params.child)}; document.body.append(f); })`
          );
          const frames = await h.attempt('Page.getFrameTree', {}, sessionId);
          sent = {
            url: params.url,
            frameId: frames.result?.frameTree?.childFrames?.[0]?.frame?.id,
          };
        }
        const answer = method ? await h.attempt(method, sent, sessionId) : {};
        if (wait)
          await h.until(async () => (await h.evaluate(sessionId, 'location.href')) === wait);
        await h.sleep(300);
        const tree = await h.attempt('Page.getFrameTree', {}, sessionId);
        return {
          label,
          answer,
          origin: await h.evaluate(sessionId, 'self.origin'),
          href: await h.evaluate(sessionId, 'location.href'),
          frameId: tree.result?.frameTree?.frame?.id,
          detached: h.detached(sessionId),
          child: params?.child
            ? await h.evaluate(
                sessionId,
                'new Promise((resolve) => setTimeout(resolve, 300)).then(() => { try { const w = document.querySelector("iframe").contentWindow; return w.origin + " " + w.location.href; } catch (e) { return String(e); } })'
              )
            : undefined,
        };
      },
      { label, method, params, wait }
    );
    step.raw = await rawOrigin(step.frameId ?? step.answer.result?.frameId);
    steps.push(step);
  }
  const done = await page.evaluate(async () => {
    const { sessionId, targetId } = globalThis.blank;
    const detaches = h.events.filter(
      (event) =>
        event.method === 'Target.detachedFromTarget' && event.params?.sessionId === sessionId
    ).length;
    const reply = await h.evaluate(sessionId, '6 * 7');
    await h.close(targetId);
    return { detaches, reply };
  });
  return { steps, ...done };
}

for (const transport of transports) {
  for (const start of ['about:blank', 'https://ordinary.test/doc?n=blank-control']) {
    const control = start !== 'about:blank';
    test(`${transport} ${control ? 'control: an ordinary page' : 'createTarget about:blank'} navigated to about:blank never gets the extension's origin, keeps its session and answers`, async (t) => {
      const page = await client(t, transport);
      const run = await flow(page, start);
      assert.ok(run.steps, JSON.stringify(run));
      const step = (label) => run.steps.find((s) => s.label === label);
      for (const s of run.steps) {
        assert.equal(typeof s.origin, 'string', `${s.label}: ${JSON.stringify(s)}`);
        assert.ok(!s.origin.startsWith('chrome-extension:'), `${s.label}: ${JSON.stringify(s)}`);
        assert.equal(s.detached, false, `${s.label}: ${JSON.stringify(s)}`);
        assert.equal(s.raw, s.origin, `${s.label}: ${JSON.stringify(s)}`);
      }
      assert.equal(run.detaches, 0);
      assert.equal(run.reply, 42);
      const first = control ? 'https://ordinary.test' : 'null';
      assert.equal(step('createTarget').origin, first);
      for (const label of ['about:blank', 'ABOUT:blank', 'about:blank?x']) {
        const opened = step(label);
        const href = label === 'about:blank?x' ? 'about:blank?x' : 'about:blank';
        assert.equal(opened.href, href, JSON.stringify(opened));
        assert.equal(typeof opened.answer.result?.loaderId, 'string', JSON.stringify(opened));
        assert.equal(opened.answer.result?.frameId, opened.frameId, JSON.stringify(opened));
        assert.equal(opened.origin, first, JSON.stringify(opened));
      }
      const fragment = step('about:blank#x');
      assert.equal(fragment.href, 'about:blank#x', JSON.stringify(fragment));
      assert.equal(fragment.answer.result?.frameId, fragment.frameId, JSON.stringify(fragment));
      assert.equal(fragment.answer.result?.loaderId, undefined);
      assert.equal(fragment.origin, first);
      assert.equal(
        step('view-source:about:blank').answer.error,
        'slicc: refused: view-source and other wrappers of about: urls do not open'
      );
      assert.equal(step('view-source:about:blank').raw, first);
      for (const label of ['about:srcdoc', 'about:BLANK']) {
        assert.equal(
          step(label).answer.error,
          'slicc: refused: about: urls other than about:blank do not open',
          label
        );
      }
      const ordinary = step('ordinary');
      assert.equal(typeof ordinary.answer.result?.loaderId, 'string');
      assert.equal(ordinary.origin, 'https://ordinary.test');
      const back = step('about:blank from ordinary');
      assert.equal(back.href, 'about:blank', JSON.stringify(back));
      assert.equal(typeof back.answer.result?.loaderId, 'string');
      assert.equal(back.origin, 'https://ordinary.test');
      const failed = step('unreachable');
      assert.equal(failed.href, 'chrome-error://chromewebdata/');
      const recovered = step('about:blank from an error page');
      assert.equal(recovered.href, 'about:blank', JSON.stringify(recovered));
      assert.equal(typeof recovered.answer.result?.loaderId, 'string');
      assert.equal(recovered.origin, 'null');
      const child = step('child about:blank');
      assert.equal(typeof child.answer.result?.loaderId, 'string', JSON.stringify(child));
      assert.notEqual(child.answer.result?.frameId, child.frameId);
      assert.equal(child.child, 'https://ordinary.test about:blank', JSON.stringify(child));
    });
  }

  test(`${transport} an extension-origin about:blank tab with no opener is refused at every attach, with no detach loop`, async (t) => {
    const page = await client(t, transport);
    const { targetId: opaque } = await chrome.cdp.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
    });
    t.after(() =>
      chrome.cdp.send('Target.closeTarget', { targetId: opaque }).catch(() => undefined)
    );
    assert.equal(await rawUrl(opaque, 'about:blank'), 'about:blank');
    assert.equal(await rawOrigin(opaque), 'null');
    const controlTab = await rawEvaluate(opaque, 'window.name = "slicc-opaque-control"');
    assert.equal(controlTab, 'slicc-opaque-control');
    const control = await page.evaluate(async () => {
      const { targetInfos } = await h.cdp.send('Target.getTargets', {});
      for (const info of targetInfos.filter(
        (each) => each.url === 'about:blank' && !each.openerId
      )) {
        const tried = await h.attempt('Target.attachToTarget', {
          targetId: info.targetId,
          flatten: true,
        });
        const sessionId = tried.result?.sessionId;
        if (!sessionId) continue;
        const name = await h.evaluate(sessionId, 'window.name');
        if (name === 'slicc-opaque-control') {
          return {
            name,
            origin: await h.evaluate(sessionId, 'self.origin'),
            detached: h.detached(sessionId),
          };
        }
        await h.attempt('Target.detachFromTarget', { sessionId });
      }
      return { targetInfos };
    });
    assert.deepEqual(control, { name: 'slicc-opaque-control', origin: 'null', detached: false });
    const url = `${extension}/secrets.html`;
    const { targetId: raw } = await chrome.cdp.send('Target.createTarget', {
      url,
      newWindow: true,
    });
    t.after(() => chrome.cdp.send('Target.closeTarget', { targetId: raw }).catch(() => undefined));
    assert.equal(await rawUrl(raw, url), url);
    assert.equal(
      await rawOrigin(raw),
      extension,
      'positive control: the probe sees the extension origin'
    );
    const tabId = await rawEvaluate(raw, 'chrome.tabs.getCurrent().then((current) => current.id)');
    await rawEvaluate(raw, 'location.href = "about:blank"');
    assert.equal(await rawUrl(raw, 'about:blank'), 'about:blank');
    assert.equal(
      await rawOrigin(raw),
      extension,
      'positive control: the blank document is extension-origin'
    );
    const run = await page.evaluate(async (targetId) => {
      const listed = (await h.cdp.send('Target.getTargets', {})).targetInfos.find(
        (info) => info.targetId === targetId
      );
      const tries = [];
      for (let i = 0; i < 3; i++) {
        const tried = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
        tries.push(tried);
      }
      await h.sleep(500);
      return {
        listed,
        tries,
        detaches: h.events.filter((e) => e.method === 'Target.detachedFromTarget').length,
      };
    }, String(tabId));
    assert.equal(run.listed?.url, 'about:blank', JSON.stringify(run));
    assert.equal(run.listed?.openerId, undefined, JSON.stringify(run));
    for (const each of run.tries)
      assert.ok(String(each.error).startsWith(refused), JSON.stringify(run));
    assert.equal(run.detaches, 0);
    assert.equal(await rawOrigin(raw), extension);
  });

  test(`${transport} view-source of about:blank is refused before forwarding, after a view-source control`, async (t) => {
    const page = await client(t, transport);
    const control = 'https://ordinary.test/doc?n=view-source-control';
    const run = await page.evaluate(async (control) => {
      const created = await h.cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await h.cdp.send('Target.attachToTarget', {
        targetId: created.targetId,
        flatten: true,
      });
      const tree = await h.cdp.send('Page.getFrameTree', {}, sessionId);
      const wrapped = await h.attempt(
        'Page.navigate',
        { url: 'view-source:about:blank' },
        sessionId
      );
      const nested = await h.attempt(
        'Page.navigate',
        { url: ' VIEW-SOURCE:view-source:about:blank#x' },
        sessionId
      );
      const opened = await h.attempt('Target.createTarget', { url: 'view-source:about:blank' });
      await h.sleep(500);
      const origin = await h.evaluate(sessionId, 'self.origin');
      const viewed = await h.attempt('Page.navigate', { url: `view-source:${control}` }, sessionId);
      await h.sleep(800);
      return {
        targetId: created.targetId,
        frameId: tree.frameTree.frame.id,
        wrapped,
        nested,
        opened,
        origin,
        viewed,
        detached: h.detached(sessionId),
      };
    }, control);
    const refusal = 'slicc: refused: view-source and other wrappers of about: urls do not open';
    assert.equal(run.wrapped.error, refusal, JSON.stringify(run));
    assert.equal(run.nested.error, refusal, JSON.stringify(run));
    assert.equal(run.opened.error, refusal, JSON.stringify(run));
    assert.equal(run.origin, 'null');
    assert.equal(typeof run.viewed.result?.loaderId, 'string', JSON.stringify(run));
    assert.equal(run.viewed.result?.errorText, undefined, JSON.stringify(run));
    assert.equal(await rawOrigin(run.frameId), 'https://ordinary.test');
    await page.evaluate((id) => h.close(id), run.targetId);
  });

  test(`${transport} an ordinary page with sandboxed about:blank iframes still attaches and answers`, async (t) => {
    const page = await client(t, transport);
    const url = 'https://ordinary.test/doc?n=sandboxed-children';
    const run = await page.evaluate(async (url) => {
      const created = await h.cdp.send('Target.createTarget', { url });
      const first = await h.cdp.send('Target.attachToTarget', {
        targetId: created.targetId,
        flatten: true,
      });
      await h.until(
        async () => (await h.evaluate(first.sessionId, 'document.readyState')) === 'complete'
      );
      const made = await h.evaluate(
        first.sessionId,
        `Promise.all(['', 'allow-scripts', 'allow-same-origin', 'allow-scripts allow-same-origin'].map((flags) => new Promise((resolve) => { const f = document.createElement('iframe'); f.setAttribute('sandbox', flags); f.onload = () => resolve(flags); f.src = 'about:blank'; document.body.append(f); }))).then((all) => all.length)`
      );
      await h.cdp.send('Target.detachFromTarget', { sessionId: first.sessionId });
      const again = await h.attempt('Target.attachToTarget', {
        targetId: created.targetId,
        flatten: true,
      });
      const sessionId = again.result?.sessionId;
      const reply = sessionId
        ? await h.evaluate(sessionId, 'document.querySelectorAll("iframe").length')
        : undefined;
      await h.close(created.targetId);
      return { made, again, reply };
    }, url);
    assert.equal(run.made, 4, JSON.stringify(run));
    assert.equal(typeof run.again.result?.sessionId, 'string', JSON.stringify(run));
    assert.equal(run.reply, 4, JSON.stringify(run));
  });
}
