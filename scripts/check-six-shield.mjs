import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHIELD_SENTINELS = [
  'request was not paused toward this client',
  'request was not seen by the shield',
];

export function hasSixShield(source) {
  return SHIELD_SENTINELS.every((s) => source.includes(s));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const file = process.argv[2] ?? join(root, 'extension', 'six-sw.js');
  const source = readFileSync(file, 'utf8');
  if (!hasSixShield(source)) {
    process.stderr.write(
      `check-six-shield: ${file} lacks six's CDP shield (slicc#3986); refusing to release the cutover build without it\n`
    );
    process.exit(1);
  }
  process.stdout.write('check-six-shield: six bundle carries the slicc#3986 shield\n');
}
