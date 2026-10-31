import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { protectedOrigins } from '../../extension/protected.mjs';
import { protectedRules } from '../../extension/protected-rules.js';
import { strictGuard } from '../../extension/shield.js';

const vectors = JSON.parse(
  await readFile(new URL(import.meta.resolve('@ai-ecoverse/slicc-browsers/protected.json')))
);

test('the extension classifier has no ordinary shared premise origin or page', () => {
  const guard = strictGuard(protectedOrigins(protectedRules, vectors.origins), protectedRules);
  const cases = vectors.urls.filter((vector) => vector.url.endsWith('/cdp-premise'));
  assert.equal(cases.length, 10);
  for (const item of cases) {
    assert.equal(item.protected, true, item.url);
    assert.equal(guard.url(item.url), true, item.url);
    assert.equal(guard.target({ url: item.url, type: 'page' }), true, item.url);
  }
});
