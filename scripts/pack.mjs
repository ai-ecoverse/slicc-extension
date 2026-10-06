import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, cwd } from 'node:process';

const root = cwd();
const outDir = join(root, 'artifacts');
const zipPath = join(outDir, 'slicc-extension.zip');
const stage = mkdtempSync(join(tmpdir(), 'slicc-extension-pack-'));
const version = argv[2];
if (version !== undefined && !/^\d+(\.\d+){0,3}$/.test(version)) {
  throw new Error(`not a Chrome extension version: ${version}`);
}
cpSync(join(root, 'extension'), stage, {
  recursive: true,
  filter: (path) => !path.includes('_metadata'),
});
if (version) {
  const manifest = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8'));
  writeFileSync(
    join(stage, 'manifest.json'),
    `${JSON.stringify({ ...manifest, version }, null, 2)}\n`
  );
}
mkdirSync(outDir, { recursive: true });
rmSync(zipPath, { force: true });
execFileSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: stage, stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
process.stdout.write(`${zipPath}\n`);
