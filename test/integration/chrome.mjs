import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch as start } from '@ai-ecoverse/slicc-shared-web/harness';
import { seven } from '../../extension/seven.js';
import { certificate, ims, pages, upstream } from './servers.mjs';

export async function launch() {
  await rm(new URL('../../extension/_metadata', import.meta.url), { recursive: true, force: true });
  const dir = await mkdtemp(join(tmpdir(), 'slicc-extension-'));
  const tls = await certificate(dir);
  const site = await pages(tls);
  const remote = await upstream(tls);
  const adobe = await ims(tls);
  const rules = [
    `MAP seven.sliccy.ai 127.0.0.1:${site.port}`,
    `MAP vault.sliccy.ai 127.0.0.1:${site.port}`,
    `MAP vault-preview.sliccy.ai 127.0.0.1:${site.port}`,
    `MAP vault-x.sliccy.ai 127.0.0.1:${site.port}`,
    `MAP vault-feature-x.sliccy.ai 127.0.0.1:${site.port}`,
    `MAP get.sliccy.ai 127.0.0.1:${site.port}`,
    `MAP echo.sliccy.ai 127.0.0.1:${site.port}`,
    `MAP www.sliccy.ai 127.0.0.1:${site.port}`,
    `MAP other.test 127.0.0.1:${site.port}`,
    `MAP discover.test 127.0.0.1:${site.port}`,
    `MAP ordinary.test 127.0.0.1:${site.port}`,
    `MAP upstream.test 127.0.0.1:${remote.port}`,
    `MAP ims-na1.adobelogin.com 127.0.0.1:${adobe.port}`,
  ].join(', ');
  const chrome = await start({
    roots: [['/', 'test/integration/page/']],
    coverage: process.env.SLICC_COVERAGE ? undefined : [],
    extensions: ['extension/'],
    args: [
      '--ignore-certificate-errors',
      `--host-resolver-rules=${rules}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });
  const opened = new WeakMap();

  const allowedHosts = new Set(['www.sliccy.ai', 'seven.sliccy.ai']);
  function expectsExtension(hostname) {
    if (allowedHosts.has(hostname)) return true;
    const domain = `.${seven.domain}`;
    if (!hostname.endsWith(domain)) return false;
    const label = hostname.slice(0, -domain.length);
    if (!label) return false;
    const { excludedLabels, excludedLabelPrefixes } = seven;
    if (excludedLabels.includes(label) || excludedLabelPrefixes.some((p) => label.startsWith(p))) {
      return false;
    }
    return true;
  }

  async function visit(t, href) {
    const first = opened.get(t);
    const page = first ? await first.tab() : await chrome.page(t);
    if (!first) opened.set(t, page);
    await page.goto(href);
    const host = new URL(href).hostname;
    const needsExt = expectsExtension(host);
    await page.until(
      (target, ext) =>
        document.readyState === 'complete' &&
        location.href === target &&
        (!ext || 'sliccExtension' in globalThis),
      href,
      needsExt
    );
    return page;
  }

  return {
    site,
    cdp: chrome.cdp,
    upstream: remote,
    ims: adobe,
    visit,
    async close() {
      await chrome.close();
      await Promise.all([site.close(), remote.close(), adobe.close()]);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
