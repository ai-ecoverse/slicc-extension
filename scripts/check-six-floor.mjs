import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  extractCodebaseUrl,
  extractCrxVersion,
  extractManifestFromZip,
  extractSixTagFromVersionName,
  fetchCrxManifest,
  fetchLiveVersion,
  LIVE_UPDATE_XML_URL,
} from './cws-live.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function bundledFloor(manifest, upstream) {
  const legacy = extractSixTagFromVersionName(manifest?.version_name);
  if (legacy) return legacy;
  const tag = /^v(\d+(?:\.\d+)*)$/.exec(upstream?.tag ?? '')?.[1];
  if (!tag) {
    throw new Error(
      `release has no six floor: version_name ${JSON.stringify(manifest?.version_name ?? null)} names no six tag and upstream tag is ${JSON.stringify(upstream?.tag ?? null)}`
    );
  }
  return tag;
}

export async function liveSix(opts = {}) {
  const xml = await fetchLiveVersion({ ...opts, url: opts.url ?? LIVE_UPDATE_XML_URL });
  const crxVersion = extractCrxVersion(xml);
  if (!crxVersion) throw new Error('could not parse version from update XML');
  if (compareVersions(crxVersion, '7.0.0') < 0) return { crxVersion, six: crxVersion };
  const codebase = extractCodebaseUrl(xml);
  if (!codebase) throw new Error(`live build ${crxVersion} has no codebase URL in update XML`);
  const manifest = await (opts.fetchCrxManifest
    ? opts.fetchCrxManifest(codebase)
    : fetchCrxManifest(codebase, opts));
  return { crxVersion, six: extractSixTagFromVersionName(manifest?.version_name) };
}

export async function checkSixFloor(manifest, upstream, opts = {}) {
  let floor;
  try {
    floor = bundledFloor(manifest, upstream);
  } catch (err) {
    return { ok: false, error: `${err.message}. Failing closed.` };
  }
  const legacy = extractSixTagFromVersionName(manifest?.version_name) !== null;
  let live;
  try {
    live = await liveSix(opts);
  } catch (err) {
    return { ok: false, floor, error: `live version unreadable: ${err.message}. Failing closed.` };
  }
  const seen = { floor, live: live.six, liveVersion: live.crxVersion };
  if (live.six === null) {
    if (legacy) {
      return {
        ...seen,
        ok: false,
        error: `the live build ${live.crxVersion} comes from six/, and this release is a legacy build tagged six ${floor}, which predates it; refusing to roll back`,
      };
    }
    if (compareVersions(manifest?.version ?? '0', live.crxVersion) <= 0) {
      return {
        ...seen,
        ok: false,
        error: `release ${manifest?.version} is not newer than the live build ${live.crxVersion}, which comes from six/; refusing to roll back`,
      };
    }
    return {
      ...seen,
      ok: true,
      decidedBy: 'version',
      notice: `the live build ${live.crxVersion} comes from six/, so no six floor applies; release ${manifest.version} passes only because it is newer, and cws-publish.mjs checks that again against the store before publishing`,
    };
  }
  if (compareVersions(floor, live.six) < 0) {
    return {
      ...seen,
      ok: false,
      error: `release is based on six ${floor}, older than the live six ${live.six} (live build ${live.crxVersion}); refusing to ship less than the live listing has`,
    };
  }
  return { ...seen, ok: true, decidedBy: 'floor' };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const zip = resolve(process.argv[2] ?? resolve(root, 'artifacts/slicc-extension.zip'));
  const upstreamPath = resolve(process.argv[3] ?? resolve(root, 'six/upstream.json'));
  let manifest;
  let upstream;
  try {
    manifest = await extractManifestFromZip(readFileSync(zip));
  } catch (err) {
    process.stderr.write(`GUARD FAILED: ${zip} manifest unreadable: ${err.message}\n`);
    process.exit(1);
  }
  try {
    upstream = JSON.parse(readFileSync(upstreamPath, 'utf8'));
  } catch {
    upstream = null;
  }
  const result = await checkSixFloor(manifest, upstream);
  if (result.notice) process.stdout.write(`::notice title=Six floor guard::${result.notice}\n`);
  if (!result.ok) {
    process.stderr.write(`GUARD FAILED: ${result.error}\n`);
    process.exit(1);
  }
  process.stdout.write(
    result.decidedBy === 'version'
      ? `Six floor guard passed on version alone: release ${manifest.version} is newer than the live build ${result.liveVersion}\n`
      : `Six floor guard passed: release based on six ${result.floor}, live six ${result.live} (live build ${result.liveVersion})\n`
  );
}
