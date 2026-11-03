import assert from 'node:assert/strict';

export async function committedFrame(cdp, parent, url) {
  const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
  const matches = targetInfos.filter((info) => info.type === 'iframe' && info.url === url);
  assert.equal(matches.length, 1, 'raw control needs the exact loaded cross-process iframe target');
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: matches[0].targetId,
    flatten: true,
  });
  assert.ok(sessionId, 'raw child observer must attach');
  try {
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
    const frame = frameTree?.frame;
    assert.equal(frame?.url, url, 'raw child target must prove the requested document committed');
    assert.equal(frame.securityOrigin, new URL(url).origin);
    assert.ok(typeof frame.id === 'string' && frame.id);
    assert.ok(typeof frame.loaderId === 'string' && frame.loaderId);
    await parent.send('DOM.getDocument', { depth: 1, pierce: false });
    const owner = await parent.send('DOM.getFrameOwner', { frameId: frame.id });
    assert.ok(
      Number.isSafeInteger(owner.backendNodeId) && owner.backendNodeId > 0,
      'raw child must belong to the fixture parent'
    );
    return frame;
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId });
  }
}

export function assertFrameReply(reply, committedChild, protectedChild) {
  const serialized = JSON.stringify(reply.snapshot ?? { error: reply.error });
  assert.doesNotMatch(JSON.stringify(reply), /vault\.sliccy\.ai|FRAME_REPLY_CANARY/);
  assert.doesNotMatch(
    serialized,
    /https?:\/\/|vault\.sliccy\.ai|ordinary\.test|other\.test|FRAME_REPLY_CANARY|FRAME_REPLY_ORDINARY/
  );
  assert.doesNotMatch(serialized, /"(?:url|origin|securityOrigin|documentId|rootDocumentId)"/);
  if (protectedChild) {
    assert.equal(reply.error, 'slicc: refused: unsettled frame list');
    assert.equal(reply.snapshot, undefined);
    assert.deepEqual(Object.keys(reply).sort(), ['error', 'events']);
    assert.ok(!JSON.stringify(reply).includes(committedChild.id));
  } else {
    assert.equal(reply.error, undefined);
    assert.equal(reply.snapshot.version, 2);
    assert.equal(reply.snapshot.frames.length, 2);
    assert.equal(reply.snapshot.localFrames.length + reply.snapshot.remoteOwners.length, 2);
    assert.ok(reply.snapshot.frames.every((frame) => frame.kind === 'ordinary'));
  }
  assert.equal(
    reply.events.some((message) => message.privateFrames || message.result?.frames),
    false
  );
}
