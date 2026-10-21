import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch({ pinned: true });
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

function unique(prefix) {
  return `${prefix}${++serial}${Date.now()}`.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mark(n) {
  return `S3CR3T${[...n].reverse().join('')}`;
}

function leaks(events, n) {
  const secret = mark(n);
  const needles = [secret, encodeURIComponent(secret), btoa(secret).replace(/=+$/, '')];
  return events
    .filter((event) => needles.some((needle) => JSON.stringify(event).includes(needle)))
    .map((event) => event.method);
}

async function twice(page, n, to) {
  return page.evaluate(
    async ({ n, to }) => {
      const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=hop-${n}`);
      await h.attempt('Network.enable', {}, sessionId);
      const from = h.events.length;
      const url = `https://ordinary.test/moved?to=${to}&n=${n}`;
      const load = `fetch(${JSON.stringify(url)}, { mode: "no-cors", credentials: "include" }).then(() => "ok", (e) => String(e))`;
      const first = await h.evaluate(sessionId, load);
      await h.sleep(300);
      const second = await h.evaluate(sessionId, load);
      await h.sleep(800);
      const events = h.events.slice(from);
      await h.close(targetId);
      return { first, second, events };
    },
    { n, to }
  );
}

function cachedHop(events) {
  return events.some(
    (e) =>
      e.method === 'Network.requestWillBeSent' && e.params.redirectResponse?.fromDiskCache === true
  );
}

for (const transport of transports) {
  test(`${transport}: an ordinary 301 into vault, loaded twice, the second time from the cache, never shows a redirect cookie or the code vault's redirect carries`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}cachedhop`);
    const run = await twice(page, n, 'vault');
    assert.deepEqual([run.first, run.second], ['ok', 'ok']);
    assert.ok(cachedHop(run.events), 'the second load takes the 301 from the cache');
    const found = leaks(run.events, n);
    t.diagnostic(`LEAK ${transport} cached hop: ${found.join(' ') || 'none'}`);
    assert.deepEqual(found, [], `the cookie or code leaks through ${found.join(' ')}`);
    assert.ok(
      run.events.some(
        (e) => e.method === 'Network.responseReceivedExtraInfo' && e.params.statusCode === 301
      ),
      "the ordinary hop's own ExtraInfo still reaches the client"
    );
  });

  test(`${transport} control: a cached ordinary 301 to another ordinary host shows its redirect cookie and code`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}cachedplain`);
    const run = await twice(page, n, 'ordinary');
    assert.deepEqual([run.first, run.second], ['ok', 'ok']);
    assert.ok(cachedHop(run.events), 'the second load takes the 301 from the cache');
    assert.ok(leaks(run.events, n).length > 0, 'the ordinary cookie and code reach the client');
  });
}
