import { readdir, readFile, writeFile } from 'node:fs/promises';
import { carriers, report } from './guard.mjs';

const set = JSON.parse(
  await readFile(
    new URL('../../../node_modules/@ai-ecoverse/slicc-browsers/guard-vectors.json', import.meta.url)
  )
);
const dir = new URL('../../../artifacts/guard/', import.meta.url);
const shards = [];
for (const name of await readdir(dir)) {
  if (!name.endsWith('.json') || name.startsWith('summary-')) continue;
  shards.push(JSON.parse(await readFile(new URL(name, dir))));
}
const expected = (process.env.GUARD_EXPECT ?? 'seven,six-bridge').split(',');
const variants = (process.env.GUARD_VARIANT ?? 'prompt,lagging').split(',');
let ok = true;
for (const transport of expected) {
  const mine = shards.filter((shard) => shard.transport === transport);
  const shas = [...new Set(mine.map((shard) => shard.sha))];
  const covered = [...new Set(mine.flatMap((shard) => shard.variants))].sort();
  const results = mine.flatMap((shard) => shard.results);
  const value = report(set, results, shas[0] ?? 'unknown', transport);
  const complete = shas.length === 1 && variants.every((variant) => covered.includes(variant));
  const pass = value.pass && complete;
  const tally = carriers(mine.map((shard) => shard.carriers));
  ok &&= pass;
  await writeFile(
    new URL(`summary-${transport}.json`, dir),
    `${JSON.stringify({ transport, variants: covered, sha: shas[0], carriers: tally, ...value, pass }, null, 2)}\n`
  );
  console.log(
    complete
      ? value.line
      : `GUARD-FAIL ${transport}: shards ${covered.join(',')} of ${shas.join(',')}`
  );
  console.log(`  skips ${JSON.stringify(value.skips)}`);
  console.log(`  carriers ${JSON.stringify(tally)}`);
  console.log(
    `  passed ${value.passed} (${value.passedClean} without ran/notes), not-run ${value.notRun.length} ids, failed ${value.failed.length}, incomplete ${value.incomplete.length}, forged ${value.forged.length}, missing ${value.missing.length}`
  );
  for (const row of value.failed)
    console.log(`  fail ${row.id} ${row.target} ${row.variant}: ${row.why}`);
  for (const row of value.incomplete)
    console.log(`  incomplete ${row.id} ${row.target} ${row.variant}: ${row.why}`);
  for (const row of value.forged)
    console.log(`  forged ${row.id} ${row.target} ${row.variant}: ${row.why}`);
}
process.exitCode = ok ? 0 : 1;
