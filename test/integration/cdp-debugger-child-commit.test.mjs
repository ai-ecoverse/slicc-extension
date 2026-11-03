import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

async function committing(t) {
  const fixture = await backend();
  t.after(fixture.close);
  const send = fixture.api.debugger.sendCommand;
  fixture.api.debugger.sendCommand = async (source, method, params) => {
    const result = await send(source, method, params);
    if (method === 'Page.getFrameTree')
      result.frameTree.childFrames = [
        {
          frame: {
            id: 'same-child',
            parentId: 'root',
            loaderId: 'same-child-document',
            url: 'https://ordinary.test/child',
            securityOrigin: 'https://ordinary.test',
          },
        },
      ];
    return result;
  };
  fixture.api.webNavigation.getAllFrames = async () => [
    {
      frameId: 0,
      parentFrameId: -1,
      documentId: 'ordinary-document',
      url: 'https://ordinary.test/',
    },
    {
      frameId: 1,
      parentFrameId: 0,
      documentId: 'same-child-document',
      url: 'https://ordinary.test/child',
    },
  ];
  await fixture.lease();
  await fixture.emit('Debugger.scriptParsed', {
    scriptId: 'root-commit-script',
    executionContextId: 1,
    url: 'https://ordinary.test/root.js',
    embedderName: 'https://ordinary.test/root.js',
  });
  const params = {
    reason: 'other',
    callFrames: [{ callFrameId: '1.1.0', location: { scriptId: 'root-commit-script' } }],
  };
  await fixture.emit('Debugger.paused', {
    ...params,
    reason: 'instrumentation',
    data: { scriptId: 'root-commit-script' },
  });
  const gate = fixture.connection.debuggerGate;
  const state = gate.states.get(11);
  const pause = state.pause;
  const resumed = fixture.calls.filter(({ method }) => method === 'Debugger.resume').length;
  const tree = fixture.connection.contentTree.bind(fixture.connection);
  const releases = [];
  let started;
  const entering = new Promise((resolve) => {
    started = resolve;
  });
  let reads = 0;
  let block = true;
  fixture.connection.contentTree = async (...args) => {
    const result = await tree(...args);
    assert.equal(result.frameTree.childFrames[0].frame.url, 'https://ordinary.test/child');
    reads++;
    if (block) {
      await new Promise((resolve) => {
        releases.push(resolve);
        started();
      });
    }
    return result;
  };
  const normal = fixture.emit('Debugger.paused', params);
  await entering;
  return {
    fixture,
    gate,
    state,
    pause,
    resumed,
    normal,
    reads: () => reads,
    commit: (frameId, url = 'https://ordinary.test/child') =>
      fixture.api.webNavigation.onCommitted.emit({ tabId: 11, frameId, url }),
    release() {
      block = false;
      for (const resolve of releases) resolve();
    },
  };
}

const published = (row) =>
  row.fixture.messages.filter(({ method }) => method === 'Debugger.paused').length;
const resumes = (row) =>
  row.fixture.calls.filter(({ method }) => method === 'Debugger.resume').length;

test('675 ordinary same-process child commit holds an unpublished root pause for a fresh proof and one publication', async (t) => {
  const row = await committing(t);
  const before = row.reads();
  await row.commit(1);
  await new Promise(setImmediate);
  assert.equal(row.gate.states.get(11), row.state);
  assert.ok(row.pause.holding);
  assert.ok(row.reads() > before);
  assert.equal(published(row), 0);
  assert.equal(resumes(row), row.resumed);
  row.release();
  await row.normal;
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(row.pause.published, true);
  assert.equal(published(row), 1);
  assert.equal(
    row.fixture.messages.filter(({ method }) => method === 'Debugger.scriptParsed').length,
    1
  );
});

for (const [name, frameId, url] of [
  ['protected child', 1, 'https://vault.sliccy.ai/'],
  ['error child', 1, 'chrome-error://chromewebdata/'],
  ['main frame', 0, 'https://ordinary.test/next'],
]) {
  test(`675 ${name} commit still drops the unpublished root pause immediately`, async (t) => {
    const row = await committing(t);
    await row.commit(frameId, url);
    await new Promise(setImmediate);
    assert.equal(row.gate.states.has(11), false);
    assert.ok(resumes(row) > row.resumed);
    assert.equal(published(row), 0);
    row.release();
    await row.normal;
    assert.equal(published(row), 0);
  });
}

test('675 a foreign world at child commit still drops the unpublished root pause', async (t) => {
  const row = await committing(t);
  row.fixture.connection.tabState(11).worlds.foreign = true;
  await row.commit(1);
  await new Promise(setImmediate);
  assert.equal(row.gate.states.has(11), false);
  assert.ok(resumes(row) > row.resumed);
  assert.equal(published(row), 0);
  row.release();
  await row.normal;
});

test('675 repeated child commits cannot reset the held root one-second cap or publish after expiry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const row = await committing(t);
  await row.commit(1);
  await new Promise(setImmediate);
  assert.ok(row.pause.holding);
  const deadline = row.pause.deadline;
  t.mock.timers.tick(500);
  await row.commit(2);
  assert.equal(row.pause.deadline, deadline);
  t.mock.timers.tick(499);
  await row.commit(3);
  assert.equal(row.pause.deadline, deadline);
  assert.equal(resumes(row), row.resumed);
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.equal(row.state.pause, null);
  assert.ok(resumes(row) > row.resumed);
  assert.equal(published(row), 0);
  row.release();
  await row.normal;
  await new Promise(setImmediate);
  assert.equal(published(row), 0);
});
