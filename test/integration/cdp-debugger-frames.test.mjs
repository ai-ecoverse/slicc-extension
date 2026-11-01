import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

async function witnessedWorker(t) {
  const fixture = await children(t, []);
  await fixture.emit('Target.attachedToTarget', {
    sessionId: 'gap-worker',
    targetInfo: {
      targetId: 'gap-worker-target',
      type: 'worker',
      url: 'https://ordinary.test/worker.js',
    },
  });
  await fixture.lease();
  fixture.connection.tabState(11).frameEvents++;
  assert.equal(fixture.connection.debuggerGate.childrenPlaced(11), false);
  return fixture;
}

test('675 extension buffers root scripts before refreshing an invalidated whole-page witness at publication', async (t) => {
  const fixture = await witnessedWorker(t);
  const state = fixture.connection.debuggerGate.states.get(11);
  await fixture.emit('Debugger.scriptParsed', {
    scriptId: 'witness-gap-script',
    executionContextId: 1,
    url: 'https://ordinary.test/root-script.js',
  });
  assert.ok(state.scripts.has('witness-gap-script'));
  assert.equal(
    fixture.messages.some(({ method }) => method?.startsWith('Debugger.')),
    false
  );
  await fixture.emit('Debugger.paused', {
    reason: 'instrumentation',
    data: { scriptId: 'witness-gap-script' },
    callFrames: [],
  });
  await fixture.emit('Debugger.paused', {
    reason: 'other',
    callFrames: [{ callFrameId: '1.1.0', location: { scriptId: 'witness-gap-script' } }],
  });
  assert.equal(fixture.messages.filter(({ method }) => method === 'Debugger.paused').length, 1);
  assert.equal(fixture.connection.debuggerGate.childrenPlaced(11), true);
});

test('675 extension R1 resumes a known evaluation before any invalidated child-witness read', async (t) => {
  const fixture = await witnessedWorker(t);
  await fixture.emit('Debugger.scriptParsed', {
    scriptId: 'witness-gap-evaluate',
    executionContextId: 1,
    url: '',
    embedderName: '',
  });
  const before = fixture.calls.length;
  await fixture.emit('Debugger.paused', {
    reason: 'instrumentation',
    data: { scriptId: 'witness-gap-evaluate' },
    callFrames: [],
  });
  const calls = fixture.calls.slice(before);
  assert.equal(calls.filter(({ method }) => method === 'Debugger.resume').length, 1);
  assert.equal(
    calls.some(({ method }) =>
      ['Debugger.pause', 'Page.getFrameTree', 'DOM.getDocument'].includes(method)
    ),
    false
  );
  assert.equal(
    fixture.messages.some(({ method }) => method?.startsWith('Debugger.')),
    false
  );
});

async function children(t, urls) {
  const fixture = await backend();
  t.after(fixture.close);
  fixture.api.webNavigation.getAllFrames = async () => [
    { frameId: 0, parentFrameId: -1, documentId: 'root-native', url: 'https://ordinary.test/' },
    ...urls.map((url, index) => ({
      frameId: index + 1,
      parentFrameId: 0,
      documentId: `native-${index}`,
      url,
    })),
  ];
  const send = fixture.api.debugger.sendCommand;
  fixture.api.debugger.sendCommand = (source, method, params) =>
    method === 'DOM.getDocument'
      ? Promise.resolve({
          root: {
            nodeName: '#document',
            children: urls.map((_, index) => ({ nodeName: 'IFRAME', frameId: `remote-${index}` })),
          },
        })
      : send(source, method, params);
  for (let index = 0; index < urls.length; index++)
    await fixture.emit('Target.attachedToTarget', {
      sessionId: `child-${index}`,
      targetInfo: { targetId: `remote-${index}`, type: 'iframe', url: urls[index] },
      waitingForDebugger: false,
    });
  return fixture;
}

