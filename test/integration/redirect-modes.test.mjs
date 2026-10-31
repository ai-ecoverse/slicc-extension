import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { extId } from './extension-page.mjs';

const slicc = 'https://seven.sliccy.ai/';
const remote = 'https://upstream.test';
const next = 'https://next.test';
const statuses = [301, 302, 303, 307, 308];
let serial = 0;

async function prepare(paths) {
  const path = join(paths[0], 'background.js');
  const source = await readFile(path, 'utf8');
  await writeFile(
    path,
    source.replace('const watched = new Map();', 'const watched = (self.watched = new Map());')
  );
}

let chrome;
before(async () => {
  chrome = await launch({ pinned: true, prepare });
});
after(() => chrome?.close());

function unique(prefix) {
  return `/${prefix}-${++serial}`;
}

function hop(status, to, extra = {}) {
  const params = new URLSearchParams({ status, ...extra });
  for (const target of [to].flat()) {
    if (target !== undefined) params.append('to', target);
  }
  return `${remote}/hop?${params}`;
}

function relay(page, url, init) {
  return page.evaluate(
    async (url, init) => {
      try {
        const response = await globalThis.sliccExtension.fetch(url, init ?? undefined);
        return {
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          redirected: response.redirected,
          location: response.headers.get('location'),
          marker: response.headers.get('x-hop'),
          text: await response.text(),
        };
      } catch (error) {
        return { rejected: error.name };
      }
    },
    url,
    init
  );
}

