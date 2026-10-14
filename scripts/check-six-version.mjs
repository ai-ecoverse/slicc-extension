import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const UPDATE_XML_URL =
  'https://clients2.google.com/service/update2/crx?prodversion=140.0&acceptformat=crx3&x=id%3Dakjjllgokmbgpbdbmafpiefnhidlmbgf%26uc';

export function compareVersions(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function parseSixVersion(tag) {
  const m = tag.match(/^v?(\d+(?:\.\d+)*)$/);
  return m ? m[1] : null;
}

export function extractCrxVersion(xml) {
  const m = xml.match(/updatecheck[^>]*version=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

export function extractVersionName(xml) {
  const m = xml.match(/updatecheck[^>]*version_name=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

export function liveIsSevenBuild(versionStr) {
  return versionStr !== null && compareVersions(versionStr, '7.0.0') >= 0;
}

export function extractSixTagFromVersionName(versionName) {
  if (!versionName) return null;
  const m = versionName.match(/\(six v(\d+(?:\.\d+)*)\)/);
  return m ? m[1] : null;
}

export async function fetchLiveVersion(opts = {}) {
  const f = opts.fetchImpl ?? fetch;
  const url = opts.url ?? UPDATE_XML_URL;
  const response = await f(url);
  if (!response.ok) {
    throw new Error(`Update XML fetch failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

export async function checkSixVersion(sixTag, opts = {}) {
  const sixVersion = parseSixVersion(sixTag);
  if (!sixVersion) {
    return { ok: false, error: `Invalid six tag: ${sixTag}` };
  }

  let xml;
  try {
    xml = await fetchLiveVersion(opts);
  } catch (err) {
    return { ok: false, error: `Failed to fetch live version: ${err.message}` };
  }

  const crxVersion = extractCrxVersion(xml);
  if (!crxVersion) {
    return { ok: false, error: 'Could not parse version from update XML' };
  }

  if (liveIsSevenBuild(crxVersion)) {
    const versionName = extractVersionName(xml);
    const sixFromLive = extractSixTagFromVersionName(versionName);
    if (!sixFromLive) {
      return {
        ok: false,
        error: `Live build is 7.x (${crxVersion}) but version_name does not contain a six tag. Failing closed.`,
      };
    }
    if (compareVersions(sixVersion, sixFromLive) < 0) {
      return {
        ok: false,
        error: `Pinned six ${sixVersion} is older than the six in the live 7.x build (${sixFromLive})`,
      };
    }
    return { ok: true, liveVersion: crxVersion, liveSixVersion: sixFromLive, sixVersion };
  }

  if (compareVersions(sixVersion, crxVersion) < 0) {
    return {
      ok: false,
      error: `Pinned six ${sixVersion} is older than the live CWS version ${crxVersion}`,
    };
  }

  return { ok: true, liveVersion: crxVersion, sixVersion };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const sixTag = process.env.SIX_REF || readFileSync(resolve(root, '.six-tag'), 'utf8').trim();

  checkSixVersion(sixTag).then(
    (result) => {
      if (!result.ok) {
        process.stderr.write(`GUARD FAILED: ${result.error}\n`);
        process.exit(1);
      }
      process.stdout.write(
        `Six version guard passed: pinned=${result.sixVersion} live=${result.liveVersion}\n`
      );
    },
    (err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
  );
}
