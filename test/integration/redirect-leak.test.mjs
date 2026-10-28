import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';
import { waitErrorFrame } from './frame-observer.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const transports = ['seven', 'six-bridge'];
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const callbacks = {
  seven: 'https://seven.sliccy.ai/auth/callback',
  vault: 'https://vault.sliccy.ai/oauth/mcp-callback',
  ordinary: 'https://ordinary.test/landing',
};
const REFUSED = 'slicc: refused';
let serial = 0;

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

function unique(prefix) {
  return `${prefix}${++serial}${Date.now()}`.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mark(n) {
  return `S3CR3T${[...n].reverse().join('')}`;
}

const forms = ['fragment', 'query', 'path'];

function target(to, n, form = 'query') {
  if (form === 'fragment')
    return `${callbacks[to]}?nonce=n#access_token=${mark(n)}&token_type=bearer`;
  if (form === 'query') return `${callbacks[to]}?code=${mark(n)}&state=${mark(n)}`;
  return `${callbacks[to]}/${mark(n)}`;
}

function encodings(secret) {
  return [secret, encodeURIComponent(secret), btoa(secret), btoa(secret).replace(/=+$/, '')];
}

function paths(value, needles, at = '', out = []) {
  if (typeof value === 'string') {
    if (needles.some((needle) => value.includes(needle))) out.push(at || '.');
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      paths(item, needles, `${at}[${index}]`, out);
    });
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) paths(item, needles, `${at}.${key}`, out);
  }
  return out;
}

function leaks(run, n, only) {
  const needles = encodings(mark(n));
  const out = [];
  for (const event of run.events)
    for (const at of paths(event, needles)) out.push(`${event.method}${at}`);
  for (const reply of run.replies) {
    if (only && !only.includes(reply.method)) continue;
    for (const at of paths(reply.answer, needles)) out.push(`${reply.method} reply${at}`);
  }
  return [...new Set(out)];
}

function errors(run) {
  return run.replies
    .filter((r) => r.answer?.error)
    .map((r) => `${r.method}: ${r.answer.error.slice(0, 120)}`)
    .join(' | ');
}

function reply(run, method) {
  return run.replies.find((r) => r.method === method)?.answer;
}

function replies(run, method) {
  return run.replies.filter((r) => r.method === method).map((r) => r.answer);
}

function refused(answer) {
  return typeof answer?.error === 'string' && answer.error.startsWith(REFUSED);
}

async function inPage(page, body, args) {
  return page.evaluate(
    async ({ body, args }) => {
      const replies = [];
      const record = async (method, params, sessionId) => {
        const answer = await Promise.race([
          h.attempt(method, params, sessionId),
          h.sleep(5000).then(() => ({ error: 'test: no answer in 5 s' })),
        ]);
        replies.push({ method, answer });
        return answer;
      };
      const start = h.events.length;
      const run = new Function(
        'h',
        'record',
        'args',
        'replies',
        `return (async () => { ${body} })();`
      );
      const out = await run(h, record, args, replies);
      await h.sleep(500);
      return { ...out, events: h.events.slice(start), replies };
    },
    { body, args }
  );
}

const PROBE = `
  const tree = await record('Page.getFrameTree', {}, s);
  await record('Page.getResourceTree', {}, s);
  await record('Page.getNavigationHistory', {}, s);
  const frameId = tree.result?.frameTree?.frame?.id;
  const current = tree.result?.frameTree?.frame?.url ?? 'chrome-error://chromewebdata/';
  await record('Page.getResourceContent', { frameId, url: current }, s);
  await record('Page.captureSnapshot', {}, s);
  for (const expression of [
    'location.href',
    'document.URL',
    'document.documentElement.outerHTML',
    'JSON.stringify(globalThis.loadTimeData?.data_ ?? null)',
    'performance.getEntries().map((e) => e.name).join(" ")',
    'console.log(document.documentElement.outerHTML, JSON.stringify(globalThis.loadTimeData?.data_ ?? null)); 1',
    'setTimeout(() => { throw new Error(JSON.stringify(globalThis.loadTimeData?.data_ ?? null)); }, 0); 1',
  ]) {
    await record('Runtime.evaluate', { expression, returnByValue: true }, s);
  }
  await record('Runtime.evaluate', { expression: 'location.hash = "moved"; 1', returnByValue: true }, s);
`;

