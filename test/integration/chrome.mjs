import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch as start } from '@ai-ecoverse/slicc-shared-web/harness';
import { certificate, ims, pages, upstream } from './servers.mjs';

export async function launch() {
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
    `MAP get.sliccy.ai 127.0.0.1:${site.port}`,
    `MAP www.sliccy.ai 127.0.0.1:${site.port}`,
    `MAP other.test 127.0.0.1:${site.port}`,
    `MAP upstream.test 127.0.0.1:${remote.port}`,
    `MAP ims-na1.adobelogin.com 127.0.0.1:${adobe.port}`,
  ].join(', ');
  const chrome = await start({
    roots: [['/', 'test/integration/page/']],
    extensions: ['extension/'],
    args: ['--ignore-certificate-errors', `--host-resolver-rules=${rules}`],
  });
  const opened = new WeakMap();

  const allowedHosts = new Set(['www.sliccy.ai', 'seven.sliccy.ai']);
  function expectsExtension(hostname) {
    if (allowedHosts.has(hostname)) return true;
    if (!hostname.endsWith('.sliccy.ai')) return false;
    const label = hostname.slice(0, -'.sliccy.ai'.length);
    if (!label) return false;
    const exL = ['www', 'vault', 'vault-preview', 'get', 'mcpcat'];
    const exP = ['vault-'];
    if (exL.includes(label) || exP.some((p) => label.startsWith(p))) return false;
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
