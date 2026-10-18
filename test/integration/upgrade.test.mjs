import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';
import { extId } from './extension-page.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cache = join(root, 'node_modules/.cache/slicc-extension-releases');
const secretsUrl = `chrome-extension://${extId}/secrets.html`;

const releases = {
  '6.249.3': {
    url: 'https://github.com/ai-ecoverse/slicc/releases/download/v6.249.3/sliccy-extension-v6.249.3.zip',
    sha256: 'd383ca3e56b6cf89c4c91add3bf6439b14837875ee9528f5e72dfbf3e49f23e0',
  },
  '7.5.0': {
    url: 'https://github.com/ai-ecoverse/slicc-extension/releases/download/v7.5.0/slicc-extension.zip',
    sha256: '05d5a2af417a4c683b4e853b4fce714b083ff2ef16ea59605a8e66c634b3b5d3',
  },
};

async function release(version) {
  const { url, sha256 } = releases[version];
  const zip = join(cache, `${version}.zip`);
  if (!existsSync(zip)) {
    const response = await fetch(url);
    assert.ok(response.ok, `download ${url}: ${response.status}`);
    await mkdir(cache, { recursive: true });
    await writeFile(zip, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash('sha256')
    .update(await readFile(zip))
    .digest('hex');
  assert.equal(digest, sha256, `${version} release zip is the pinned one`);
  return zip;
}

async function replaceWith(dir, source) {
  for (const entry of await readdir(dir)) await rm(join(dir, entry), { recursive: true });
  await cp(source, dir, { recursive: true, filter: (path) => !path.includes('_metadata') });
}

function database() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('slicc-secrets');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const stores = [...db.objectStoreNames].sort();
      const read = (name) =>
        new Promise((done) => {
          if (!stores.includes(name)) return done(null);
          const all = db.transaction(name, 'readonly').objectStore(name).getAll();
          all.onsuccess = () => done(all.result);
        });
      Promise.all([read('keys'), read('records')]).then(([keys, records]) => {
        const out = {
          version: db.version,
          stores,
          keys: keys?.map((k) => k?.constructor?.name ?? typeof k) ?? null,
          records: records?.map((r) => ({
            name: r.name,
            domains: r.domains,
            encrypted: typeof r.value?.ct === 'string' && typeof r.value?.iv === 'string',
          })),
        };
        db.close();
        resolve(out);
      }, reject);
    };
  });
}

async function openSecrets(page, version) {
  await page.send('Page.navigate', { url: secretsUrl });
  await page.until(
    (want) =>
      location.href.startsWith('chrome-extension://') &&
      document.readyState === 'complete' &&
      chrome.runtime.getManifest().version === want &&
      document.getElementById('c-save') !== null,
    version
  );
}

async function saveSecret(page, name, value, domains) {
  await page.evaluate(
    (n, v, d) => {
      document.querySelector('[data-pane="custom"]')?.click();
      document.getElementById('c-name').value = n;
      document.getElementById('c-value').value = v;
      document.getElementById('c-domains').value = d;
      document.getElementById('c-save').click();
    },
    name,
    value,
    domains
  );
  await page.until(
    (n) =>
      [...document.querySelectorAll('#list .secret-row')].some((row) => row.dataset.name === n),
    name
  );
}

async function upgrade(t, from, before) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-extension-upgrade-'));
  execFileSync('unzip', ['-q', await release(from), '-d', dir]);
  const chrome = await launch({
    roots: [['/', 'test/integration/page/']],
    coverage: process.env.SLICC_COVERAGE ? undefined : [],
    extensions: [dir],
  });
  try {
    const name = `UPGRADE_${from.replaceAll('.', '_')}`;
    const value = `plaintext-${from}-${Date.now()}`;
    const old = await chrome.page(t);
    await openSecrets(old, from);
    await saveSecret(old, name, value, 'upstream.test, *.upstream.test');
    before(await old.evaluate(database), await old.evaluate(() => chrome.storage.local.get(null)), {
      name,
      value,
    });

    await replaceWith(dir, join(root, 'extension'));
    const { id } = await chrome.cdp.send('Extensions.loadUnpacked', { path: dir });
    assert.equal(id, extId, 'the new build updates the same extension in place');
    let fresh;
    for (let attempt = 0; ; attempt++) {
      fresh = await old.tab();
      try {
        await openSecrets(fresh, '0.0.0');
        break;
      } catch (error) {
        if (attempt === 5) throw error;
        await fresh.close().catch(() => undefined);
      }
    }
    await fresh.until(
      (n) =>
        [...document.querySelectorAll('#list .secret-row')].some((row) => row.dataset.name === n),
      name
    );
    const listed = await fresh.evaluate((n) => {
      const row = document.querySelector(`.secret-row[data-name="${n}"]`);
      return {
        domains: row.querySelector('.secret-domains').textContent,
        unreadable: row.classList.contains('secret-row-unreadable'),
      };
    }, name);
    assert.deepEqual(listed, { domains: 'upstream.test, *.upstream.test', unreadable: false });
    const pipeline = await fresh.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: 'secrets.list-with-values-for-pipeline' }, resolve)
        )
    );
    assert.deepEqual(
      pipeline.entries.find((e) => e.name === name),
      { name, value, domains: ['upstream.test', '*.upstream.test'] },
      'the secret decrypts with the key the old build created'
    );
    const after = await fresh.evaluate(database);
    assert.equal(after.version, 2);
    assert.deepEqual(after.stores, ['keys', 'records']);
    assert.deepEqual(after.keys, ['CryptoKey'], 'the old AES key is kept, not replaced');
    assert.deepEqual(
      after.records.filter((r) => r.name === name),
      [{ name, domains: 'upstream.test,*.upstream.test', encrypted: true }]
    );
    const local = JSON.stringify(await fresh.evaluate(() => chrome.storage.local.get(null)));
    assert.equal(local.includes(name), false, 'storage.local no longer names the secret');
    assert.equal(local.includes(value), false, 'storage.local carries no plaintext');
  } finally {
    await chrome.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('upgrade from six 6.249.3, the live listing: its v1 secrets database migrates into v2 records, readable, with no plaintext left in storage.local', async (t) => {
  await upgrade(t, '6.249.3', (db, local, { name, value }) => {
    assert.equal(db.version, 1, '6.249.3 keeps secrets beside a v1 keys database');
    assert.deepEqual(db.stores, ['keys']);
    assert.deepEqual(db.keys, ['CryptoKey']);
    assert.equal(typeof local[name]?.ct, 'string', '6.249.3 stores {ct, iv} in storage.local');
    assert.equal(local[`${name}_DOMAINS`], 'upstream.test,*.upstream.test');
    assert.equal(JSON.stringify(local).includes(value), false);
  });
});

test('upgrade from 7.5.0: its v2 records stay readable and storage.local stays clean', async (t) => {
  await upgrade(t, '7.5.0', (db, local, { name }) => {
    assert.equal(db.version, 2, '7.5.0 already keeps secrets in v2 records');
    assert.deepEqual(
      db.records.filter((r) => r.name === name),
      [{ name, domains: 'upstream.test,*.upstream.test', encrypted: true }]
    );
    assert.equal(JSON.stringify(local).includes(name), false);
  });
});
