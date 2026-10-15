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
  'async function _secMigrate() { var all = await chrome.storage.local.get(null); var candidates = []; for (var [k, v] of Object.entries(all)) { if (typeof v !== "string" || k.endsWith(DOMAINS_SUFFIX) || !(k + DOMAINS_SUFFIX in all)) continue; candidates.push(k); } for (var key of candidates) { var fresh = await chrome.storage.local.get(key); var value = fresh[key]; if (typeof value !== "string") continue; await chrome.storage.local.set({ [key]: await _secEncrypt(value) }); } }',
  'var _secMigrationDone = null;',
  'function _secEnsureMigrated() { if (!_secMigrationDone) _secMigrationDone = _secMigrate().catch(function(e) { console.error("[slicc] secrets migration failed", e); }); return _secMigrationDone; }',
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

const idbOpen =
  'function _secOpenDb() { return new Promise(function(resolve, reject) { if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB not available")); return; } var req = indexedDB.open(_secDbName, 2); req.onupgradeneeded = function() { var db = req.result; if (!db.objectStoreNames.contains(_secStoreName)) db.createObjectStore(_secStoreName); if (!db.objectStoreNames.contains(_secRecordStore)) db.createObjectStore(_secRecordStore); }; req.onsuccess = function() { resolve(req.result); }; req.onerror = function() { reject(req.error ?? new Error("IndexedDB open failed")); }; }); }';

const idbRecords = [
  'var _secRecordStore = "records";',
  'async function _secTx(mode, fn) { var db = await _secOpenDb(); try { return await new Promise(function(resolve, reject) { var tx = db.transaction(_secRecordStore, mode); var store = tx.objectStore(_secRecordStore); var out; Promise.resolve(fn(store, function(v) { out = v; })).catch(reject); tx.oncomplete = function() { resolve(out); }; tx.onerror = function() { reject(tx.error); }; tx.onabort = function() { reject(tx.error ?? new Error("IndexedDB transaction aborted")); }; }); } finally { db.close(); } }',
  'function _secAllRecords() { return _secTx("readonly", function(store, done) { var r = store.getAll(); r.onsuccess = function() { done(r.result ?? []); }; }); }',
  'function _secGetRecord(name) { return _secTx("readonly", function(store, done) { var r = store.get(name); r.onsuccess = function() { done(r.result); }; }); }',
  'function _secPutRecords(records) { return _secTx("readwrite", function(store) { for (var rec of records) store.put(rec, rec.name); }); }',
  'function _secDeleteRecords(names) { return _secTx("readwrite", function(store) { for (var n of names) store.delete(n); }); }',
].join('\n');

const idbMigrate =
  'async function _secMigrate() { var all = await chrome.storage.local.get(null); var names = Object.keys(all).filter(function(k) { return !k.endsWith(DOMAINS_SUFFIX) && k + DOMAINS_SUFFIX in all && (typeof all[k] === "string" || _secIsEncrypted(all[k])); }); for (var name of names) { var fresh = await chrome.storage.local.get([name, name + DOMAINS_SUFFIX]); var value = fresh[name]; if (typeof value !== "string" && !_secIsEncrypted(value)) continue; var existing = await _secGetRecord(name); if (!existing) { var enc = typeof value === "string" ? await _secEncrypt(value) : value; var domains = typeof fresh[name + DOMAINS_SUFFIX] === "string" ? fresh[name + DOMAINS_SUFFIX] : ""; await _secPutRecords([{ name: name, value: enc, domains: domains }]); } await chrome.storage.local.remove([name, name + DOMAINS_SUFFIX]); } }';

const idbAdapter =
  'var _encryptedStorage = { async get(keys) { await _secEnsureMigrated(); var out = {}; for (var rec of await _secAllRecords()) { var dec = await _secDecrypt(rec.value); if (dec !== void 0) out[rec.name] = dec; out[rec.name + DOMAINS_SUFFIX] = rec.domains ?? ""; } if (keys === null || keys === void 0) return out; var wanted = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys); var picked = {}; for (var k of wanted) if (k in out) picked[k] = out[k]; return picked; }, async set(items) { await _secEnsureMigrated(); var changes = new Map(); for (var [k, v] of Object.entries(items)) { var isDomains = k.endsWith(DOMAINS_SUFFIX); var base = isDomains ? k.slice(0, -DOMAINS_SUFFIX.length) : k; var c = changes.get(base) ?? {}; if (isDomains) c.domains = typeof v === "string" ? v : ""; else c.value = v; changes.set(base, c); } var records = []; for (var [name, c] of changes) { var rec = (await _secGetRecord(name)) ?? { name: name, value: void 0, domains: "" }; if ("value" in c) rec.value = typeof c.value === "string" ? await _secEncrypt(c.value) : c.value; if ("domains" in c) rec.domains = c.domains; if (rec.value !== void 0) records.push(rec); } await _secPutRecords(records); }, async remove(keys) { await _secEnsureMigrated(); var list = typeof keys === "string" ? [keys] : keys; var names = []; var cleared = []; for (var k of list) { if (k.endsWith(DOMAINS_SUFFIX)) cleared.push(k.slice(0, -DOMAINS_SUFFIX.length)); else names.push(k); } var records = []; for (var n of cleared) { if (names.includes(n)) continue; var rec = await _secGetRecord(n); if (rec) { rec.domains = ""; records.push(rec); } } if (records.length) await _secPutRecords(records); if (names.length) await _secDeleteRecords(names); } };';

const idbList = `async function listSecretsIncludingUnreadable() {
    await _secEnsureMigrated();
    var result = [];
    for (var rec of await _secAllRecords()) {
      var domains = (rec.domains ?? "").split(",").map(function(d) { return d.trim(); }).filter(Boolean);
      result.push({ name: rec.name, domains: domains, unreadable: (await _secDecrypt(rec.value)) === void 0 });
    }
    result.sort(function(a, b) { return a.name.localeCompare(b.name); });
    return result;
  }`;

function idbStore(source, prefix) {
  let out = assertPatch(
    source,
    `${prefix}-open`,
    /function _secOpenDb\(\) \{[^\n]*\}\n/,
    `${idbRecords}\n${idbOpen}\n`
  );
  out = assertPatch(
    out,
    `${prefix}-migrate`,
    /async function _secMigrate\(\) \{[^\n]*\}\n/,
    `${idbMigrate}\n`
  );
  out = assertPatch(
    out,
    `${prefix}-adapter`,
    /var _encryptedStorage = \{[^\n]*\};\n/,
    `${idbAdapter}\n`
  );
  applied.push(`${prefix}-open`, `${prefix}-migrate`, `${prefix}-adapter`);
  return out;
}

if (!content.includes('_secRecordStore')) {
  content = idbStore(content, 'B-SEC3-sw');
  content = assertPatch(
    content,
    'B-SEC3-sw-delete-unreadable',
    /const existing = await listSecrets\(storageLocal\);\s*if \(!existing\.some\(\(e\) => e\.name === name\)\) \{/,
    'await _secEnsureMigrated();\n      if (!(await _secGetRecord(name))) {'
  );
  applied.push('B-SEC3-sw-delete-unreadable');
} else {
  skip('six-secret-store', 'six-sw.js');
}

if (!secretsJs.includes('_secRecordStore')) {
  secretsJs = idbStore(secretsJs, 'B-SEC3-page');
  secretsJs = assertPatch(
    secretsJs,
    'B-SEC3-page-list',
    /async function listSecretsIncludingUnreadable\(\) \{[\s\S]*?\n {2}\}\n/,
    `${idbList}\n`
  );
  applied.push('B-SEC3-page-list');
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
