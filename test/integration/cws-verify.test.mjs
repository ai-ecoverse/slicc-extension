import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cert = join(root, 'scripts/cert');
const scratch = mkdtempSync(join(tmpdir(), 'cws-verify-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function zip(dir, files) {
  rmSync(dir, { recursive: true, force: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const out = `${dir}.zip`;
  rmSync(out, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', out, '.'], { cwd: dir });
  return readFileSync(out);
}

function crx(zipBuf) {
  const header = Buffer.alloc(12);
  header.write('Cr24', 0, 'latin1');
  header.writeUInt32LE(3, 4);
  header.writeUInt32LE(4, 8);
  return Buffer.concat([header, Buffer.from([1, 2, 3, 4]), zipBuf]);
}

const manifest = '{\n  "manifest_version": 3,\n  "version": "7.9.0"\n}\n';
const store = (m = manifest) =>
  `{\n"update_url": "https://clients2.google.com/service/update2/crx",\n\n${m.slice(2)}`;

function verify(storeFiles, releaseFiles, rebuiltFiles) {
  const s = join(scratch, 'store.crx');
  writeFileSync(s, crx(zip(join(scratch, 'store'), storeFiles)));
  zip(join(scratch, 'release'), releaseFiles);
  const rebuilt = rebuiltFiles ? ['--rebuilt', `${join(scratch, 'rebuilt')}.zip`] : [];
  if (rebuiltFiles) zip(join(scratch, 'rebuilt'), rebuiltFiles);
  try {
    return {
      code: 0,
      out: execFileSync(
        process.execPath,
        [
          join(root, 'scripts/gate.mjs'),
          'cws-verify',
          '--',
          process.execPath,
          join(cert, 'cws-verify.mjs'),
          '--crx',
          s,
          '--zip',
          join(scratch, 'release.zip'),
          ...rebuilt,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ),
    };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

test('cws-verify passes when the store crx minus _metadata/ and update_url is the release zip, and fails on any other difference', () => {
  const release = { 'manifest.json': manifest, 'cdp.js': 'guard();\n' };
  const meta = { '_metadata/verified_contents.json': '[]' };
  const ok = verify({ ...release, ...meta, 'manifest.json': store() }, release);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /^cws-verify: PASS /m);
  const changed = verify(
    { ...release, ...meta, 'manifest.json': store(), 'cdp.js': 'noGuard();\n' },
    release
  );
  assert.equal(changed.code, 1);
  assert.match(changed.out, /cws-verify: FAIL .*cdp\.js differs/);
  const extra = verify({ ...release, ...meta, 'manifest.json': store(), 'evil.js': 'x' }, release);
  assert.match(extra.out, /only in the store crx: evil\.js/);
  const reworded = verify(
    { ...release, ...meta, 'manifest.json': store(manifest.replace('7.9.0', '7.9.1')) },
    release
  );
  assert.match(reworded.out, /manifest\.json differs/);
  const unstamped = verify({ ...release, ...meta }, release);
  assert.match(unstamped.out, /update_url line/);
  const noMeta = verify({ ...release, 'manifest.json': store() }, release);
  assert.match(noMeta.out, /no _metadata/);
  const rebuiltOk = verify({ ...release, ...meta, 'manifest.json': store() }, release, release);
  assert.equal(rebuiltOk.code, 0, rebuiltOk.out);
  const swapped = verify({ ...release, ...meta, 'manifest.json': store() }, release, {
    ...release,
    'cdp.js': 'other();\n',
  });
  assert.equal(swapped.code, 1);
  assert.match(swapped.out, /cdp\.js differs from the rebuild/);
});

test('cws-verify refuses a zip entry whose bytes fail its CRC', () => {
  const s = join(scratch, 'store.crx');
  const good = zip(join(scratch, 'store'), {
    'manifest.json': store(),
    'cdp.js': 'guard();\n',
    '_metadata/v.json': '[]',
  });
  const at = good.indexOf(Buffer.from('guard();'));
  assert.ok(at > 0);
  good[at] = 'G'.charCodeAt(0);
  writeFileSync(s, crx(good));
  zip(join(scratch, 'release'), { 'manifest.json': manifest, 'cdp.js': 'guard();\n' });
  let out = '';
  try {
    execFileSync(
      process.execPath,
      [join(cert, 'cws-verify.mjs'), '--crx', s, '--zip', join(scratch, 'release.zip')],
      { encoding: 'utf8' }
    );
  } catch (err) {
    out = err.stdout;
  }
  assert.match(out, /cws-verify: FAIL .*CRC/);
});
