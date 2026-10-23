import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const slicc = 'https://seven.sliccy.ai/';
const ordinary = 'https://other.test';
const destinations = {
  control: 'https://ordinary.test',
  seven: 'https://seven.sliccy.ai',
  vault: 'https://vault.sliccy.ai',
};
const challenged = { seven: destinations.control, 'six-bridge': 'https://challenged.test' };
const twoPixels =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAAAAADRSSBWAAAAC0lEQVR4nGNgYAAAAAMAAbitOmMAAAAASUVORK5CYII=';

const bounded = (expression) =>
  `Promise.race([${expression}, new Promise((resolve) => setTimeout(() => resolve('timeout'), 10000))])`;

const probes = {
  fetch: (url) => `fetch(${JSON.stringify(url)}).then((r) => r.text(), () => 'error')`,
  xhr: (url) =>
    `new Promise((resolve) => { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(url)}); x.onload = () => resolve(x.responseText); x.onerror = () => resolve('error'); x.send(); })`,
  image: (url) =>
    `new Promise((resolve) => { const i = new Image(); i.onload = () => resolve('width ' + i.naturalWidth); i.onerror = () => resolve('error'); i.src = ${JSON.stringify(url)}; })`,
};

const extId = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';
const leader = 'https://www.sliccy.ai/?slicc=leader';
const transports = ['seven', 'six-bridge'];

async function client(t, transport) {
  const page = await chrome.visit(t, transport === 'six-bridge' ? leader : slicc);
  await page.evaluate(install, transport, extId);
  return page;
}

function subresource(page, kind, dest, tag) {
  const path = kind === 'image' ? 'img' : 'data';
  const url = `${dest}/${path}?n=${tag}`;
  return page.evaluate(
    async ({ ordinary, url, probe, kind, twoPixels }) => {
      const { targetId, sessionId } = await h.open(`${ordinary}/start`);
      const seen = [];
      const off = h.cdp.on((e) => {
        if (e.method !== 'Fetch.requestPaused' || e.sessionId !== sessionId) return;
        const id = e.params.requestId;
        const atResponse = e.params.responseStatusCode !== undefined;
        if (e.params.request.url === url) seen.push(atResponse ? 'response' : 'request');
        if (e.params.request.url === url && !atResponse) {
          const body = kind === 'image' ? twoPixels : btoa('fulfilled');
          h.attempt(
            'Fetch.fulfillRequest',
            {
              requestId: id,
              responseCode: 200,
              responseHeaders: [
                { name: 'content-type', value: kind === 'image' ? 'image/png' : 'text/plain' },
                { name: 'access-control-allow-origin', value: '*' },
              ],
              body,
            },
            sessionId
          );
          return;
        }
        h.attempt('Fetch.continueRequest', { requestId: id }, sessionId);
      });
      await h.cdp.send(
        'Fetch.enable',
        {
          patterns: [
            { urlPattern: '*', requestStage: 'Request' },
            { urlPattern: '*', requestStage: 'Response' },
          ],
        },
        sessionId
      );
      const body = await h.evaluate(sessionId, probe);
      off();
      const alive = await h.evaluate(sessionId, '1 + 1');
      const detached = h.detached(sessionId);
      await h.close(targetId);
      return { seen: seen.length > 0, body, alive, detached };
    },
    { ordinary, url, probe: bounded(probes[kind](url)), kind, twoPixels }
  );
}

for (const transport of transports) {
  for (const kind of ['fetch', 'xhr', 'image']) {
    test(`${transport} C5.${kind}: a page's Fetch pauses and fulfils an ordinary ${kind}, never a protected one`, async (t) => {
      const page = await client(t, transport);
      const fulfilled = kind === 'image' ? 'width 2' : 'fulfilled';
      const real = (tag) => (kind === 'image' ? 'width 1' : `real-${tag}`);
      const control = await subresource(page, kind, destinations.control, `c-${kind}`);
      assert.deepEqual(
        control,
        { seen: true, body: fulfilled, alive: 2, detached: false },
        'control'
      );
      for (const name of ['seven', 'vault']) {
        const tag = `${name}-${kind}`;
        const guarded = await subresource(page, kind, destinations[name], tag);
        assert.deepEqual(
          guarded,
          { seen: false, body: real(tag), alive: 2, detached: false },
          `${name}: never seen, real body, session alive`
        );
      }
    });
  }
}

