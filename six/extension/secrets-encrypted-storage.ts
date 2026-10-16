import { DOMAINS_SUFFIX } from '@slicc/shared-ts';
import type { SecretsStorageItems, StorageArea } from './secrets-storage.js';

const DB_NAME = 'slicc-secrets';
const DB_VERSION = 2;
const RECORD_STORE = 'records';
const STORE_NAME = 'keys';
const KEY_ID = 'aes-gcm-secrets';

export const UNREADABLE_SECRET = Symbol.for('slicc:unreadable-secret');

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(RECORD_STORE)) db.createObjectStore(RECORD_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

async function getOrCreateKey(): Promise<CryptoKey> {
  const db = await openDb();
  try {
    const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(KEY_ID);
      req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
      req.onerror = () => reject(req.error);
    });
    if (existing) return existing;

    const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);

    return await new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(KEY_ID);
      getReq.onsuccess = () => {
        if (getReq.result) {
          resolve(getReq.result as CryptoKey);
          return;
        }
        const putReq = store.put(candidate, KEY_ID);
        putReq.onsuccess = () => resolve(candidate);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

let keyPromise: Promise<CryptoKey> | null = null;
function cachedKey(): Promise<CryptoKey> {
  if (!keyPromise) keyPromise = getOrCreateKey();
  return keyPromise;
}

interface EncryptedValue {
  ct: string;
  iv: string;
}

export function isEncryptedValue(v: unknown): v is EncryptedValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as EncryptedValue).ct === 'string' &&
    typeof (v as EncryptedValue).iv === 'string'
  );
}

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

export async function encryptValue(plaintext: string): Promise<EncryptedValue> {
  const key = await cachedKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { ct: toBase64(ct), iv: toBase64(iv.buffer) };
}

export async function decryptValue(
  encrypted: EncryptedValue
): Promise<string | typeof UNREADABLE_SECRET> {
  try {
    const key = await cachedKey();
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(encrypted.iv) },
      key,
      fromBase64(encrypted.ct)
    );
    return new TextDecoder().decode(plainBuf);
  } catch {
    return UNREADABLE_SECRET;
  }
}

interface SecretRecord {
  name: string;
  value: EncryptedValue | string | undefined;
  domains: string;
}

type StoredValue = EncryptedValue | string;

async function recordTx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore, done: (value: T) => void) => void
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(RECORD_STORE, mode);
      const store = tx.objectStore(RECORD_STORE);
      let out: T;
      try {
        fn(store, (v) => {
          out = v;
        });
      } catch (e) {
        reject(e);
      }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

function allRecords(): Promise<SecretRecord[]> {
  return recordTx('readonly', (s, done) => {
    const r = s.getAll();
    r.onsuccess = () => done((r.result as SecretRecord[] | undefined) ?? []);
  });
}

export function getRecord(name: string): Promise<SecretRecord | undefined> {
  return recordTx('readonly', (s, done) => {
    const r = s.get(name);
    r.onsuccess = () => done(r.result as SecretRecord | undefined);
  });
}

function putRecords(records: SecretRecord[]): Promise<void> {
  return recordTx('readwrite', (s) => {
    for (const rec of records) s.put(rec, rec.name);
  });
}

function deleteRecords(names: string[]): Promise<void> {
  return recordTx('readwrite', (s) => {
    for (const n of names) s.delete(n);
  });
}

function putRecordIfAbsent(rec: SecretRecord): Promise<boolean> {
  return recordTx('readwrite', (s, done) => {
    const g = s.get(rec.name);
    g.onsuccess = () => {
      if (g.result) {
        done(false);
        return;
      }
      s.put(rec, rec.name);
      done(true);
    };
  });
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return isEncryptedValue(a) && isEncryptedValue(b) && a.ct === b.ct && a.iv === b.iv;
}

async function decryptRecord(value: SecretRecord['value']): Promise<string | undefined> {
  const dec = await decryptValue(value as EncryptedValue);
  return dec === UNREADABLE_SECRET ? undefined : dec;
}

