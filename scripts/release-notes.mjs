import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { repo, tag, sha } = JSON.parse(readFileSync(resolve(root, 'six/upstream.json'), 'utf8'));
process.stdout.write(
  `\n\n---\nSix bridge built from six/, imported from ${repo} ${tag} (${sha})\n\nRoll forward only: this build migrates stored secrets to encrypted storage. Never roll the store listing back to a build without that migration; ship a fixed build forward instead.\n`
);
