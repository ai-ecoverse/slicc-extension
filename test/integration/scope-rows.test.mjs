import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as plainServer } from 'node:http';
import { createServer as secureServer } from 'node:https';
import { test } from 'node:test';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';
import { copies } from './copies.mjs';
import { certificate } from './servers.mjs';

const budget = 15000;
const lines = [];
const observations = [];

function row(number, fields) {
  const line = `row-${number}: ${Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ')}`;
  lines.push(line);
  console.log(line);
}

async function probe(url, init, ms) {
  const permissions = async () => {
    const out = {};
    for (const name of ['local-network-access', 'local-network', 'loopback-network']) {
      try {
        out[name] = (await navigator.permissions.query({ name })).state;
      } catch (error) {
        out[name] = `${error.name}: ${error.message}`;
      }
    }
    return out;
  };
  const result = {
    origin: location.origin,
    secure: isSecureContext,
    api: typeof globalThis.sliccExtension,
    before: await permissions(),
  };
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    result.available = true;
    result.status = response.status;
    result.length = (await response.text()).length;
    result.headers = Object.fromEntries(response.headers);
  } catch (error) {
    result.available = false;
    result.error = `${error.name}: ${error.message}`;
  }
  result.after = await permissions();
  return result;
}

async function fixture(tls, seen) {
  const handler = (request, response) => {
    const url = new URL(request.url, 'https://receiver.test');
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
    });
    request.on('end', () => {
      seen.push({
        host: request.headers.host,
        path: url.pathname,
        method: request.method,
        cookieSent: (request.headers.cookie ?? '').includes('receiver-cookie=fixture'),
        origin: request.headers.origin ?? null,
        requestedMethod: request.headers['access-control-request-method'] ?? null,
        requestedHeaders: request.headers['access-control-request-headers'] ?? null,
        requestedSpace: request.headers['access-control-request-private-network'] ?? null,
        authorizationSent: request.headers.authorization === 'Bearer fixture',
        size,
        status: request.method === 'OPTIONS' ? (url.pathname.includes('405') ? 405 : 204) : 200,
      });
      if (url.pathname.startsWith('/origin-')) {
        const child = url.searchParams.get('receiver');
        const script = child
          ? `<script>(${probe.toString()})(${JSON.stringify(child)}, {}, ${budget}).then(result => parent.postMessage({type:'receiver',result},'https://diag-b.sliccy.ai'));</script>`
          : '';
        response
          .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
          .end(`<!doctype html><title>${url.pathname.slice(1)}</title><p>receiver</p>${script}`);
        return;
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(url.pathname.includes('405') ? 405 : 204).end();
        return;
      }
      response
        .writeHead(200, {
          'content-type': 'text/plain',
          'cache-control': 'no-store',
          'x-receiver': 'fixture',
        })
        .end('receiver');
    });
  };
  const server = tls ? secureServer(tls, handler) : plainServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function browser(installed, paths, servers) {
  const [plain, secure, receiver, loopback, local] = servers;
  const rules = [
    `MAP diag-a.sliccy.ai:80 127.0.0.1:${plain.port}`,
    `MAP diag-a.sliccy.ai 127.0.0.1:${plain.port}`,
    `MAP diag-b.sliccy.ai 127.0.0.1:${secure.port}`,
    `MAP diag-c.sliccy.ai 127.0.0.1:${secure.port}`,
    `MAP receiver.test 127.0.0.1:${receiver.port}`,
    `MAP receiver-local.test 127.0.0.1:${local.port}`,
    'EXCLUDE 127.0.0.1',
    'MAP * ~NOTFOUND',
  ];
  const overrides = [
    `127.0.0.1:${plain.port}=public`,
    `127.0.0.1:${secure.port}=public`,
    `127.0.0.1:${receiver.port}=public`,
    `127.0.0.1:${local.port}=local`,
  ];
  const args = [
    '--ignore-certificate-errors',
    '--no-proxy-server',
    `--host-resolver-rules=${rules.join(', ')}`,
    `--ip-address-space-overrides=${overrides.join(',')}`,
  ];
  const chrome = await launch({
    roots: [['/', 'test/integration/page/']],
    coverage: [],
    extension: false,
    extensions: installed ? paths : [],
    args,
  });
  const events = [];
  const off = chrome.cdp.on((event) => events.push(event));
  const version = await chrome.cdp.send('Browser.getVersion');
  const command = await readFile(`/proc/${chrome.pid}/cmdline`, 'utf8').then(
    (value) => value.split('\0').filter(Boolean),
    (error) => [`${error.name}: ${error.message}`, ...args]
  );
  return {
    chrome,
    events,
    version,
    command,
    overrides,
    loopback: `https://127.0.0.1:${loopback.port}`,
    async close() {
      off();
      await chrome.close();
    },
  };
}

