import assert from 'node:assert/strict';
import { test } from 'node:test';
import { send, until, waitEvent } from './guard/guard.mjs';

function stall(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end);
}

function afterStall(ms, fn) {
  setTimeout(() => {
    stall(ms);
    setImmediate(() => setImmediate(fn));
  }, 20);
}

test('a guard harness send answered right after an event-loop stall longer than its bound resolves', async () => {
  const cdp = {
    send: (method, params, sessionId) =>
      new Promise((resolve) => afterStall(1500, () => resolve({ method, params, sessionId }))),
  };
  assert.deepEqual(await send(cdp, 'Page.enable', { a: 1 }, 'S', 300), {
    method: 'Page.enable',
    params: { a: 1 },
    sessionId: 'S',
  });
});

test('the guard client readiness wait survives an event-loop stall longer than its bound', async () => {
  let ready = false;
  afterStall(1500, () => {
    ready = true;
  });
  assert.equal(await until(async () => ready && 'ready', 300, 'ready'), 'ready');
});

test('a guard client event wait survives an event-loop stall longer than its bound', async () => {
  const events = [];
  afterStall(1500, () => events.push({ method: 'Page.loadEventFired' }));
  const event = await waitEvent(events, (e) => e.method === 'Page.loadEventFired', 300);
  assert.equal(event.method, 'Page.loadEventFired');
});

test('without a stall the harness waits still give up at their bound', async () => {
  const never = { send: () => new Promise(() => {}) };
  await assert.rejects(
    send(never, 'Page.enable', {}, undefined, 100),
    /Page.enable: no answer in 100 ms/
  );
  await assert.rejects(
    until(async () => false, 100, 'x'),
    /guard client: x within 100 ms/
  );
  await assert.rejects(
    waitEvent([], () => true, 100),
    /waitEvent: no event in 100 ms/
  );
});
