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
let serial = 0;

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

async function hop(page, n, to, via) {
  return page.evaluate(
    async ({ n, to, via }) => {
      const replies = [];
      const record = async (method, params, sessionId) => {
        const answer = await h.attempt(method, params, sessionId);
        replies.push({ method, answer });
        return answer;
      };
      const start = `https://ordinary.test/doc?n=start-${n}`;
      const { targetId, sessionId } = await h.open(start);
      const mark = h.events.length;
      const off = h.cdp.on((event) => {
        if (event.method !== 'Fetch.requestPaused' || event.sessionId !== sessionId) return;
        const id = event.params.requestId;
        void (async () => {
          if (event.params.responseStatusCode !== undefined)
            await record('Fetch.getResponseBody', { requestId: id }, sessionId);
          await record('Fetch.continueRequest', { requestId: id }, sessionId);
        })();
      });
      await record('Network.enable', {}, sessionId);
      await record(
        'Fetch.enable',
        {
          patterns: [
            { urlPattern: '*', requestStage: 'Request' },
            { urlPattern: '*', requestStage: 'Response' },
          ],
        },
        sessionId
      );
      const url = `https://ordinary.test/hop?n=${n}&to=${to}`;
      if (via === 'navigate') await record('Page.navigate', { url }, sessionId);
      if (via === 'script')
        await record(
          'Runtime.evaluate',
          { expression: `location.href = ${JSON.stringify(url)}` },
          sessionId
        );
      if (via === 'fetch')
        await record(
          'Runtime.evaluate',
          {
            expression: `fetch(${JSON.stringify(url)}, { mode: 'no-cors', credentials: 'include' }).then(() => 'ok', (e) => String(e))`,
            awaitPromise: true,
            returnByValue: true,
          },
          sessionId
        );
      await h.sleep(2500);
      const requests = h.events
        .slice(mark)
        .filter((e) => e.method === 'Network.requestWillBeSent')
        .map((e) => e.params.requestId);
      for (const requestId of [...new Set(requests)])
        await record('Network.getResponseBody', { requestId }, sessionId);
      await record('Target.getTargetInfo', { targetId });
      await record('Target.getTargets', {});
      await record('Page.getNavigationHistory', {}, sessionId);
      await record('Page.getFrameTree', {}, sessionId);
      off();
      await h.close(targetId);
      return { events: h.events.slice(mark), replies };
    },
    { n, to, via }
  );
}

function paths(value, needle, at = '', out = []) {
  if (typeof value === 'string') {
    if (value.includes(needle)) out.push(at);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      paths(item, needle, `${at}[${index}]`, out);
    });
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) paths(item, needle, `${at}.${key}`, out);
  }
  return out;
}

function leaks(run) {
  const found = [];
  for (const event of run.events)
    for (const at of paths(event.params, 'S3CR3T')) found.push(`${event.method}${at}`);
  for (const reply of run.replies)
    for (const at of paths(reply.answer, 'S3CR3T')) found.push(`${reply.method} reply${at}`);
  return [...new Set(found)];
}

for (const transport of transports) {
  for (const via of ['navigate', 'script', 'fetch']) {
    for (const to of ['seven', 'vault']) {
      test(`${transport} ${via}: a 302 from an ordinary page into ${to}'s callback never shows the client its path, query or fragment`, async (t) => {
        const page = await client(t, transport);
        const n = `${to}${via}${transport}${++serial}`.replace(/[^a-z0-9]/g, '');
        const run = await hop(page, n, to, via);
        const found = leaks(run);
        t.diagnostic(
          `GUARD-LEAK ${transport} ${via} ${to}: ${found.length ? found.join(' ') : 'none'}`
        );
        assert.deepEqual(found, [], `${transport} ${via} ${to} leaks: ${found.join(' ')}`);
      });
    }
    test(`${transport} ${via} control: a 302 into an ordinary url reaches the client intact`, async (t) => {
      const page = await client(t, transport);
      const n = `ordinary${via}${transport}${++serial}`.replace(/[^a-z0-9]/g, '');
      const run = await hop(page, n, 'ordinary', via);
      const found = leaks(run);
      t.diagnostic(`GUARD-LEAK ${transport} ${via} ordinary: ${found.join(' ')}`);
      assert.ok(
        found.some((at) => at.startsWith('Network.requestWillBeSent')),
        `the ordinary redirect is visible: ${found.join(' ')}`
      );
    });
  }
}
