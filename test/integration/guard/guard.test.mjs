import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fixtureServer } from '@ai-ecoverse/slicc-browsers/fixture';
import { run } from '@ai-ecoverse/slicc-browsers/guard-runner';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';
import { install } from '../client.mjs';
import { extId } from '../extension-page.mjs';
import { certificate } from '../servers.mjs';
import { batches, capabilities, entries, report, targets } from './guard.mjs';

const set = JSON.parse(
  await readFile(
    new URL('../../../node_modules/@ai-ecoverse/slicc-browsers/guard-vectors.json', import.meta.url)
  )
);
const transports = (process.env.GUARD_TRANSPORT ?? 'seven,six-bridge').split(',');
const variants = (process.env.GUARD_VARIANT ?? 'prompt,lagging').split(',');
const parallel = Number(process.env.GUARD_PARALLEL ?? 4);
const only = process.env.GUARD_ONLY ? new RegExp(process.env.GUARD_ONLY) : undefined;
const sha =
  process.env.GUARD_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const hosts = [
  'seven.sliccy.ai',
  'www.sliccy.ai',
  'vault.sliccy.ai',
  'vault-x.sliccy.ai',
  'sliccy.ai',
  'ordinary.test',
  'cross.test',
  'exa%20mple.sliccy.ai',
  'xn--1ug.sliccy.ai',
  'xn--a.sliccy.ai',
];
const binding = '__sliccGuardEvent';
const cachesAuth = (vector) => JSON.stringify([vector.setup, vector.trigger]).includes('/auth/');

let dir;
let fixture;
let spki;
const pool = [];

before(async () => {
  await rm(new URL('../../../extension/_metadata', import.meta.url), {
    recursive: true,
    force: true,
  });
  dir = await mkdtemp(join(tmpdir(), 'slicc-extension-guard-'));
  const tls = await certificate(dir);
  spki = createHash('sha256')
    .update(createPublicKey(tls.cert).export({ type: 'spki', format: 'der' }))
    .digest('base64');
  fixture = await fixtureServer({ tls });
});

after(async () => {
  await Promise.allSettled(pool.map(async (browser) => (await browser)?.close()));
  await fixture?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function evaluate(cdp, sessionId, expression) {
  const answer = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (answer.exceptionDetails)
    throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
  return answer.result.value;
}

async function until(cdp, sessionId, expression, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await evaluate(cdp, sessionId, expression).catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`guard client: ${expression} within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function browser() {
  const rules = hosts.map((host) => `MAP ${host} 127.0.0.1:${fixture.port}`).join(', ');
  const chrome = await launch({
    roots: [['/', 'test/integration/page/']],
    coverage: [],
    extensions: ['extension/'],
    args: [`--ignore-certificate-errors-spki-list=${spki}`, `--host-resolver-rules=${rules}`],
  });
  const cdp = chrome.cdp;
  const real = new Map();
  let worker;

  async function workerSession() {
    if (worker) return worker;
    const { targetInfos } = await cdp.send('Target.getTargets');
    const info = targetInfos.find(
      (target) =>
        target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extId}/`)
    );
    if (!info) throw new Error('guard observer: no extension service worker');
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: info.targetId,
      flatten: true,
    });
    worker = sessionId;
    return worker;
  }

  async function realTarget(tabId) {
    if (real.has(tabId)) return real.get(tabId);
    const expression = `chrome.debugger.getTargets().then((list) => list.find((target) => target.tabId === ${Number(tabId)})?.id)`;
    let id = await evaluate(cdp, await workerSession(), expression).catch(() => undefined);
    if (id === undefined) {
      worker = undefined;
      id = await evaluate(cdp, await workerSession(), expression).catch(() => undefined);
    }
    if (id) real.set(tabId, id);
    return id ?? tabId;
  }

  const given = new Map();

  function asGiven(value) {
    if (Array.isArray(value)) return value.map(asGiven);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = key === 'targetId' && given.has(item) ? given.get(item) : asGiven(item);
    }
    return out;
  }

  async function tabOf(targetId) {
    const expression = `chrome.debugger.getTargets().then((list) => list.find((target) => target.id === ${JSON.stringify(targetId)})?.tabId)`;
    for (let attempt = 0; attempt < 50; attempt++) {
      const tabId = await evaluate(cdp, await workerSession(), expression).catch(() => {
        worker = undefined;
        return undefined;
      });
      if (typeof tabId === 'number') {
        real.set(String(tabId), targetId);
        given.set(String(tabId), targetId);
        return String(tabId);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return targetId;
  }

  const heard = [];
  cdp.on((message) => heard.push(JSON.stringify(message)));
  const observer = {
    messages: heard,
    async send(method, params = {}, sessionId) {
      const tab = typeof params.targetId === 'string' && /^\d+$/.test(params.targetId);
      const mapped = tab ? { ...params, targetId: await realTarget(params.targetId) } : params;
      if (method === 'Runtime.enable') await cdp.send('Runtime.disable', {}, sessionId);
      try {
        const result = await cdp.send(method, mapped, sessionId);
        heard.push(JSON.stringify({ result }));
        return result;
      } catch (error) {
        heard.push(JSON.stringify({ error: { message: String(error?.message ?? error) } }));
        throw error;
      }
    },
    on: (listener) => cdp.on(listener),
    off: (listener) => cdp.off(listener),
    get events() {
      return cdp.events;
    },
    waitEvent: (...args) => cdp.waitEvent(...args),
  };

  async function guarded(transport) {
    const entry = entries[transport];
    const url = `${entry.origin}${entry.path}`;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const events = [];
    const messages = [];
    const listeners = new Set();
    const off = cdp.on(({ method, params, sessionId: from }) => {
      if (method !== 'Runtime.bindingCalled' || from !== sessionId || params.name !== binding)
        return;
      const payload = JSON.parse(params.payload);
      if (typeof payload.text === 'string') {
        messages.push(payload.text);
        return;
      }
      const event = asGiven(payload.event);
      events.push(event);
      for (const listener of listeners) listener(event);
    });
    const close = async () => {
      off();
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    };
    try {
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Runtime.addBinding', { name: binding }, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Page.navigate', { url }, sessionId);
      const ready = transport === 'seven' ? " && 'sliccExtension' in globalThis" : '';
      await until(
        cdp,
        sessionId,
        `document.readyState === 'complete' && location.href === ${JSON.stringify(url)}${ready}`
      );
      await evaluate(
        cdp,
        sessionId,
        `(${install})(${JSON.stringify(transport)}, ${JSON.stringify(extId)})`
      );
      await evaluate(
        cdp,
        sessionId,
        `(h.tap((text) => globalThis.${binding}(JSON.stringify({ text }))), h.cdp.on((event) => globalThis.${binding}(JSON.stringify({ event }))), true)`
      );
    } catch (error) {
      await close();
      throw error;
    }
    const client = {
      transport,
      events,
      messages,
      async send(method, params, session) {
        const raw = params?.targetId;
        const local =
          typeof raw === 'string' && /^[0-9A-F]{32}$/.test(raw)
            ? { ...params, targetId: await tabOf(raw) }
            : (params ?? {});
        const args = [method, local, ...(session === undefined ? [] : [session])];
        const answer = await evaluate(
          cdp,
          sessionId,
          `h.cdp.send(...${JSON.stringify(args)}).then((result) => ({ ok: true, result: result ?? {} }), (error) => ({ ok: false, message: String(error?.message ?? error), code: error?.code }))`
        );
        if (answer.ok) return asGiven(answer.result);
        const error = new Error(answer.message);
        error.cdp = {
          message: answer.message,
          ...(answer.code === undefined ? {} : { code: answer.code }),
        };
        throw error;
      },
      waitEvent(predicate, ms = 10000) {
        const found = events.find(predicate);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
          const listener = (event) => {
            if (!predicate(event)) return;
            clearTimeout(timer);
            listeners.delete(listener);
            resolve(event);
          };
          const timer = setTimeout(() => {
            listeners.delete(listener);
            reject(new Error(`waitEvent: no event in ${ms} ms`));
          }, ms);
          listeners.add(listener);
        });
      },
    };
    return { client, close };
  }

  return { observer, guarded, close: () => chrome.close() };
}

