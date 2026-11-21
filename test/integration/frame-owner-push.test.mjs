import assert from 'node:assert/strict';
import test from 'node:test';
import { backend } from './fixtures/cdp-675-extension-backend.mjs';

const NOT_FOUND = '{"code":-32000,"message":"Frame with the given id was not found."}';

function tree(protectedOwner) {
  const iframe = (backendNodeId, frameId, src) => ({
    backendNodeId,
    nodeType: 1,
    nodeName: 'IFRAME',
    localName: 'iframe',
    nodeValue: '',
    frameId,
    attributes: ['src', src],
  });
  const body = {
    backendNodeId: 4,
    nodeType: 1,
    nodeName: 'BODY',
    localName: 'body',
    nodeValue: '',
    attributes: [],
    children: [
      iframe(10, 'child', 'https://other.test/'),
      ...(protectedOwner ? [iframe(11, 'vault-child', 'https://vault.sliccy.ai/private')] : []),
    ],
  };
  const html = {
    backendNodeId: 2,
    nodeType: 1,
    nodeName: 'HTML',
    localName: 'html',
    nodeValue: '',
    attributes: [],
    children: [body],
  };
  return {
    backendNodeId: 1,
    nodeType: 9,
    nodeName: '#document',
    localName: '',
    nodeValue: '',
    documentURL: 'https://ordinary.test/',
    children: [html],
  };
}

function chromeDom(root, emit) {
  const parents = new Map();
  const index = (node, parent) => {
    parents.set(node, parent);
    for (const child of node.children ?? []) index(child, node);
  };
  index(root, null);
  const bound = new Map();
  const pushed = new Set();
  let next = 0;
  let enabled = false;
  const bind = (node) => {
    if (!bound.has(node)) bound.set(node, ++next);
    return bound.get(node);
  };
  const build = (node, depth) => {
    const { children, ...rest } = node;
    const out = { ...rest, nodeId: bind(node), childNodeCount: children?.length ?? 0 };
    if (children && depth > 0) {
      pushed.add(node);
      out.children = children.map((child) => build(child, depth - 1));
    }
    return out;
  };
  const owner = (frameId) => {
    const pending = [root];
    while (pending.length) {
      const node = pending.pop();
      if (node.nodeType === 1 && node.frameId === frameId) return node;
      pending.push(...(node.children ?? []));
    }
    return undefined;
  };
  return {
    enable() {
      enabled = true;
      return {};
    },
    getDocument({ depth = 2 } = {}) {
      enabled = true;
      bound.clear();
      pushed.clear();
      return { root: build(root, depth === -1 ? Number.MAX_SAFE_INTEGER : depth) };
    },
    async getFrameOwner({ frameId }) {
      const node = owner(frameId);
      if (!node) throw new Error(NOT_FOUND);
      if (!enabled || !bound.has(root)) return { backendNodeId: node.backendNodeId };
      const path = [];
      for (let parent = parents.get(node); parent; parent = parents.get(parent)) {
        path.push(parent);
        if (bound.has(parent)) break;
      }
      for (const parent of path.reverse()) {
        if (!bound.has(parent) || pushed.has(parent)) continue;
        pushed.add(parent);
        await emit('DOM.setChildNodes', {
          parentId: bound.get(parent),
          nodes: parent.children.map((child) => build(child, 0)),
        });
      }
      return { backendNodeId: node.backendNodeId, nodeId: bound.get(node) };
    },
    nodeId(backendNodeId) {
      for (const [node, id] of bound) if (node.backendNodeId === backendNodeId) return id;
      return undefined;
    },
  };
}

async function page(t, { protectedOwner = false } = {}) {
  const fixture = await backend();
  t.after(fixture.close);
  fixture.api.webNavigation.getAllFrames = async () => [
    { frameId: 0, parentFrameId: -1, documentId: 'native-root', url: 'https://ordinary.test/' },
    { frameId: 1, parentFrameId: 0, documentId: 'native-child', url: 'https://other.test/' },
  ];
  const dom = chromeDom(tree(protectedOwner), fixture.emit);
  const original = fixture.api.debugger.sendCommand;
  fixture.api.debugger.sendCommand = async (source, method, params) => {
    if (method === 'Page.getNavigationHistory')
      return {
        currentIndex: 0,
        entries: [{ id: 1, url: 'https://ordinary.test/', title: 'ordinary' }],
      };
    if (method === 'Runtime.evaluate' && params.expression === '({})')
      return { result: { type: 'object', objectId: '1.1.1' } };
    if (!source?.sessionId && method === 'DOM.enable') return dom.enable(params);
    if (!source?.sessionId && method === 'DOM.getDocument') return dom.getDocument(params);
    if (!source?.sessionId && method === 'DOM.getFrameOwner') {
      fixture.calls.push({ source, method, params });
      return dom.getFrameOwner(params);
    }
    return original(source, method, params);
  };
  await fixture.command('Runtime.enable');
  await fixture.emit('Target.attachedToTarget', {
    sessionId: 'child-session',
    targetInfo: { targetId: 'child', type: 'iframe', url: 'https://other.test/' },
  });
  return { ...fixture, dom };
}

