import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { protectedRules } from '../../extension/protected-rules.js';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const METHODS = [
  'DOM.getDocument',
  'DOM.getOuterHTML',
  'Page.captureScreenshot',
  'Page.printToPDF',
  'Accessibility.getFullAXTree',
  'DOMSnapshot.captureSnapshot',
  'Page.getFrameTree',
  'CSS.getComputedStyleForNode',
];
const BLOB = `URL.createObjectURL(new Blob(['<!doctype html><title>doc</title><body id=b><p>ok</p></body>'],{type:'text/html'}))`;
const MARK = 'framed-marker';
const FRAMED = `URL.createObjectURL(new Blob(['<!doctype html><body><p>${MARK}</p></body>'],{type:'text/html'}))`;
const ORDINARY = 'https://other.test/hello';
let serial = 0;

async function raw(url) {
  for (let i = 0; i < 100; i += 1) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const found = targetInfos.find((info) => info.type === 'page' && info.url === url);
    if (found) {
      const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
        targetId: found.targetId,
        flatten: true,
      });
      return sessionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no raw target at ${url}`);
}

async function rawEval(sessionId, expression) {
  for (let i = 0; i < 100; i += 1) {
    const answer = await chrome.cdp
      .send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
      .catch(() => undefined);
    if (answer?.result && !answer.exceptionDetails) return answer.result.value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`raw evaluate failed: ${expression}`);
}

async function rawGo(sessionId, url, ready) {
  await chrome.cdp.send('Page.navigate', { url }, sessionId);
  for (let i = 0; i < 100; i += 1) {
    const href = await rawEval(
      sessionId,
      'document.readyState === "complete" ? location.href : ""'
    ).catch(() => '');
    if (ready(href)) return href;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`raw navigation to ${url} did not land`);
}

async function rawBlob(sessionId) {
  let ready = '';
  for (let i = 0; i < 100; i += 1) {
    ready = await rawEval(
      sessionId,
      `document.readyState === "complete" && location.origin.startsWith("http") ? location.origin : ""`
    ).catch(() => '');
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `page not committed before blob: ${ready}`);
  const url = await rawEval(sessionId, BLOB);
  assert.match(url, /^blob:https?:\/\//);
  return rawGo(sessionId, url, (href) => href === url);
}

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

async function open(page, url) {
  const targetId = await page.evaluate(async (url) => {
    const created = await h.attempt('Target.createTarget', { url });
    return created.result?.targetId;
  }, url);
  assert.ok(targetId, 'created a tab');
  const session = await raw(url);
  const want = new URL(url).origin;
  let last = { href: '', origin: '', ready: '' };
  for (let i = 0; i < 100; i += 1) {
    last = await rawEval(
      session,
      `({ href: location.href, origin: location.origin, ready: document.readyState })`
    ).catch(() => ({ href: '', origin: '', ready: '' }));
    if (
      last?.ready === 'complete' &&
      last.origin === want &&
      want.startsWith('http') &&
      typeof last.href === 'string' &&
      !last.href.startsWith('about:')
    ) {
      return { targetId, session };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`open did not commit ${url}: href=${last?.href} origin=${last?.origin}`);
}

async function verdicts(page, targetId, settle = true) {
  const read = await page.evaluate(
    async ({ targetId, METHODS, settle, MARK }) => {
      const attached = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = attached.result?.sessionId;
      if (!sessionId) return { attach: attached.error ?? JSON.stringify(attached) };
      const once = async () => {
        await h.attempt('DOM.enable', {}, sessionId);
        await h.attempt('CSS.enable', {}, sessionId);
        const node = async (selector) => {
          const doc = await h.attempt('DOM.getDocument', { depth: -1 }, sessionId);
          const nodeId = doc.result?.root?.nodeId ?? 1;
          if (!selector) return nodeId;
          const found = await h.attempt('DOM.querySelector', { nodeId, selector }, sessionId);
          return found.result?.nodeId ?? nodeId;
        };
        const params = {
          'DOM.getDocument': async () => ({ depth: 0 }),
          'DOM.getOuterHTML': async () => ({ nodeId: await node() }),
          'Page.captureScreenshot': async () => ({ format: 'png' }),
          'Page.printToPDF': async () => ({}),
          'Accessibility.getFullAXTree': async () => ({}),
          'DOMSnapshot.captureSnapshot': async () => ({ computedStyles: [] }),
          'Page.getFrameTree': async () => ({}),
          'CSS.getComputedStyleForNode': async () => ({ nodeId: await node('body') }),
        };
        const out = {};
        for (const method of METHODS) {
          const answer = await h.attempt(method, await params[method](), sessionId);
          out[method] = answer.error ?? 'answered';
          if (JSON.stringify(answer.result ?? {}).includes(MARK)) out.shown = true;
          if (JSON.stringify(answer.result ?? {}).includes('vault.sliccy.ai')) out.named = true;
        }
        return out;
      };
      let out = await once();
      let rounds = 1;
      for (let i = 0; settle && i < 30 && METHODS.some((m) => out[m] !== 'answered'); i += 1) {
        await h.sleep(100);
        out = await once();
        rounds += 1;
      }
      await h.attempt('Target.detachFromTarget', { sessionId });
      return { out, rounds };
    },
    { targetId, METHODS, settle, MARK }
  );
  if (read.attach) return read;
  console.log(`rounds ${read.rounds}`);
  return read.out;
}

async function framedBlob() {
  for (let i = 0; i < 100; i += 1) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const frame = targetInfos.find(
      (info) => info.type === 'iframe' && info.url.startsWith('blob:')
    );
    if (frame) {
      const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
        targetId: frame.targetId,
        flatten: true,
      });
      const text = await rawEval(sessionId, 'document.body?.textContent ?? ""').catch(() => '');
      await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      if (text.includes(MARK)) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function all(verdict) {
  return Object.fromEntries(METHODS.map((method) => [method, verdict]));
}

async function close(page, targetId, session) {
  await chrome.cdp.send('Target.detachFromTarget', { sessionId: session }).catch(() => undefined);
  await page.evaluate((targetId) => h.attempt('Target.closeTarget', { targetId }), targetId);
}

function refusedEverywhere(out) {
  if (out.attach)
    return out.attach.startsWith('slicc: refused') || /Cannot access/.test(out.attach);
  return METHODS.every((method) => out[method] !== 'answered');
}

async function markVault(session) {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const frame = targetInfos.find(
    (info) => info.type === 'iframe' && info.url.startsWith('https://vault.sliccy.ai/')
  );
  assert.ok(frame, 'vault iframe target');
  const { sessionId: inner } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: frame.targetId,
    flatten: true,
  });
  await rawEval(
    inner,
    `(() => { const p = document.createElement('p'); p.textContent = ${JSON.stringify(MARK)}; document.body.append(p); return true; })()`
  );
  const text = await rawEval(inner, 'document.body?.textContent ?? ""');
  await chrome.cdp.send('Target.detachFromTarget', { sessionId: inner }).catch(() => undefined);
  assert.ok(text.includes(MARK), 'marker injected into the vault iframe');
}

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport}: an ordinary blob document answers content commands`, async (t) => {
    const page = await client(t, transport);
    const { targetId, session } = await open(page, `https://ordinary.test/doc?n=b${++serial}`);
    const blob = await rawBlob(session);
    assert.match(blob, /^blob:https:\/\/ordinary\.test\//);
    assert.deepEqual(await verdicts(page, targetId), all('answered'));
    await close(page, targetId, session);
  });

  test(`${transport}: a plain-http blob document answers as its plain-http page does`, async (t) => {
    const page = await client(t, transport);
    const { targetId, session } = await open(page, `http://upstream.test/hello?n=h${++serial}`);
    const plain = await verdicts(page, targetId);
    const blob = await rawBlob(session);
    assert.match(blob, /^blob:http:\/\/upstream\.test\//);
    assert.deepEqual(plain, all('answered'));
    assert.deepEqual(await verdicts(page, targetId), plain);
    await close(page, targetId, session);
  });

  for (const host of ['vault.sliccy.ai', 'www.sliccy.ai']) {
    test(`${transport}: a ${host} blob document stays refused, then its next ordinary page answers`, async (t) => {
      const page = await client(t, transport);
      const { targetId, session } = await open(page, `https://ordinary.test/doc?n=p${++serial}`);
      await rawGo(session, `https://${host}/doc?n=p${serial}`, (href) => href.includes(host));
      const blob = await rawBlob(session);
      assert.ok(blob.startsWith('blob:'), blob);
      assert.deepEqual(await verdicts(page, targetId, false), { attach: protectedRules.refusal });
      const next = `https://ordinary.test/doc?n=q${serial}`;
      await rawGo(session, next, (href) => href === next);
      assert.deepEqual(await verdicts(page, targetId), all('answered'));
      await close(page, targetId, session);
    });
  }

  test(`${transport}: an ordinary blob document moved to a vault page stays refused`, async (t) => {
    const page = await client(t, transport);
    const { targetId, session } = await open(page, `https://ordinary.test/doc?n=v${++serial}`);
    await rawBlob(session);
    assert.deepEqual(await verdicts(page, targetId), all('answered'));
    await rawGo(session, `https://vault.sliccy.ai/doc?n=v${serial}`, (href) =>
      href.includes('vault.sliccy.ai')
    );
    assert.deepEqual(await verdicts(page, targetId, false), { attach: protectedRules.refusal });
    await close(page, targetId, session);
  });

  test(`${transport}: an ordinary page with an ordinary blob iframe answers`, async (t) => {
    const page = await client(t, transport);
    const { targetId, session } = await open(page, `https://ordinary.test/doc?n=f${++serial}`);
    await rawEval(
      session,
      `new Promise((r) => { const f = document.createElement('iframe'); f.onload = () => r(f.src); f.src = ${FRAMED}; document.body.append(f); })`
    );
    const out = await verdicts(page, targetId);
    assert.equal(out.shown, true, 'its own blob iframe shows in content reads');
    delete out.shown;
    assert.deepEqual(out, all('answered'));
    await close(page, targetId, session);
  });

  test(`${transport}: an ordinary page never shows a vault iframe's blob document`, async (t) => {
    const page = await client(t, transport);
    const { targetId, session } = await open(page, `https://ordinary.test/doc?n=g${++serial}`);
    await rawEval(
      session,
      `new Promise((r) => { const f = document.createElement('iframe'); f.onload = () => r(true); f.src = 'https://vault.sliccy.ai/doc?n=g${serial}'; document.body.append(f); })`
    );
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const frame = targetInfos.find(
      (info) => info.type === 'iframe' && info.url.startsWith('https://vault.sliccy.ai/')
    );
    assert.ok(frame, 'vault iframe target');
    const { sessionId: inner } = await chrome.cdp.send('Target.attachToTarget', {
      targetId: frame.targetId,
      flatten: true,
    });
    await rawEval(
      inner,
      `(() => { const u = ${FRAMED}; setTimeout(() => { location.href = u; }, 0); return u; })()`
    );
    await chrome.cdp.send('Target.detachFromTarget', { sessionId: inner }).catch(() => undefined);
    assert.ok(await framedBlob(), 'the vault iframe shows its blob document');
    const out = await verdicts(page, targetId, false);
    assert.equal(out.shown, undefined, JSON.stringify(out));
    await close(page, targetId, session);
  });

  test(`${transport}: an ordinary blob document with a vault iframe answers nothing carrying vault content`, async (t) => {
    const page = await client(t, transport);
    const { targetId, session } = await open(page, `https://ordinary.test/doc?n=i${++serial}`);
    await rawBlob(session);
    await rawEval(
      session,
      `new Promise((r) => { const f = document.createElement('iframe'); f.onload = () => r(true); f.src = 'https://vault.sliccy.ai/doc?n=i${serial}'; document.body.append(f); setTimeout(() => r(false), 5000); })`
    );
    await markVault(session);
    const out = await verdicts(page, targetId, false);
    assert.equal(out.named, undefined, JSON.stringify(out));
    assert.equal(out.shown, undefined, JSON.stringify(out));
    assert.equal(refusedEverywhere(out), true, JSON.stringify(out));
    console.log(`DIAG ${transport} blob+vault: ${JSON.stringify(out)}`);
    await close(page, targetId, session);
  });

  test(`${transport}: an ordinary blob document with a failed vault iframe answers nothing carrying vault content`, async (t) => {
    const page = await client(t, transport);
    const { targetId, session } = await open(page, `https://ordinary.test/doc?n=e${++serial}`);
    await rawBlob(session);
    await rawEval(
      session,
      `new Promise((r) => { const f = document.createElement('iframe'); f.onload = () => r(true); f.src = 'https://vault.sliccy.ai/controller/x?n=e${serial}'; document.body.append(f); setTimeout(() => r(false), 5000); })`
    );
    const out = await verdicts(page, targetId, false);
    assert.equal(out.named, undefined, JSON.stringify(out));
    assert.equal(refusedEverywhere(out), true, JSON.stringify(out));
    console.log(`DIAG ${transport} blob+failed-vault: ${JSON.stringify(out)}`);
    await close(page, targetId, session);
  });

  test(`${transport}: an ordinary blob document with an ordinary https iframe answers`, async (t) => {
    const page = await client(t, transport);
    const { targetId, session } = await open(page, `https://ordinary.test/doc?n=o${++serial}`);
    await rawBlob(session);
    await rawEval(
      session,
      `new Promise((r) => { const f = document.createElement('iframe'); f.onload = () => r(true); f.src = '${ORDINARY}?n=o${serial}'; document.body.append(f); setTimeout(() => r(false), 5000); })`
    );
    const out = await verdicts(page, targetId);
    delete out.shown;
    delete out.named;
    assert.deepEqual(out, all('answered'));
    console.log(`DIAG ${transport} blob+ordinary-iframe: ${JSON.stringify(out)}`);
    await close(page, targetId, session);
  });
}
