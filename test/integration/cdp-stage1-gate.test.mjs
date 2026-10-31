import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

const ordinaryScript = {
  scriptId: 'ordinary-script',
  executionContextId: 1,
  url: 'https://ordinary.test/script.js',
};
const ordinaryPause = {
  reason: 'other',
  callFrames: [
    {
      callFrameId: '1.1.0',
      location: { scriptId: 'ordinary-script', lineNumber: 0 },
      url: 'https://ordinary.test/script.js',
    },
  ],
};

test('675 extension live reads require an ordinary published current-generation pause', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  await fixture.emit('Debugger.scriptParsed', ordinaryScript);
  assert.equal(
    fixture.messages.some((message) => message.method === 'Debugger.scriptParsed'),
    false
  );
  assert.match(
    (await fixture.command('Debugger.getScriptSource', { scriptId: 'ordinary-script' })).error,
    /slicc: refused:/
  );
  await fixture.emit('Debugger.paused', { reason: 'instrumentation', callFrames: [] });
  assert.equal(
    fixture.messages.some((message) => message.method === 'Debugger.paused'),
    false
  );
  assert.equal(fixture.calls.filter((call) => call.method === 'Debugger.pause').length, 1);
  await fixture.emit('Debugger.resumed', {});
  await fixture.emit('Debugger.paused', ordinaryPause);
  assert.equal(
    fixture.messages.filter((message) => message.method === 'Debugger.paused').length,
    1
  );
  const published = fixture.calls.length;
  for (const [method, params] of [
    ['Debugger.getScriptSource', { scriptId: 'ordinary-script' }],
    ['Debugger.evaluateOnCallFrame', { callFrameId: '1.1.0', expression: '40 + 2' }],
  ]) {
    assert.match((await fixture.command(method, params)).error ?? '', /slicc: refused:/);
    assert.equal(
      fixture.calls.slice(published).some((call) => call.method === method),
      false
    );
  }
  const before = fixture.calls.length;
  assert.match(
    (await fixture.command('Debugger.getScriptSource', { scriptId: 'unplaced-script' })).error,
    /slicc: refused:/
  );
  assert.equal(
    fixture.calls.slice(before).some((call) => call.method === 'Debugger.getScriptSource'),
    false
  );
  await fixture.commit();
  const after = fixture.calls.length;
  assert.match(
    (
      await fixture.command('Debugger.evaluateOnCallFrame', {
        callFrameId: '1.1.0',
        expression: 'globalThis.unsafe = true',
      })
    ).error,
    /slicc: refused:/
  );
  assert.equal(
    fixture.calls.slice(after).some((call) => call.method === 'Debugger.evaluateOnCallFrame'),
    false
  );
});

test('675 extension an unplaced isolated world revokes an existing debugger lease', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  await fixture.emit('Debugger.scriptParsed', ordinaryScript);
  await fixture.emit('Debugger.paused', ordinaryPause);
  const isolated = await fixture.command('Page.createIsolatedWorld', {
    frameId: 'root',
    worldName: 'ordinary-unplaced',
  });
  assert.equal(isolated.result.executionContextId, 999);
  const before = fixture.calls.length;
  const reply = await fixture.command('Debugger.enable');
  assert.match(reply.error ?? '', /slicc: refused:/);
  assert.equal(
    fixture.calls.slice(before).some((call) => call.method === 'Debugger.enable'),
    false
  );
  assert.ok(fixture.calls.some((call) => call.method === 'Debugger.resume'));
});

test('675 extension a committed generation never forwards a stale call-frame evaluation', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  await fixture.emit('Debugger.scriptParsed', ordinaryScript);
  await fixture.emit('Debugger.paused', ordinaryPause);
  await fixture.commit();
  const before = fixture.calls.length;
  const reply = await fixture.command('Debugger.evaluateOnCallFrame', {
    callFrameId: '1.1.0',
    expression: 'globalThis.unsafe = true',
  });
  assert.match(reply.error ?? '', /slicc: refused:/);
  assert.equal(
    fixture.calls.slice(before).some((call) => call.method === 'Debugger.evaluateOnCallFrame'),
    false
  );
});

test('675 extension a script ID without a published live ordinary pause is refused', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  await fixture.emit('Debugger.scriptParsed', ordinaryScript);
  const before = fixture.calls.length;
  const reply = await fixture.command('Debugger.getScriptSource', { scriptId: 'ordinary-script' });
  assert.match(reply.error ?? '', /slicc: refused:/);
  assert.equal(
    fixture.calls.slice(before).some((call) => call.method === 'Debugger.getScriptSource'),
    false
  );
});