async function hop(page, n, to, how, read, form) {
  const run = await inPage(
    page,
    `
    const { targetId, sessionId: s } = await h.open('https://ordinary.test/doc?n=start-' + args.n);
    const initial = await h.attempt('Page.getFrameTree', {}, s);
    await record('Runtime.enable', {}, s);
    await record('Network.enable', {}, s);
    await record('Fetch.enable', { patterns: [{ urlPattern: '*/hop?*', requestStage: 'Response' }] }, s);
    const from = h.events.length;
    const url = 'https://ordinary.test/hop?n=' + args.n + '&to=' + args.to + '&how=' + args.how + '&form=' + args.form;
    const going = h.attempt('Page.navigate', { url }, s);
    const paused = await h.until(() => h.events.slice(from).find((e) => e.method === 'Fetch.requestPaused' && e.sessionId === s));
    if (paused) {
      const requestId = paused.params.requestId;
      const taken = await record(args.read, { requestId }, s);
      const handle = taken.result?.stream;
      if (handle) {
        let body = '';
        for (let i = 0; i < 50; i++) {
          const chunk = await h.attempt('IO.read', { handle }, s);
          if (!chunk.result) break;
          body += chunk.result.base64Encoded ? atob(chunk.result.data) : chunk.result.data;
          if (chunk.result.eof) break;
        }
        await h.attempt('IO.close', { handle }, s);
        await record('Fetch.fulfillRequest', { requestId, responseCode: paused.params.responseStatusCode, responseHeaders: paused.params.responseHeaders, body: btoa(body) }, s);
      } else {
        await record('Fetch.continueRequest', { requestId }, s);
      }
    }
    replies.push({ method: 'Page.navigate', answer: await going });
    await h.until(async () => {
      const href = await h.evaluate(s, 'document.readyState === "complete" ? location.href : ""');
      if (/^slicc: refused:/.test(href?.error ?? '')) return true;
      return typeof href === 'string' && href !== '' && !href.startsWith('https://ordinary.test/doc') && (args.how !== 'refresh' || !href.includes('/hop?')) ? href : undefined;
    });
    await h.sleep(600);
    const href = await h.evaluate(s, 'location.href');
    const sent = h.events.slice(from).find((e) => e.method === 'Network.requestWillBeSent' && e.sessionId === s && e.params.request?.url === url);
    const networkId = paused?.params.networkId ?? sent?.params.requestId;
    await record('Network.getResponseBody', { requestId: networkId }, s);
    ${PROBE}
    await record('Target.attachToTarget', { targetId, flatten: true });
    await h.sleep(300);
    await record('Target.getTargetInfo', { targetId });
    return { paused: Boolean(paused), href, targetId, raw: initial.result?.frameTree?.frame?.id };
  `,
    { n, to, how, read, form }
  );
  try {
    if (to !== 'ordinary' && how !== 'link') await waitErrorFrame(chrome, run.raw, callbacks[to]);
    return run;
  } finally {
    await page.evaluate((targetId) => h.close(targetId), run.targetId);
  }
}

async function loadNetwork(page, n, to, form) {
  return inPage(
    page,
    `
    const { targetId, sessionId: s } = await h.open('https://ordinary.test/doc?n=start-' + args.n);
    const tree = await record('Page.getFrameTree', {}, s);
    const frameId = tree.result?.frameTree?.frame?.id;
    const url = 'https://ordinary.test/redirect?to=' + encodeURIComponent(args.to);
    const loaded = await record('Network.loadNetworkResource', { frameId, url, options: { disableCache: true, includeCredentials: true } }, s);
    const handle = loaded.result?.resource?.stream;
    let text = '';
    if (handle) {
      for (let i = 0; i < 50; i++) {
        const chunk = await record('IO.read', { handle }, s);
        if (!chunk.result) break;
        text += chunk.result.base64Encoded ? atob(chunk.result.data) : chunk.result.data;
        if (chunk.result.eof) break;
      }
      await record('IO.close', { handle }, s);
    }
    await h.close(targetId);
    return { text };
  `,
    { n, to: target(to, n, form) }
  );
}

async function replay(page, n, to) {
  return inPage(
    page,
    `
    const { targetId, sessionId: s } = await h.open('https://ordinary.test/doc?n=start-' + args.n);
    await record('Runtime.enable', {}, s);
    await record('Network.enable', {}, s);
    const from = h.events.length;
    const url = 'https://ordinary.test/hop?n=' + args.n + '&to=' + args.to + '&how=location';
    await h.evaluate(s, 'new Promise((done) => { const x = new XMLHttpRequest(); x.open("GET", ' + JSON.stringify(url) + '); x.onloadend = () => done(1); x.send(); })');
    await h.sleep(500);
    const sent = h.events.slice(from).find((e) => e.method === 'Network.requestWillBeSent' && e.sessionId === s && e.params.type === 'XHR');
    const requestId = sent?.params.requestId;
    await record('Network.replayXHR', { requestId }, s);
    await h.sleep(800);
    await record('Network.getResponseBody', { requestId }, s);
    await h.close(targetId);
    return { requestId };
  `,
    { n, to }
  );
}

