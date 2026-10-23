import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureServer } from '@ai-ecoverse/slicc-browsers/fixture';
import { waitFor } from '@ai-ecoverse/slicc-browsers/guard-driver.mjs';
import { run } from '@ai-ecoverse/slicc-browsers/guard-runner';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';
import { install } from '../client.mjs';
import { copies } from '../copies.mjs';
import { extId } from '../extension-page.mjs';
import { certificate } from '../servers.mjs';
import {
  capabilities,
  carrier,
  entries,
  report,
  send,
  strict,
  targets,
  until,
  waitEvent,
} from './guard.mjs';

const set = JSON.parse(
  await readFile(
    new URL('../../../node_modules/@ai-ecoverse/slicc-browsers/guard-vectors.json', import.meta.url)
  )
);
const parallel = Number(process.env.GUARD_PARALLEL ?? 4);
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
const unisolated = [];
const sharing = [
  '--disable-site-isolation-trials',
  '--disable-features=IsolateOrigins,site-per-process',
];

async function setUp() {
  dir = await mkdtemp(join(tmpdir(), 'slicc-extension-guard-'));
  const tls = await certificate(dir);
  spki = createHash('sha256')
    .update(createPublicKey(tls.cert).export({ type: 'spki', format: 'der' }))
    .digest('base64');
  fixture = await fixtureServer({ tls });
}

async function tearDown() {
  await Promise.allSettled(
    [...pool, ...unisolated].map(async (browser) => (await browser)?.close())
  );
  pool.length = 0;
  unisolated.length = 0;
  await fixture?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
}

