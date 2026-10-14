import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInflateRaw } from 'node:zlib';

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
  const m = xml.match(/updatecheck[^>]*\bversion=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

export function extractCodebaseUrl(xml) {
  const m = xml.match(/updatecheck[^>]*\bcodebase=["']([^"']+)["']/i);
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

export function extractManifestFromCrx(crxBuffer) {
  const buf = Buffer.from(crxBuffer);
  if (buf.slice(0, 4).toString() !== 'Cr24') {
    throw new Error('Not a CRX3 file');
  }
  const headerLen = buf.readUInt32LE(8);
  const zipStart = 12 + headerLen;
  const zipBuf = buf.slice(zipStart);
  return extractManifestFromZip(zipBuf);
}

export function extractManifestFromZip(zipBuf) {
  const buf = Buffer.from(zipBuf);
  let offset = 0;
  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const compression = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.slice(offset + 30, offset + 30 + nameLen).toString();
    const dataStart = offset + 30 + nameLen + extraLen;
    if (name === 'manifest.json') {
      const raw = buf.slice(dataStart, dataStart + compressedSize);
      if (compression === 0) return JSON.parse(raw.toString());
      return new Promise((res, rej) => {
        const inflate = createInflateRaw();
        const chunks = [];
        inflate.on('data', (c) => chunks.push(c));
        inflate.on('end', () => {
          try {
            res(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            rej(e);
          }
        });
        inflate.on('error', rej);
        inflate.end(raw);
      });
    }
    offset = dataStart + compressedSize;
  }
  throw new Error('manifest.json not found in CRX/ZIP');
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

export async function fetchCrxManifest(codebaseUrl, opts = {}) {
  const f = opts.fetchImpl ?? fetch;
  const response = await f(codebaseUrl);
  if (!response.ok) {
    throw new Error(`CRX download failed: ${response.status} ${response.statusText}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  return extractManifestFromCrx(buf);
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
    const codebaseUrl = extractCodebaseUrl(xml);
    if (!codebaseUrl) {
      return {
        ok: false,
        error: `Live build is 7.x (${crxVersion}) but no codebase URL in update XML. Failing closed.`,
      };
    }
    let manifest;
    try {
      manifest = await (opts.fetchCrxManifest
        ? opts.fetchCrxManifest(codebaseUrl)
        : fetchCrxManifest(codebaseUrl, opts));
    } catch (err) {
      return {
        ok: false,
        error: `Live build is 7.x (${crxVersion}) but failed to read CRX manifest: ${err.message}. Failing closed.`,
      };
    }
    const sixFromLive = extractSixTagFromVersionName(manifest.version_name);
    if (!sixFromLive) {
      return {
        ok: false,
        error: `Live build is 7.x (${crxVersion}) but manifest version_name does not contain a six tag. Failing closed.`,
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

function readSixRef() {
  const refPath = resolve(root, '.six-ref');
  const raw = readFileSync(refPath, 'utf8').trim();
  return raw.split(' ')[0];
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const sixTag = readSixRef();

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
