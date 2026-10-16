import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const ext = join(root, '..', 'extension');

const catalog = JSON.parse(
  readFileSync(join(root, '..', 'node_modules/@ai-ecoverse/slicc-browsers/catalog.json'), 'utf8')
);
const protectedRulesData = catalog.protectedOrigins;

const patches = JSON.parse(readFileSync(join(root, 'six-patches.json'), 'utf8'));

const guardSource = readFileSync(
  join(root, '..', 'node_modules/@ai-ecoverse/slicc-browsers/protected.mjs'),
  'utf8'
).replace(/^export /gm, '');

const guardFn = [
  `var _protGuard = (function () {\n${guardSource}\nreturn protectedOrigins(${JSON.stringify(protectedRulesData)});\n})();`,
  `var _PROTECTED_REFUSAL = ${JSON.stringify(protectedRulesData.refusal)};`,
  'function _isProtectedUrl(url) { return typeof url === "string" && url !== "" && _protGuard.url(url); }',
  'function _isProtectedTarget(url, previous, opener) { return _protGuard.target({ url: typeof url === "string" ? url : "", previous: previous === true, opener: opener }); }',
  'async function _openerStateOf(tab, getTab) { if (typeof tab.openerTabId !== "number") return void 0; try { var opener = await getTab(tab.openerTabId); if (!opener) return "unknown"; return _isProtectedTarget(opener.url ?? "", false, "unknown") || _isProtectedUrl(opener.pendingUrl) ? "protected" : "unprotected"; } catch { return "unknown"; } }',
  'async function _isProtectedTab(tab, getTab) { if (!tab) return false; if (_isProtectedUrl(tab.pendingUrl)) return true; var url = tab.url ?? ""; if (_isProtectedUrl(url)) return true; return _isProtectedTarget(url, false, await _openerStateOf(tab, getTab)); }',
  'async function _getTabOrUndefined(tabId) { try { return await chrome.tabs.get(tabId); } catch { return void 0; } }',
].join('\n');

function patchAndCount(source, pattern, replacement) {
  let count = 0;
  const result = source.replace(pattern, (...args) => {
    count++;
    return typeof replacement === 'function'
      ? replacement(...args)
      : replacement.replace(/\$(\d+)/g, (_, n) => args[Number(n)]);
  });
  return { result, count };
}

const counts = {};

function assertPatch(source, id, pattern, replacement) {
  const expected = patches.find((p) => p.id === id)?.match;
  if (expected === undefined) throw new Error(`strip-comments: unknown patch "${id}"`);
  const { result, count } = patchAndCount(source, pattern, replacement);
  if (count !== expected) {
    throw new Error(`strip-comments: "${id}" matched ${count} times, expected ${expected}`);
  }
  counts[id] = count;
  return result;
}

const sixSwPath = join(ext, 'six-sw.js');
let content = readFileSync(sixSwPath, 'utf8');
const secretsPath = join(ext, 'secrets.js');
let secretsJs = readFileSync(secretsPath, 'utf8');
const secretsHtmlPath = join(ext, 'secrets.html');
let secretsHtml = readFileSync(secretsHtmlPath, 'utf8');

const pr3977needed = !content.includes('isProtectedUrl');
const pr3978needed = content.includes('payload.type === "cdp-command"');
const pr3979needed = !content.includes('isTrustedInternalSender');
const pr3980needed = !content.includes('encryptedStorage');
const pr3980pageNeeded = !secretsJs.includes('listSecretsIncludingUnreadable');
const pr3980htmlNeeded = !secretsHtml.includes('secret-row-unreadable');

const applied = [];
const skipped = [];

function apply(id, pattern, replacement) {
  content = assertPatch(content, id, pattern, replacement);
  applied.push(id);
}

function applyPage(id, pattern, replacement) {
  secretsJs = assertPatch(secretsJs, id, pattern, replacement);
  applied.push(id);
}

function applyHtml(id, pattern, replacement) {
  secretsHtml = assertPatch(secretsHtml, id, pattern, replacement);
  applied.push(id);
}

