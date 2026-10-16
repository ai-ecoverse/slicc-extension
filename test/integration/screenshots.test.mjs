import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { certificate } from './servers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const extId = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';
const extPages = ['sidepanel.html', 'secrets.html', 'capture-popup.html', 'picker-popup.html'];

async function launchWithExtension(extensionDir) {
  const dir = await mkdir(join(tmpdir(), `slicc-shot-${Date.now()}`), {
    recursive: true,
  });
  const tls = await certificate(dir);
  const browser = await chromium.launchPersistentContext(join(dir, 'profile'), {
    executablePath: chromium.executablePath(),
    headless: false,
    args: [
      '--headless=new',
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-certificate-errors',
    ],
    ignoreDefaultArgs: ['--disable-extensions', '--headless'],
  });
  return { browser, dir };
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
