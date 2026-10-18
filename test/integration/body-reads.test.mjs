import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

function held(page, reads) {
  return page.evaluate(async (list) => {
    const { attempt, open, evaluate, until, close, events } = globalThis.h;
    const { targetId, sessionId } = await open('https://other.test/');
    await attempt(
      'Fetch.enable',
      { patterns: [{ urlPattern: 'https://other.test/data*', requestStage: 'Response' }] },
      sessionId
    );
    const start = events.length;
    const tag = String(Math.random()).slice(2);
    await attempt(
      'Runtime.evaluate',
      {
        expression: `globalThis.body = fetch("/data?n=${tag}").then((r) => r.text(), () => "error"); 1`,
      },
      sessionId
    );
    const paused = await until(() =>
      events
        .slice(start)
        .find((e) => e.method === 'Fetch.requestPaused' && e.params.responseStatusCode)
    );
    const requestId = paused?.params.requestId;
    const answers = [];
    let handle;
    for (const method of list) {
      const out = await attempt(method, { requestId }, sessionId);
      answers.push(out.error ?? 'ok');
      handle ??= out.result?.stream;
    }
    let streamed = '';
    if (handle) {
      for (let i = 0; i < 20; i++) {
        const chunk = await attempt('IO.read', { handle }, sessionId);
        if (chunk.error) break;
        streamed += chunk.result.base64Encoded ? atob(chunk.result.data) : chunk.result.data;
        if (chunk.result.eof) break;
      }
      await attempt('IO.close', { handle }, sessionId);
    }
    const settled = handle
      ? await attempt('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, sessionId)
      : await attempt('Fetch.continueRequest', { requestId }, sessionId);
    const text = await evaluate(sessionId, 'globalThis.body');
    await close(targetId);
    return {
      paused: Boolean(requestId),
      answers,
      streamed,
      settled: settled.error ?? 'ok',
      text,
      expected: `real-${tag}`,
    };
  }, reads);
}

async function alive() {
  const { product } = await chrome.cdp.send('Browser.getVersion');
  return typeof product === 'string';
}

const refusal = /^slicc: refused: this paused response body was already read the other way$/;

for (const transport of ['seven', 'six-bridge']) {
  test(`${transport} getResponseBody then takeResponseBodyAsStream on one held request is refused and Chrome survives`, async (t) => {
    const page = await client(t, transport);
    const run = await held(page, ['Fetch.getResponseBody', 'Fetch.takeResponseBodyAsStream']);
    assert.ok(run.paused, 'the response is held');
    assert.equal(run.answers[0], 'ok', 'the first read works');
    assert.match(run.answers[1], refusal, 'the second read of the other kind is refused');
    assert.equal(run.settled, 'ok', 'the request still continues');
    assert.equal(run.text, run.expected, 'the page gets the real body');
    assert.ok(await alive(), 'Chrome survives');
  });

  test(`${transport} takeResponseBodyAsStream then getResponseBody on one held request is refused and Chrome survives`, async (t) => {
    const page = await client(t, transport);
    const run = await held(page, ['Fetch.takeResponseBodyAsStream', 'Fetch.getResponseBody']);
    assert.ok(run.paused, 'the response is held');
    assert.equal(run.answers[0], 'ok', 'the first read works');
    assert.match(run.answers[1], refusal, 'the second read of the other kind is refused');
    assert.equal(run.streamed, run.expected, 'the stream carries the body');
    assert.ok(await alive(), 'Chrome survives');
  });

  test(`${transport} control: a single body read of either kind works`, async (t) => {
    const page = await client(t, transport);
    const once = await held(page, ['Fetch.getResponseBody']);
    assert.deepEqual(once.answers, ['ok']);
    assert.equal(once.settled, 'ok');
    assert.equal(once.text, once.expected);
    const twice = await held(page, ['Fetch.getResponseBody', 'Fetch.getResponseBody']);
    assert.deepEqual(twice.answers, ['ok', 'ok'], 'the same kind twice is not refused');
    const stream = await held(page, ['Fetch.takeResponseBodyAsStream']);
    assert.deepEqual(stream.answers, ['ok']);
    assert.equal(stream.streamed, stream.expected);
    assert.ok(await alive());
  });
}
