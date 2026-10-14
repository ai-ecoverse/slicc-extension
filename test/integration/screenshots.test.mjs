import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { certificate } from './servers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = join(root, 'screenshots');
const extId = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';
const sixExtDir = process.env.SIX_IMPORT_DIR;
const extPages = ['sidepanel.html', 'secrets.html', 'capture-popup.html', 'picker-popup.html'];

const viewports = [
  { label: 'light-1280', width: 1280, height: 900, dark: false },
  { label: 'dark-1280', width: 1280, height: 900, dark: true },
  { label: 'light-420', width: 420, height: 900, dark: false },
];

async function launchWithExtension(extensionDir) {
  const dir = await mkdir(join(tmpdir(), `slicc-shot-${Date.now()}`), {
    recursive: true,
  });
  const tls = await certificate(dir);
  const browser = await chromium.launchPersistentContext(join(dir, 'profile'), {
    executablePath: chromium.executablePath(),
    headless: false,
    args: [
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-certificate-errors',
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  return { browser, dir };
}

async function shootAll(extensionDir, prefix) {
  const { browser, dir } = await launchWithExtension(extensionDir);
  const shots = [];
  for (const pageName of extPages) {
    const name = pageName.replace('.html', '');
    for (const vp of viewports) {
      const label = `${prefix}-${name}-${vp.label}`;
      const page = await browser.newPage();
      await page.setViewportSize({ width: vp.width, height: vp.height });
      if (vp.dark) {
        await page.emulateMedia({ colorScheme: 'dark' });
      }
      await page.goto(`chrome-extension://${extId}/${pageName}`, {
        waitUntil: 'load',
        timeout: 10000,
      });
      await page.waitForTimeout(800);
      const buf = await page.screenshot({ type: 'png' });
      await writeFile(join(outDir, `${label}.png`), buf);
      shots.push({ label, buf: Buffer.from(buf) });
      await page.close();
    }
  }
  await browser.close();
  await rm(dir, { recursive: true, force: true });
  return shots;
}

test('extension pages load without console errors', async () => {
  const { browser, dir } = await launchWithExtension(join(root, 'extension'));
  try {
    for (const pageName of extPages) {
      const errors = [];
      const page = await browser.newPage();
      page.on('pageerror', (err) => errors.push(err.message));
      await page.goto(`chrome-extension://${extId}/${pageName}`, {
        waitUntil: 'load',
        timeout: 10000,
      });
      await page.waitForTimeout(500);
      assert.deepEqual(errors, [], `${pageName} had console errors: ${errors.join('; ')}`);
      await page.close();
    }
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

describe('pixel diff against six (skipped unless SIX_IMPORT_DIR is set)', {
  skip: !sixExtDir,
}, () => {
  let mergedShots;
  let sixShots;

  before(async () => {
    await mkdir(outDir, { recursive: true });
  });

  test('capture merged extension screenshots', async () => {
    mergedShots = await shootAll(join(root, 'extension'), 'merged');
    assert.ok(mergedShots.length > 0);
  });

  test('capture six screenshots from SIX_IMPORT_DIR', async () => {
    sixShots = await shootAll(sixExtDir, 'six');
    assert.ok(sixShots.length > 0);
  });

  test('pixel diff each pair', async () => {
    assert.ok(mergedShots, 'merged shots must exist');
    assert.ok(sixShots, 'six shots must exist');
    const diffs = [];
    for (const merged of mergedShots) {
      const suffix = merged.label.replace('merged-', '');
      const six = sixShots.find((s) => s.label === `six-${suffix}`);
      assert.ok(six, `no six shot for ${suffix}`);
      const mHash = createHash('sha256').update(merged.buf).digest('hex');
      const sHash = createHash('sha256').update(six.buf).digest('hex');
      diffs.push({ page: suffix, identical: mHash === sHash, mHash, sHash });
    }
    const report = diffs
      .map(
        (d) =>
          `${d.page}: ${d.identical ? 'IDENTICAL' : `DIFFERENT (merged=${d.mHash.slice(0, 12)} six=${d.sHash.slice(0, 12)})`}`
      )
      .join('\n');
    await writeFile(join(outDir, 'diff-report.txt'), report);
    process.stdout.write(`\n${report}\n`);
    const allIdentical = diffs.every((d) => d.identical);
    process.stdout.write(allIdentical ? '\nAll pairs identical.\n' : '\nSome pairs differ.\n');
  });
});