test('675 extension protected pending normal pause is held and privately rescued', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  await fixture.emit('Debugger.scriptParsed', ordinaryScript);
  await fixture.emit('Debugger.paused', { reason: 'instrumentation', callFrames: [] });
  fixture.errorPage();
  const before = fixture.calls.length;
  const start = performance.now();
  await fixture.emit('Debugger.paused', ordinaryPause);
  assert.ok(performance.now() - start < 5500);
  assert.ok(fixture.calls.slice(before).some((call) => call.method === 'Debugger.resume'));
  assert.equal(
    fixture.messages.some((message) => message.method?.startsWith('Debugger.')),
    false
  );
});

test('675 extension the existing other-extension latch and refusal text are unchanged', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  await fixture.emit('Runtime.executionContextCreated', {
    context: {
      id: 2,
      uniqueId: 'foreign-context',
      origin: 'chrome-extension://foreign',
      name: 'foreign',
      auxData: { isDefault: false, frameId: 'root' },
    },
  });
  const before = fixture.calls.length;
  const reply = await fixture.command('Debugger.enable');
  assert.equal(
    reply.error,
    'slicc: refused: a browser extension runs scripts in this page, and profiling it would expose them'
  );
  assert.equal(
    fixture.calls.slice(before).some((call) => call.method === 'Debugger.enable'),
    false
  );
  await fixture.emit('Debugger.paused', ordinaryPause);
  assert.equal(
    fixture.messages.some((message) => message.method === 'Debugger.paused'),
    false
  );
});

const parsed = {
  scriptId: 'blocked-script',
  executionContextId: 1,
  url: 'chrome-error://chromewebdata/',
};
const paused = {
  reason: 'instrumentation',
  callFrames: [
    {
      callFrameId: '1.1.0',
      location: { scriptId: 'blocked-script', lineNumber: 0 },
      url: 'chrome-error://chromewebdata/',
    },
  ],
};

test('675 extension trusted commit revokes before the blocked document script and pause events', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  await fixture.emit('Debugger.scriptParsed', ordinaryScript);
  await fixture.emit('Debugger.paused', ordinaryPause);
  const before = fixture.messages.filter((message) =>
    message.method?.startsWith('Debugger.')
  ).length;
  const native = fixture.calls.length;
  await fixture.api.webNavigation.onCommitted.emit({
    tabId: 11,
    frameId: 0,
    url: 'https://vault.sliccy.ai/',
  });
  assert.ok(
    fixture.calls.slice(native).some((call) => call.method === 'Debugger.resume'),
    'commit causes private rescue before scriptParsed or paused'
  );
  fixture.errorPage();
  await fixture.emit('Debugger.scriptParsed', parsed);
  await fixture.emit('Debugger.paused', paused);
  assert.equal(
    fixture.messages.filter((message) => message.method?.startsWith('Debugger.')).length,
    before
  );
});

test('675 extension blocked error-page script events never publish', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  fixture.errorPage();
  await fixture.emit('Debugger.scriptParsed', parsed);
  await fixture.emit('Debugger.scriptFailedToParse', parsed);
  assert.deepEqual(
    fixture.messages.filter((message) => message.method?.startsWith('Debugger.')),
    []
  );
});

test('675 extension blocked error-page pause resumes privately within its bound', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  fixture.errorPage();
  const start = performance.now();
  await fixture.emit('Debugger.paused', paused);
  await fixture.emit('Debugger.resumed', {});
  assert.ok(performance.now() - start < 5500, 'private rescue bound');
  assert.ok(
    fixture.calls.some((call) => call.method === 'Debugger.resume'),
    'guard resume'
  );
  assert.deepEqual(
    fixture.messages.filter((message) => message.method?.startsWith('Debugger.')),
    []
  );
});

test('675 extension a stalled live pause proof rescues instead of publishing', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  fixture.stallRead();
  const start = performance.now();
  await fixture.emit('Debugger.paused', paused);
  assert.ok(performance.now() - start < 5500, 'stalled-proof rescue bound');
  assert.ok(
    fixture.calls.some((call) => call.method === 'Debugger.resume'),
    'guard resume'
  );
  assert.equal(
    fixture.messages.some((message) => message.method === 'Debugger.paused'),
    false
  );
});

test('675 extension refuses client-owned free pause and Stage2 methods', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  for (const method of [
    'Debugger.pause',
    'Debugger.setBreakpoint',
    'Debugger.setBreakpointByUrl',
    'DOMDebugger.setEventListenerBreakpoint',
    'EventBreakpoints.setInstrumentationBreakpoint',
  ]) {
    const before = fixture.calls.length;
    const reply = await fixture.command(method);
    assert.match(reply.error ?? '', /slicc: refused:/, method);
    assert.equal(
      fixture.calls.slice(before).some((call) => call.method === method),
      false
    );
  }
});
