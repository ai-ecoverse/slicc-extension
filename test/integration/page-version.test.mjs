import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { launch } from './chrome.mjs';
import { openExtensionPage } from './extension-page.mjs';

async function prepare(paths) {
  const path = join(paths[0], 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...manifest, version: '9.8.7' }));
}

test('the page exposes the installed extension version read-only', {
  timeout: 30000,
}, async (t) => {
  process.env.SLICC_CDP_PORTS = '9300-9309';
  const chrome = await launch({ prepare });
  try {
    await t.test('seven', async (t) => {
      const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
      const extension = await openExtensionPage(page, 'secrets.html');
      let version;
      try {
        version = await extension.evaluate('chrome.runtime.getManifest().version');
      } finally {
        await extension.close();
      }
      assert.equal(version, '9.8.7');
      const report = await page.evaluate(() => {
        const api = globalThis.sliccExtension;
        const descriptor = Object.getOwnPropertyDescriptor(api, 'version');
        const before = api.version;
        const assigned = Reflect.set(api, 'version', '0.0.1');
        const deleted = Reflect.deleteProperty(api, 'version');
        const redefined = Reflect.defineProperty(api, 'version', { value: '0.0.2' });
        return {
          version: before,
          type: typeof before,
          after: api.version,
          frozen: Object.isFrozen(api),
          writable: descriptor?.writable,
          configurable: descriptor?.configurable,
          assigned,
          deleted,
          redefined,
        };
      });
      assert.equal(report.version, version);
      assert.equal(report.type, 'string');
      assert.equal(report.after, version);
      assert.equal(report.frozen, true);
      for (const key of ['writable', 'configurable', 'assigned', 'deleted', 'redefined'])
        assert.equal(report[key], false, key);
    });
    await t.test('ordinary origin', async (t) => {
      const page = await chrome.visit(t, 'https://ordinary.test/marker');
      assert.equal(await page.evaluate(() => 'sliccExtension' in globalThis), false);
    });
  } finally {
    await chrome.close();
  }
});
