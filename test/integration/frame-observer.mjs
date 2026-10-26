import assert from 'node:assert/strict';

export async function waitErrorFrame(chrome, targetId, prefix = '') {
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const { frameTree } = await chrome.cdp.send('Page.getFrameTree', {}, sessionId);
      const frame = frameTree.frame;
      if (
        frame.url === 'chrome-error://chromewebdata/' &&
        typeof frame.unreachableUrl === 'string' &&
        frame.unreachableUrl.startsWith(prefix)
      )
        return frame;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('fixture commit');
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }
}
