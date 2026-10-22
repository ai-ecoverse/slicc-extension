import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'main-guard-'));
const linked = join(scratch, 'repo');
symlinkSync(root, linked, 'dir');
after(() => rmSync(scratch, { recursive: true, force: true }));

function run(cwd, script) {
  return execFileSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '' },
  });
}

test('build-seven runs its main through a real path (control) and through a symlinked checkout', () => {
  assert.match(run(root, join(root, 'scripts/build-seven.mjs')), /excluded/);
  assert.match(run(linked, join(linked, 'scripts/build-seven.mjs')), /excluded/);
});

test('isMain is true for the entry script through a symlink and false for an imported module', () => {
  const probe = `import { isMain } from ${JSON.stringify(join(linked, 'scripts/is-main.mjs'))}; process.stdout.write(String(isMain(${JSON.stringify(`file://${join(root, 'scripts/is-main.mjs')}`)}, ${JSON.stringify(join(linked, 'scripts/is-main.mjs'))})) + ' ' + String(isMain(${JSON.stringify(`file://${join(root, 'scripts/build-seven.mjs')}`)}, ${JSON.stringify(join(linked, 'scripts/is-main.mjs'))})));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
  });
  assert.equal(out, 'true false');
});