function contacted(path) {
  return chrome.upstream.seen.filter((seen) => seen.path === path);
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function worker(expression) {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const target = targetInfos.find(
    (info) =>
      info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
  );
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const answer = await chrome.cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  await chrome.cdp.send('Target.detachFromTarget', { sessionId });
  assert.equal(answer.exceptionDetails, undefined, 'worker evaluation');
  return answer.result.value;
}

const leftovers = () =>
  worker(
    `chrome.declarativeNetRequest.getSessionRules().then((rules) => [rules.length, self.watched?.size])`
  );

test('follow stays the default and reports the final URL', async (t) => {
  const page = await chrome.visit(t, slicc);
  for (const init of [undefined, { redirect: 'follow' }]) {
    const landing = unique('landing');
    const answer = await relay(page, hop(302, `${next}${landing}`), init);
    assert.equal(answer.status, 200);
    assert.equal(answer.url, `${next}${landing}`);
    assert.equal(answer.redirected, true);
    assert.equal(JSON.parse(answer.text).path, landing);
    assert.equal(contacted(landing).length, 1);
  }
  const direct = await relay(page, `${remote}/hello#mine`);
  assert.equal(direct.url, `${remote}/hello`);
  assert.equal(direct.redirected, false);
  assert.equal(direct.text, 'hello from upstream');
});

test('error rejects any redirect and passes without one', async (t) => {
  const page = await chrome.visit(t, slicc);
  for (const status of statuses) {
    const landing = unique('error');
    const answer = await relay(page, hop(status, `${next}${landing}`), { redirect: 'error' });
    assert.deepEqual(answer, { rejected: 'TypeError' });
    await settle();
    assert.equal(contacted(landing).length, 0);
  }
  const direct = await relay(page, `${remote}/hello`, { redirect: 'error' });
  assert.equal(direct.status, 200);
  assert.equal(direct.url, `${remote}/hello`);
  assert.equal(direct.redirected, false);
  assert.equal(direct.text, 'hello from upstream');
});

test('manual stops at the 3xx with its location and never contacts the next hop', async (t) => {
  const page = await chrome.visit(t, slicc);
  const reasons = {
    301: 'Moved Permanently',
    302: 'Found',
    303: 'See Other',
    307: 'Temporary Redirect',
    308: 'Permanent Redirect',
  };
  for (const status of statuses) {
    for (const to of [`${next}${unique('manual')}`, `${remote}${unique('manual')}`]) {
      const url = hop(status, to);
      const answer = await relay(page, url, { redirect: 'manual' });
      assert.deepEqual(answer, {
        status,
        statusText: reasons[status],
        url,
        redirected: false,
        location: to,
        marker: 'seen',
        text: '',
      });
      await settle();
      assert.equal(contacted(new URL(to).pathname).length, 0, `${status} ${to}`);
    }
  }
});

test('manual reads a relative Location and one with its own fragment as sent', async (t) => {
  const page = await chrome.visit(t, slicc);
  const landing = unique('relative');
  for (const to of [`${landing}?a=1`, `${next}${landing}#mine`]) {
    const answer = await relay(page, hop(302, to), { redirect: 'manual' });
    assert.equal(answer.status, 302);
    assert.equal(answer.location, to);
  }
  await settle();
  assert.equal(contacted(landing).length, 0);
});

test('manual hands a Location over byte for byte, however it is encoded', async (t) => {
  const page = await chrome.visit(t, slicc);
  for (const to of [Buffer.from('/日本', 'utf8').toString('latin1'), '/\xe9']) {
    const answer = await relay(page, hop(302, to), { redirect: 'manual' });
    assert.equal(answer.status, 302);
    assert.equal(answer.location, to);
    const plain = await relay(page, hop(300, to), { redirect: 'manual' });
    assert.equal(plain.location, answer.location);
  }
});

test('manual hands over a 3xx without a Location, and never set-cookie', async (t) => {
  const page = await chrome.visit(t, slicc);
  const url = hop(301);
  const answer = await relay(page, url, { redirect: 'manual' });
  assert.deepEqual(answer, {
    status: 301,
    statusText: 'Moved Permanently',
    url,
    redirected: false,
    location: null,
    marker: 'seen',
    text: '',
  });
  const blank = await relay(page, hop(302, ''), { redirect: 'manual' });
  assert.equal(blank.status, 302);
  assert.equal(blank.location, '');

  const raw = await page.evaluate(async (url) => {
    const Real = globalThis.Response;
    const names = [];
    globalThis.Response = function (body, init) {
      names.push(...init.headers.map(([name]) => name));
      return new Real(body, init);
    };
    await globalThis.sliccExtension.fetch(url, { redirect: 'manual' });
    globalThis.Response = Real;
    return names;
  }, url);
  assert.ok(raw.includes('location') === false && raw.includes('x-hop'));
  assert.equal(raw.includes('set-cookie'), false);
});

test('manual passes responses that are not redirects through', async (t) => {
  const page = await chrome.visit(t, slicc);
  const url = hop(304);
  assert.deepEqual(await relay(page, url, { redirect: 'manual' }), {
    status: 304,
    statusText: 'Not Modified',
    url,
    redirected: false,
    location: null,
    marker: 'seen',
    text: '',
  });
  const choices = await relay(page, hop(300, `${next}/choice`), { redirect: 'manual' });
  assert.equal(choices.status, 300);
  assert.equal(choices.location, `${next}/choice`);
  assert.equal(choices.text, 'hop body');
  const direct = await relay(page, `${remote}/hello`, { redirect: 'manual' });
  assert.equal(direct.status, 200);
  assert.equal(direct.text, 'hello from upstream');
});

test('manual takes one hop with a request body', async (t) => {
  const page = await chrome.visit(t, slicc);
  const landing = unique('posted');
  const marker = unique('body');
  const url = hop(307, `${next}${landing}`, { marker });
  const answer = await relay(page, url, { redirect: 'manual', method: 'POST', body: 'payload' });
  assert.equal(answer.status, 307);
  assert.equal(answer.location, `${next}${landing}`);
  await settle();
  const sent = chrome.upstream.seen.filter((seen) =>
    seen.search.includes(encodeURIComponent(marker))
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(atob(sent[0].body), 'payload');
  assert.equal(contacted(landing).length, 0);
});

test('every mode sends the client headers and omits the cookie jar', async (t) => {
  const jar = await chrome.visit(t, `${remote}/jar`);
  assert.equal(await jar.evaluate(() => document.body.textContent), 'stored');
  const page = await chrome.visit(t, slicc);
  for (const redirect of ['follow', 'error', 'manual']) {
    const marker = unique(redirect);
    await relay(page, hop(302, `${next}${unique('jar')}`, { marker }), {
      redirect,
      headers: { 'user-agent': 'git/2.47.0' },
    });
    const [sent] = chrome.upstream.seen.filter((seen) =>
      seen.search.includes(encodeURIComponent(marker))
    );
    assert.equal(sent.headers['user-agent'], 'git/2.47.0');
    assert.equal(sent.headers.cookie, undefined);
  }
});

test('manual reads a 301 the cache answers', async (t) => {
  const page = await chrome.visit(t, slicc);
  const to = `${next}${unique('cached')}`;
  const marker = unique('cached');
  const url = hop(301, to, { cache: 'max-age=3600', marker });
  assert.equal((await relay(page, url)).status, 200);
  for (let i = 0; i < 2; i++) {
    const answer = await relay(page, url, { redirect: 'manual' });
    assert.equal(answer.status, 301);
    assert.equal(answer.location, to);
  }
  const sent = chrome.upstream.seen.filter((seen) =>
    seen.search.includes(encodeURIComponent(marker))
  );
  assert.equal(sent.length, 1);
});

test('an unknown mode rejects with nothing sent', async (t) => {
  const page = await chrome.visit(t, slicc);
  const landing = unique('unknown');
  for (const redirect of ['bogus', 'Manual', '', null, 1]) {
    const answer = await relay(page, `${remote}${landing}`, { redirect });
    assert.deepEqual(answer, { rejected: 'TypeError' });
  }
  await settle();
  assert.equal(contacted(landing).length, 0);
});

test('a redirect Chrome makes up is never observed, and rejects without hanging', async (t) => {
  const page = await chrome.visit(t, slicc);
  const landing = unique('hsts');
  const started = Date.now();
  const answer = await relay(page, `http://hsts.dev${landing}`, { redirect: 'manual' });
  assert.deepEqual(answer, { rejected: 'TypeError' });
  assert.ok(Date.now() - started < 8000);
  assert.equal(contacted(landing).length, 0);
  assert.deepEqual(await leftovers(), [0, 0]);
});

test('an ambiguous head rejects', async (t) => {
  const page = await chrome.visit(t, slicc);
  const to = `${next}${unique('twice')}`;
  assert.deepEqual(await relay(page, hop(302, [to, to]), { redirect: 'manual' }), {
    rejected: 'TypeError',
  });
  assert.deepEqual(await relay(page, hop(302, [to, `${to}-other`]), { redirect: 'manual' }), {
    rejected: 'TypeError',
  });
  assert.deepEqual(await leftovers(), [0, 0]);
});

test('concurrent manual fetches keep their own heads', async (t) => {
  const page = await chrome.visit(t, slicc);
  const targets = Array.from({ length: 6 }, () => `${next}${unique('together')}`);
  const answers = await Promise.all(
    targets.map((to, index) =>
      relay(page, hop(index % 2 ? 301 : 307, to, { delay: 300 - index * 50 }), {
        redirect: 'manual',
      })
    )
  );
  answers.forEach((answer, index) => {
    assert.equal(answer.status, index % 2 ? 301 : 307);
    assert.equal(answer.location, targets[index]);
  });
  const url = hop(302, `${next}/same`);
  const same = await Promise.all([1, 2].map(() => relay(page, url, { redirect: 'manual' })));
  assert.deepEqual(
    same.map((answer) => [answer.status, answer.location]),
    [
      [302, `${next}/same`],
      [302, `${next}/same`],
    ]
  );
  assert.deepEqual(await leftovers(), [0, 0]);
});

test('abort during the wait rejects and cleans up', async (t) => {
  const page = await chrome.visit(t, slicc);
  await page.evaluate(
    (url) => {
      globalThis.controller = new AbortController();
      globalThis.pending = globalThis.sliccExtension
        .fetch(url, { redirect: 'manual', signal: globalThis.controller.signal })
        .then(
          () => 'resolved',
          (error) => error.name
        );
    },
    `http://hsts.dev${unique('aborted')}`
  );
  await settle();
  assert.deepEqual(await leftovers(), [1, 1]);
  const started = Date.now();
  const answer = await page.evaluate(() => {
    globalThis.controller.abort();
    return globalThis.pending;
  });
  assert.equal(answer, 'AbortError');
  assert.ok(Date.now() - started < 2000);
  await settle();
  assert.deepEqual(await leftovers(), [0, 0]);
});

test('no rule and no capture entry outlives a request, in any mode', async (t) => {
  const page = await chrome.visit(t, slicc);
  for (const redirect of ['follow', 'error', 'manual']) {
    await relay(page, hop(302, `${next}${unique('gone')}`), { redirect });
    await relay(page, `${remote}/hello`, { redirect });
    assert.deepEqual(await leftovers(), [0, 0], redirect);
  }
});

test('a status the page cannot carry rejects and does not hang', async (t) => {
  const page = await chrome.visit(t, slicc);
  assert.deepEqual(await relay(page, `${remote}/hop?status=600`), { rejected: 'TypeError' });
});

const client = {
  cookie: 'session=from-client',
  origin: 'https://client.example',
  referer: 'https://client.example/page',
  'user-agent': 'git/2.47.0',
};

function sentTo(path) {
  const [sent, ...rest] = contacted(path);
  assert.ok(sent, `${path} was contacted`);
  assert.deepEqual(rest, []);
  return sent;
}

function assertClientValues(sent) {
  assert.equal(sent.headers.cookie, client.cookie);
  assert.equal(sent.headers.origin, client.origin);
  assert.equal(sent.headers.referer, client.referer);
  assert.equal(sent.headers['user-agent'], client['user-agent']);
}

function assertNoClientValues(sent) {
  assert.equal(sent.headers.cookie, undefined);
  assert.equal(sent.headers.referer, undefined);
  assert.notEqual(sent.headers.origin, client.origin);
  assert.match(sent.headers['user-agent'], /Chrome/);
  assert.doesNotMatch(JSON.stringify(sent.headers), /client|chrome-extension|slicc-/);
}

async function followed(t, first, to, init = {}) {
  const page = await chrome.visit(t, slicc);
  const answer = await relay(page, first(to), { headers: client, ...init });
  assert.equal(answer.status, 200);
  return sentTo(new URL(to).pathname);
}

test('a cross-origin hop gets none of the client values', async (t) => {
  const sent = await followed(t, (to) => hop(302, to), `${next}${unique('cross')}`);
  assert.equal(sent.headers.host, 'next.test');
  assertNoClientValues(sent);
  assert.equal(sent.headers.origin, undefined);
});

test('a cross-origin 307 keeps its body and gets none of the client values', async (t) => {
  const sent = await followed(t, (to) => hop(307, to), `${next}${unique('posted')}`, {
    method: 'POST',
    body: 'payload',
  });
  assert.equal(sent.method, 'POST');
  assert.equal(atob(sent.body), 'payload');
  assertNoClientValues(sent);
  assert.equal(sent.headers.origin, undefined);
});

test('the same host on another port is another origin', async (t) => {
  const sent = await followed(
    t,
    (to) => hop(302, to),
    `https://upstream.test:8443${unique('port')}`
  );
  assert.equal(sent.headers.host, 'upstream.test:8443');
  assertNoClientValues(sent);
  assert.equal(sent.headers.origin, undefined);
});

test('http to https on the same host is another origin', async (t) => {
  const sent = await followed(
    t,
    (to) => `http://upstream.test/hop?${new URLSearchParams({ status: 302, to })}`,
    `${remote}${unique('scheme')}`
  );
  assertNoClientValues(sent);
  assert.equal(sent.headers.origin, undefined);
});

test('a same-origin hop keeps the client values', async (t) => {
  const marker = unique('first');
  const sent = await followed(t, (to) => hop(302, to, { marker }), `${remote}${unique('same')}`);
  assertClientValues(sent);
  const [first] = chrome.upstream.seen.filter((seen) =>
    seen.search.includes(encodeURIComponent(marker))
  );
  assertClientValues(first);
});

test('a Location with its own fragment ends with no client values either', async (t) => {
  const page = await chrome.visit(t, slicc);
  const path = unique('fragment');
  const answer = await relay(page, hop(302, `${next}${path}#mine`), { headers: client });
  assert.equal(answer.status, 200);
  assert.equal(answer.url, `${next}${path}`);
  assertNoClientValues(sentTo(path));
});

test('a follow with no client headers sends no origin and no extension URL', async (t) => {
  const page = await chrome.visit(t, slicc);
  for (const to of [`${next}${unique('bare')}`, `${remote}${unique('bare')}`]) {
    const marker = unique('bare-first');
    const answer = await relay(page, hop(302, to, { marker }));
    assert.equal(answer.status, 200);
    const [first] = chrome.upstream.seen.filter((seen) =>
      seen.search.includes(encodeURIComponent(marker))
    );
    for (const sent of [first, sentTo(new URL(to).pathname)]) {
      assertNoClientValues(sent);
      assert.equal(sent.headers.origin, undefined);
    }
  }
});

test('no rule outlives a request that set client values', async (t) => {
  const page = await chrome.visit(t, slicc);
  await relay(page, hop(302, `${next}${unique('rules')}`), { headers: client });
  assert.deepEqual(await leftovers(), [0, 0]);
});