async function documentAt(run, url) {
  const cdp = run.chrome.cdp;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => cdp.send(method, params, sessionId, 30000);
  const domains = {};
  for (const domain of ['Page', 'Network', 'Runtime', 'Log', 'Audits']) {
    domains[domain] = await send(`${domain}.enable`).then(
      () => 'enabled',
      (error) => error.message
    );
  }
  const loaded = cdp.waitEvent(
    'Page.loadEventFired',
    (event) => event.sessionId === sessionId,
    30000
  );
  const navigation = await send('Page.navigate', { url });
  await loaded;
  const state = await send('Runtime.evaluate', {
    expression:
      '({href:location.href,origin:location.origin,secure:isSecureContext,api:typeof globalThis.sliccExtension})',
    returnByValue: true,
  });
  if (state.result?.value?.href !== url) throw new Error(JSON.stringify({ navigation, state }));
  return { sessionId, targetId, send, domains, state: state.result.value };
}

function diagnostics(events, sessionId, url) {
  const own = events.filter((event) => event.sessionId === sessionId);
  const ids = new Set(
    own
      .filter(
        (event) => event.method === 'Network.requestWillBeSent' && event.params.request.url === url
      )
      .map((event) => event.params.requestId)
  );
  const output = [];
  for (const { method, params } of own) {
    if (method === 'Network.loadingFailed' && ids.has(params.requestId)) {
      output.push({
        method,
        error: params.errorText,
        blockedReason: params.blockedReason ?? null,
        corsErrorStatus: params.corsErrorStatus ?? null,
        canceled: params.canceled,
      });
    }
    if (method === 'Network.responseReceived' && ids.has(params.requestId)) {
      output.push({
        method,
        status: params.response.status,
        remoteIPAddress: params.response.remoteIPAddress,
        securityState: params.response.securityState,
        headers: params.response.headers,
      });
    }
    if (method === 'Network.requestWillBeSentExtraInfo' && ids.has(params.requestId)) {
      output.push({
        method,
        clientSecurityState: params.clientSecurityState ?? null,
        blockedCookies: (params.associatedCookies ?? []).map((entry) => ({
          blockedReasons: entry.blockedReasons,
        })),
        connectTiming: params.connectTiming,
      });
    }
    if (method === 'Network.responseReceivedExtraInfo' && ids.has(params.requestId)) {
      output.push({
        method,
        status: params.statusCode,
        addressSpace: params.resourceIPAddressSpace,
        blockedCookies: (params.blockedCookies ?? []).map((entry) => ({
          blockedReasons: entry.blockedReasons,
        })),
        corsErrorStatus: params.corsErrorStatus ?? null,
      });
    }
    if (method === 'Log.entryAdded')
      output.push({ method, level: params.entry.level, text: params.entry.text });
    if (method === 'Runtime.consoleAPICalled')
      output.push({
        method,
        type: params.type,
        text: params.args.map((arg) => arg.value ?? arg.description).join(' '),
      });
    if (method === 'Audits.issueAdded') output.push({ method, issue: params.issue });
    if (method === 'Page.javascriptDialogOpening')
      output.push({ method, type: params.type, message: params.message });
  }
  return output;
}

async function request(run, doc, seen, path, init = {}, base = 'https://receiver.test') {
  const url = `${base}${path}`;
  const mark = run.events.length;
  let result;
  try {
    const answer = await doc.send('Runtime.evaluate', {
      expression: `(${probe.toString()})(${JSON.stringify(url)},${JSON.stringify(init)},${budget})`,
      awaitPromise: true,
      returnByValue: true,
    });
    result = answer.exceptionDetails
      ? { harnessError: answer.exceptionDetails }
      : answer.result.value;
  } catch (error) {
    result = { harnessError: error.message };
  }
  await doc
    .send('Runtime.evaluate', { expression: '0', returnByValue: true })
    .catch(() => undefined);
  const out = {
    receiver: url,
    ...result,
    received: seen.filter((entry) => entry.path === path),
    diagnostics: diagnostics(run.events.slice(mark), doc.sessionId, url),
  };
  observations.push(out);
  return out;
}

const put = {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' },
  body: '{"receiver":true}',
};

async function trio(run, doc, seen, label) {
  return {
    plain: await request(run, doc, seen, `/receiver/${label}/plain`),
    include: await request(run, doc, seen, `/receiver/${label}/include`, {
      credentials: 'include',
    }),
    options204: await request(run, doc, seen, `/receiver/${label}/options-204`, put),
    options405: await request(run, doc, seen, `/receiver/${label}/options-405`, put),
  };
}

