import { createInflateRaw } from 'node:zlib';

export const LIVE_UPDATE_XML_URL =
  'https://clients2.google.com/service/update2/crx?prodversion=146.0&acceptformat=crx3&x=id%3Dakjjllgokmbgpbdbmafpiefnhidlmbgf%26uc';

export function compareVersions(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function extractCrxVersion(xml) {
  const m = xml.match(/updatecheck[^>]*\bversion=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

export function extractCodebaseUrl(xml) {
  const m = xml.match(/updatecheck[^>]*\bcodebase=["']([^"']+)["']/i);
  return m ? m[1] : null;
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
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('ZIP end-of-central-directory not found');
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (pos + 46 <= cdEnd) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compression = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString();
    if (name === 'manifest.json') {
      const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
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
    pos += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('manifest.json not found in CRX/ZIP');
}

export async function fetchLiveVersion(opts = {}) {
  const f = opts.fetchImpl ?? fetch;
  const url = opts.url ?? LIVE_UPDATE_XML_URL;
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
