import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';

const slicc = 'https://seven.sliccy.ai/';
const other = 'https://other.test/';
const remote = 'https://upstream.test';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

async function visit(t, href) {
  const page = await chrome.open(href);
  t.after(() => page.close());
  return page;
}

function requests(method, path) {
  return chrome.upstream.seen.filter((seen) => seen.method === method && seen.path === path);
}

test('the handshake shows the relay on sliccy.ai pages only', async (t) => {
  const page = await visit(t, slicc);
  assert.equal(await page.evaluate(() => typeof globalThis.sliccExtension?.fetch), 'function');
  assert.equal(await page.evaluate(() => Object.isFrozen(globalThis.sliccExtension)), true);
  const stranger = await visit(t, other);
  assert.equal(await stranger.evaluate(() => 'sliccExtension' in globalThis), false);
});

test('plain fetch reads a CORS-less upstream with its headers exposed', async (t) => {
  const page = await visit(t, slicc);
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return {
      status: response.status,
      text: await response.text(),
      header: response.headers.get('x-upstream'),
    };
  }, `${remote}/hello`);
  assert.deepEqual(result, { status: 200, text: 'hello from upstream', header: 'exposed' });

  const stranger = await visit(t, other);
  const blocked = await stranger.evaluate(async (url) => {
    try {
      await fetch(url);
      return 'reached';
    } catch (error) {
      return error.name;
    }
  }, `${remote}/hello`);
  assert.equal(blocked, 'TypeError');
});

test('plain fetch passes preflights the upstream answers with 2xx', async (t) => {
  const page = await visit(t, slicc);
  const echo = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-custom': 'yes', authorization: 'Bearer t' },
      body: '{"a":1}',
      credentials: 'omit',
      mode: 'cors',
    });
    return response.json();
  }, `${remote}/preflighted`);
  assert.equal(echo.method, 'PUT');
  assert.equal(echo.headers['x-custom'], 'yes');
  assert.equal(echo.headers.authorization, 'Bearer t');
  assert.equal(atob(echo.body), '{"a":1}');
  assert.equal(requests('OPTIONS', '/preflighted').length, 1);
});

test('the relay gets through preflights the upstream rejects', async (t) => {
  const page = await visit(t, slicc);
  const url = `${remote}/strict/git-upload-pack`;
  const plain = await page.evaluate(async (url) => {
    try {
      await fetch(url, { method: 'POST', headers: { 'git-protocol': 'version=2' }, body: 'x' });
      return 'reached';
    } catch (error) {
      return error.name;
    }
  }, url);
  assert.equal(plain, 'TypeError');
  assert.equal(
    requests('OPTIONS', '/strict/git-upload-pack')[0]?.headers.origin,
    slicc.slice(0, -1)
  );

  const echo = await page.evaluate(async (url) => {
    const body = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const response = await globalThis.sliccExtension.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-upload-pack-request',
        'git-protocol': 'version=2',
      },
      body,
    });
    return { status: response.status, ...(await response.json()) };
  }, url);
  assert.equal(echo.status, 200);
  assert.equal(echo.method, 'POST');
  assert.equal(echo.headers['git-protocol'], 'version=2');
  assert.equal(echo.headers['content-type'], 'application/x-git-upload-pack-request');
  assert.deepEqual([...Buffer.from(echo.body, 'base64')], [0, 1, 2, 253, 254, 255]);
  assert.equal(echo.headers.origin, undefined);
});

test('the relay sends the forbidden headers curl and git set, and never the cookie jar', async (t) => {
  const jar = await visit(t, `${remote}/jar`);
  assert.equal(await jar.evaluate(() => document.body.textContent), 'stored');

  const page = await visit(t, slicc);
  const echo = await page.evaluate(async (url) => {
    const headers = new Headers();
    headers.append('user-agent', 'git/2.47.0');
    headers.append('cookie', 'session=from-curl');
    headers.append('referer', 'https://example.com/');
    const response = await globalThis.sliccExtension.fetch(url, { headers });
    return response.json();
  }, `${remote}/forbidden`);
  assert.equal(echo.headers['user-agent'], 'git/2.47.0');
  assert.equal(echo.headers.cookie, 'session=from-curl');
  assert.equal(echo.headers.referer, 'https://example.com/');

  const bare = await page.evaluate(async (url) => {
    const response = await globalThis.sliccExtension.fetch(url);
    return response.json();
  }, `${remote}/bare`);
  assert.equal(bare.headers.cookie, undefined);
  assert.equal(bare.headers.origin, undefined);
  assert.match(bare.headers['user-agent'], /Chrome/);
});