async function frame(run, doc, seen) {
  const path = '/receiver/frame/plain';
  const url = `https://receiver.test${path}`;
  const mark = run.events.length;
  const answer = await doc.send('Runtime.evaluate', {
    expression: `new Promise(resolve => {
      const timer = setTimeout(() => resolve({harnessError:'frame-message-timeout'}), ${budget + 5000});
      const listener = event => {
        if (event.origin !== 'https://diag-c.sliccy.ai' || event.data?.type !== 'receiver') return;
        clearTimeout(timer);
        removeEventListener('message',listener);
        resolve(event.data.result);
      };
      addEventListener('message',listener);
      const iframe = document.createElement('iframe');
      iframe.src = 'https://diag-c.sliccy.ai/origin-c?receiver=' + encodeURIComponent(${JSON.stringify(url)});
      document.body.appendChild(iframe);
    })`,
    awaitPromise: true,
    returnByValue: true,
  });
  return {
    receiver: url,
    ...answer.result.value,
    received: seen.filter((entry) => entry.path === path),
    diagnostics: diagnostics(run.events.slice(mark), doc.sessionId, url),
  };
}

test('diagnostic rows', { timeout: 600000 }, async () => {
  const scratch = await mkdtemp('/tmp/scope-rows-');
  const servers = [];
  const runs = [];
  const seen = [];
  let copy;
  try {
    const tls = await certificate(scratch);
    for (const config of [null, tls, tls, tls, tls]) servers.push(await fixture(config, seen));
    copy = await copies(['extension/']);
    const run = await browser(true, copy.paths, servers);
    runs.push(run);
    const originA = await documentAt(run, 'http://diag-a.sliccy.ai/origin-a');
    const cookie = await originA.send('Network.setCookie', {
      name: 'receiver-cookie',
      value: 'fixture',
      url: 'https://receiver.test/',
      secure: true,
      sameSite: 'None',
      path: '/',
    });
    const first = await trio(run, originA, seen, 'origin-a');
    row(1, { chrome: run.version.product, document: originA.state, result: first.plain });
    row(2, { cookie, result: first.include });
    row(3, { options204: first.options204, options405: first.options405 });
    const originB = await documentAt(run, 'https://diag-b.sliccy.ai/origin-b');
    row(4, { document: originB.state, ...(await trio(run, originB, seen, 'origin-b')) });
    const control = await browser(false, [], servers);
    runs.push(control);
    const originControl = await documentAt(control, 'http://diag-a.sliccy.ai/origin-a');
    const controlCookie = await originControl.send('Network.setCookie', {
      name: 'receiver-cookie',
      value: 'fixture',
      url: 'https://receiver.test/',
      secure: true,
      sameSite: 'None',
      path: '/',
    });
    row(5, {
      chrome: control.version.product,
      installed: false,
      cookie: controlCookie,
      document: originControl.state,
      ...(await trio(control, originControl, seen, 'control')),
    });
    const local = {};
    for (const [label, doc] of [
      ['origin-a', originA],
      ['origin-b', originB],
    ]) {
      local[label] = {
        loopback: await request(run, doc, seen, `/receiver/${label}/loopback`, {}, run.loopback),
        local: await request(
          run,
          doc,
          seen,
          `/receiver/${label}/local`,
          {},
          'https://receiver-local.test'
        ),
      };
    }
    row(6, {
      version: run.version,
      featureFlags: run.command.filter((arg) =>
        /feature|local-network|private-network|ip-address-space|headless|automation|certificate/.test(
          arg
        )
      ),
      featureState: 'defaults',
      command: run.command.filter((arg) => !arg.startsWith('--user-data-dir=')),
      overrides: run.overrides,
      domains: originA.domains,
      ...local,
    });
    row(7, { top: originB.state, frame: await frame(run, originB, seen) });
    assert.equal(lines.length, 7);
    assert.equal(originA.state.origin, 'http://diag-a.sliccy.ai');
    assert.equal(originB.state.origin, 'https://diag-b.sliccy.ai');
  } catch (error) {
    row(lines.length + 1, {
      harnessError: error.message,
      events: runs.flatMap((run) =>
        run.events.filter((event) =>
          ['Network.loadingFailed', 'Log.entryAdded', 'Audits.issueAdded'].includes(event.method)
        )
      ),
    });
    throw error;
  } finally {
    await mkdir('artifacts', { recursive: true });
    await writeFile(
      'artifacts/scope-rows.json',
      JSON.stringify({ lines, observations, seen }, null, 2)
    );
    await Promise.allSettled(runs.map((run) => run.close()));
    await copy?.remove();
    await Promise.allSettled(servers.map((server) => server.close()));
    await rm(scratch, { recursive: true, force: true });
  }
});
