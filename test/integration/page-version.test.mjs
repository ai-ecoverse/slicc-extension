import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch } from './chrome.mjs';
import { openExtensionPage } from './extension-page.mjs';

const sourceManifest = JSON.parse(
  await readFile(new URL('../../extension/manifest.json', import.meta.url), 'utf8')
);

async function prepare(paths) {
  const directory = await mkdtemp(join(tmpdir(), 'page-version-'));
  try {
    await cp(paths[0], join(directory, 'extension'), { recursive: true });
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('../../scripts/pack.mjs', import.meta.url)), '9.8.7'],
      { cwd: directory, stdio: 'pipe' }
    );
    execFileSync('unzip', [
      '-q',
      '-o',
      join(directory, 'artifacts/slicc-extension.zip'),
      '-d',
      paths[0],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const variant of ['build', 'packed']) {
  test(`the ${variant} page exposes the installed extension version read-only`, {
    timeout: 30000,
  }, async (t) => {
    process.env.SLICC_CDP_PORTS = '9300-9309';
    const chrome = await launch(variant === 'packed' ? { prepare } : {});
    const expected = variant === 'packed' ? '9.8.7' : sourceManifest.version;
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
        assert.equal(version, expected);
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
      await t.test('synchronous document_start', async (t) => {
        const page = await chrome.visit(t, 'https://seven.sliccy.ai/page-version');
        assert.deepEqual(await page.evaluate(() => globalThis.__earlyExtension), {
          exists: true,
          version: expected,
        });
      });
      await t.test('ordinary origin', async (t) => {
        const page = await chrome.visit(t, 'https://ordinary.test/page-version');
        assert.equal(await page.evaluate(() => 'sliccExtension' in globalThis), false);
        assert.deepEqual(await page.evaluate(() => globalThis.__earlyExtension), { exists: false });
      });
    } finally {
      await chrome.close();
    }
  });
}
