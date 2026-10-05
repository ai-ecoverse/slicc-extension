import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '@ai-ecoverse/slicc-shared-web/harness';
import { chromium } from 'playwright-core';
import { certificate, pages, upstream } from './servers.mjs';

const extension = fileURLToPath(new URL('../../extension/', import.meta.url));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function start(profile, rules) {
  const args = [
    '--headless',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--ignore-certificate-errors',
    `--host-resolver-rules=${rules}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
  const child = spawn(chromium.executablePath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  const url = new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    child.once('exit', (code) => reject(new Error(`Chromium exited with ${code}\n${log}`)));
  });
  return { child, url };
}

async function until(probe, what, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

export async function launch() {
  const profile = await mkdtemp(join(tmpdir(), 'slicc-extension-'));
  const tls = await certificate(profile);
  const site = await pages(tls);
  const remote = await upstream(tls);
  const rules = [
    `MAP seven.sliccy.ai 127.0.0.1:${site.port}`,
    `MAP other.test 127.0.0.1:${site.port}`,
    `MAP upstream.test 127.0.0.1:${remote.port}`,
  ].join(', ');
  const { child, url } = start(profile, rules);
  const cdp = await connect(await url);
  const worker = await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find(
      (target) => target.type === 'service_worker' && target.url.endsWith('/background.js')
    );
  }, 'the extension service worker');

  async function open(href) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    async function evaluate(fn, ...args) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression: `(${fn})(...${JSON.stringify(args)})`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description);
      return result.value;
    }
    await send('Page.enable');
    await send('Page.navigate', { url: href });
    const loaded = (target) => document.readyState === 'complete' && location.href === target;
    await until(() => evaluate(loaded, href).catch(() => false), href);
    return { evaluate, close: () => cdp.send('Target.closeTarget', { targetId }) };
  }

  return {
    worker,
    upstream: remote,
    open,
    async close() {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      await cdp.send('Browser.close').catch(() => null);
      cdp.close();
      await Promise.race([exited, sleep(5000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
      await Promise.all([site.close(), remote.close()]);
      await rm(profile, { recursive: true, force: true });
    },
  };
}