function skip(pr, where) {
  for (const p of patches.filter((x) => x.pr === pr && (x.file ?? 'six-sw.js') === where)) {
    skipped.push(p.id);
  }
}

const refuse = 'throw new Error(_PROTECTED_REFUSAL);';

if (pr3977needed) {
  content = `${guardFn}\n${content}`;

  apply(
    'B24-1-headers-discovery',
    /(chrome\.webRequest\.onHeadersReceived\.addListener\(\s*\(details\) => \{)/g,
    '$1\n    if (_isProtectedUrl(details.url)) return;'
  );

  apply(
    'B24-1-headers-handoff',
    /(chrome\.webRequest\.onHeadersReceived\.addListener\()(onHandoffHeaders)/g,
    '$1(details) => { if (_isProtectedUrl(details.url)) return; return $2(details); }'
  );

  apply(
    'B24-1-attach-bridge',
    /(async function cdpAttachToTarget\(params, state2, deps\) \{\s*const targetId = readTargetIdParam\(params\);\s*const tabId = parseInt\(targetId, 10\);\s*if \(!Number\.isFinite\(tabId\) \|\| tabId <= 0\) \{\s*throw new Error\(`Invalid targetId: \$\{targetId\}`\);\s*\})(\s*if \(!state2\.ownedTabs\.has\(tabId\)\) \{\s*const attachedByThisPort = await deps\.attachDebugger\(tabId\);\s*if \(attachedByThisPort\) state2\.ownedTabs\.add\(tabId\);\s*\})/,
    `$1\n  if (await _isProtectedTab(await deps.getTab(tabId), deps.getTab)) ${refuse}$2\n  if (await _isProtectedTab(await deps.getTab(tabId), deps.getTab)) { if (state2.ownedTabs.has(tabId)) { state2.ownedTabs.delete(tabId); await deps.detachDebugger(tabId); } ${refuse} }`
  );

  apply(
    'B24-1-create-bridge',
    /(async function cdpCreateTarget\(params, deps\) \{\s*const url = readCreateTargetUrl\(params\);)/,
    `$1\n  if (_isProtectedTarget(url)) ${refuse}`
  );

  apply(
    'B24-1-navigate-bridge',
    /(const tabId = sessionId !== void 0 \? state2\.sessionToTab\.get\(sessionId\) : void 0;\s*if \(tabId === void 0\) \{\s*throw new Error\(`[^`]*`\);\s*\})/,
    `$1\n  if (method === "Page.navigate") { const _navUrl = typeof params?.["url"] === "string" ? params["url"] : void 0; if (_navUrl && _isProtectedUrl(_navUrl)) ${refuse} }`
  );

  apply(
    'B24-1-attach-legacy',
    /(async function cdpAttachToTarget2\(params\) \{\s*const targetId = params\["targetId"\];\s*const tabId = tabIdFromTargetId\(targetId\);)(\s*await acquireDebuggerAttachment\(tabId, "legacy"\);)/,
    `$1\n  if (await _isProtectedTab(await _getTabOrUndefined(tabId), _getTabOrUndefined)) ${refuse}$2\n  if (await _isProtectedTab(await _getTabOrUndefined(tabId), _getTabOrUndefined)) { sessionToTab.delete(targetId); await releaseDebuggerAttachment(tabId, "legacy"); ${refuse} }`
  );

  apply(
    'B24-1-create-legacy',
    /(async function cdpCreateTarget2\(params\) \{\s*const url = params\["url"\] \?\? "about:blank";)/,
    `$1\n  if (_isProtectedTarget(url)) ${refuse}`
  );

  apply(
    'B24-1-navigate-legacy',
    /(async function cdpSendCommand\(method, params, sessionId\) \{\s*const tabId = sessionId \? sessionToTab\.get\(sessionId\) : void 0;\s*if \(tabId === void 0\) \{\s*throw new Error\(`[^`]*`\);\s*\})/,
    `$1\n  if (method === "Page.navigate") { const _navUrl = typeof params?.["url"] === "string" ? params["url"] : void 0; if (_navUrl && _isProtectedUrl(_navUrl)) ${refuse} }`
  );

  apply(
    'B24-1-tabs-onupdated',
    /(installCdpProxyListeners\(\);)/,
    `$1
chrome.tabs.onUpdated.addListener(function _b24TabProtect(tabId, changeInfo, tab) {
  var _url = changeInfo.url ?? (tab && tab.pendingUrl);
  if (!_url || !_isProtectedUrl(_url)) return;
  var _bridgeDetached = new Set();
  for (var [_port, _state] of liveBridgePortStates) {
    var _sessions = [..._state.sessionToTab].filter(function(e) { return e[1] === tabId; }).map(function(e) { return e[0]; });
    if (!_sessions.length) continue;
    invalidatePortDebuggerAttachment(_state, tabId);
    _bridgeDetached.add(tabId);
    if (_state.channelId === null) continue;
    for (var _sid of _sessions) { try { _port.postMessage({ bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION, channelId: _state.channelId, kind: "cdp.event", method: "Target.detachedFromTarget", params: { sessionId: _sid, targetId: String(tabId), reason: _PROTECTED_REFUSAL } }); } catch {} }
  }
  var _legSid; for (var [_ls, _lt] of sessionToTab) { if (_lt === tabId) { _legSid = _ls; break; } }
  if (_legSid !== void 0) { sessionToTab.delete(_legSid); forceReleaseDebuggerAttachment(tabId).catch(function() {}); notifyBridgeDebuggerDetached(tabId); }
  for (var _dt of _bridgeDetached) releaseDebuggerAttachment(_dt, "bridge").catch(function() {});
});`
  );
} else {
  skip(3977, 'six-sw.js');
}

if (pr3978needed) {
  apply(
    'B24-3-offscreen-relay',
    /if \(message\.source === "offscreen"\) \{\s*const payload = message\.payload;\s*if \(payload\.type === "cdp-command"\) relayCdpCommand\(payload\);\s*else if \(isTraySocketCommand\(payload\)\) relayTraySocketCommand\(payload\);\s*return "handled";\s*\}/,
    'if (message.source === "offscreen") {\n    console.warn("[slicc-sw] dropping offscreen message \\u2014 offscreen document no longer exists");\n    return "handled";\n  }'
  );

  apply(
    'B24-3-legacy-create-sliccgroup',
    /await addToSliccGroup\(tab\.id\);\n {2}return \{ targetId: String\(tab\.id\) \};\n\}/,
    'return { targetId: String(tab.id) };\n}'
  );

  apply(
    'B24-3-tray-socket-relay',
    /function relayTraySocketCommand\(command\) \{[\s\S]*?\n\}\nfunction handleRelayMessage/,
    'function relayTraySocketCommand(command) {}\nfunction handleRelayMessage'
  );

  apply(
    'B24-3-legacy-event-forward',
    /(function installCdpProxyListeners\(\) \{)\s*chrome\.debugger\.onEvent\.addListener\(forwardDebuggerEvent\);/,
    '$1'
  );
} else {
  skip(3978, 'six-sw.js');
}

const trustedSender =
  'function isTrustedInternalSender(sender) { if (!sender || typeof sender.id !== "string" || sender.id !== chrome.runtime.id) return false; var _o; try { _o = sender.origin ?? (sender.url ? new URL(sender.url).origin : void 0); } catch { _o = void 0; } return _o === "chrome-extension://" + chrome.runtime.id; }';

if (pr3979needed) {
  apply(
    'B-SEC1-message-router',
    /(function routeSwMessage\(handlers, message, sender, sendResponse\) \{)/,
    `${trustedSender}\n$1\n  if (!isTrustedInternalSender(sender)) return false;`
  );

  apply(
    'B-SEC1-onconnect',
    /(chrome\.runtime\.onConnect\.addListener\(\(port\) => \{)/,
    '$1\n  if (!isTrustedInternalSender(port.sender)) return;'
  );
} else {
  if (
    /chrome\.runtime\.onConnect\.addListener\(\(port\) => \{[\s\S]{0,800}?port\.disconnect\(\)/.test(
      content
    )
  ) {
    throw new Error(
      "strip-comments: six's onConnect gate disconnects foreign ports, which would cut seven's relay port; keep B-SEC1-onconnect until slicc#3979 returns instead"
    );
  }
  skip(3979, 'six-sw.js');
}

const encryptedStorageFn = [
  'var _secDbName = "slicc-secrets";',
  'var _secStoreName = "keys";',
  'var _secKeyId = "aes-gcm-secrets";',
  'var _secKeyPromise = null;',
  'function _secOpenDb() { return new Promise(function(resolve, reject) { if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB not available")); return; } var req = indexedDB.open(_secDbName, 1); req.onupgradeneeded = function() { var db = req.result; if (!db.objectStoreNames.contains(_secStoreName)) db.createObjectStore(_secStoreName); }; req.onsuccess = function() { resolve(req.result); }; req.onerror = function() { reject(req.error ?? new Error("IndexedDB open failed")); }; }); }',
  'async function _secGetOrCreateKey() { var db = await _secOpenDb(); try { var existing = await new Promise(function(resolve, reject) { var tx = db.transaction(_secStoreName, "readonly"); var r = tx.objectStore(_secStoreName).get(_secKeyId); r.onsuccess = function() { resolve(r.result); }; r.onerror = function() { reject(r.error); }; }); if (existing) return existing; var candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); return await new Promise(function(resolve, reject) { var tx = db.transaction(_secStoreName, "readwrite"); var store = tx.objectStore(_secStoreName); var g = store.get(_secKeyId); g.onsuccess = function() { if (g.result) { resolve(g.result); return; } var p = store.put(candidate, _secKeyId); p.onsuccess = function() { resolve(candidate); }; p.onerror = function() { reject(p.error); }; }; g.onerror = function() { reject(g.error); }; tx.onerror = function() { reject(tx.error); }; }); } finally { db.close(); } }',
  'function _secCachedKey() { if (!_secKeyPromise) _secKeyPromise = _secGetOrCreateKey(); return _secKeyPromise; }',
  'function _secToBase64(buf) { var bytes = new Uint8Array(buf); var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }',
  'function _secFromBase64(b64) { var bin = atob(b64); var arr = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return arr.buffer; }',
  'function _secIsEncrypted(v) { return typeof v === "object" && v !== null && typeof v.ct === "string" && typeof v.iv === "string"; }',
  'async function _secEncrypt(plaintext) { var key = await _secCachedKey(); var iv = crypto.getRandomValues(new Uint8Array(12)); var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(plaintext)); return { ct: _secToBase64(ct), iv: _secToBase64(iv.buffer) }; }',
  'async function _secDecrypt(encrypted) { try { var key = await _secCachedKey(); var plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: _secFromBase64(encrypted.iv) }, key, _secFromBase64(encrypted.ct)); return new TextDecoder().decode(plainBuf); } catch { return void 0; } }',
  'async function _secMigrate() { var all = await chrome.storage.local.get(null); var candidates = []; for (var [k, v] of Object.entries(all)) { if (typeof v !== "string" || k.endsWith(DOMAINS_SUFFIX) || !(k + DOMAINS_SUFFIX in all)) continue; candidates.push(k); } for (var key of candidates) { var fresh = await chrome.storage.local.get(key); var value = fresh[key]; if (typeof value !== "string") continue; var encrypted = await _secEncrypt(value); var again = (await chrome.storage.local.get(key))[key]; if (again !== value) continue; await chrome.storage.local.set({ [key]: encrypted }); } }',
  'var _secMigrationDone = null;',
  'function _secEnsureMigrated() { if (!_secMigrationDone) _secMigrationDone = _secMigrate().catch(function(e) { _secMigrationDone = null; console.error("[slicc] secrets migration failed", e); throw e; }); return _secMigrationDone; }',
  'var _encryptedStorage = { async get(keys) { await _secEnsureMigrated(); var raw = await chrome.storage.local.get(keys); var result = {}; for (var [k, v] of Object.entries(raw)) { if (_secIsEncrypted(v)) { var dec = await _secDecrypt(v); if (dec !== void 0) result[k] = dec; } else { result[k] = v; } } return result; }, async set(items) { await _secEnsureMigrated(); var enc = {}; for (var [k, v] of Object.entries(items)) { if (typeof v === "string" && !k.endsWith(DOMAINS_SUFFIX)) { enc[k] = await _secEncrypt(v); } else { enc[k] = v; } } await chrome.storage.local.set(enc); }, async remove(keys) { await _secEnsureMigrated(); await chrome.storage.local.remove(keys); } };',
].join('\n');

const listUnreadableFn = `async function listSecretsIncludingUnreadable() {
    await _secEnsureMigrated();
    var raw = await chrome.storage.local.get(null);
    var readable = {};
    var unreadableNames = new Set();
    for (var [k, v] of Object.entries(raw)) {
      if (k.endsWith(DOMAINS_SUFFIX)) { if (typeof v === "string") readable[k] = v; continue; }
      if (_secIsEncrypted(v)) {
        var dec = await _secDecrypt(v);
        if (dec === void 0) unreadableNames.add(k); else readable[k] = dec;
      } else if (typeof v === "string") { readable[k] = v; }
    }
    var result = pairStorageEntries(readable).map(function(e) { return { name: e.name, domains: e.domains, unreadable: false }; });
    for (var name of unreadableNames) {
      var dk = name + DOMAINS_SUFFIX;
      var dr = typeof raw[dk] === "string" ? raw[dk].split(",").filter(Boolean) : [];
      result.push({ name: name, domains: dr, unreadable: true });
    }
    result.sort(function(a, b) { return a.name.localeCompare(b.name); });
    return result;
  }`;

if (pr3980needed) {
  apply(
    'B-SEC2-encrypted-storage',
    /var storageLocal = chrome\.storage\.local;/,
    `${encryptedStorageFn}\nvar storageLocal = _encryptedStorage;`
  );

  apply(
    'B-SEC2-pipeline-source',
    /const got = await chrome\.storage\.local\.get\(name\);\s*return got\[name\];/,
    'const got = await storageLocal.get(name);\n    return typeof got[name] === "string" ? got[name] : void 0;'
  );

  apply(
    'B-SEC2-mount-backends',
    /var chromeStorageSecretGetter = \{ async get\(key\) \{\s*const result = await chrome\.storage\.local\.get\(key\);/,
    'var chromeStorageSecretGetter = { async get(key) {\n  const result = await _encryptedStorage.get(key);'
  );

  apply(
    'B-SEC2-oauth-storage',
    /await chrome\.storage\.local\.set\(\{ \[`oauth\.\$\{providerId\}\.token`\]/,
    'await _encryptedStorage.set({ [`oauth.${providerId}.token`]'
  );
} else {
  skip(3980, 'six-sw.js');
}

if (pr3980pageNeeded) {
  applyPage(
    'B-SEC2-page-storage',
    /var storage = chrome\.storage\.local;/,
    `${encryptedStorageFn.replace(/\n/g, '\n  ')}\n  ${listUnreadableFn}\n  var storage = _encryptedStorage;`
  );

  applyPage(
    'B-SEC2-page-list-unreadable',
    /entries = await listSecrets\(storage\);/,
    'entries = await listSecretsIncludingUnreadable();'
  );

  applyPage(
    'B-SEC2-page-unreadable-row',
    /return el\("div", \{ class: "secret-row", dataset: \{ name: entry\.name \} \}, el\("div", \{ class: "secret-meta" \}, el\("div", \{ class: "secret-name", text: entry\.name \}\), el\("div", \{ class: "secret-domains", text: entry\.domains\.join\(", "\) \}\)\)/,
    'return el("div", { class: entry.unreadable ? "secret-row secret-row-unreadable" : "secret-row", dataset: { name: entry.name } }, el("div", { class: "secret-meta" }, el("div", { class: "secret-name", text: entry.name }), el("div", { class: "secret-domains", text: entry.domains.join(", ") }), ...(entry.unreadable ? [el("div", { class: "secret-unreadable", text: "\\u26a0\\ufe0f Unreadable \\u2014 encryption key lost. Please re-enter this secret." })] : []))'
  );
} else {
  skip(3980, 'secrets.js');
}

if (pr3980htmlNeeded) {
  applyHtml(
    'B-SEC2-page-css',
    /(\n {4}\.empty \{)/,
    '\n    .secret-unreadable {\n      font-size: 11px;\n      color: #c44;\n      margin-top: 4px;\n    }\n    .secret-row-unreadable {\n      border: 1px solid #c44;\n      background: rgba(204, 68, 68, 0.05);\n    }$1'
  );

  applyHtml(
    'B-SEC2-page-subtitle',
    /Stored in\s*<code>chrome\.storage\.local<\/code>; never visible to the agent\./,
    'Encrypted\n        at rest (AES-GCM); the agent sees only masked placeholders, and content scripts\n        cannot read the plaintext values.'
  );
} else {
  skip(3980, 'secrets.html');
}

const recordStore = [
  'var _recStore = "records";',
  'async function _recTx(mode, fn) { const db = await openDb(); try { return await new Promise((resolve, reject) => { const tx = db.transaction(_recStore, mode); const store = tx.objectStore(_recStore); let out; try { fn(store, (v) => { out = v; }); } catch (e) { reject(e); } tx.oncomplete = () => resolve(out); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted")); }); } finally { db.close(); } }',
  'function _recAll() { return _recTx("readonly", (s, done) => { const r = s.getAll(); r.onsuccess = () => done(r.result ?? []); }); }',
  'function _recGet(name) { return _recTx("readonly", (s, done) => { const r = s.get(name); r.onsuccess = () => done(r.result); }); }',
  'function _recPut(records) { return _recTx("readwrite", (s) => { for (const rec of records) s.put(rec, rec.name); }); }',
  'function _recDelete(names) { return _recTx("readwrite", (s) => { for (const n of names) s.delete(n); }); }',
  'function _recPutIfAbsent(rec) { return _recTx("readwrite", (s, done) => { const g = s.get(rec.name); g.onsuccess = () => { if (g.result) { done(false); return; } s.put(rec, rec.name); done(true); }; }); }',
  'function _recSame(a, b) { if (typeof a === "string" || typeof b === "string") return a === b; return isEncryptedValue(a) && isEncryptedValue(b) && a.ct === b.ct && a.iv === b.iv; }',
  'async function _recDecrypt(value) { const dec = await decryptValue(value); return dec === UNREADABLE_SECRET ? void 0 : dec; }',
  'async function migrateSecretsToEncrypted() { const all = await chrome.storage.local.get(null); const names = Object.keys(all).filter((k) => !k.endsWith(DOMAINS_SUFFIX) && k + DOMAINS_SUFFIX in all && (typeof all[k] === "string" || isEncryptedValue(all[k]))); for (const name of names) { const dk = name + DOMAINS_SUFFIX; const fresh = await chrome.storage.local.get([name, dk]); const value = fresh[name]; if (typeof value !== "string" && !isEncryptedValue(value)) continue; const enc = typeof value === "string" ? await encryptValue(value) : value; const again = await chrome.storage.local.get([name, dk]); if (!_recSame(again[name], value) || again[dk] !== fresh[dk]) continue; await _recPutIfAbsent({ name, value: enc, domains: typeof fresh[dk] === "string" ? fresh[dk] : "" }); const last = await chrome.storage.local.get([name, dk]); if (_recSame(last[name], value) && last[dk] === fresh[dk]) await chrome.storage.local.remove([name, dk]); } }',
].join('\n');

const recordAdapter =
  'var encryptedStorage = { async get(keys) { await ensureMigrated(); const out = {}; for (const rec of await _recAll()) { const dec = await _recDecrypt(rec.value); if (dec !== void 0) out[rec.name] = dec; out[rec.name + DOMAINS_SUFFIX] = rec.domains ?? ""; } if (keys === null || keys === void 0) return out; const wanted = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); const picked = {}; for (const k of wanted) if (k in out) picked[k] = out[k]; return picked; }, async set(items) { await ensureMigrated(); const changes = new Map(); for (const [k, v] of Object.entries(items)) { const isDomains = k.endsWith(DOMAINS_SUFFIX); const base = isDomains ? k.slice(0, -DOMAINS_SUFFIX.length) : k; const c = changes.get(base) ?? {}; if (isDomains) c.domains = typeof v === "string" ? v : ""; else c.value = v; changes.set(base, c); } const records = []; for (const [name, c] of changes) { const rec = (await _recGet(name)) ?? { name, value: void 0, domains: "" }; if ("value" in c) rec.value = typeof c.value === "string" ? await encryptValue(c.value) : c.value; if ("domains" in c) rec.domains = c.domains; if (rec.value !== void 0) records.push(rec); } await _recPut(records); }, async remove(keys) { await ensureMigrated(); const list = typeof keys === "string" ? [keys] : keys; const names = []; const cleared = []; for (const k of list) { if (k.endsWith(DOMAINS_SUFFIX)) cleared.push(k.slice(0, -DOMAINS_SUFFIX.length)); else names.push(k); } const records = []; for (const n of cleared) { if (names.includes(n)) continue; const rec = await _recGet(n); if (rec) { rec.domains = ""; records.push(rec); } } if (records.length) await _recPut(records); if (names.length) await _recDelete(names); } };';

const recordList =
  'async function listSecretsIncludingUnreadable() { await ensureMigrated(); const result = []; for (const rec of await _recAll()) { const domains = (rec.domains ?? "").split(",").map((d) => d.trim()).filter(Boolean); result.push({ name: rec.name, domains, unreadable: (await _recDecrypt(rec.value)) === void 0 }); } result.sort((a, b) => a.name.localeCompare(b.name)); return result; }';

function recordStoreIn(source, prefix) {
  let out = assertPatch(
    source,
    `${prefix}-open`,
    /(indexedDB\.open\(DB_NAME, )DB_VERSION(\);\s*req\.onupgradeneeded = \(\) => \{\s*const db = req\.result;\s*if \(!db\.objectStoreNames\.contains\(STORE_NAME\)\) \{\s*db\.createObjectStore\(STORE_NAME\);\s*\})/,
    (_, open, rest) =>
      `${open}2${rest}\n      if (!db.objectStoreNames.contains("records")) db.createObjectStore("records");`
  );
  out = assertPatch(
    out,
    `${prefix}-migrate`,
    /async function migrateSecretsToEncrypted\(\) \{[\s\S]*?\n(\s*)var migrationPromise = null;/,
    `${recordStore}\n$1var migrationPromise = null;`
  );
  out = assertPatch(
    out,
    `${prefix}-adapter`,
    /var encryptedStorage = \{ async get\(keys\) \{[\s\S]*?\n\s*\} \};\n/,
    `${recordAdapter}\n`
  );
  applied.push(`${prefix}-open`, `${prefix}-migrate`, `${prefix}-adapter`);
  return out;
}

if (!pr3980needed && !content.includes('_recStore')) {
  content = recordStoreIn(content, 'B-SEC3-sw');
  content = assertPatch(
    content,
    'B-SEC3-sw-delete-unreadable',
    /const existing = await listSecrets\(storageLocal\);\s*if \(!existing\.some\(\(e\) => e\.name === name\)\) \{/,
    'await ensureMigrated();\n      if (!(await _recGet(name))) {'
  );
  applied.push('B-SEC3-sw-delete-unreadable');
} else if (pr3980needed) {
  throw new Error('strip-comments: B-SEC3 needs slicc#3980 in the pinned six tag');
} else {
  skip('six-secret-store', 'six-sw.js');
}

if (!pr3980pageNeeded && !secretsJs.includes('_recStore')) {
  secretsJs = recordStoreIn(secretsJs, 'B-SEC3-page');
  secretsJs = assertPatch(
    secretsJs,
    'B-SEC3-page-list',
    /async function listSecretsIncludingUnreadable\(\) \{[\s\S]*?\n\s*return result;\n\s*\}\n/,
    `${recordList}\n`
  );
  applied.push('B-SEC3-page-list');
} else if (pr3980pageNeeded) {
  throw new Error('strip-comments: B-SEC3 needs slicc#3980 in the pinned six tag');
} else {
  skip('six-secret-store', 'secrets.js');
}

const pr3994pageNeeded = !secretsJs.includes("This value can't be read any more. Enter it again.");
const pr3994htmlNeeded = !secretsHtml.includes('box-shadow: inset 0 0 0 1px var(--danger)');

if (pr3994pageNeeded) {
  applyPage(
    'UX-unreadable-copy',
    /text: "[^"]*Unreadable[^"]*encryption key lost[^"]*"/,
    'text: "This value can\'t be read any more. Enter it again."'
  );

  applyPage(
    'UX-reenter-button',
    /( {2}function createSecretRow\(entry\) \{[\s\S]*?)createCopyNameButton\(entry\), createDeleteSecretButton\(entry\)\);/,
    `  function activatePane(target) {
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.pane === target);
    });
    document.querySelectorAll(".pane").forEach((p) => {
      p.classList.toggle("active", p.id === \`pane-\${target}\`);
    });
  }
  function prefillCustomSecret(entry) {
    activatePane("custom");
    $("c-name").value = entry.name;
    $("c-domains").value = entry.domains.join(", ");
    const value = $("c-value");
    value.value = "";
    $("pane-custom")?.scrollIntoView?.({ block: "nearest" });
    value.focus();
  }
  function createReenterButton(entry) {
    return el("button", { class: "btn-secondary btn", text: "Re-enter", "style:font-size": "11px", "style:padding": "4px 8px", on: { click: () => prefillCustomSecret(entry) } });
  }
$1...(entry.unreadable ? [createReenterButton(entry)] : []), createCopyNameButton(entry), createDeleteSecretButton(entry));`
  );
} else {
  skip(3994, 'secrets.js');
}

if (pr3994htmlNeeded) {
  applyHtml(
    'UX-unreadable-style',
    /(\.secret-unreadable \{\s*font-size: 11px;\s*)color: #c44;([\s\S]*?)\.secret-row-unreadable \{\s*border: 1px solid #c44;\s*background: rgba\(204, 68, 68, 0\.05\);\s*\}/,
    '$1color: var(--danger);$2.secret-row-unreadable {\n      grid-template-columns: 1fr auto auto auto;\n      box-shadow: inset 0 0 0 1px var(--danger);\n    }'
  );

  applyHtml(
    'UX-narrow-layout',
    /(\.form-grid \.span2 \{\s*grid-column: 1 \/ 3;\s*\})/,
    '$1\n    @media (max-width: 600px) {\n      body {\n        padding: 16px;\n      }\n      .form-grid {\n        grid-template-columns: 1fr;\n        gap: 4px;\n      }\n      .form-grid label {\n        margin-top: 8px;\n      }\n      .form-grid .span2 {\n        grid-column: 1;\n      }\n      .tabs {\n        flex-wrap: nowrap;\n        overflow-x: auto;\n        scrollbar-width: none;\n      }\n      .tab {\n        flex: none;\n        white-space: nowrap;\n      }\n      .secret-row-unreadable .secret-meta {\n        grid-column: 1 / -1;\n      }\n      .secret-row-unreadable > button:first-of-type {\n        grid-column: 2;\n      }\n    }'
  );
} else {
  skip(3994, 'secrets.html');
}

writeFileSync(sixSwPath, content);
writeFileSync(secretsPath, secretsJs);
writeFileSync(secretsHtmlPath, secretsHtml);

if (applied.length > 0) {
  process.stdout.write(`Applied ${applied.length} patches:\n`);
  for (const id of applied) {
    const p = patches.find((x) => x.id === id);
    process.stdout.write(`  ${p.pr} ${id} ${p.file ?? 'six-sw.js'} matched ${counts[id]}\n`);
  }
}
if (skipped.length > 0) {
  process.stdout.write(
    `Skipped ${skipped.length} patches (sentinel present): ${skipped.join(', ')}\n`
  );
}

const htmlFiles = ['sidepanel.html', 'secrets.html', 'capture-popup.html', 'picker-popup.html'];
for (const file of htmlFiles) {
  const path = join(ext, file);
  let html;
  try {
    html = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/\n{3,}/g, '\n\n');
  writeFileSync(path, html);
}
