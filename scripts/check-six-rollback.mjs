import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_UPDATE_XML_URL } from './check-live-permissions.mjs';
import {
  compareVersions,
  extractCodebaseUrl,
  extractCrxVersion,
  extractManifestFromZip,
  extractSixTagFromVersionName,
  fetchCrxManifest,
  fetchLiveVersion,
  liveIsSevenBuild,
} from './check-six-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function bundledSixVersion(manifest) {
  const six = extractSixTagFromVersionName(manifest?.version_name);
  if (!six) {
    throw new Error(
      `bundled manifest version_name ${JSON.stringify(manifest?.version_name ?? null)} has no six tag`
    );
  }
  return six;
}

export async function liveSixVersion(opts = {}) {
  const xml = await fetchLiveVersion({ ...opts, url: opts.url ?? LIVE_UPDATE_XML_URL });
  const crxVersion = extractCrxVersion(xml);
  if (!crxVersion) throw new Error('could not parse version from update XML');
  if (!liveIsSevenBuild(crxVersion)) return { crxVersion, six: crxVersion };
  const codebase = extractCodebaseUrl(xml);
  if (!codebase) throw new Error(`live build ${crxVersion} has no codebase URL in update XML`);
  const manifest = await (opts.fetchCrxManifest
    ? opts.fetchCrxManifest(codebase)
    : fetchCrxManifest(codebase, opts));
  const six = extractSixTagFromVersionName(manifest?.version_name);
  if (!six) {
    throw new Error(
      `live build ${crxVersion} version_name ${JSON.stringify(manifest?.version_name ?? null)} has no six tag`
    );
  }
  return { crxVersion, six };
}

export async function checkSixRollback(manifest, opts = {}) {
  let bundled;
  try {
    bundled = bundledSixVersion(manifest);
  } catch (err) {
    return { ok: false, error: `${err.message}. Failing closed.` };
  }
  let live;
  try {
    live = await liveSixVersion(opts);
  } catch (err) {
    return {
      ok: false,
      bundled,
      error: `live six version unreadable: ${err.message}. Failing closed.`,
    };
  }
  if (compareVersions(bundled, live.six) < 0) {
    return {
      ok: false,
      bundled,
      live: live.six,
      liveVersion: live.crxVersion,
      error: `bundled six ${bundled} is older than the live six ${live.six} (live build ${live.crxVersion}); refusing to roll six back`,
    };
  }
  return { ok: true, bundled, live: live.six, liveVersion: live.crxVersion };
}

export async function readZipManifest(path) {
  return extractManifestFromZip(readFileSync(path));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const zip = resolve(process.argv[2] ?? resolve(root, 'artifacts/slicc-extension.zip'));
  let manifest;
  try {
    manifest = await readZipManifest(zip);
  } catch (err) {
    process.stderr.write(`GUARD FAILED: ${zip} manifest unreadable: ${err.message}\n`);
    process.exit(1);
  }
  const result = await checkSixRollback(manifest);
  if (!result.ok) {
    process.stderr.write(`GUARD FAILED: ${result.error}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `Six rollback guard passed: bundled=${result.bundled} live=${result.live} (live build ${result.liveVersion})\n`
  );
}
