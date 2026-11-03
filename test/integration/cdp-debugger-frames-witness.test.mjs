import assert from 'node:assert/strict';
import test from 'node:test';
import { framesWitness } from './fixtures/cdp-675-frames-witness.mjs';

function publications(row) {
  return row.fixture.messages.filter(({ method }) => method === 'Debugger.paused');
}

function resumes(row) {
  return row.fixture.calls.filter(({ method }) => method === 'Debugger.resume').length;
}

test('675 witness rehold extends to child frame events during the final private frames read, requiring a fresh complete proof before one publication', async (t) => {
  const row = await framesWitness(t);
  assert.equal(row.gate.states.get(11), row.state);
  assert.equal(row.state.pause, row.pause);
  assert.ok(row.pause.holding);
  assert.equal(row.pause.verifying, false);
  assert.equal(row.pause.deadline, row.deadline);
  assert.equal(row.pause.contexts.size, 0);
  assert.equal(row.pause.scripts.size, 0);
  assert.equal(row.pause.frames.size, 0);
  assert.equal(resumes(row), row.resumed);
  assert.deepEqual(publications(row), []);
  assert.equal(row.reads, 3);
  row.release();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(row.pause.published, true);
  assert.equal(publications(row).length, 1);
  assert.equal(
    row.fixture.messages.filter(({ method }) => method === 'Debugger.scriptParsed').length,
    1
  );
  assert.equal(row.pause.deadline, row.deadline);
});

test('675 a protected child in the moved final private frames read drops rather than reholding or publishing', async (t) => {
  const row = await framesWitness(t, 'protected');
  assert.equal(row.gate.states.has(11), false);
  assert.ok(resumes(row) > row.resumed);
  assert.deepEqual(publications(row), []);
  assert.equal(row.reads, 2);
});

test('675 repeated private frame witness movement resumes privately at the original nonreset pause cap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const row = await framesWitness(t, 'repeat');
  assert.ok(row.pause.holding);
  assert.equal(row.pause.deadline, row.deadline);
  assert.equal(resumes(row), row.resumed);
  t.mock.timers.tick(400);
  row.gate.revoke(11);
  await new Promise(setImmediate);
  assert.ok(row.repeated >= 3);
  assert.equal(row.pause.deadline, row.deadline);
  assert.equal(resumes(row), row.resumed);
  t.mock.timers.tick(600);
  await new Promise(setImmediate);
  assert.equal(row.state.pause, null);
  assert.ok(resumes(row) > row.resumed);
  assert.deepEqual(publications(row), []);
});
