import assert from 'node:assert/strict';
import { test } from 'node:test';
import { secondClient } from './guard/run.mjs';

for (const transport of ['six-bridge', 'seven'])
  test(`guard harness: a renewed ${transport} client gets a working session`, {
    timeout: 120000,
  }, async () => {
    const { targetInfos } = await secondClient(transport, 'guarded');
    assert.ok(Array.isArray(targetInfos));
  });

test('six-bridge: a second client tab while the leader is open is refused at once', {
  timeout: 120000,
}, async () => {
  const started = Date.now();
  await assert.rejects(secondClient('six-bridge'), /bridge refused: sender-tab-not-leader/);
  assert.ok(Date.now() - started < 30000);
});
