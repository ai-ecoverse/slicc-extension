import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

async function movingProof(t, outcome = 'ordinary', moveAt = 1) {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  const gate = fixture.connection.debuggerGate;
  const tab = fixture.connection.tabState(11);
  tab.debuggerChildren.add('child-session');
  tab.debuggerChildInfo.set('child-session', {
    target: 'child',
    type: 'iframe',
    url: 'https://other.test/',
    generation: 'ordinary-document',
    revision: tab.debuggerRevision,
  });
  fixture.connection.frames = async () => ({
    revision: tab.frameEvents,
    rootFrameId: 'root',
    rootLoaderId: 'ordinary-document',
    remoteOwners: ['child'],
    frames: [{ url: 'https://ordinary.test/' }, { url: 'https://other.test/' }],
  });
  await gate.placeChildren(11);
  await fixture.emit('Debugger.scriptParsed', {
    scriptId: 'root-script',
    executionContextId: 1,
    url: 'https://ordinary.test/script.js',
    embedderName: 'https://ordinary.test/script.js',
  });
  const params = {
    reason: 'other',
    callFrames: [{ callFrameId: '1.1.0', location: { scriptId: 'root-script' } }],
  };
  await fixture.emit('Debugger.paused', {
    ...params,
    reason: 'instrumentation',
    data: { scriptId: 'root-script' },
  });
  const state = gate.states.get(11);
  const pause = state.pause;
  pause.deadline = Date.now() + 1000;
  const deadline = pause.deadline;
  const resumed = fixture.calls.filter(({ method }) => method === 'Debugger.resume').length;
  const tree = fixture.connection.contentTree.bind(fixture.connection);
  let release;
  let reads = 0;
  let blocked = false;
  fixture.connection.contentTree = async (...args) => {
    const result = await tree(...args);
    if (++reads === moveAt) {
      tab.frameEvents++;
      if (outcome === 'protected') tab.debuggerFrameBlocks.add('child');
      if (outcome === 'foreign') tab.worlds.foreign = true;
      if (outcome === 'root') tab.documents.frames.get('root').loaderId = 'replacement';
    } else if (reads > moveAt && !blocked && (outcome === 'ordinary' || outcome === 'stall')) {
      blocked = true;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return result;
  };
  await fixture.emit('Debugger.paused', params);
  await new Promise(setImmediate);
  return { fixture, gate, state, pause, deadline, resumed, release: () => release?.() };
}

test('675 frameEvents moving during held-root verification re-holds without resume and publishes only after the next complete proof', async (t) => {
  const row = await movingProof(t);
  assert.equal(row.gate.states.get(11), row.state);
  assert.equal(row.state.pause, row.pause);
  assert.ok(row.pause.holding);
  assert.equal(row.pause.deadline, row.deadline);
  assert.equal(
    row.fixture.calls.filter(({ method }) => method === 'Debugger.resume').length,
    row.resumed
  );
  assert.equal(
    row.fixture.messages.some(({ method }) => method === 'Debugger.paused'),
    false
  );
  row.release();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(row.pause.published, true);
  assert.equal(row.fixture.messages.filter(({ method }) => method === 'Debugger.paused').length, 1);
});

test('675 witness movement in the last publication proof rechecks all IDs and still publishes the buffered script once', async (t) => {
  const row = await movingProof(t, 'ordinary', 2);
  assert.ok(row.pause.holding);
  assert.equal(row.pause.contexts.size, 0);
  assert.equal(row.pause.scripts.size, 0);
  assert.equal(row.pause.frames.size, 0);
  assert.equal(row.pause.deadline, row.deadline);
  assert.equal(
    row.fixture.messages.some(({ method }) => method === 'Debugger.paused'),
    false
  );
  row.release();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(row.pause.published, true);
  assert.equal(
    row.fixture.messages.filter(({ method }) => method === 'Debugger.scriptParsed').length,
    1
  );
  assert.equal(row.fixture.messages.filter(({ method }) => method === 'Debugger.paused').length, 1);
});

test('675 repeated witness settlement never extends the original held pause cap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const row = await movingProof(t, 'stall');
  assert.ok(row.pause.holding);
  assert.equal(row.pause.deadline, row.deadline);
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.equal(row.state.pause, null);
  assert.equal(
    row.fixture.messages.some(({ method }) => method === 'Debugger.paused'),
    false
  );
  assert.ok(
    row.fixture.calls.filter(({ method }) => method === 'Debugger.resume').length > row.resumed
  );
  row.release();
  await new Promise(setImmediate);
  assert.equal(
    row.fixture.messages.some(({ method }) => method === 'Debugger.paused'),
    false
  );
});

for (const outcome of ['protected', 'foreign', 'root']) {
  test(`675 moved witness with ${outcome} evidence still drops immediately`, async (t) => {
    const row = await movingProof(t, outcome);
    assert.equal(row.gate.states.has(11), false);
    assert.ok(
      row.fixture.calls.filter(({ method }) => method === 'Debugger.resume').length > row.resumed
    );
    assert.equal(
      row.fixture.messages.some(({ method }) => method === 'Debugger.paused'),
      false
    );
  });
}
