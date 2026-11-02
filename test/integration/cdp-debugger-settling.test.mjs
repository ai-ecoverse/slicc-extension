import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

async function provisional(t) {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  const tab = fixture.connection.tabState(11);
  const state = fixture.connection.debuggerGate.states.get(11);
  const tree = {
    frame: { id: 'root' },
    childFrames: [{ frame: { id: 'child', url: '', securityOrigin: '://' } }],
  };
  fixture.connection.pruneFrames(tab, tree, tab.frameEvents);
  assert.equal(tab.frames.get('child'), true);
  assert.equal(tree.childFrames.length, 0);
  await fixture.emit('Page.frameAttached', { frameId: 'child', parentFrameId: 'root' });
  return { fixture, tab, state };
}

test('675 extension provisional hidden child suspends the existing holder without disabling it', async (t) => {
  const { fixture, state } = await provisional(t);
  const gate = fixture.connection.debuggerGate;
  assert.equal(gate.states.get(11), state);
  assert.equal(gate.current(11, state), false);
  const before = fixture.calls.length;
  await fixture.emit('Debugger.paused', { reason: 'instrumentation', callFrames: [] });
  assert.equal(
    fixture.calls.slice(before).filter(({ method }) => method === 'Debugger.resume').length,
    1
  );
  assert.equal(
    fixture.calls.some(({ method }) => method === 'Debugger.disable'),
    false
  );
  assert.equal(
    fixture.messages.some(({ method }) => method?.startsWith('Debugger.')),
    false
  );
});

test('675 extension complete same-generation ordinary placement lifts suspension with scrub intact', async (t) => {
  const { fixture, tab, state } = await provisional(t);
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
  const gate = fixture.connection.debuggerGate;
  assert.equal(gate.states.get(11), state);
  assert.equal(state.suspension, null);
  assert.equal(gate.current(11, state), true);
  assert.equal(tab.frames.get('child'), true);
  await fixture.emit('Debugger.scriptParsed', {
    scriptId: 'root-after-placement',
    executionContextId: 1,
    url: 'https://ordinary.test/script.js',
  });
  await fixture.emit('Debugger.paused', {
    reason: 'other',
    callFrames: [{ callFrameId: '1.1.0', location: { scriptId: 'root-after-placement' } }],
  });
  assert.equal(fixture.messages.filter(({ method }) => method === 'Debugger.paused').length, 1);
  assert.ok((await fixture.command('Debugger.resume')).result);
});

test('675 extension unsettled child drops at one five-second bound without event resets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { fixture, state } = await provisional(t);
  await new Promise(setImmediate);
  const deadline = state.suspension.deadline;
  t.mock.timers.tick(4999);
  await fixture.emit('Page.frameAttached', { frameId: 'child', parentFrameId: 'root' });
  assert.equal(state.suspension.deadline, deadline);
  assert.equal(fixture.connection.debuggerGate.states.get(11), state);
  t.mock.timers.tick(1);
  assert.equal(fixture.connection.debuggerGate.states.has(11), false);
});

test('675 extension a root-only snapshot never lifts an outstanding unknown child', async (t) => {
  const { fixture, state } = await provisional(t);
  await new Promise(setImmediate);
  fixture.api.webNavigation.getAllFrames = async () => [
    { frameId: 0, parentFrameId: -1, documentId: 'root', url: 'https://ordinary.test/' },
  ];
  await fixture.emit('Page.frameAttached', { frameId: 'child', parentFrameId: 'root' });
  await new Promise(setImmediate);
  assert.equal(fixture.connection.debuggerGate.states.get(11), state);
  assert.ok(state.suspension);
  assert.equal(fixture.connection.debuggerGate.childrenPlaced(11), false);
  const before = fixture.calls.length;
  assert.match((await fixture.command('Debugger.enable')).error, /slicc: refused:/);
  assert.equal(
    fixture.calls.slice(before).some(({ method }) => method === 'Debugger.enable'),
    false
  );
});

test('675 extension a known protected child drops the holder immediately', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  await fixture.emit('Page.frameNavigated', {
    frame: {
      id: 'child',
      parentId: 'root',
      loaderId: 'protected-child',
      url: 'https://vault.sliccy.ai/',
      securityOrigin: 'https://vault.sliccy.ai',
    },
  });
  assert.equal(fixture.connection.debuggerGate.states.has(11), false);
  assert.ok(fixture.calls.some(({ method }) => method === 'Debugger.resume'));
  assert.equal(
    fixture.messages.some(({ method }) => method?.startsWith('Debugger.')),
    false
  );
});
