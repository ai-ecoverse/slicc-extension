import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function stampPageVersion(directory, version) {
  const path = join(directory, 'seven-gate-main.js');
  const prefix = 'globalThis.__sliccSeven = ';
  const source = readFileSync(path, 'utf8');
  const seven = JSON.parse(source.slice(prefix.length, -2));
  writeFileSync(path, `${prefix}${JSON.stringify({ ...seven, version })};\n`);
}
