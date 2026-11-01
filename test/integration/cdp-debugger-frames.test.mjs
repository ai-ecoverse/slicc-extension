import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

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

test('675 extension debugger refuses a missing native child snapshot and keeps the foreign-world latch', async (t) => {
  const fixture = await children(t, ['https://other.test/']);
  fixture.api.webNavigation.getAllFrames = async () => undefined;
  assert.match((await fixture.command('Debugger.enable')).error, /refused|unsettled/);
  fixture.connection.tabState(11).worlds.foreign = true;
  const before = fixture.calls.length;
  assert.match((await fixture.command('Debugger.enable')).error, /browser extension runs scripts/);
  assert.equal(fixture.calls.length, before);
});
