import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bindingDiagnostic } from './binding-diagnostic.mjs';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch({ prepare: bindingDiagnostic });
});
after(() => chrome?.close());

const transports = ['seven', 'six-bridge'];
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const origins = {
  seven: 'https://seven.sliccy.ai',
  vault: 'https://vault.sliccy.ai',
  ordinary: 'https://ordinary.test',
};
const callbacks = {
  seven: 'https://seven.sliccy.ai/auth/callback',
  vault: 'https://vault.sliccy.ai/oauth/mcp-callback',
  ordinary: 'https://ordinary.test/landing',
};
const errorPage = 'chrome-error://chromewebdata/';
const forms = ['fragment', 'query', 'path'];
let serial = 0;

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

function unique(prefix) {
  return `${prefix}${++serial}${Date.now()}`.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mark(n) {
  return `S3CR3T${[...n].reverse().join('')}`;
}

function landing(to, form, n) {
  const secret = mark(n);
  if (form === 'fragment')
    return `${callbacks[to]}?nonce=n#access_token=${secret}&token_type=bearer&expires_in=86399`;
  if (form === 'query') return `${callbacks[to]}?code=${secret}&state=${secret}`;
  return `${callbacks[to]}/${secret}`;
}

function encodings(secret) {
  return [secret, encodeURIComponent(secret), btoa(secret), btoa(secret).replace(/=+$/, '')];
}

function paths(value, needles, at = '', out = []) {
  if (typeof value === 'string') {
    if (needles.some((needle) => value.includes(needle))) out.push(at || '.');
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      paths(item, needles, `${at}[${index}]`, out);
    });
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) paths(item, needles, `${at}.${key}`, out);
  }
  return out;
}

function found(run, n) {
  const needles = encodings(mark(n));
  const out = [];
  for (const event of run.events)
    for (const at of paths(event, needles)) out.push(`${event.method}${at}`);
  for (const reply of run.replies)
    for (const at of paths(reply.answer, needles)) out.push(`${reply.method} reply${at}`);
  return [...new Set(out)];
}

async function signIn(page, transport, n, to, form, via) {
  return page.evaluate(
    async ({ transport, n, to, form, via, errorPage }) => {
      const replies = [];
      const record = async (method, params, sessionId) => {
        const answer = await h.attempt(method, params, sessionId);
        replies.push({ method, answer });
        return answer;
      };
      const start = h.events.length;
      if (transport === 'seven') await record('Target.setDiscoverTargets', { discover: true });
      const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=start-${n}`);
      await record('Runtime.enable', {}, sessionId);
      const url = `https://ordinary.test/signin?n=${n}&to=${to}&form=${form}`;
      if (via === 'navigate') await record('Page.navigate', { url }, sessionId);
      else
        await record(
          'Runtime.evaluate',
          { expression: `setTimeout(() => { location.href = ${JSON.stringify(url)}; }, 0)` },
          sessionId
        );
      const settled = await h.until(async () => {
        const href = await h.evaluate(
          sessionId,
          'document.readyState === "complete" ? location.href : ""'
        );
        return typeof href === 'string' &&
          href !== '' &&
          !href.startsWith('https://ordinary.test/doc')
          ? href
          : undefined;
      });
      await h.sleep(800);
      await record('Target.getTargetInfo', { targetId });
      await record('Target.getTargets', {});
      const href = await h.evaluate(sessionId, 'location.href');
      const detached = h.detached(sessionId);
      await h.close(targetId);
      if (transport === 'seven') await record('Target.setDiscoverTargets', { discover: false });
      return {
        settled,
        href,
        detached,
        errorPage: settled === errorPage,
        events: h.events.slice(start),
        replies,
      };
    },
    { transport, n, to, form, via, errorPage }
  );
}

async function listed(page, transport, url) {
  const before = await page.evaluate(async () =>
    (await h.cdp.send('Target.getTargets')).targetInfos.map((info) => info.targetId)
  );
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url, background: true });
  try {
    return await page.evaluate(
      async ({ transport, before }) => {
        const replies = [];
        const record = async (method, params) => {
          const answer = await h.attempt(method, params);
          replies.push({ method, answer });
          return answer;
        };
        const start = h.events.length;
        const target = await h.until(async () => {
          const { targetInfos } = await h.cdp.send('Target.getTargets');
          return targetInfos.find(
            (info) => !before.includes(info.targetId) && info.url && info.url !== 'about:blank'
          );
        });
        if (transport === 'seven') await record('Target.setDiscoverTargets', { discover: true });
        await record('Target.getTargets', {});
        if (target) await record('Target.getTargetInfo', { targetId: target.targetId });
        await h.sleep(500);
        if (transport === 'seven') await record('Target.setDiscoverTargets', { discover: false });
        return { target, events: h.events.slice(start), replies };
      },
      { transport, before }
    );
  } finally {
    await chrome.cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }
}

