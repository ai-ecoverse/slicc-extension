import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

async function memoryDom(t, push = false) {
  const fixture = await backend();
  t.after(fixture.close);
  fixture.api.webNavigation.getAllFrames = async () => [
    { frameId: 0, parentFrameId: -1, documentId: 'native-root', url: 'https://ordinary.test/' },
    { frameId: 1, parentFrameId: 0, documentId: 'native-child', url: 'https://other.test/' },
  ];
  const root = {
    nodeName: '#document',
    frameId: 'root',
    children: [
      { nodeName: 'IFRAME', frameId: 'child', attributes: ['src', 'https://other.test/'] },
    ],
  };
  const original = fixture.api.debugger.sendCommand;
  let node = 0;
  let failure;
  fixture.api.debugger.sendCommand = async (source, method, params) => {
    if (method === 'Page.getNavigationHistory')
      return {
        currentIndex: 0,
        entries: [{ id: 1, url: 'https://ordinary.test/', title: 'ordinary' }],
      };
    if (method === 'Runtime.evaluate' && params.expression === '({})')
      return { result: { type: 'object', objectId: '1.1.1' } };
    if (method === 'DOM.getDocument')
      return { root: { ...root, nodeId: ++node, backendNodeId: 100 } };
    if (method === 'DOM.querySelectorAll') {
      if (params.nodeId !== node) throw new Error('Could not find node with given id');
      return { nodeIds: [node + 1000] };
    }
    if (method === 'DOMSnapshot.getSnapshot')
      return {
        domNodes: [
          { nodeType: 9, nodeName: '#document', frameId: 'root', backendNodeId: 100 },
          {
            nodeType: 1,
            nodeName: 'IFRAME',
            backendNodeId: 10,
            attributes: [{ name: 'src', value: 'https://other.test/' }],
          },
        ],
      };
    if (method === 'DOM.getFrameOwner') {
      if (failure) throw new Error(failure);
      assert.equal(params.frameId, 'child');
      if (push && node) {
        await fixture.emit('DOM.setChildNodes', {
          parentId: node,
          nodes: [
            {
              nodeId: node + 1,
              backendNodeId: 10,
              nodeType: 1,
              nodeName: 'IFRAME',
              nodeValue: '',
              frameId: 'child',
              attributes: ['src', 'https://other.test/'],
            },
          ],
        });
        await fixture.emit('DOM.setChildNodes', {
          parentId: node,
          nodes: [
            {
              nodeId: node + 2,
              backendNodeId: 20,
              nodeType: 9,
              nodeName: '#document',
              nodeValue: '',
              documentURL: 'https://vault.sliccy.ai/private-push',
            },
          ],
        });
      }
      return { backendNodeId: 10, ...(node ? { nodeId: node + 1 } : {}) };
    }
    return original(source, method, params);
  };
  await fixture.command('Runtime.enable');
  await fixture.emit('Target.attachedToTarget', {
    sessionId: 'child-session',
    targetInfo: { targetId: 'child', type: 'iframe', url: 'https://other.test/' },
  });
  return {
    ...fixture,
    ownerFailure(value) {
      failure = value;
    },
  };
}

test('client frontend DOM node survives a private frame closure read on the shared tab', async (t) => {
  const fixture = await memoryDom(t);
  const document = await fixture.command('DOM.getDocument', { depth: 1, pierce: false });
  assert.equal(document.error, undefined);
  const before = fixture.messages.length;
  const privateRead = await fixture.connection.frames(11);
  assert.deepEqual(privateRead.remoteOwners, [{ frameId: 'child', backendNodeId: 10 }]);
  assert.equal(fixture.messages.length, before);
  const listed = await fixture.command('DOM.querySelectorAll', {
    nodeId: document.result.root.nodeId,
    selector: 'iframe,frame',
  });
  assert.equal(listed.error, undefined);
  assert.equal(listed.result.nodeIds.length, 1);
});

test('private owner frontend pushes traverse the existing event scrub and never publish a protected document', async (t) => {
  const fixture = await memoryDom(t, true);
  await fixture.command('DOM.getDocument', { depth: 1, pierce: false });
  const scrub = fixture.connection.sealEvent.bind(fixture.connection);
  let pushes = 0;
  fixture.connection.sealEvent = async (...args) => {
    if (args[2] === 'DOM.setChildNodes') pushes++;
    return scrub(...args);
  };
  const before = fixture.messages.length;
  const proof = await fixture.connection.frames(11);
  assert.deepEqual(proof.remoteOwners, [{ frameId: 'child', backendNodeId: 10 }]);
  assert.equal(pushes, 2);
  const events = fixture.messages
    .slice(before)
    .filter(({ method }) => method === 'DOM.setChildNodes');
  assert.ok(events.some(({ params }) => params.nodes.some((node) => node.backendNodeId === 10)));
  assert.doesNotMatch(JSON.stringify(events), /vault|private-push/);
  assert.equal(
    events.some(({ params }) => params.nodes.some((node) => node.backendNodeId === 20)),
    false
  );
});

for (const failure of ["'DOM.getFrameOwner' wasn't found", 'owner no longer belongs to parent']) {
  test(`a missing or stale private frame owner refuses admission and rescues an owned pause: ${failure}`, async (t) => {
    const fixture = await memoryDom(t);
    await fixture.lease();
    fixture.ownerFailure(failure);
    await assert.rejects(fixture.connection.frames(11), /refused|unsettled/);
    await fixture.emit('Debugger.scriptParsed', {
      scriptId: 'script',
      executionContextId: 1,
      url: 'https://ordinary.test/script.js',
    });
    await fixture.emit('Debugger.paused', {
      reason: 'instrumentation',
      data: { scriptId: 'script' },
      callFrames: [{ callFrameId: '1.1.0', location: { scriptId: 'script' } }],
    });
    await fixture.emit('Debugger.paused', {
      reason: 'other',
      callFrames: [{ callFrameId: '1.1.0', location: { scriptId: 'script' } }],
    });
    assert.equal(
      fixture.messages.some(({ method }) => method?.startsWith('Debugger.')),
      false
    );
    assert.ok(fixture.calls.some(({ method }) => method === 'Debugger.resume'));
    const before = fixture.calls.length;
    assert.match((await fixture.command('Debugger.enable')).error, /refused|unsettled/);
    assert.equal(
      fixture.calls.slice(before).some(({ method }) => method === 'Debugger.enable'),
      false
    );
  });
}
