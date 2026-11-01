import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

test('a private frame reply arriving after relay disconnect never reaches CDP listeners', async () => {
  let port;
  const sent = [];
  const page = vm.createContext({
    __sliccSeven: {
      domain: 'sliccy.ai',
      excludedLabels: [],
      excludedLabelPrefixes: [],
      version: '7.10.1',
    },
    location: { hostname: 'seven.sliccy.ai', origin: 'https://seven.sliccy.ai' },
    MessageChannel: class {
      constructor() {
        this.port1 = port = { postMessage: (value) => sent.push(value) };
        this.port2 = {};
      }
    },
    postMessage() {},
  });
  vm.runInContext(
    await readFile(new URL('../../extension/page.js', import.meta.url), 'utf8'),
    page
  );
  const events = [];
  page.sliccExtension.cdp.on((value) => events.push(value));
  const secondListener = [];
  page.sliccExtension.cdp.on((value) => secondListener.push(value));
  const waiting = page.sliccExtension.frames(11);
  const id = sent.at(-1).privateFrames.id;
  port.onmessage({ data: { cdp: { error: 'slicc-extension: relay disconnected' } } });
  await assert.rejects(waiting, /disconnected/);
  port.onmessage({
    data: {
      privateFrames: {
        id,
        result: {
          version: 1,
          revision: 41,
          rootDocumentId: 'private-native-root',
          rootFrameId: 'private-cdp-root',
          rootLoaderId: 'private-loader',
          remoteOwners: ['private-owner'],
          frames: [{ url: 'https://vault.sliccy.ai/private-document' }],
        },
      },
    },
  });
  assert.deepEqual(events, [], 'private fields must be dropped, never dispatched as CDP events');
  assert.deepEqual(secondListener, [], 'no public listener receives any private field');
});

function nativeFrames(protectedChild = false) {
  return [
    {
      frameId: 0,
      parentFrameId: -1,
      documentId: 'native-root-document',
      url: 'https://ordinary.test/',
      errorOccurred: false,
    },
    {
      frameId: 1,
      parentFrameId: 0,
      documentId: 'native-child-one',
      url: 'https://other.test/one',
      errorOccurred: false,
    },
    {
      frameId: 2,
      parentFrameId: 0,
      documentId: 'native-child-two',
      url: protectedChild ? 'https://vault.sliccy.ai/private-frame' : 'https://third.test/two',
      errorOccurred: false,
    },
  ];
}

function owners() {
  return {
    root: {
      nodeName: '#document',
      children: [
        {
          nodeName: 'IFRAME',
          frameId: 'remote-one',
          attributes: ['src', 'https://other.test/one'],
        },
        {
          nodeName: 'IFRAME',
          frameId: 'remote-two',
          attributes: ['src', 'https://third.test/two'],
        },
      ],
    },
  };
}

for (const protectedChild of [false, true]) {
  test(`private frame snapshot contains the complete guard-owned native closure, including ${protectedChild ? 'a protected frame among ordinary ones' : 'ordinary cross-origin children'}, without publishing its URLs`, async (t) => {
    const fixture = await backend();
    t.after(fixture.close);
    fixture.api.webNavigation.getAllFrames = async () => nativeFrames(protectedChild);
    const send = fixture.api.debugger.sendCommand;
    fixture.api.debugger.sendCommand = (target, method, params) =>
      method === 'DOM.getDocument' ? Promise.resolve(owners()) : send(target, method, params);
    const before = structuredClone(fixture.messages);
    assert.equal(
      typeof fixture.connection.frames,
      'function',
      'the trusted non-CDP frame reader is required'
    );
    const snapshot = await fixture.connection.frames(11);
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.rootDocumentId, 'native-root-document');
    assert.equal(snapshot.rootFrameId, 'root');
    assert.equal(snapshot.rootLoaderId, 'ordinary-document');
    assert.ok(Number.isSafeInteger(snapshot.revision));
    assert.deepEqual(snapshot.frames, nativeFrames(protectedChild));
    assert.deepEqual(snapshot.remoteOwners.sort(), ['remote-one', 'remote-two']);
    assert.deepEqual(
      fixture.messages,
      before,
      'private list must not enter any CDP response or event'
    );
    for (const method of ['frames', 'sliccExtension.frames', 'Slicc.frames']) {
      const answer = await fixture.command(method, { tabId: 11 });
      assert.ok(answer.error, 'a CDP client cannot name the private frame reader');
      assert.doesNotMatch(JSON.stringify(answer), /private-frame|other\.test|third\.test/);
    }
  });
}

test('private frame snapshot refuses missing, malformed, orphaned and concurrently changing native closures', async (t) => {
  const fixture = await backend();
  t.after(fixture.close);
  assert.equal(typeof fixture.connection.frames, 'function');
  for (const frames of [
    null,
    [],
    nativeFrames().slice(1),
    [{ ...nativeFrames()[0], documentId: '' }],
    [nativeFrames()[0], { ...nativeFrames()[1], parentFrameId: 9 }],
  ]) {
    fixture.api.webNavigation.getAllFrames = async () => frames;
    await assert.rejects(fixture.connection.frames(11), /refused|unsettled|frame/i);
  }
  fixture.api.webNavigation.getAllFrames = async () => {
    fixture.connection.tabState(11).frameEvents++;
    return nativeFrames();
  };
  await assert.rejects(fixture.connection.frames(11), /refused|unsettled|frame/i);
});
