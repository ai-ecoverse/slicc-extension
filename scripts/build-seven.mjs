import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const require = createRequire(join(root, 'package.json'));
const catalog = require('@ai-ecoverse/slicc-browsers/catalog.json');
const version = require('@ai-ecoverse/slicc-browsers/package.json').version;

export function sevenOf(catalog) {
  const { sitePattern, excludedLabels, excludedLabelPrefixes } = catalog.seven;
  const site = /^\[\*\.\]([a-z0-9.-]+)$/.exec(sitePattern);
  if (!site) throw new Error(`build-seven: unexpected seven.sitePattern ${sitePattern}`);
  const words = [...excludedLabels, ...excludedLabelPrefixes];
  const bad = words.find((w) => typeof w !== 'string' || !/^[a-z0-9-]+$/.test(w));
  if (bad !== undefined) throw new Error(`build-seven: unexpected label ${JSON.stringify(bad)}`);
  return { domain: site[1], excludedLabels, excludedLabelPrefixes };
}

export function excludesOf(seven, sixHosts) {
  const { domain, excludedLabels, excludedLabelPrefixes } = seven;
  return {
    exclude_matches: [
      `https://${domain}/*`,
      ...excludedLabels
        .map((label) => `${label}.${domain}`)
        .filter((host) => !sixHosts.includes(host))
        .map((host) => `https://${host}/*`),
    ],
    exclude_globs: excludedLabelPrefixes.map((prefix) => `https://${prefix}*.${domain}/*`),
  };
}

export function sixHostsOf(manifest) {
  return manifest.externally_connectable.matches
    .filter((m) => m.startsWith('https://'))
    .map((m) => new URL(m.replace('/*', '/')).hostname);
}

function main() {
  const seven = sevenOf(catalog);
  const manifestPath = join(ext, 'manifest.json');
  const before = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(before);
  const excludes = excludesOf(seven, sixHostsOf(manifest));
  let text = before;
  for (const [key, list] of Object.entries(excludes)) {
    const pattern = new RegExp(`"${key}": \\[[^\\]]*\\]`, 'g');
    const found = text.match(pattern)?.length ?? 0;
    if (found !== manifest.content_scripts.length) {
      throw new Error(`build-seven: ${key} appears ${found} times in the manifest`);
    }
    text = text.replace(pattern, `"${key}": ${JSON.stringify(list)}`);
  }
  writeFileSync(manifestPath, text);
  execFileSync(join(root, 'node_modules/.bin/biome'), ['format', '--write', manifestPath], {
    stdio: 'ignore',
  });
  const after = readFileSync(manifestPath, 'utf8');
  if (after !== before && process.env.CI) {
    writeFileSync(manifestPath, before);
    throw new Error(
      `build-seven: extension/manifest.json content_scripts excludes differ from @ai-ecoverse/slicc-browsers@${version}; run npm run build and commit the manifest`
    );
  }
  const data = JSON.stringify(seven);
  writeFileSync(join(ext, 'seven.js'), `export const seven = ${data};\n`);
  for (const gate of ['seven-gate.js', 'seven-gate-main.js']) {
    writeFileSync(join(ext, gate), `globalThis.__sliccSeven = ${data};\n`);
  }
  writeFileSync(
    join(ext, 'protected-rules.js'),
    `export const protectedRules = ${JSON.stringify(catalog.protectedOrigins)};\n`
  );
  process.stdout.write(
    `seven from @ai-ecoverse/slicc-browsers@${version}: excluded ${seven.excludedLabels.join(', ')}; prefixes ${seven.excludedLabelPrefixes.join(', ')}\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