function auth(page, dest, tag) {
  const url = `${dest}/auth?n=${tag}`;
  return page.evaluate(
    async ({ ordinary, url }) => {
      const probe = (u) =>
        `Promise.race([fetch(${JSON.stringify(u)}, { credentials: 'include' }).then(async (r) => r.status + ' ' + (await r.text()), () => 'error'), new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))])`;
      const plainTab = await h.open(`${ordinary}/start`);
      const plain = await h.evaluate(plainTab.sessionId, probe(`${url}&plain=1`));
      await h.close(plainTab.targetId);
      const { targetId, sessionId } = await h.open(`${ordinary}/start`);
      const seen = [];
      const off = h.cdp.on((e) => {
        if (e.sessionId !== sessionId) return;
        const id = e.params?.requestId;
        if (e.method === 'Fetch.requestPaused') {
          if (e.params.request.url === url) seen.push('paused');
          h.attempt('Fetch.continueRequest', { requestId: id }, sessionId);
        } else if (e.method === 'Fetch.authRequired') {
          const mine = e.params.request.url === url;
          if (mine) seen.push('auth');
          const authChallengeResponse = mine
            ? { response: 'ProvideCredentials', username: 'u', password: 'p' }
            : { response: 'Default' };
          h.attempt('Fetch.continueWithAuth', { requestId: id, authChallengeResponse }, sessionId);
        }
      });
      await h.cdp.send(
        'Fetch.enable',
        { patterns: [{ urlPattern: '*' }], handleAuthRequests: true },
        sessionId
      );
      const body = await h.evaluate(sessionId, probe(url));
      off();
      const alive = await h.evaluate(sessionId, '1 + 1');
      const detached = h.detached(sessionId);
      await h.close(targetId);
      return {
        alive,
        detached,
        seen: seen.includes('auth'),
        pausedSeen: seen.includes('paused'),
        authed: body === '200 authed',
        untouched: body === plain,
      };
    },
    { ordinary, url }
  );
}

for (const transport of transports) {
  test(`${transport} C5.auth: authRequired reaches the client for an ordinary origin, never for a protected one`, async (t) => {
    const page = await client(t, transport);
    assert.deepEqual(
      await auth(page, challenged[transport], 'c-auth'),
      { alive: 2, detached: false, seen: true, pausedSeen: true, authed: true, untouched: false },
      'control'
    );
    for (const name of ['seven', 'vault']) {
      assert.deepEqual(
        await auth(page, destinations[name], `${name}-auth`),
        {
          alive: 2,
          detached: false,
          seen: false,
          pausedSeen: false,
          authed: false,
          untouched: true,
        },
        name
      );
    }
  });
}

function guessed(page, dest, tag) {
  return page.evaluate(
    async ({ ordinary, dest, tag, probes }) => {
      const run = (url) => `fetch(${JSON.stringify(url)}).then((r) => r.text(), () => 'error')`;
      const url = `${dest}/data?n=${tag}`;
      const { targetId, sessionId } = await h.open(`${ordinary}/start`);
      const ids = new Map();
      const off = h.cdp.on((e) => {
        if (e.method !== 'Fetch.requestPaused' || e.sessionId !== sessionId) return;
        ids.set(e.params.request.url, e.params.requestId);
        if (e.params.request.url !== url) {
          h.attempt('Fetch.continueRequest', { requestId: e.params.requestId }, sessionId);
        }
      });
      await h.cdp.send(
        'Fetch.enable',
        { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
        sessionId
      );
      const first = `${ordinary}/data?n=a-${tag}`;
      const last = `${ordinary}/data?n=b-${tag}`;
      await h.evaluate(sessionId, run(first));
      await h.evaluate(sessionId, `window.__probe = ${run(url)}; true`);
      await h.sleep(300);
      await h.evaluate(sessionId, run(last));
      const num = (id) => Number(/(\d+)\.\d+$/.exec(id ?? '')?.[1]);
      const [lo, hi] = [num(ids.get(first)), num(ids.get(last))];
      const prefix = (ids.get(first) ?? '').replace(/\d+\.\d+$/, '');
      const attempts = [];
      for (let n = lo + 1; n < hi; n += 1) {
        attempts.push(
          await h.attempt(
            'Fetch.fulfillRequest',
            {
              requestId: `${prefix}${n}.0`,
              responseCode: 200,
              responseHeaders: [
                { name: 'content-type', value: 'text/plain' },
                { name: 'access-control-allow-origin', value: '*' },
              ],
              body: btoa('guessed'),
            },
            sessionId
          )
        );
      }
      const body = await h.evaluate(sessionId, 'window.__probe');
      off();
      const alive = await h.evaluate(sessionId, '1 + 1');
      const detached = h.detached(sessionId);
      await h.close(targetId);
      return {
        alive,
        detached,
        candidates: attempts.length > 0,
        fulfilled: body === 'guessed',
        refused:
          attempts.length > 0 &&
          attempts.every(
            (a) => typeof a.error === 'string' && a.error.startsWith('slicc: refused: ')
          ),
        answered: body === `real-${tag}`,
      };
    },
    { ordinary, dest, tag, probes: null }
  );
}

for (const transport of transports) {
  test(`${transport} C5.guessed-id: a client can only answer request ids it was given`, async (t) => {
    const page = await client(t, transport);
    assert.deepEqual(
      await guessed(page, destinations.control, 'c-guess'),
      {
        alive: 2,
        detached: false,
        candidates: true,
        fulfilled: true,
        refused: false,
        answered: false,
      },
      'control'
    );
    for (const name of ['seven', 'vault']) {
      assert.deepEqual(
        await guessed(page, destinations[name], `${name}-guess`),
        {
          alive: 2,
          detached: false,
          candidates: true,
          fulfilled: false,
          refused: true,
          answered: true,
        },
        name
      );
    }
  });
}
