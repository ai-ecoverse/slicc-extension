import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, parseSixVersion, resolveLatestV6Tag } from './check-six-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function deriveSixPaths(buildScript) {
  const paths = new Set();
  const pkgPatterns = [
    /packages\/chrome-extension/g,
    /packages\/shared-ts/g,
    /packages\/webapp/g,
    /packages\/cherry/g,
  ];
  for (const pattern of pkgPatterns) {
    if (pattern.test(buildScript)) {
      const dir = pattern.source.replace(/\\/g, '');
      paths.add(dir);
    }
  }
  const resolveMatches = buildScript.matchAll(
    /resolve\(sixDir,\s*'(packages\/[^']+?)(?:\/[^']*)?'\)/g
  );
  for (const m of resolveMatches) {
    const top = m[1].split('/').slice(0, 2).join('/');
    paths.add(top);
  }
  const relImportMatch = buildScript.match(/args\.path\.replace\(['"]\.\.\/\.\.\/([^/]+)\/src\//);
  if (relImportMatch) {
    paths.add(`packages/${relImportMatch[1]}`);
  }
  return [...paths].sort();
}

export function resolveLatestTag(sliccRepoUrl) {
  const raw = execFileSync('git', ['ls-remote', '--tags', sliccRepoUrl, 'refs/tags/v6.*'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return resolveLatestV6Tag(raw);
}

export function diffHasRelevantChanges(sliccRepoUrl, oldTag, newTag, relevantPaths) {
  const tmp = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['clone', '--bare', '--filter=blob:none', '--no-tags', sliccRepoUrl, tmp], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync(
      'git',
      [
        '-C',
        tmp,
        'fetch',
        'origin',
        `+refs/tags/${oldTag}:refs/tags/${oldTag}`,
        `+refs/tags/${newTag}:refs/tags/${newTag}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const diff = execFileSync(
      'git',
      [
        '-C',
        tmp,
        'diff',
        '--name-only',
        `refs/tags/${oldTag}`,
        `refs/tags/${newTag}`,
        '--',
        ...relevantPaths,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    return { changed: diff.length > 0, files: diff ? diff.split('\n') : [] };
  } finally {
    execFileSync('rm', ['-rf', tmp]);
  }
}

export function shouldBump({ currentTag, latestTag, relevantPaths, sliccRepoUrl }) {
  const currentVersion = parseSixVersion(currentTag);
  const latestVersion = parseSixVersion(latestTag);

  if (!currentVersion || !latestVersion) {
    return { bump: false, reason: `Invalid tag: current=${currentTag} latest=${latestTag}` };
  }

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return { bump: false, reason: `Current ${currentTag} is up to date with ${latestTag}` };
  }

  const { changed, files } = diffHasRelevantChanges(
    sliccRepoUrl,
    currentTag,
    latestTag,
    relevantPaths
  );

  if (!changed) {
    return {
      bump: false,
      reason: `${latestTag} is newer than ${currentTag} but no extension-relevant files changed in: ${relevantPaths.join(', ')}`,
    };
  }

  return { bump: true, reason: `Bumping ${currentTag} → ${latestTag}`, files, latestTag };
}

const SLICC_REPO = 'https://github.com/ai-ecoverse/slicc.git';

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dryRun = process.argv.includes('--dry-run');
  const currentTag = readFileSync(resolve(root, '.six-tag'), 'utf8').trim();
  const buildScript = readFileSync(resolve(root, 'scripts/build-six.mjs'), 'utf8');
  const relevantPaths = deriveSixPaths(buildScript);

  process.stdout.write(`Current six tag: ${currentTag}\n`);
  process.stdout.write(`Relevant paths: ${relevantPaths.join(', ')}\n`);

  const latestTag = resolveLatestTag(SLICC_REPO);
  if (!latestTag) {
    process.stdout.write('Could not resolve latest v6.* tag\n');
    process.exit(0);
  }
  process.stdout.write(`Latest v6 tag: ${latestTag}\n`);

  const result = shouldBump({
    currentTag,
    latestTag,
    relevantPaths,
    sliccRepoUrl: SLICC_REPO,
  });

  process.stdout.write(`${result.reason}\n`);

  if (!result.bump) {
    process.exit(0);
  }

  if (result.files) {
    process.stdout.write(`Changed files:\n${result.files.map((f) => `  ${f}`).join('\n')}\n`);
  }

  if (dryRun) {
    process.stdout.write('Dry run — skipping build and commit\n');
    process.exit(0);
  }

  const setOutput = process.env.GITHUB_OUTPUT;
  if (setOutput) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(setOutput, `bump=true\n`);
    appendFileSync(setOutput, `new_tag=${result.latestTag}\n`);
  }
}
