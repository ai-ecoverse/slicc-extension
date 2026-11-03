import assert from 'node:assert/strict';
import test from 'node:test';
import { frameRelay } from './fixtures/cdp-frame-relay.mjs';

function nativeFrames(child = 'https://vault.sliccy.ai/FRAME_URL_CANARY') {
  return [
    {
      frameId: 0,
      parentFrameId: -1,
      documentId: 'ROOT_DOCUMENT_CANARY',
      url: 'https://ordinary.test/',
      securityOrigin: 'https://ordinary.test',
    },
    {
      frameId: 1,
      parentFrameId: 0,
      documentId: 'CHILD_DOCUMENT_CANARY',
      url: child,
      securityOrigin: child,
      extra: 'EXTRA_CANARY',
    },
  ];
}

function tree(fixture, child) {
  const send = fixture.api.debugger.sendCommand;
  fixture.api.debugger.sendCommand = async (source, method, params) => {
    const result = await send(source, method, params);
    if (method === 'Page.getFrameTree') {
      result.frameTree.childFrames = [
        {
          frame: {
            id: 'child',
            parentId: 'root',
            loaderId: 'child-loader',
            url: child,
            securityOrigin: child,
          },
        },
      ];
    }
    return result;
  };
}

for (const host of ['seven.sliccy.ai', 'www.sliccy.ai']) {
  test(`real page and relay source exposes only worker-redacted frame facts on ${host}`, async (t) => {
    const r = await frameRelay(host);
    t.after(r.close);
    const frames = nativeFrames();
    r.fixture.api.webNavigation.getAllFrames = async () => frames;
    tree(r.fixture, frames[1].url);
    const events = [];
    r.page.sliccExtension.cdp.on((message) => events.push(message));
    const reply = await r.page.sliccExtension.frames(11);
    const serialized = JSON.stringify({ reply, workerReplies: r.replies });
    assert.doesNotMatch(
      serialized,
      /sliccy\.ai|ordinary\.test|DOCUMENT_CANARY|URL_CANARY|EXTRA_CANARY/
    );
    assert.equal(reply.version, 2);
    assert.deepEqual(reply.frames, [
      { frameId: 0, parentFrameId: -1, kind: 'ordinary' },
      { frameId: 1, parentFrameId: 0, kind: 'protected' },
    ]);
    assert.equal(reply.rootFrameId, 'root');
    assert.equal(reply.rootLoaderId, 'ordinary-document');
    assert.equal(reply.rootDocumentId, undefined);
    assert.deepEqual(reply.localFrames, ['root', 'child']);
    assert.deepEqual(reply.remoteOwners, []);
    assert.deepEqual(events, []);
    r.deliver({
      privateFrames: { id: 999999, result: { url: 'https://vault.sliccy.ai/LATE_CANARY' } },
    });
    assert.deepEqual(events, []);
  });
}

test('worker redaction preserves complete ordinary frame facts through the real page and relay source', async (t) => {
  const r = await frameRelay();
  t.after(r.close);
  const frames = nativeFrames('https://other.test/ordinary');
  r.fixture.api.webNavigation.getAllFrames = async () => frames;
  tree(r.fixture, frames[1].url);
  const reply = await r.page.sliccExtension.frames(11);
  assert.equal(reply.frames.length, 2);
  assert.ok(reply.frames.every((frame) => frame.kind === 'ordinary'));
  assert.equal(reply.localFrames.length + reply.remoteOwners.length, reply.frames.length);
  assert.doesNotMatch(
    JSON.stringify(reply),
    /https?:|documentId|rootDocumentId|securityOrigin|url/
  );
});

test('matched, unmatched and disconnected private replies never fall through to public CDP listeners', async (t) => {
  const r = await frameRelay();
  t.after(r.close);
  const events = [];
  r.page.sliccExtension.cdp.on((message) => events.push(message));
  const matched = await r.page.sliccExtension.frames(11);
  assert.equal(matched.version, 2);
  let release;
  r.fixture.api.webNavigation.getAllFrames = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const waiting = r.page.sliccExtension.frames(11);
  r.worker.onDisconnect.emit();
  await assert.rejects(waiting, /disconnected/);
  release(nativeFrames().slice(0, 1));
  await r.fixture.connection.settled();
  r.deliver({
    privateFrames: { id: 999, result: { url: 'https://vault.sliccy.ai/UNMATCHED_CANARY' } },
  });
  assert.deepEqual(events, []);
});