for (const transport of transports) {
  for (const form of forms) {
    for (const via of ['navigate', 'script']) {
      for (const to of ['seven', 'vault']) {
        test(`${transport} ${via}: a 302 to ${to}'s sign-in callback with the token in its ${form} fails, keeps the session and never shows the token`, async (t) => {
          const page = await client(t, transport);
          const n = unique(`${transport}${to}${form}${via}`);
          const run = await signIn(page, transport, n, to, form, via);
          if (transport === 'seven' && !run.errorPage) {
            const { targetInfos } = await chrome.cdp.send('Target.getTargets');
            const worker = targetInfos.find(
              (target) =>
                target.type === 'service_worker' &&
                target.url.startsWith(`chrome-extension://${extId}/`)
            );
            const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
              targetId: worker.targetId,
              flatten: true,
            });
            const trace = await chrome.cdp.send(
              'Runtime.evaluate',
              { expression: 'JSON.stringify(globalThis.__sliccBindingTrace)', returnByValue: true },
              sessionId
            );
            console.log(
              'binding-check ' +
                JSON.stringify({
                  transport,
                  via,
                  to,
                  form,
                  href: run.href,
                  replies: run.replies,
                  trace: trace.result?.value,
                })
            );
            await chrome.cdp.send('Target.detachFromTarget', { sessionId });
          }
          const leaks = found(run, n);
          t.diagnostic(`LEAK ${transport} ${via} ${to} ${form}: ${leaks.join(' ') || 'none'}`);
          assert.deepEqual(leaks, [], `the token leaks through ${leaks.join(' ')}`);
          assert.equal(run.errorPage, true, `the callback fails at the request: ${run.settled}`);
          assert.equal(run.detached, false, 'the ordinary session stays');
          assert.equal(run.href, errorPage, 'the ordinary tab still answers');
          const info = run.replies.find((r) => r.method === 'Target.getTargetInfo')?.answer.result
            ?.targetInfo;
          assert.deepEqual(
            [info?.url, info?.title],
            [origins[to], origins[to]],
            JSON.stringify(info)
          );
        });
      }
      test(`${transport} ${via} control: a 302 to an ordinary callback with the token in its ${form} reaches the client`, async (t) => {
        const page = await client(t, transport);
        const n = unique(`${transport}ordinary${form}${via}`);
        const run = await signIn(page, transport, n, 'ordinary', form, via);
        assert.equal(run.settled, landing('ordinary', form, n), JSON.stringify(run.settled));
        const info = run.replies.find((r) => r.method === 'Target.getTargetInfo')?.answer.result
          ?.targetInfo;
        assert.equal(info?.url, landing('ordinary', form, n), JSON.stringify(info));
        assert.ok(found(run, n).length > 0, 'the ordinary token is visible to the client');
      });
    }

    for (const to of ['seven', 'vault']) {
      test(`${transport}: a protected ${to} tab holding a token in its ${form} is listed as its origin only`, async (t) => {
        const page = await client(t, transport);
        const n = unique(`${transport}listed${to}${form}`);
        const run = await listed(page, transport, landing(to, form, n));
        assert.ok(run.target, 'the protected tab is listed');
        const leaks = found(run, n);
        t.diagnostic(`LEAK ${transport} listed ${to} ${form}: ${leaks.join(' ') || 'none'}`);
        assert.deepEqual(leaks, [], `the token leaks through ${leaks.join(' ')}`);
        assert.deepEqual([run.target.url, run.target.title], [origins[to], origins[to]]);
      });
    }

    test(`${transport} control: an ordinary tab holding a token in its ${form} is listed in full`, async (t) => {
      const page = await client(t, transport);
      const n = unique(`${transport}listedordinary${form}`);
      const url = landing('ordinary', form, n);
      const run = await listed(page, transport, url);
      assert.equal(run.target?.url, url, JSON.stringify(run.target));
      assert.ok(found(run, n).length > 0);
    });
  }
}