async function override(page, n, to, stage) {
  return inPage(
    page,
    `
    const { targetId, sessionId: s } = await h.open('https://ordinary.test/doc?n=start-' + args.n);
    await record('Runtime.enable', {}, s);
    await record('Fetch.enable', { patterns: [{ urlPattern: '*/data?*', requestStage: args.stage }] }, s);
    const from = h.events.length;
    const fetched = h.evaluate(s, 'fetch("https://ordinary.test/data?n=' + args.n + '").then((r) => r.url + " " + r.status, (e) => String(e))');
    const paused = await h.until(() => h.events.slice(from).find((e) => e.method === 'Fetch.requestPaused' && e.sessionId === s));
    const requestId = paused?.params.requestId;
    const answer = args.stage === 'Request'
      ? await record('Fetch.continueRequest', { requestId, url: args.to }, s)
      : await record('Fetch.continueResponse', { requestId, responseCode: 302, responseHeaders: [{ name: 'Location', value: args.to }] }, s);
    if (answer.error) await record('Fetch.continueRequest', { requestId }, s);
    const outcome = await fetched;
    await h.close(targetId);
    return { outcome };
  `,
    {
      n,
      to: to === 'unreachable' ? `https://unreachable.invalid/data?n=${n}` : target(to, n),
      stage,
    }
  );
}

function onlyOrigins(value, origin) {
  const urls = [];
  const walk = (item) => {
    if (typeof item === 'string') {
      for (const m of item.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]*/gi)) {
        if (m[0].includes(new URL(origin).host)) urls.push(m[0].replace(/[;,)]+$/, ''));
      }
    } else if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === 'object') Object.values(item).forEach(walk);
  };
  walk(value);
  return urls.filter((url) => url !== origin && url !== `${origin}/`);
}

function fragments(value, n, at = '', out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      fragments(item, n, `${at}[${index}]`, out);
    });
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'urlFragment' && paths(item, encodings(mark(n))).length > 0) out.push(at);
      else fragments(item, n, `${at}.${key}`, out);
    }
  }
  return out;
}

function frames(tree, out = []) {
  if (tree?.frame) out.push(tree.frame);
  for (const child of tree?.childFrames ?? []) frames(child, out);
  return out;
}