function pushes(messages, from) {
  return messages.slice(from).filter(({ method }) => method === 'DOM.setChildNodes');
}

test('fake getFrameOwner models Chromium push-only-when-bound, from source, not measured: frames() reads the iframe owner without pushing nodes to a client that has not bound the DOM tree', async (t) => {
  const fixture = await page(t);
  const before = fixture.messages.length;
  const reply = await fixture.connection.frames(11);
  assert.deepEqual(reply.remoteOwners, [{ frameId: 'child', backendNodeId: 10 }]);
  assert.deepEqual(reply.localFrames, ['root']);
  assert.ok(fixture.calls.some(({ method }) => method === 'DOM.getFrameOwner'));
  assert.equal(fixture.messages.length, before);
});

test('fake getFrameOwner models Chromium push-only-when-bound, from source, not measured: frames() reads the iframe owner on the shared session, and a client that bound the DOM tree receives the owner path', async (t) => {
  const fixture = await page(t);
  const document = await fixture.command('DOM.getDocument', { depth: 1 });
  assert.equal(document.error, undefined);
  const before = fixture.messages.length;
  const reply = await fixture.connection.frames(11);
  assert.deepEqual(reply.remoteOwners, [{ frameId: 'child', backendNodeId: 10 }]);
  const events = pushes(fixture.messages, before);
  assert.deepEqual(
    events.map(({ params }) => params.nodes.map((node) => node.backendNodeId)),
    [[4], [10]]
  );
  assert.equal(events[0].params.parentId, document.result.root.children[0].nodeId);
  assert.equal(events[1].params.parentId, fixture.dom.nodeId(4));
  assert.equal(
    fixture.messages.slice(before).some(({ method }) => method === 'DOM.documentUpdated'),
    false
  );
  const again = fixture.messages.length;
  assert.deepEqual(await fixture.connection.frames(11), reply);
  assert.equal(fixture.messages.length, again);
});

test('fake getFrameOwner models Chromium push-only-when-bound, from source, not measured: a DOM.setChildNodes event that carries a protected iframe owner is not delivered to the client', async (t) => {
  const fixture = await page(t, { protectedOwner: true });
  const document = await fixture.command('DOM.getDocument', { depth: 1 });
  assert.equal(document.error, undefined);
  const before = fixture.messages.length;
  const reply = await fixture.connection.frames(11);
  assert.deepEqual(reply.remoteOwners, [{ frameId: 'child', backendNodeId: 10 }]);
  const events = pushes(fixture.messages, before);
  assert.deepEqual(
    events.map(({ params }) => params.nodes.map((node) => node.backendNodeId)),
    [[4]]
  );
  assert.doesNotMatch(JSON.stringify(fixture.messages.slice(before)), /vault|private/);
  const html = document.result.root.children[0].nodeId;
  const direct = fixture.messages.length;
  await fixture.emit('DOM.setChildNodes', {
    parentId: html,
    nodes: [
      {
        nodeId: 90,
        backendNodeId: 90,
        nodeType: 1,
        nodeName: 'IFRAME',
        localName: 'iframe',
        nodeValue: '',
        attributes: ['src', 'https://vault-preview.sliccy.ai/frame'],
      },
    ],
  });
  assert.equal(fixture.messages.length, direct);
  await fixture.emit('DOM.attributeModified', { nodeId: html, name: 'lang', value: 'en' });
  assert.deepEqual(
    fixture.messages.slice(direct).map(({ method }) => method),
    ['DOM.attributeModified']
  );
});

test("fake getFrameOwner models Chromium push-only-when-bound, from source, not measured: frames() refuses when Chrome does not find a child's owner frame", async (t) => {
  const fixture = await page(t);
  await fixture.emit('Target.attachedToTarget', {
    sessionId: 'gone-session',
    targetInfo: { targetId: 'gone', type: 'iframe', url: 'https://third.test/' },
  });
  fixture.api.webNavigation.getAllFrames = async () => [
    { frameId: 0, parentFrameId: -1, documentId: 'native-root', url: 'https://ordinary.test/' },
    { frameId: 1, parentFrameId: 0, documentId: 'native-child', url: 'https://other.test/' },
    { frameId: 2, parentFrameId: 0, documentId: 'native-gone', url: 'https://third.test/' },
  ];
  await fixture.command('DOM.getDocument', { depth: 1 });
  await assert.rejects(fixture.connection.frames(11), {
    message: 'slicc: refused: unsettled frame list',
  });
});
