import { mkdir, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';

const outDir = new URL('../../screenshots/', import.meta.url);

let chrome;
before(async () => {
  chrome = await launch();
  await mkdir(outDir, { recursive: true });
});
after(() => chrome?.close());

async function shoot(t, label, href, width, darkMode) {
  const page = await chrome.visit(t, href);
  if (darkMode) {
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
  }
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.goto(href);
  await new Promise((r) => setTimeout(r, 1500));
  const { data } = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  const buf = Buffer.from(data, 'base64');
  await writeFile(new URL(`${label}.png`, outDir), buf);
}

test('seven page light 1280', async (t) => {
  await shoot(t, 'seven-page-light-1280', 'https://seven.sliccy.ai/', 1280, false);
});

test('seven page dark 1280', async (t) => {
  await shoot(t, 'seven-page-dark-1280', 'https://seven.sliccy.ai/', 1280, true);
});

test('seven page light 420', async (t) => {
  await shoot(t, 'seven-page-light-420', 'https://seven.sliccy.ai/', 420, false);
});

test('six page light 1280', async (t) => {
  await shoot(t, 'six-page-light-1280', 'https://www.sliccy.ai/', 1280, false);
});

test('six page dark 1280', async (t) => {
  await shoot(t, 'six-page-dark-1280', 'https://www.sliccy.ai/', 1280, true);
});

test('six page light 420', async (t) => {
  await shoot(t, 'six-page-light-420', 'https://www.sliccy.ai/', 420, false);
});
