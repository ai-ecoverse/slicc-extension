import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

const limit = 64 * 1024 * 1024;
const parsed = {
  scriptId: 'budget-script',
  executionContextId: 1,
  url: 'https://ordinary.test/budget.js',
};
const paused = {
  reason: 'other',
  callFrames: [{ callFrameId: '1.1.0', location: { scriptId: parsed.scriptId } }],
};

test('debugger script flood frees the shared budget and the next ordinary document publishes', async (t) => {
  const f = await backend();
  t.after(f.close);
  await f.lease();
  const gate = f.connection.debuggerGate;
  const state = gate.states.get(11);
  await f.emit('Debugger.scriptParsed', parsed);
  await f.emit('Debugger.paused', paused);
  assert.equal(state.pause.published, true);
  const large = 'https://ordinary.test/' + 'x'.repeat(1000000);
  for (let i = 0; i < 40; i++) {
    await f.emit('Debugger.scriptParsed', {
      scriptId: `flood-${i}`,
      executionContextId: 1,
      url: large,
    });
    assert.ok(gate.retainedBytes >= 0 && gate.retainedBytes <= limit);
  }
  assert.equal(state.full, true);
  assert.equal(state.scripts.size, 0);
  assert.equal(state.scriptInfo.size, 0);
  assert.equal(gate.retainedBytes, 0);
  assert.equal(state.pause, null);
  assert.equal(state.resuming, null);
  assert.match((await f.command('Debugger.enable')).error, /slicc: refused:/);
  const before = f.messages.length;
  const resumes = f.calls.filter(({ method }) => method === 'Debugger.resume').length;
  await f.emit('Debugger.paused', {
    ...paused,
    callFrames: [{ callFrameId: '1.1.0', location: { scriptId: 'flood-39' } }],
  });
  await f.emit('Debugger.resumed', {});
  assert.ok(f.calls.filter(({ method }) => method === 'Debugger.resume').length > resumes);
  assert.equal(
    f.messages.slice(before).some(({ method }) => method?.startsWith('Debugger.')),
    false
  );
  await f.commit();
  await f.lease();
  await f.emit('Debugger.scriptParsed', parsed);
  await f.emit('Debugger.paused', paused);
  assert.equal(gate.states.get(11).pause.published, true);
  assert.equal(gate.states.get(11).full, false);
  assert.ok(gate.retainedBytes > 0);
  await f.command('Debugger.disable');
  assert.equal(gate.retainedBytes, 0);
});

async function published(f) {
  await f.emit('Debugger.scriptParsed', parsed);
  await f.emit('Debugger.paused', paused);
  const gate = f.connection.debuggerGate;
  const state = gate.states.get(11);
  assert.equal(state.pause.published, true);
  gate.clearScripts(state);
  assert.ok(gate.retainedBytes > 0);
  return { gate, state, pause: state.pause };
}

async function clientResume(f) {
  const reply = await f.command('Debugger.resume');
  assert.equal(reply.error, undefined);
  await f.emit('Debugger.resumed', {});
}

test('published pause client resume refunds its reservation and preserves owned resumed publication', async (t) => {
  const f = await backend();
  t.after(f.close);
  await f.lease();
  const { gate, state, pause } = await published(f);
  await clientResume(f);
  assert.equal(gate.retainedBytes, 0);
  assert.equal(state.retainedBytes, 0);
  assert.equal(state.pause, null);
  assert.equal(state.resuming, null);
  assert.equal(pause.data, null);
  assert.deepEqual(pause.retained, {});
  assert.equal(pause.contexts.get(1), 'ordinary-context');
  assert.equal(f.messages.filter(({ method }) => method === 'Debugger.resumed').length, 1);
  assert.equal(
    f.messages.find(({ method }) => method === 'Debugger.resumed').sessionId,
    f.sessionId
  );
});

test('three ordinary published pause client resume cycles leave no shared reservation debt', async (t) => {
  const f = await backend();
  t.after(f.close);
  await f.lease();
  for (let cycle = 0; cycle < 3; cycle++) {
    const { gate, state } = await published(f);
    await clientResume(f);
    assert.equal(gate.retainedBytes, 0);
    assert.equal(state.retainedBytes, 0);
    assert.equal(state.pause, null);
    assert.equal(state.resuming, null);
  }
  assert.equal(f.messages.filter(({ method }) => method === 'Debugger.resumed').length, 3);
});

test('new document revoke leaves no completed client resume reservation behind', async (t) => {
  const f = await backend();
  t.after(f.close);
  await f.lease();
  const { gate, state } = await published(f);
  await clientResume(f);
  await f.commit();
  assert.equal(state.generation, 'next-document');
  assert.equal(gate.retainedBytes, 0);
  assert.equal(state.retainedBytes, 0);
  assert.equal(state.pause, null);
  assert.equal(state.resuming, null);
});