for (const transport of transports) {
  for (const how of ['location', 'link', 'refresh']) {
    for (const form of forms) {
      const read = form === 'query' ? 'Fetch.takeResponseBodyAsStream' : 'Fetch.getResponseBody';
      for (const to of ['seven', 'vault']) {
        test(`${transport}: an ordinary response whose ${how} names ${to}'s callback with the token in its ${form} reaches the client as the origin only, ${read} refused`, async (t) => {
          const page = await client(t, transport);
          const n = unique(`${transport}${how}${to}${form}`);
          const run = await hop(page, n, to, how, read, form);
          t.diagnostic(`ERRORS ${errors(run)}`);
          const found = leaks(run, n);
          const origin = new URL(callbacks[to]).origin;
          t.diagnostic(`LEAK ${transport} ${how} ${to} ${form}: ${found.join(' ') || 'none'}`);
          assert.equal(run.paused, true, 'the response paused toward the client');
          assert.deepEqual(found, [], `the token leaks through ${found.join(' ')}`);
          const beyond = onlyOrigins([run.events, run.replies], origin);
          assert.deepEqual(beyond, [], `more than the origin reaches the client: ${beyond}`);
          assert.ok(refused(reply(run, read)), `${read}: ${JSON.stringify(reply(run, read))}`);
          const body = reply(run, 'Network.getResponseBody');
          assert.ok(
            refused(body),
            `Network.getResponseBody: ${JSON.stringify(body)?.slice(0, 300)}`
          );
          const paused = run.events.find((e) => e.method === 'Fetch.requestPaused');
          const named = (paused?.params.responseHeaders ?? []).filter((x) =>
            ['location', 'link', 'refresh'].includes(x.name.toLowerCase())
          );
          assert.equal(named.length, 1, JSON.stringify(paused?.params.responseHeaders));
          assert.ok(
            named[0].value.includes(origin),
            `the header keeps the origin: ${named[0].value}`
          );
          const separate = fragments([run.events, run.replies], n);
          assert.deepEqual(separate, [], `a urlFragment carries the token: ${separate}`);
          if (how !== 'link') {
            const again = reply(run, 'Target.attachToTarget')?.result?.sessionId;
            const attached = run.events.filter(
              (e) => e.method === 'Target.attachedToTarget' && e.params.sessionId === again
            );
            const fresh = attached.at(-1)?.params.targetInfo;
            assert.deepEqual([fresh?.url, fresh?.title], [origin, origin], JSON.stringify(fresh));
            const info = reply(run, 'Target.getTargetInfo')?.result?.targetInfo;
            assert.deepEqual([info?.url, info?.title], [origin, origin], JSON.stringify(info));
            const tree = reply(run, 'Page.getFrameTree');
            assert.equal(tree?.error, undefined, 'frame metadata answers');
            assert.equal(tree?.result?.frameTree?.frame?.url, 'chrome-error://chromewebdata/');
            assert.equal(tree?.result?.frameTree?.frame?.unreachableUrl, origin);
          }
        });
      }
      test(`${transport} control: an ordinary response whose ${how} names an ordinary callback with the token in its ${form} keeps its full url, ${read} answers`, async (t) => {
        const page = await client(t, transport);
        const n = unique(`${transport}${how}ordinary${form}`);
        const run = await hop(page, n, 'ordinary', how, read, form);
        t.diagnostic(`ERRORS ${errors(run)}`);
        assert.equal(run.paused, true);
        const paused = run.events.find((e) => e.method === 'Fetch.requestPaused');
        const named = (paused?.params.responseHeaders ?? []).find((x) =>
          ['location', 'link', 'refresh'].includes(x.name.toLowerCase())
        );
        assert.ok(named?.value.includes(target('ordinary', n, form)), JSON.stringify(named));
        assert.ok(!refused(reply(run, read)), JSON.stringify(reply(run, read)));
        if (how === 'link') {
          const body = reply(run, 'Network.getResponseBody');
          assert.ok(body?.result?.body?.includes(mark(n)), JSON.stringify(body)?.slice(0, 300));
        }
        if (how !== 'link') {
          const history = reply(run, 'Page.getNavigationHistory')?.result?.entries ?? [];
          assert.ok(
            history.some((e) => e.url === target('ordinary', n, form)),
            JSON.stringify(history)
          );
        }
      });
    }
  }

  for (const how of ['scheme', 'backslash', 'tab']) {
    for (const form of ['fragment', 'query']) {
      for (const to of how === 'tab' ? ['vault'] : ['seven', 'vault']) {
        test(`${transport}: a ${how}-relative Location naming ${to}'s callback with the token in its ${form} reaches the client as the origin only, its body refused`, async (t) => {
          const page = await client(t, transport);
          const n = unique(`${transport}${how}${to}${form}`);
          const run = await hop(page, n, to, how, 'Fetch.getResponseBody', form);
          const found = leaks(run, n);
          const origin = new URL(callbacks[to]).origin;
          t.diagnostic(`LEAK ${transport} ${how} ${to} ${form}: ${found.join(' ') || 'none'}`);
          assert.equal(run.paused, true, 'the response paused toward the client');
          assert.deepEqual(found, [], `the token leaks through ${found.join(' ')}`);
          const beyond = onlyOrigins([run.events, run.replies], origin);
          assert.deepEqual(beyond, [], `more than the origin reaches the client: ${beyond}`);
          const separate = fragments([run.events, run.replies], n);
          assert.deepEqual(separate, [], `a urlFragment carries the token: ${separate}`);
          const read = reply(run, 'Fetch.getResponseBody');
          assert.ok(refused(read), `Fetch.getResponseBody: ${JSON.stringify(read)}`);
          const body = reply(run, 'Network.getResponseBody');
          assert.ok(
            refused(body),
            `Network.getResponseBody: ${JSON.stringify(body)?.slice(0, 300)}`
          );
          const paused = run.events.find((e) => e.method === 'Fetch.requestPaused');
          const location = (paused?.params.responseHeaders ?? []).find(
            (x) => x.name.toLowerCase() === 'location'
          );
          assert.equal(location?.value, origin, JSON.stringify(location));
        });
      }
    }
  }

  for (const how of ['scheme', 'backslash', 'path']) {
    for (const form of ['fragment', 'query']) {
      test(`${transport} control: a ${how}-relative Location naming an ordinary callback with the token in its ${form} keeps its value`, async (t) => {
        const page = await client(t, transport);
        const n = unique(`${transport}${how}ordinary${form}`);
        const run = await hop(page, n, 'ordinary', how, 'Fetch.getResponseBody', form);
        const url = target('ordinary', n, form);
        const raw = {
          scheme: url.replace(/^https:/, ''),
          backslash: `/\\${url.slice('https://'.length)}`,
          path: url.slice(new URL(url).origin.length),
        }[how];
        assert.equal(run.paused, true);
        const paused = run.events.find((e) => e.method === 'Fetch.requestPaused');
        const location = (paused?.params.responseHeaders ?? []).find(
          (x) => x.name.toLowerCase() === 'location'
        );
        assert.equal(location?.value, raw, JSON.stringify(location));
        assert.ok(
          !refused(reply(run, 'Fetch.getResponseBody')),
          JSON.stringify(reply(run, 'Fetch.getResponseBody'))
        );
        const history = reply(run, 'Page.getNavigationHistory')?.result?.entries ?? [];
        assert.ok(
          history.some((e) => e.url === url),
          JSON.stringify(history)
        );
      });
    }
  }

  for (const to of ['seven', 'vault']) {
    for (const form of forms) {
      test(`${transport}: Network.loadNetworkResource through a redirect to ${to}'s callback with the token in its ${form} returns nothing beyond the origin`, async (t) => {
        const page = await client(t, transport);
        const n = unique(`${transport}load${to}${form}`);
        const run = await loadNetwork(page, n, to, form);
        const found = leaks(run, n);
        t.diagnostic(
          `LEAK ${transport} loadNetworkResource ${to} ${form}: ${found.join(' ') || 'none'}`
        );
        assert.deepEqual(found, [], `the token leaks through ${found.join(' ')}`);
        assert.ok(!run.text.includes('signed in'), `the protected body: ${run.text.slice(0, 200)}`);
        const answer = reply(run, 'Network.loadNetworkResource');
        assert.ok(refused(answer), JSON.stringify(answer));
      });
    }

    test(`${transport}: Network.replayXHR of an xhr that redirected to ${to}'s callback returns nothing beyond the origin`, async (t) => {
      const page = await client(t, transport);
      const n = unique(`${transport}replay${to}`);
      const run = await replay(page, n, to);
      const found = leaks(run, n);
      t.diagnostic(`LEAK ${transport} replayXHR ${to}: ${found.join(' ') || 'none'}`);
      assert.ok(run.requestId, 'the xhr was seen');
      assert.deepEqual(found, [], `the token leaks through ${found.join(' ')}`);
    });

    for (const stage of ['Request', 'Response']) {
      const method = stage === 'Request' ? 'Fetch.continueRequest' : 'Fetch.continueResponse';
      test(`${transport}: ${method} overriding the url to ${to}'s callback is refused`, async (t) => {
        const page = await client(t, transport);
        const n = unique(`${transport}override${stage}${to}`);
        const run = await override(page, n, to, stage);
        const answer = replies(run, method)[0];
        assert.ok(refused(answer), `${method}: ${JSON.stringify(answer)}`);
      });
    }
  }

  test(`${transport}: Network.loadNetworkResource of an ordinary url is refused too, since the guard cannot see where it redirects`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}loadordinary`);
    const run = await loadNetwork(page, n, 'ordinary', 'query');
    const answer = reply(run, 'Network.loadNetworkResource');
    assert.ok(refused(answer), JSON.stringify(answer));
  });

  test(`${transport} control: Network.replayXHR of an xhr that redirected to an ordinary callback replays`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}replayordinary`);
    const run = await replay(page, n, 'ordinary');
    assert.ok(!refused(reply(run, 'Network.replayXHR')), JSON.stringify(run.replies));
    assert.ok(leaks(run, n).length > 0);
  });

  test(`${transport}: a Fetch.continueRequest url override whose rewritten request fails at the network answers promptly`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}overridefail`);
    const run = await override(page, n, 'unreachable', 'Request');
    const answer = replies(run, 'Fetch.continueRequest')[0];
    assert.ok(answer && !answer.error, `Fetch.continueRequest: ${JSON.stringify(answer)}`);
  });

  for (const stage of ['Request', 'Response']) {
    const method = stage === 'Request' ? 'Fetch.continueRequest' : 'Fetch.continueResponse';
    test(`${transport} control: ${method} overriding the url to an ordinary callback answers`, async (t) => {
      const page = await client(t, transport);
      const n = unique(`${transport}overrideordinary${stage}`);
      const run = await override(page, n, 'ordinary', stage);
      const answer = replies(run, method)[0];
      assert.ok(answer && !answer.error, `${method}: ${JSON.stringify(answer)}`);
    });
  }
}
