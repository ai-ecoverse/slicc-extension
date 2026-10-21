import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const repo = ['../../extension/_metadata', './fixture-extension/_metadata'].map(
  (path) => new URL(path, import.meta.url)
);
const chromes = [];
after(() => Promise.allSettled(chromes.map((chrome) => chrome.close())));

function unwritten() {
  for (const path of repo)
    assert.equal(existsSync(path), false, `${path.pathname} stays unwritten`);
}

async function appears(path, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function extended(chrome, t, name) {
  return t.test(name, async (s) => {
    const page = await chrome.visit(s, 'https://seven.sliccy.ai/frames');
    assert.equal(await page.evaluate(() => 'sliccExtension' in globalThis), true);
  });
}

test('a Chrome that leaves _metadata behind does not stop a parallel Chrome loading the extension', async (t) => {
  const first = await launch();
  chromes.push(first);
  await extended(first, t, 'first');
  unwritten();
  const left = join(first.extensions[0], '_metadata');
  assert.ok(await appears(left), 'Chrome wrote _metadata into its own copy');
  const [second, third] = await Promise.all([launch(), launch()]);
  chromes.push(second, third);
  for (const [index, chrome] of [second, third].entries()) {
    await extended(chrome, t, `parallel ${index + 1}`);
    assert.notDeepEqual(chrome.extensions, first.extensions);
  }
  unwritten();
  await first.close();
  chromes.splice(chromes.indexOf(first), 1);
  for (const path of first.extensions) assert.equal(existsSync(path), false, `${path} is removed`);
});