export async function migrateSecretsToEncrypted(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const names = Object.keys(all).filter(
    (k) =>
      !k.endsWith(DOMAINS_SUFFIX) &&
      k + DOMAINS_SUFFIX in all &&
      (typeof all[k] === 'string' || isEncryptedValue(all[k]))
  );
  for (const name of names) {
    const dk = name + DOMAINS_SUFFIX;
    const fresh = await chrome.storage.local.get([name, dk]);
    const value = fresh[name];
    if (typeof value !== 'string' && !isEncryptedValue(value)) continue;
    const enc: StoredValue = typeof value === 'string' ? await encryptValue(value) : value;
    const again = await chrome.storage.local.get([name, dk]);
    if (!sameValue(again[name], value) || again[dk] !== fresh[dk]) continue;
    await putRecordIfAbsent({
      name,
      value: enc,
      domains: typeof fresh[dk] === 'string' ? fresh[dk] : '',
    });
    const last = await chrome.storage.local.get([name, dk]);
    if (sameValue(last[name], value) && last[dk] === fresh[dk])
      await chrome.storage.local.remove([name, dk]);
  }
}

let migrationPromise: Promise<void> | null = null;
export function ensureMigrated(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = migrateSecretsToEncrypted().catch((err) => {
      migrationPromise = null;
      console.error('[slicc] secrets migration failed', err);
      throw err;
    });
  }
  return migrationPromise;
}

export const encryptedStorage: StorageArea = {
  async get(keys?: null | string | string[]): Promise<SecretsStorageItems> {
    await ensureMigrated();
    const out: SecretsStorageItems = {};
    for (const rec of await allRecords()) {
      const dec = await decryptRecord(rec.value);
      if (dec !== undefined) out[rec.name] = dec;
      out[rec.name + DOMAINS_SUFFIX] = rec.domains ?? '';
    }
    if (keys === null || keys === undefined) return out;
    const wanted =
      typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const picked: SecretsStorageItems = {};
    for (const k of wanted) if (k in out) picked[k] = out[k];
    return picked;
  },

  async set(items: SecretsStorageItems): Promise<void> {
    await ensureMigrated();
    const changes = new Map<string, { value?: unknown; domains?: string }>();
    for (const [k, v] of Object.entries(items)) {
      const isDomains = k.endsWith(DOMAINS_SUFFIX);
      const base = isDomains ? k.slice(0, -DOMAINS_SUFFIX.length) : k;
      const c = changes.get(base) ?? {};
      if (isDomains) c.domains = typeof v === 'string' ? v : '';
      else c.value = v;
      changes.set(base, c);
    }
    const records: SecretRecord[] = [];
    for (const [name, c] of changes) {
      const rec: SecretRecord = (await getRecord(name)) ?? { name, value: undefined, domains: '' };
      if ('value' in c)
        rec.value =
          typeof c.value === 'string'
            ? await encryptValue(c.value)
            : (c.value as SecretRecord['value']);
      if ('domains' in c) rec.domains = c.domains as string;
      if (rec.value !== undefined) records.push(rec);
    }
    await putRecords(records);
  },

  async remove(keys: string | string[]): Promise<void> {
    await ensureMigrated();
    const list = typeof keys === 'string' ? [keys] : keys;
    const names: string[] = [];
    const cleared: string[] = [];
    for (const k of list) {
      if (k.endsWith(DOMAINS_SUFFIX)) cleared.push(k.slice(0, -DOMAINS_SUFFIX.length));
      else names.push(k);
    }
    const records: SecretRecord[] = [];
    for (const n of cleared) {
      if (names.includes(n)) continue;
      const rec = await getRecord(n);
      if (rec) {
        rec.domains = '';
        records.push(rec);
      }
    }
    if (records.length) await putRecords(records);
    if (names.length) await deleteRecords(names);
  },
};

export function isValueEncrypted(value: unknown): boolean {
  return isEncryptedValue(value);
}

export interface UnreadableSecretEntry {
  name: string;
  domains: string[];
  unreadable: true;
}

export async function listSecretsIncludingUnreadable(): Promise<
  Array<{ name: string; domains: string[]; unreadable: boolean }>
> {
  await ensureMigrated();
  const result: Array<{ name: string; domains: string[]; unreadable: boolean }> = [];
  for (const rec of await allRecords()) {
    const domains = (rec.domains ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    result.push({
      name: rec.name,
      domains,
      unreadable: (await decryptRecord(rec.value)) === undefined,
    });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