test('the relay streams large binary bodies, empty bodies and errors', async (t) => {
  const page = await visit(t, slicc);
  const result = await page.evaluate(async (remote) => {
    const response = await globalThis.sliccExtension.fetch(`${remote}/bytes`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let mismatches = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== ((i * 31) & 0xff)) mismatches++;
    const empty = await globalThis.sliccExtension.fetch(`${remote}/empty`);
    let unsupported;
    try {
      await globalThis.sliccExtension.fetch('ftp://upstream.test/');
    } catch (error) {
      unsupported = `${error.name}: ${error.message}`;
    }
    return {
      length: bytes.length,
      mismatches,
      type: response.headers.get('content-type'),
      empty: [empty.status, empty.body],
      unsupported,
    };
  }, remote);
  assert.deepEqual(result, {
    length: 3 * 1024 * 1024,
    mismatches: 0,
    type: 'application/octet-stream',
    empty: [204, null],
    unsupported: 'TypeError: slicc-extension: cannot fetch ftp: URLs',
  });
});

test('the relay honours abort signals', async (t) => {
  const page = await visit(t, slicc);
  const result = await page.evaluate(async (url) => {
    const before = new AbortController();
    before.abort();
    const early = await globalThis.sliccExtension.fetch(url, { signal: before.signal }).then(
      () => 'resolved',
      (error) => error.name
    );
    const during = new AbortController();
    const response = await globalThis.sliccExtension.fetch(url, { signal: during.signal });
    const reader = response.body.getReader();
    await reader.read();
    during.abort();
    const late = await reader.read().then(
      () => 'read',
      (error) => error.name
    );
    return { early, late };
  }, `${remote}/bytes`);
  assert.deepEqual(result, { early: 'AbortError', late: 'AbortError' });
});

test('the relay reads the upstream only as fast as the page consumes it', async (t) => {
  const page = await visit(t, slicc);
  await page.evaluate(async (url) => {
    const response = await globalThis.sliccExtension.fetch(url);
    globalThis.slow = response.body.getReader();
    await globalThis.slow.read();
  }, `${remote}/stream`);
  const { progress } = chrome.upstream;
  let last = -1;
  for (let i = 0; i < 40 && progress.sent !== last; i++) {
    last = progress.sent;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(progress.done, false);
  assert.ok(progress.sent < 256 * 1024 * 1024, `upstream sent ${progress.sent} bytes`);
  await page.evaluate(() => globalThis.slow.cancel());
  for (let i = 0; i < 40 && !progress.closed; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(progress.closed, true);
  assert.equal(progress.done, false);
});

test('the relay keeps the content type a body brings', async (t) => {
  const page = await visit(t, slicc);
  const echo = await page.evaluate(async (url) => {
    const form = new FormData();
    form.append('field', 'value');
    const response = await globalThis.sliccExtension.fetch(url, { method: 'POST', body: form });
    const params = await globalThis.sliccExtension.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/x-mine' },
      body: new URLSearchParams({ a: '1' }),
    });
    return { form: await response.json(), params: await params.json() };
  }, `${remote}/form`);
  assert.match(echo.form.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(atob(echo.form.body), /name="field"\r\n\r\nvalue/);
  assert.equal(echo.params.headers['content-type'], 'text/x-mine');
  assert.equal(atob(echo.params.body), 'a=1');
});

test('the relay rejects a request aborted while its body is read', async (t) => {
  const page = await visit(t, slicc);
  const before = requests('POST', '/raced').length;
  const result = await page.evaluate(async (url) => {
    const controller = new AbortController();
    const pending = globalThis.sliccExtension.fetch(url, {
      method: 'POST',
      body: new Blob(['x'.repeat(1024 * 1024)]),
      signal: controller.signal,
    });
    controller.abort();
    return pending.then(
      () => 'resolved',
      (error) => error.name
    );
  }, `${remote}/raced`);
  assert.equal(result, 'AbortError');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(requests('POST', '/raced').length, before);
});
