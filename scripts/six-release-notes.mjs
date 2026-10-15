import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [tag, sha] = readFileSync(resolve(root, '.six-ref'), 'utf8').trim().split(' ');
process.stdout.write(
  `\n\n---\nBuilt with six ${tag} (${sha})\n\nRoll forward only: this build migrates stored secrets to encrypted storage. Never roll the store listing back to a build without that migration; ship a fixed build forward instead.\n`
);
