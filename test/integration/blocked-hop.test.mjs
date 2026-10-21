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
const ERROR_PAGE = 'chrome-error://chromewebdata/';
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

async function blockedHop(page, { n, scheme, discover }) {
  return page.evaluate(
    async ({ n, scheme, discover }) => {
      const replies = [];
      const record = async (step, method, params, sessionId) => {
        const answer = await Promise.race([
          h.attempt(method, params, sessionId),
          h.sleep(8000).then(() => ({ error: 'test: no answer in 8 s' })),
        ]);
        replies.push({ step, method, answer });
        return answer;
      };
      const protectedHost = (url) => {
        try {
          return new URL(url).hostname.endsWith('sliccy.ai');
        } catch {
          return false;
        }
      };
      const command = async (step, targetId, body) => {
        const info = await record(step, 'Target.getTargetInfo', { targetId });
        const url = info.result?.targetInfo?.url ?? '';
        if (protectedHost(url)) return { refused: `client: ${url} is protected` };
        const attached = await record(step, 'Target.attachToTarget', { targetId, flatten: true });
        const sessionId = attached.result?.sessionId;
        if (!sessionId) return { refused: attached.error };
        try {
          return await body(sessionId);
        } finally {
          await record(step, 'Target.detachFromTarget', { sessionId });
        }
      };
      if (discover) await record('discover', 'Target.setDiscoverTargets', { discover: true });
      const { targetId, sessionId: first } = await h.open(`https://ordinary.test/doc?n=start-${n}`);
      await record('open', 'Target.detachFromTarget', { sessionId: first });
      const from = h.events.length;
      const hop = `https://ordinary.test/meta?n=${n}&scheme=${scheme}`;
      const going = await command('hop', targetId, async (s) => {
        await record('hop', 'Page.enable', {}, s);
        const start = h.events.length;
        const answer = await record('hop', 'Page.navigate', { url: hop }, s);
        await h.until(
          () =>
            h.events
              .slice(start)
              .some((e) => e.method === 'Page.loadEventFired' && e.sessionId === s),
          8000
        );
        return answer;
      });
      const landed = await h.until(async () => {
        const info = await h.attempt('Target.getTargetInfo', { targetId });
        const url = info.result?.targetInfo?.url ?? '';
        return url && !url.startsWith('https://ordinary.test/')
          ? info.result.targetInfo
          : undefined;
      });
      await h.sleep(800);
      const info = (await record('info', 'Target.getTargetInfo', { targetId })).result?.targetInfo;
      const listed = (await record('list', 'Target.getTargets', {})).result?.targetInfos?.find(
        (each) => each.targetId === targetId
      );
      const changed = h.events
        .slice(from)
        .filter(
          (e) =>
            e.method === 'Target.targetInfoChanged' && e.params.targetInfo?.targetId === targetId
        )
        .at(-1)?.params.targetInfo;
      const onError = await command('read', targetId, (s) =>
        record('read', 'Runtime.evaluate', { expression: 'location.href', returnByValue: true }, s)
      );
      const after = `https://ordinary.test/doc?n=after-${n}`;
      const back = await command('back', targetId, async (s) => {
        const answer = await record('back', 'Page.navigate', { url: after }, s);
        const href = await h.until(async () => {
          const value = await h.evaluate(
            s,
            'document.readyState === "complete" ? location.href : ""'
          );
          return typeof value === 'string' && value.startsWith(after) ? value : undefined;
        });
        const evaluated = await record(
          'back',
          'Runtime.evaluate',
          { expression: '6 * 7', returnByValue: true },
          s
        );
        return { answer, href, evaluated };
      });
      const again = await command('again', targetId, (s) =>
        record('again', 'Runtime.evaluate', { expression: 'location.href', returnByValue: true }, s)
      );
      const events = h.events.slice(from);
      await h.close(targetId);
      return { going, landed, info, listed, changed, onError, back, again, events, replies };
    },
    { n, scheme, discover }
  );
}

function leaks(run, secret) {
  const needles = [secret, encodeURIComponent(secret), btoa(secret).replace(/=+$/, '')];
  const text = JSON.stringify([run.events, run.replies]);
  return needles.filter((needle) => text.includes(needle));
}

for (const transport of transports) {
  for (const scheme of ['https', 'http']) {
    test(`${transport}: after a meta refresh hop to ${scheme} vault is blocked, the tab reports the error page, and a client that refuses protected targets drives it to an ordinary page and evaluates there`, async (t) => {
      const page = await client(t, transport);
      const n = unique(`${transport}${scheme}metahop`);
      const run = await blockedHop(page, { n, scheme, discover: transport === 'seven' });
      t.diagnostic(
        JSON.stringify({
          landed: run.landed,
          info: run.info,
          listed: run.listed,
          changed: run.changed,
          onError: run.onError,
          back: run.back,
          again: run.again,
        })
      );
      assert.equal(run.going?.error, undefined, 'the hop page itself loads');
      assert.deepEqual(leaks(run, mark(n)), [], 'nothing names the protected url');
      assert.equal(run.landed?.url, ERROR_PAGE, 'the blocked hop leaves the tab on the error page');
      assert.equal(run.info?.url, ERROR_PAGE, 'getTargetInfo reports the error page');
      assert.equal(run.info?.title, '', 'and no title');
      assert.equal(run.listed?.url, ERROR_PAGE, 'getTargets lists the error page');
      if (transport === 'seven') {
        assert.equal(run.changed?.url, ERROR_PAGE, 'discovery last reports the error page');
      }
      assert.equal(run.onError?.refused, undefined, 'the client still drives the tab');
      assert.equal(run.back?.refused, undefined, 'the client drives it to an ordinary page');
      assert.equal(run.back?.answer?.error, undefined, 'Page.navigate to an ordinary page works');
      assert.ok(run.back?.href, 'the ordinary page loads');
      assert.equal(run.back?.evaluated?.result?.result?.value, 42, 'Runtime.evaluate works there');
      assert.equal(
        run.again?.result?.result?.value,
        run.back.href,
        'a later command on the tab works too'
      );
    });
  }
}
