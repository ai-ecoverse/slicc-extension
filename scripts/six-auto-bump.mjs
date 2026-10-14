import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, parseSixVersion, resolveLatestV6Tag } from './check-six-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SLICC_REPO = 'https://github.com/ai-ecoverse/slicc.git';
const BUNDLE_FILES = ['extension/six-sw.js', 'extension/sidepanel.js', 'extension/secrets.js'];

export function resolveLatestTag(sliccRepoUrl) {
  const raw = execFileSync('git', ['ls-remote', '--tags', sliccRepoUrl, 'refs/tags/v6.*'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return resolveLatestV6Tag(raw);
}

export function hashBundles(rootDir, files) {
  const hashes = {};
  for (const f of files) {
    const content = readFileSync(resolve(rootDir, f));
    hashes[f] = createHash('sha256').update(content).digest('hex');
  }
  return hashes;
}

export function bundlesChanged(before, after) {
  const changed = [];
  for (const f of Object.keys(before)) {
    if (before[f] !== after[f]) changed.push(f);
  }
  return changed;
}

export function isNewerTag(currentTag, latestTag) {
  const currentVersion = parseSixVersion(currentTag);
  const latestVersion = parseSixVersion(latestTag);
  if (!currentVersion || !latestVersion) return false;
  return compareVersions(latestVersion, currentVersion) > 0;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dryRun = process.argv.includes('--dry-run');
  const currentTag = readFileSync(resolve(root, '.six-tag'), 'utf8').trim();

  process.stdout.write(`Current six tag: ${currentTag}\n`);

  const latestTag = resolveLatestTag(SLICC_REPO);
  if (!latestTag) {
    process.stdout.write('Could not resolve latest v6.* tag\n');
    process.exit(0);
  }
  process.stdout.write(`Latest v6 tag: ${latestTag}\n`);

  if (!isNewerTag(currentTag, latestTag)) {
    process.stdout.write(`Current ${currentTag} is up to date with ${latestTag}\n`);
    process.exit(0);
  }

  process.stdout.write(
    `${latestTag} is newer than ${currentTag} — building both to compare bundles\n`
  );

  process.stdout.write(`Building at current tag (${currentTag})…\n`);
  execFileSync('npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SIX_REF: currentTag },
  });
  const before = hashBundles(root, BUNDLE_FILES);
  for (const [f, h] of Object.entries(before)) {
    process.stdout.write(`  ${f}: ${h}\n`);
  }

  process.stdout.write(`Building at latest tag (${latestTag})…\n`);
  execFileSync('npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SIX_REF: latestTag },
  });
  const after = hashBundles(root, BUNDLE_FILES);
  for (const [f, h] of Object.entries(after)) {
    process.stdout.write(`  ${f}: ${h}\n`);
  }

  const changed = bundlesChanged(before, after);
  if (changed.length === 0) {
    process.stdout.write(
      `${latestTag} is newer than ${currentTag} but built bundles are identical — skipping bump\n`
    );
    process.exit(0);
  }

  process.stdout.write(`Bundles differ: ${changed.join(', ')}\n`);

  if (dryRun) {
    process.stdout.write('Dry run — would bump .six-tag and dispatch release\n');
    process.exit(0);
  }

  writeFileSync(resolve(root, '.six-tag'), latestTag);
  process.stdout.write(`Updated .six-tag to ${latestTag}\n`);

  const setOutput = process.env.GITHUB_OUTPUT;
  if (setOutput) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(setOutput, `bump=true\n`);
    appendFileSync(setOutput, `new_tag=${latestTag}\n`);
  }
}
