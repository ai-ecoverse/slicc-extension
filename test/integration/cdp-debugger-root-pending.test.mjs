import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

async function pendingPause(t) {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  await fixture.emit('Page.frameStartedLoading', { frameId: 'child' });
  await fixture.emit('Debugger.scriptParsed', {
    scriptId: 'root-before-child',
    executionContextId: 1,
    url: 'https://ordinary.test/script.js',
    embedderName: 'https://ordinary.test/script.js',
  });
  const gate = fixture.connection.debuggerGate;
  const state = gate.states.get(11);
  assert.equal(gate.childrenPlaced(11), true);
  assert.equal(gate.convertible(11, state), true);
  assert.equal(gate.current(11, state), false);
  await fixture.emit('Debugger.paused', {
    reason: 'instrumentation',
    data: { scriptId: 'root-before-child' },
    callFrames: [{ callFrameId: '1.1.0', location: { scriptId: 'root-before-child' } }],
  });
  assert.equal(state.pause.converted, true);
  const resumed = fixture.calls.filter(({ method }) => method === 'Debugger.resume').length;
  await fixture.emit('Debugger.paused', {
    reason: 'other',
    callFrames: [{ callFrameId: '1.1.0', location: { scriptId: 'root-before-child' } }],
  });
  return { fixture, gate, state, resumed };
}

async function placedChild(fixture) {
  const tab = fixture.connection.tabState(11);
  fixture.connection.pruneFrames(
    tab,
    {
      frame: { id: 'root' },
      childFrames: [{ frame: { id: 'child', url: '', securityOrigin: '://' } }],
    },
    tab.frameEvents
  );
  await fixture.emit('Page.frameAttached', { frameId: 'child', parentFrameId: 'root' });
  await new Promise(setImmediate);
  fixture.api.webNavigation.getAllFrames = async () => [
    { frameId: 0, parentFrameId: -1, documentId: 'native-root', url: 'https://ordinary.test/' },
    { frameId: 1, parentFrameId: 0, documentId: 'native-child', url: 'https://other.test/' },
  ];
  const send = fixture.api.debugger.sendCommand;
  fixture.api.debugger.sendCommand = (source, method, params) =>
    method === 'DOM.getDocument'
      ? Promise.resolve({
          root: { nodeName: '#document', children: [{ nodeName: 'IFRAME', frameId: 'child' }] },
        })
      : send(source, method, params);
  await fixture.emit('Target.attachedToTarget', {
    sessionId: 'child-session',
    targetInfo: { targetId: 'child', type: 'iframe', url: 'https://other.test/' },
  });
  await new Promise(setImmediate);
  await fixture.emit('Page.frameStoppedLoading', { frameId: 'child' });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
}

test('675 pending child retains the guard-owned root normal pause and publishes only after whole-page placement', async (t) => {
  const { fixture, gate, state, resumed } = await pendingPause(t);
  assert.equal(fixture.calls.filter(({ method }) => method === 'Debugger.resume').length, resumed);
  assert.ok(state.pause.holding);
  assert.equal(
    fixture.messages.some(({ method }) => method === 'Debugger.paused'),
    false
  );
  await placedChild(fixture);
  assert.equal(gate.states.get(11), state);
  assert.equal(fixture.messages.filter(({ method }) => method === 'Debugger.paused').length, 1);
  assert.equal(state.pause.published, true);
  assert.ok((await fixture.command('Debugger.resume')).result);
});

test('675 unsettled held root pause resumes privately at one nonreset one-second bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { fixture, state, resumed } = await pendingPause(t);
  assert.ok(state.pause.holding);
  const deadline = state.pause.deadline;
  t.mock.timers.tick(999);
  await fixture.emit('Page.frameStartedLoading', { frameId: 'child' });
  assert.equal(state.pause.deadline, deadline);
  assert.equal(fixture.calls.filter(({ method }) => method === 'Debugger.resume').length, resumed);
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.equal(state.pause, null);
  assert.equal(
    fixture.messages.some(({ method }) => method === 'Debugger.paused'),
    false
  );
  assert.ok(fixture.calls.filter(({ method }) => method === 'Debugger.resume').length > resumed);
});

test('675 a known protected child rescues the held root pause immediately and publishes nothing', async (t) => {
  const { fixture, gate, resumed } = await pendingPause(t);
  assert.equal(fixture.calls.filter(({ method }) => method === 'Debugger.resume').length, resumed);
  await fixture.emit('Page.frameNavigated', {
    frame: {
      id: 'child',
      parentId: 'root',
      loaderId: 'protected-child',
      url: 'https://vault.sliccy.ai/',
      securityOrigin: 'https://vault.sliccy.ai',
    },
  });
  assert.equal(gate.states.has(11), false);
  assert.ok(fixture.calls.filter(({ method }) => method === 'Debugger.resume').length > resumed);
  assert.equal(
    fixture.messages.some(({ method }) => method === 'Debugger.paused'),
    false
  );
});

test('675 a root document change rescues the held pause without publishing into the new document', async (t) => {
  const { fixture, gate, resumed } = await pendingPause(t);
  assert.equal(fixture.calls.filter(({ method }) => method === 'Debugger.resume').length, resumed);
  await fixture.commit();
  assert.equal(gate.states.has(11), false);
  assert.equal(
    fixture.messages.some(({ method }) => method === 'Debugger.paused'),
    false
  );
});
