import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundles = ['six-sw.js', 'sidepanel.js', 'secrets.js'];
let scratch;

after(() => scratch && rm(scratch, { recursive: true, force: true }));

test('six bundles rebuilt in a fresh tree are byte-identical to the build', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'slicc-extension-rebuild-'));
  for (const dir of ['scripts', 'six'])
    await cp(join(root, dir), join(scratch, dir), { recursive: true });
  for (const file of ['tsconfig.json', 'package.json'])
    await cp(join(root, file), join(scratch, file));
  await mkdir(join(scratch, 'extension'));
  await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  execFileSync(process.execPath, [join(scratch, 'scripts/build-six.mjs')], {
    cwd: scratch,
    stdio: 'pipe',
  });
  for (const name of bundles) {
    const built = await readFile(join(root, 'extension', name));
    const rebuilt = await readFile(join(scratch, 'extension', name));
    assert.ok(built.equals(rebuilt), `${name} differs between the build and a rebuild`);
  }
});