async function pooled(slot, fresh = false) {
  if (fresh && pool[slot]) {
    const old = pool[slot];
    pool[slot] = undefined;
    await (await old).close();
  }
  pool[slot] ??= browser();
  return pool[slot];
}

async function clients(transport, { slot, vector }) {
  const own = await pooled(slot, cachesAuth(vector));
  const made = await own.guarded(transport);
  return { client: made.client, unguarded: own.observer, close: made.close };
}

for (const transport of transports) {
  test(`guard vectors on ${transport}, ${variants.join(' and ')}`, async () => {
    const vectors = only ? { ...set, vectors: set.vectors.filter((v) => only.test(v.id)) } : set;
    const started = Date.now();
    let done = 0;
    const options = {
      clientFactory: (metadata) => clients(transport, metadata),
      targets: targets(transport),
      capabilities: capabilities(transport),
      variant: variants,
      fixture,
      rowTimeoutMs: 180000,
      log(row) {
        done += 1;
        const verdict = `${row.control}/${row.guarded}/${row.live}`;
        const why =
          verdict === 'pass/pass/pass' ? '' : ` ${row.why ?? ''} ${(row.errors ?? []).join(' | ')}`;
        console.log(
          `guard ${transport} ${done} ${row.id} ${row.target} ${row.variant} ${verdict}${why}`
        );
      },
    };
    const results = [];
    for (const batch of batches(vectors)) {
      const execution = await run(batch.vectors, {
        ...options,
        parallel: batch.parallel ?? parallel,
      });
      results.push(...execution.results);
    }
    const summary = report(vectors, results, sha, transport);
    const out = new URL('../../../artifacts/guard/', import.meta.url);
    await mkdir(out, { recursive: true });
    await writeFile(
      new URL(`${transport}-${variants.join('-')}.json`, out),
      `${JSON.stringify(
        {
          transport,
          variants,
          sha,
          seconds: Math.round((Date.now() - started) / 1000),
          ...summary,
        },
        null,
        2
      )}\n`
    );
    console.log(summary.line);
    console.log(`skips ${JSON.stringify(summary.skips)}`);
    assert.deepEqual(
      summary.failed.map((row) => `${row.id} ${row.target} ${row.variant}: ${row.why}`),
      []
    );
    assert.ok(only || summary.pass, summary.line);
  });
}
