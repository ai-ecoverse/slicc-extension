import { backend } from './cdp-675-extension-backend.mjs';

export async function framesWitness(t, outcome = 'ordinary') {
  const fixture = await backend();
  t.after(fixture.close);
  await fixture.lease();
  const gate = fixture.connection.debuggerGate;
  const tab = fixture.connection.tabState(11);
  tab.debuggerChildren.add('remote-session');
  tab.debuggerChildInfo.set('remote-session', {
    target: 'remote',
    type: 'iframe',
    url: 'https://other.test/',
    generation: 'ordinary-document',
    revision: tab.debuggerRevision,
  });
  tab.frames.set('remote', true);
  const frames = [
    { frameId: 0, parentFrameId: -1, documentId: 'native-root', url: 'https://ordinary.test/' },
    { frameId: 1, parentFrameId: 0, documentId: 'native-child', url: 'https://other.test/' },
  ];
  fixture.api.webNavigation.getAllFrames = async () => structuredClone(frames);
  const send = fixture.api.debugger.sendCommand;
  fixture.api.debugger.sendCommand = async (source, method, params) =>
    method === 'DOM.getFrameOwner' ? { backendNodeId: 10 } : send(source, method, params);
  await gate.placeChildren(11);
  await fixture.emit('Debugger.scriptParsed', {
    scriptId: 'final-frame-read',
    executionContextId: 1,
    url: 'https://ordinary.test/script.js',
    embedderName: 'https://ordinary.test/script.js',
  });
  const params = {
    reason: 'other',
    callFrames: [{ callFrameId: '1.1.0', location: { scriptId: 'final-frame-read' } }],
  };
  await fixture.emit('Debugger.paused', {
    ...params,
    reason: 'instrumentation',
    data: { scriptId: 'final-frame-read' },
  });
  const state = gate.states.get(11);
  const pause = state.pause;
  pause.deadline = Date.now() + 1000;
  const deadline = pause.deadline;
  const resumed = fixture.calls.filter(({ method }) => method === 'Debugger.resume').length;
  let reads = 0;
  let release;
  let repeated = 0;
  let blocked = false;
  const moved = new Set();
  const originalFrames = fixture.connection.frames.bind(fixture.connection);
  fixture.connection.frames = (...args) => {
    reads++;
    return originalFrames(...args);
  };
  fixture.api.webNavigation.getAllFrames = async () => {
    if ((reads === 2 || (outcome === 'repeat' && reads > 2)) && !moved.has(reads)) {
      moved.add(reads);
      repeated++;
      await fixture.api.debugger.onEvent.emit(
        { tabId: 11, sessionId: 'remote-session' },
        'Page.frameNavigated',
        { frame: { id: 'remote', loaderId: 'child-document', url: frames[1].url } }
      );
      if (outcome === 'protected') frames[1].url = 'https://vault.sliccy.ai/';
    } else if (reads === 3 && !blocked) {
      blocked = true;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return structuredClone(frames);
  };
  await fixture.emit('Debugger.paused', params);
  await new Promise(setImmediate);
  return {
    fixture,
    gate,
    tab,
    state,
    pause,
    deadline,
    resumed,
    release: () => release?.(),
    get reads() {
      return reads;
    },
    get repeated() {
      return repeated;
    },
  };
}