test('675 extension debugger admits complete ordinary cross-origin children but publishes only the root session', async (t) => {
  const fixture = await children(t, ['https://other.test/', 'https://third.test/']);
  assert.equal(fixture.connection.tabState(11).debuggerChildren.size, 2);
  await fixture.lease();
  await fixture.emit('Debugger.scriptParsed', {
    scriptId: 'root-script',
    executionContextId: 1,
    url: 'https://ordinary.test/root.js',
  });
  await fixture.emit('Debugger.paused', {
    reason: 'other',
    callFrames: [{ callFrameId: '1.1.0', location: { scriptId: 'root-script' } }],
  });
  assert.equal(fixture.messages.filter(({ method }) => method === 'Debugger.paused').length, 1);
  const before = fixture.messages.length;
  for (const method of ['Debugger.scriptParsed', 'Debugger.paused', 'Debugger.resumed'])
    await fixture.api.debugger.onEvent.emit({ tabId: 11, sessionId: 'child-0' }, method, {
      reason: 'other',
      scriptId: 'child-script',
      executionContextId: 1,
      callFrames: [{ callFrameId: '1.1.0', location: { scriptId: 'root-script' } }],
    });
  assert.equal(fixture.messages.length, before);
  assert.ok((await fixture.command('Debugger.resume')).result);
});

test('675 extension debugger still refuses a protected child among ordinary cross-origin siblings', async (t) => {
  const fixture = await children(t, [
    'https://other.test/',
    'https://vault.sliccy.ai/private',
    'https://third.test/',
  ]);
  const before = fixture.calls.length;
  assert.match((await fixture.command('Debugger.enable')).error, /slicc: refused:/);
  assert.equal(
    fixture.calls.slice(before).some(({ method }) => method === 'Debugger.enable'),
    false
  );
  assert.equal(
    fixture.messages.some(({ method }) => method?.startsWith('Debugger.')),
    false
  );
});

test('675 extension debugger admits a concrete ordinary dedicated worker while publishing only root pauses', async (t) => {
  const fixture = await children(t, []);
  await fixture.emit('Target.attachedToTarget', {
    sessionId: 'worker',
    targetInfo: {
      targetId: 'worker-target',
      type: 'worker',
      url: 'https://ordinary.test/worker.js',
    },
  });
  await fixture.lease();
  const before = fixture.messages.length;
  await fixture.api.debugger.onEvent.emit({ tabId: 11, sessionId: 'worker' }, 'Debugger.paused', {
    reason: 'instrumentation',
    callFrames: [],
  });
  assert.equal(fixture.messages.length, before);
});

test('675 extension debugger never certifies an unknown child using ordinary frame-list counts', async (t) => {
  for (const [type, url] of [
    ['other', 'https://ordinary.test/worker.js'],
    ['worker', ''],
    ['worker', 'blob:https://ordinary.test/no-owner'],
    ['worker', 'data:text/javascript,1'],
    ['worker', 'https://vault.sliccy.ai/private'],
  ]) {
    const fixture = await children(t, ['https://other.test/', 'https://third.test/']);
    await fixture.emit('Target.detachedFromTarget', { sessionId: 'child-1' });
    await fixture.emit('Target.attachedToTarget', {
      sessionId: 'worker',
      targetInfo: { targetId: 'worker-target', type, url },
    });
    const before = fixture.calls.length;
    assert.match((await fixture.command('Debugger.enable')).error ?? '', /slicc: refused:/);
    assert.equal(
      fixture.calls.slice(before).some(({ method }) => method === 'Debugger.enable'),
      false
    );
  }
});

test('675 extension debugger refuses a missing native child snapshot and keeps the foreign-world latch', async (t) => {
  const fixture = await children(t, ['https://other.test/']);
  fixture.api.webNavigation.getAllFrames = async () => undefined;
  assert.match((await fixture.command('Debugger.enable')).error, /refused|unsettled/);
  fixture.connection.tabState(11).worlds.foreign = true;
  const before = fixture.calls.length;
  assert.match((await fixture.command('Debugger.enable')).error, /browser extension runs scripts/);
  assert.equal(fixture.calls.length, before);
});
