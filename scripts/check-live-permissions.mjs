import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractCodebaseUrl,
  extractManifestFromZip,
  fetchCrxManifest,
  fetchLiveVersion,
  LIVE_UPDATE_XML_URL,
} from './cws-live.mjs';
import { isMain } from './is-main.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export { LIVE_UPDATE_XML_URL };

export const PERMISSION_FIELDS = ['permissions', 'host_permissions', 'optional_permissions'];

function list(manifest, field) {
  const value = manifest?.[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`${field} is not a list of strings`);
  }
  return value;
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest is not an object');
  }
  if (!Array.isArray(manifest.permissions)) throw new Error('manifest has no permissions list');
  for (const field of PERMISSION_FIELDS) list(manifest, field);
  return manifest;
}

export function validateAllowed(allowed) {
  if (!Array.isArray(allowed)) throw new Error('allowlist is not a list');
  for (const p of allowed) {
    if (typeof p !== 'string' || !/^[A-Za-z][A-Za-z0-9.]*$/.test(p)) {
      throw new Error(`allowlist entry is not an API permission: ${JSON.stringify(p)}`);
    }
  }
  return allowed;
}

export function addedPermissions(release, baseline, allowed = []) {
  validateAllowed(allowed);
  const added = {};
  for (const field of PERMISSION_FIELDS) {
    const have = new Set(list(baseline, field));
    const extra = list(release, field).filter(
      (p) => !have.has(p) && !(field === 'permissions' && allowed.includes(p))
    );
    if (extra.length) added[field] = extra;
  }
  return added;
}

export async function fetchLiveManifest(opts = {}) {
  const xml = await fetchLiveVersion({ ...opts, url: opts.url ?? LIVE_UPDATE_XML_URL });
  const codebase = extractCodebaseUrl(xml);
  if (!codebase) throw new Error('no codebase URL in update XML');
  const manifest = await (opts.fetchCrxManifest
    ? opts.fetchCrxManifest(codebase)
    : fetchCrxManifest(codebase, opts));
  return validateManifest(manifest);
}

export async function resolveBaseline(opts = {}) {
  let liveError;
  try {
    const manifest = await (opts.fetchLive ?? fetchLiveManifest)(opts);
    return { source: 'live', manifest };
  } catch (err) {
    liveError = err.message;
  }
  try {
    const manifest = validateManifest(await (opts.readUpstream ?? readUpstreamManifest)());
    return { source: 'upstream', manifest, liveError };
  } catch (err) {
    throw new Error(
      `live listing manifest unreadable (${liveError}) and upstream six manifest unreadable (${err.message})`
    );
  }
}

export async function checkLivePermissions(release, opts = {}) {
  let baseline;
  try {
    validateManifest(release);
    validateAllowed(opts.allowed ?? []);
    baseline = await resolveBaseline(opts);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const added = addedPermissions(release, baseline.manifest, opts.allowed ?? []);
  const result = {
    source: baseline.source,
    liveError: baseline.liveError,
    baselineVersion: baseline.manifest.version,
    added,
  };
  if (Object.keys(added).length) {
    return {
      ...result,
      ok: false,
      error: `release manifest adds over the ${baseline.source} baseline ${baseline.manifest.version}: ${JSON.stringify(added)}`,
    };
  }
  return { ...result, ok: true };
}

export function pinnedManifest(text, upstream) {
  const pin = upstream?.manifestSha256;
  if (typeof pin !== 'string' || !/^[0-9a-f]{64}$/.test(pin)) {
    throw new Error('six/upstream.json pins no manifestSha256');
  }
  const actual = createHash('sha256').update(text).digest('hex');
  if (actual !== pin) {
    throw new Error(`six/manifest.json sha256 ${actual} is not the pinned ${pin}`);
  }
  return JSON.parse(text);
}

export function readUpstreamManifest() {
  return pinnedManifest(
    readFileSync(resolve(root, 'six/manifest.json')),
    JSON.parse(readFileSync(resolve(root, 'six/upstream.json'), 'utf8'))
  );
}

export function readAllowed() {
  return JSON.parse(readFileSync(resolve(root, 'scripts/warning-free-permissions.json'), 'utf8'));
}

export async function readReleaseManifest() {
  const zip = resolve(root, 'artifacts/slicc-extension.zip');
  if (!existsSync(zip)) throw new Error(`${zip} not found; run pack first`);
  return extractManifestFromZip(readFileSync(zip));
}

if (isMain(import.meta.url)) {
  let release;
  try {
    release = await readReleaseManifest();
  } catch (err) {
    process.stderr.write(`GUARD FAILED: release manifest unreadable: ${err.message}\n`);
    process.exit(1);
  }
  const result = await checkLivePermissions(release, { allowed: readAllowed() });
  if (result.source === 'upstream') {
    process.stderr.write(
      `::warning::PERMISSION GUARD BASELINE IS THE UPSTREAM SIX MANIFEST, NOT THE LIVE LISTING: ${result.liveError}\n`
    );
  }
  if (!result.ok) {
    process.stderr.write(`GUARD FAILED: ${result.error}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `live-permissions: PASS against the ${result.source} baseline ${result.baselineVersion}\n`
  );
}
