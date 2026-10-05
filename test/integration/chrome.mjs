import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch as start } from '@ai-ecoverse/slicc-shared-web/harness';
import { certificate, pages, upstream } from './servers.mjs';

export async function launch() {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-extension-'));
  const tls = await certificate(dir);
  const site = await pages(tls);
  const remote = await upstream(tls);
  const rules = [
    `MAP seven.sliccy.ai 127.0.0.1:${site.port}`,
    `MAP other.test 127.0.0.1:${site.port}`,
    `MAP upstream.test 127.0.0.1:${remote.port}`,
  ].join(', ');
  const chrome = await start({
    roots: [['/', 'test/integration/page/']],
    extensions: ['extension/'],
    args: ['--ignore-certificate-errors', `--host-resolver-rules=${rules}`],
  });
  const opened = new WeakMap();

  async function visit(t, href) {
    const first = opened.get(t);
    const page = first ? await first.tab() : await chrome.page(t);
    if (!first) opened.set(t, page);
    await page.goto(href);
    await page.until(
      (target) =>
        document.readyState === 'complete' &&
        location.href === target &&
        (!location.hostname.endsWith('.sliccy.ai') || 'sliccExtension' in globalThis),
      href
    );
    return page;
  }

  return {
    upstream: remote,
    visit,
    async close() {
      await chrome.close();
      await Promise.all([site.close(), remote.close()]);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
