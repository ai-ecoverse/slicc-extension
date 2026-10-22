import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';
import { copies } from './copies.mjs';
import { extId } from './extension-page.mjs';

const extPages = ['sidepanel.html', 'secrets.html', 'capture-popup.html', 'picker-popup.html'];

let chrome;
let copy;

before(async () => {
  copy = await copies(['extension/']);
  chrome = await launch({
    roots: [['/', 'test/integration/page/']],
    coverage: [],
    extensions: copy.paths,
    args: ['--ignore-certificate-errors'],
  });
});

after(async () => {
  await chrome?.close();
  await copy?.remove();
});

test('extension pages load without console errors', async (t) => {
  for (const pageName of extPages) {
    const page = await chrome.page(t);
    const url = `chrome-extension://${extId}/${pageName}`;
    await page.send('Page.navigate', { url });
    await page.until((href) => location.href === href && document.readyState === 'complete', url);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(page.errors, [], `${pageName} had console errors: ${page.errors.join('; ')}`);
    await page.close();
  }
});
