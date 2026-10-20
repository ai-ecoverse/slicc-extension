import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { DISCOVERY_IDS, DISCOVERY_SKIP, installedVectors, report } from './guard/guard.mjs';

const require = createRequire(import.meta.url);
const vectors = JSON.parse(
  readFileSync(require.resolve('@ai-ecoverse/slicc-browsers/guard-vectors.json'), 'utf8')
);
const other = 'C2.redirect-secret';
const variants = ['prompt', 'lagging'];
const set = {
  ...vectors,
  variants: Object.fromEntries(variants.map((v) => [v, vectors.variants[v]])),
  vectors: vectors.vectors.filter((v) => [...DISCOVERY_IDS, other].includes(v.id)),
};

function results(transport, failing) {
  return set.vectors.flatMap((vector) =>
    vector.targets.flatMap((target) =>
      variants.map((variant) => {
        const fail = failing.includes(vector.id);
        return {
          id: vector.id,
          target,
          variant,
          transport,
          control: 'pass',
          guarded: fail ? 'fail' : 'pass',
          live: fail ? 'fail' : 'pass',
          why: fail ? 'setDiscoverTargets refused' : undefined,
        };
      })
    )
  );
}

const rows = DISCOVERY_IDS.length * variants.length;

test('the subset under test holds all seven C8.protected ids and one other row', () => {
  assert.deepEqual(set.vectors.map((v) => v.id).sort(), [...DISCOVERY_IDS, other].sort());
});

test('on six-bridge at slicc-browsers 1.13.0 the seven C8.protected ids skip as awaiting targetDiscovery, and skips never count as passes', () => {
  const value = report(set, results('six-bridge', DISCOVERY_IDS), 'sha', 'six-bridge', '1.13.0');
  assert.equal(value.pass, true, value.line);
  assert.match(value.line, /^GUARD-PASS /);
  assert.equal(value.skips[DISCOVERY_SKIP], rows);
  assert.ok(value.line.includes(`${DISCOVERY_SKIP}=${rows}`), value.line);
  assert.equal(value.passed, variants.length, 'only the other row counts as passed');
  assert.deepEqual(value.failed, []);
});

test('the skip reads the installed slicc-browsers version, not a constant', () => {
  const installed = JSON.parse(
    readFileSync(require.resolve('@ai-ecoverse/slicc-browsers/package.json'), 'utf8')
  ).version;
  assert.equal(installedVectors(), installed);
  const value = report(set, results('six-bridge', DISCOVERY_IDS), 'sha', 'six-bridge');
  assert.equal(value.pass, installed === '1.13.0', value.line);
  assert.equal(value.skips[DISCOVERY_SKIP] ?? 0, installed === '1.13.0' ? rows : 0);
});

for (const version of ['1.12.0', '1.13.1', '1.14.0']) {
  test(`on six-bridge at slicc-browsers ${version} the skip does not apply and the failing rows fail the summary`, () => {
    const value = report(set, results('six-bridge', DISCOVERY_IDS), 'sha', 'six-bridge', version);
    assert.equal(value.pass, false, value.line);
    assert.match(value.line, /^GUARD-FAIL /);
    assert.equal(value.skips[DISCOVERY_SKIP], undefined);
    assert.equal(value.failed.length, rows);
  });
}

test('on six-bridge at 1.13.0 another failing row still fails the summary', () => {
  const value = report(
    set,
    results('six-bridge', [...DISCOVERY_IDS, other]),
    'sha',
    'six-bridge',
    '1.13.0'
  );
  assert.equal(value.pass, false, value.line);
  assert.deepEqual([...new Set(value.failed.map((row) => row.id))], [other]);
  assert.equal(value.skips[DISCOVERY_SKIP], rows);
});

test('on seven the same ids are never skipped, at 1.13.0 or any other version', () => {
  for (const version of ['1.13.0', '1.13.1']) {
    const value = report(set, results('seven', DISCOVERY_IDS), 'sha', 'seven', version);
    assert.equal(value.pass, false, value.line);
    assert.equal(value.skips[DISCOVERY_SKIP], undefined);
    assert.equal(value.failed.length, rows);
  }
});