async function evaluate(cdp, sessionId, expression) {
  const answer = await send(
    cdp,
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (answer.exceptionDetails)
    throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
  return answer.result.value;
}

async function browser(extra = []) {
  const rules = hosts.map((host) => `MAP ${host} 127.0.0.1:${fixture.port}`).join(', ');
  const copy = await copies(['extension/']);
  const chrome = await launch({
    roots: [['/', 'test/integration/page/']],
    coverage: [],
    extensions: copy.paths,
    args: [
      `--ignore-certificate-errors-spki-list=${spki}`,
      `--host-resolver-rules=${rules}`,
      ...extra,
    ],
  }).catch(async (error) => {
    await copy.remove();
    throw error;
  });
  const cdp = chrome.cdp;
  const tapped = cdp.events;
  const real = new Map();
  let worker;

  async function workerSession() {
    if (worker) return worker;
    const { targetInfos } = await send(cdp, 'Target.getTargets');
    const info = targetInfos.find(
      (target) =>
        target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extId}/`)
    );
    if (!info) throw new Error('guard observer: no extension service worker');
    const { sessionId } = await send(cdp, 'Target.attachToTarget', {
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
    let tabId;
    const known = async () => {
      tabId = await evaluate(cdp, await workerSession(), expression).catch(() => {
        worker = undefined;
        return undefined;
      });
      return typeof tabId === 'number';
    };
    if (!(await waitFor(known, 5000, 100))) return targetId;
    real.set(String(tabId), targetId);
    given.set(String(tabId), targetId);
    return String(tabId);
  }

  const heard = [];
  cdp.on((message) => heard.push(JSON.stringify(message)));
  const observer = {
    messages: heard,
    async send(method, params = {}, sessionId) {
      const tab = typeof params.targetId === 'string' && /^\d+$/.test(params.targetId);
      const mapped = tab ? { ...params, targetId: await realTarget(params.targetId) } : params;
      if (method === 'Runtime.enable') await send(cdp, 'Runtime.disable', {}, sessionId);
      try {
        const result = await send(cdp, method, mapped, sessionId);
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
      return tapped;
    },
    waitEvent: (predicate, ms = 10000) => waitEvent(tapped, predicate, ms),
  };

  async function guarded(transport) {
    const entry = entries[transport];
    const url = `${entry.origin}${entry.path}`;
    const { targetId } = await send(cdp, 'Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send(cdp, 'Target.attachToTarget', { targetId, flatten: true });
    const events = [];
    const messages = [];
    const off = cdp.on(({ method, params, sessionId: from }) => {
      if (method !== 'Runtime.bindingCalled' || from !== sessionId || params.name !== binding)
        return;
      const payload = JSON.parse(params.payload);
      if (typeof payload.text === 'string') {
        messages.push(payload.text);
        return;
      }
      events.push(asGiven(payload.event));
    });
    let closing;
    const close = () => {
      closing ??= (async () => {
        off();
        await send(cdp, 'Target.closeTarget', { targetId }).catch(() => undefined);
      })();
      return closing;
    };
    try {
      await send(cdp, 'Runtime.enable', {}, sessionId);
      await send(cdp, 'Runtime.addBinding', { name: binding }, sessionId);
      await send(cdp, 'Page.enable', {}, sessionId);
      await send(cdp, 'Page.navigate', { url }, sessionId);
      const ready = transport === 'seven' ? " && 'sliccExtension' in globalThis" : '';
      const expression = `document.readyState === 'complete' && location.href === ${JSON.stringify(url)}${ready}`;
      await until(
        () => evaluate(cdp, sessionId, expression).catch(() => undefined),
        15000,
        expression
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
        const call = (args) =>
          evaluate(
            cdp,
            sessionId,
            `h.cdp.send(...${JSON.stringify(args)}).then((result) => ({ ok: true, result: result ?? {} }), (error) => ({ ok: false, message: String(error?.message ?? error), code: error?.code }))`
          );
        if (method.startsWith('Input.') && session !== undefined)
          await call(['Page.bringToFront', {}, session]);
        const answer = await call([method, local, ...(session === undefined ? [] : [session])]);
        if (answer.ok) return asGiven(answer.result);
        const error = new Error(answer.message);
        error.cdp = {
          message: answer.message,
          ...(answer.code === undefined ? {} : { code: answer.code }),
        };
        throw error;
      },
      waitEvent: (predicate, ms = 10000) => waitEvent(events, predicate, ms),
      close,
    };
    return { client, close };
  }

  return {
    observer,
    guarded,
    async close() {
      await chrome.close();
      await copy.remove();
    },
  };
}

async function pooled(slot, fresh = false, shared = false) {
  const list = shared ? unisolated : pool;
  if (fresh && list[slot]) {
    const old = list[slot];
    list[slot] = undefined;
    await (await old).close();
  }
  list[slot] ??= browser(shared ? sharing : []);
  return list[slot];
}

async function clients(transport, metadata) {
  const { slot } = metadata;
  const shared = (metadata.vector.requires ?? []).includes('siteIsolationOff');
  const fresh = metadata.leg !== 'guarded' && cachesAuth(metadata.vector);
  const own = await pooled(slot, fresh, shared);
  const made = await own.guarded(transport);
  const close = async () => {
    if (transport === 'six-bridge' && metadata.vector.id.startsWith('C2.redirect-secret')) {
      const extras = made.client.events.filter(
        (event) =>
          event.method === 'Network.responseReceivedExtraInfo' &&
          [301, 302, 303, 307, 308].includes(event.params.statusCode)
      );
      console.log(
        'redirect-check ' +
          JSON.stringify({
            vector: metadata.vector.id,
            variant: metadata.variant,
            extras: extras.map((event) => {
              const headers = event.params.headers;
              const location = headers.location ?? headers.Location;
              const origin =
                typeof location === 'string' && URL.canParse(location)
                  ? new URL(location).origin
                  : '';
              return {
                requestId: event.params.requestId,
                status: event.params.statusCode,
                locationIsOrigin: location === origin,
                origin,
                headersTextHasOrigin: String(event.params.headersText).includes(origin),
              };
            }),
          })
      );
    }
    await made.close();
  };
  return { client: made.client, unguarded: own.observer, close };
}

async function sweep(transport, variant) {
  const started = Date.now();
  let done = 0;
  const tally = {};
  const options = {
    clientFactory: (metadata) => clients(transport, metadata),
    targets: targets(transport),
    capabilities: capabilities(transport),
    variant: [variant],
    fixture,
    rowTimeoutMs: 180000,
    parallel,
    debug: (entry) => carrier(tally, entry),
    log(row) {
      done += 1;
      const verdict = `${row.control}/${row.guarded}/${row.live}`;
      const why =
        verdict === 'pass/pass/pass' ? '' : ` ${row.why ?? ''} ${(row.errors ?? []).join(' | ')}`;
      console.log(
        `guard ${transport} ${variant} ${done} ${row.id} ${row.target} ${row.variant} ${verdict}${why}`
      );
    },
  };
  const { results } = await run(set, options);
  return { results, tally, seconds: Math.round((Date.now() - started) / 1000) };
}

export async function runGuard(transport, variant) {
  await setUp();
  let swept;
  try {
    swept = await sweep(transport, variant);
  } finally {
    await tearDown();
  }
  const { results, tally, seconds } = swept;
  const summary = report(set, results, sha, transport);
  const problems = strict(summary);
  const out = new URL('../../../artifacts/guard/', import.meta.url);
  await mkdir(out, { recursive: true });
  await writeFile(
    new URL(`${transport}-${variant}.json`, out),
    `${JSON.stringify(
      { transport, variants: [variant], sha, seconds, carriers: tally, problems, ...summary },
      null,
      2
    )}\n`
  );
  console.log(summary.line);
  console.log(`skips ${JSON.stringify(summary.skips)}`);
  console.log(`carriers ${JSON.stringify(tally)}`);
  console.log(
    `passed ${summary.passed} (${summary.passedClean} without ran/notes), not-run ${summary.notRun.length} ids, failed ${summary.failed.length}, incomplete ${summary.incomplete.length}, forged ${summary.forged.length}, missing ${summary.missing.length}`
  );
  assert.deepEqual(problems, [], summary.line);
  assert.match(summary.line, /^GUARD-PASS slicc-extension@/);
}
