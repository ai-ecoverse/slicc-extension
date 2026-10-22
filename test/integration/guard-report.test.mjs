import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { carrier, carriers, entries, report, strict } from './guard/guard.mjs';

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

function rows(status, extra = {}) {
  return set.vectors.flatMap((vector) =>
    vector.targets.map((target) => ({
      id: vector.id,
      target,
      variant: 'prompt',
      transport: 'seven',
      control: status,
      guarded: status,
      live: status,
      errors: [],
      ...extra,
    }))
  );
}

test('strict verdicts take a full PASS and refuse an empty run, an all-skip run and a skip without a reason', () => {
  assert.deepEqual(strict(report(set, rows('pass'), 'sha', 'seven')), []);
  assert.match(strict(report(set, [], 'sha', 'seven')).join('\n'), /no rows ran/);
  const skipped = strict(report(set, rows('skip', { reason: 'not-applicable' }), 'sha', 'seven'));
  assert.match(skipped.join('\n'), /all \d+ rows skipped or not run/);
  const bare = rows('pass');
  bare[0] = { ...bare[0], control: 'skip', guarded: 'skip', live: 'skip' };
  assert.match(strict(report(set, bare, 'sha', 'seven')).join('\n'), /skip without a reason/);
});

test('strict verdicts name failed, incomplete, forged and missing rows and a missing GUARD-PASS line', () => {
  const failed = rows('pass');
  failed[0] = { ...failed[0], guarded: 'fail', why: 'leak' };
  const listed = strict(report(set, failed, 'sha', 'seven')).join('\n');
  assert.match(listed, /failed: .* leak/);
  assert.match(listed, /no GUARD-PASS line/);
  const incomplete = rows('pass');
  incomplete[0] = { ...incomplete[0], live: 'incomplete', why: 'probe' };
  assert.match(strict(report(set, incomplete, 'sha', 'seven')).join('\n'), /incomplete: .* probe/);
  const forged = rows('pass');
  const at = forged.findIndex((entry) => entry.id === runnable.id);
  forged[at] = { ...forged[at], control: 'not-run', guarded: 'not-run', live: 'not-run' };
  assert.match(strict(report(set, forged, 'sha', 'seven')).join('\n'), /forged: /);
  assert.match(strict(report(set, rows('pass').slice(1), 'sha', 'seven')).join('\n'), /missing: /);
});

test('the guard files cover each transport and each published variant exactly once', async () => {
  const files = (await readdir(new URL('./', import.meta.url)))
    .filter((file) => /^guard-.+-(prompt|lagging)\.test\.mjs$/.test(file))
    .sort();
  const want = Object.keys(entries)
    .flatMap((transport) =>
      Object.keys(set.variants).map((variant) => `guard-${transport}-${variant}.test.mjs`)
    )
    .sort();
  assert.deepEqual(files, want);
  for (const file of files) {
    const [, transport, variant] = /^guard-(.+)-(prompt|lagging)\.test\.mjs$/.exec(file);
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(text, new RegExp(`runGuard\\('${transport}', '${variant}'\\)`));
  }
});
