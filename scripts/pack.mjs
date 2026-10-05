import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';

const root = cwd();
const src = join(root, 'extension');
const outDir = join(root, 'artifacts');
const zipPath = join(outDir, 'slicc-extension.zip');
mkdirSync(outDir, { recursive: true });
execFileSync('zip', ['-r', '-X', '-q', zipPath, '.', '-x', '_metadata/*'], {
  cwd: src,
  stdio: 'inherit',
});
process.stdout.write(`${zipPath}\n`);
