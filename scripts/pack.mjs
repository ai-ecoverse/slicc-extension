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
const parts = version?.split('.') ?? [];
const valid =
  parts.length <= 4 &&
  parts.every((part) => /^(0|[1-9]\d{0,4})$/.test(part) && Number(part) <= 65535) &&
  parts.some((part) => part !== '0');
if (version !== undefined && !valid) {
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
