import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { carrier, carriers, report } from './guard/guard.mjs';

const set = JSON.parse(
  await readFile(
    new URL('../../node_modules/@ai-ecoverse/slicc-browsers/guard-vectors.json', import.meta.url)
  )
);
const runnable = set.vectors.find((vector) => vector.kind === 'cdp');

function row(status, extra = {}) {
  return {
    id: runnable.id,
    target: runnable.targets[0],
    variant: 'prompt',
    transport: 'seven',
    control: status,
    guarded: status,
    live: status,
    errors: [],
    ...extra,
  };
}

test('the guard report fails and names a not-run row of a runnable vector', () => {
  const value = report(set, [row('not-run')], 'sha', 'seven');
  assert.equal(value.pass, false);
  assert.match(value.line, /^GUARD-FAIL .* forged 1/);
  assert.deepEqual(
    value.forged.map((entry) => entry.id),
    [runnable.id]
  );
});

test('the guard report fails and names a skip with no known reason', () => {
  const value = report(set, [row('skip', { reason: 'flaky' })], 'sha', 'seven');
  assert.equal(value.pass, false);
  assert.deepEqual(
    value.forged.map((entry) => entry.id),
    [runnable.id]
  );
});

test('the guard report lists incomplete rows apart from failed ones', () => {
  const value = report(set, [row('incomplete', { why: 'incomplete: probe' })], 'sha', 'seven');
  assert.equal(value.pass, false);
  assert.deepEqual(value.failed, []);
  assert.deepEqual(
    value.incomplete.map((entry) => entry.why),
    ['incomplete: probe']
  );
});

test('the redirect probes carrier fields are tallied per mode and leg and summed across shards', () => {
  const tally = {};
  const result = { networkBodyPath: 'withheld+tap', requestsTerminated: true, hopsRedacted: true };
  carrier(tally, {
    step: { redirectSecret: 'headers' },
    out: { ok: true, result },
    side: 'guarded',
  });
  carrier(tally, { step: { redirectSecret: 'headers' }, out: { ok: true }, side: 'control' });
  carrier(tally, { step: { redirectSecret: 'body' }, out: { ok: false }, side: 'guarded' });
  carrier(tally, { step: { cdp: 'Page.enable' }, out: { ok: true }, side: 'guarded' });
  assert.deepEqual(tally, {
    'headers guarded networkBodyPath=withheld+tap': 1,
    'headers guarded requestsTerminated=true': 1,
    'headers guarded hopsRedacted=true': 1,
    'headers control networkBodyPath=none': 1,
    'headers control requestsTerminated=none': 1,
    'headers control hopsRedacted=none': 1,
  });
  assert.deepEqual(carriers([tally, undefined, { 'headers guarded hopsRedacted=true': 2 }]), {
    'headers control hopsRedacted=none': 1,
    'headers control networkBodyPath=none': 1,
    'headers control requestsTerminated=none': 1,
    'headers guarded hopsRedacted=true': 3,
    'headers guarded networkBodyPath=withheld+tap': 1,
    'headers guarded requestsTerminated=true': 1,
  });
});
