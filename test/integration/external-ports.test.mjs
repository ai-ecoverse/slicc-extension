import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { extId, portCall } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const names = [
  'slicc-fetch',
  'fetch-proxy.fetch',
  'secrets.crud',
  'mount.sign-and-forward',
  'slicc.cdp-bridge',
  'no-such-port',
];

function probe(page, ports) {
  return page.evaluate(
    async (opts) => {
      const states = await Promise.all(
        opts.ports.map(
          (name) =>
            new Promise((resolve) => {
              const port = chrome.runtime.connect(opts.extId, { name });
              const timer = setTimeout(() => {
                port.disconnect();
                resolve([name, 'open']);
              }, 3000);
              port.onDisconnect.addListener(() => {
                clearTimeout(timer);
                resolve([name, 'closed']);
              });
            })
        )
      );
      return Object.fromEntries(states);
    },
    { extId, ports }
  );
}

test('#42 external ports from http://localhost close at once instead of idling', async (t) => {
  const local = new URL(chrome.url);
  local.hostname = 'localhost';
  const page = await chrome.visit(t, local.href);
  assert.equal(await page.evaluate(() => typeof chrome?.runtime?.connect), 'function');
  assert.deepEqual(
    await probe(page, names),
    Object.fromEntries(names.map((name) => [name, 'closed']))
  );
});

test('#42 the leader on www.sliccy.ai keeps its pinned ports open and reconnects after a close', async (t) => {
  const www = await chrome.visit(t, 'https://www.sliccy.ai/?slicc=leader');
  const pinned = ['fetch-proxy.fetch', 'secrets.crud', 'mount.sign-and-forward'];
  assert.deepEqual(await probe(www, [...pinned, 'no-such-port']), {
    ...Object.fromEntries(pinned.map((name) => [name, 'open'])),
    'no-such-port': 'closed',
  });
  for (const id of [1, 2]) {
    const listed = await portCall(www, 'secrets.crud', { id, type: 'secrets.list' });
    assert.ok(Array.isArray(listed?.entries), JSON.stringify(listed));
  }
});
