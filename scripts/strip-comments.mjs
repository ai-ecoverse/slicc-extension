import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const ext = join(root, '..', 'extension');

const catalog = JSON.parse(
  readFileSync(join(root, '..', 'node_modules/@ai-ecoverse/slicc-browsers/catalog.json'), 'utf8')
);
const protectedRulesData = catalog.protectedOrigins;
const { domains, schemes } = protectedRulesData;

const patches = JSON.parse(readFileSync(join(root, 'six-patches.json'), 'utf8'));

const guardFn = [
  `var _protDomains = ${JSON.stringify(domains)};`,
  `var _protSchemes = ${JSON.stringify(schemes)};`,
  `var _protInner = ${JSON.stringify(protectedRulesData.innerSchemes)};`,
  'function _isProtectedUrl(url) {',
  '  try {',
  '    var u = new URL(url);',
  '    var s = u.protocol.slice(0, -1);',
  '    for (var i = 0; _protInner.includes(s) && i < 8; i++) { u = new URL(u.href.slice(u.protocol.length)); s = u.protocol.slice(0, -1); }',
  '    if (!_protSchemes.includes(s)) return false;',
  '    var h = u.hostname.toLowerCase();',
  '    if (h.endsWith(".")) h = h.slice(0, -1);',
  '    return _protDomains.some(function(d) { return h === d || h.endsWith("." + d); });',
  '  } catch { return false; }',
  '}',
].join('\n');

function patchAndCount(source, pattern, replacement) {
  let count = 0;
  const result = source.replace(pattern, (...args) => {
    count++;
    return typeof replacement === 'function'
      ? replacement(...args)
      : args[0].replace(
          args[0],
          replacement.replace(/\$(\d+)/g, (_, n) => args[Number(n)])
        );
  });
  return { result, count };
}

function assertPatch(source, label, pattern, replacement, expected) {
  const { result, count } = patchAndCount(source, pattern, replacement);
  if (count !== expected) {
    throw new Error(`strip-comments: "${label}" matched ${count} times, expected ${expected}`);
  }
  return result;
}

const sixSwPath = join(ext, 'six-sw.js');
let content = readFileSync(sixSwPath, 'utf8');

const pr3977needed = !content.includes('isProtectedUrl');
const pr3978needed = content.includes('payload.type === "cdp-command"');
const pr3979needed = !content.includes('isTrustedInternalSender');
const pr3980needed = !content.includes('encryptedStorage');

const applied = [];
const skipped = [];

if (pr3977needed) {
  content = `${guardFn}\n${content}`;

  content = assertPatch(
    content,
    'discovery onHeadersReceived',
    /(chrome\.webRequest\.onHeadersReceived\.addListener\(\s*\(details\) => \{)/g,
    '$1\n    if (_isProtectedUrl(details.url)) return;',
    1
  );
  applied.push('B24-1-headers-discovery');

  content = assertPatch(
    content,
    'handoff onHeadersReceived',
    /(chrome\.webRequest\.onHeadersReceived\.addListener\()(onHandoffHeaders)/g,
    '$1(details) => { if (_isProtectedUrl(details.url)) return; return $2(details); }',
    1
  );
  applied.push('B24-1-headers-handoff');

  content = assertPatch(
    content,
    'bridge cdpAttachToTarget',
    /(async function cdpAttachToTarget\(params, state2, deps\) \{)/,
    '$1\n  { const _tab = await deps.getTab?.(parseInt(params["targetId"], 10)); if (_tab?.url && _isProtectedUrl(_tab.url)) throw new Error("slicc: refused: target is on a protected origin"); if (_tab?.pendingUrl && _isProtectedUrl(_tab.pendingUrl)) throw new Error("slicc: refused: target is on a protected origin"); }',
    1
  );
  applied.push('B24-1-attach-bridge');

  content = assertPatch(
    content,
    'bridge cdpCreateTarget',
    /(async function cdpCreateTarget\(params, deps\) \{)/,
    '$1\n  { const _u = params["url"]; if (_u && _isProtectedUrl(_u)) throw new Error("slicc: refused: target is on a protected origin"); }',
    1
  );
  applied.push('B24-1-create-bridge');

  content = assertPatch(
    content,
    'bridge Page.navigate refusal',
    /(const tabId = sessionId !== void 0 \? state2\.sessionToTab\.get\(sessionId\) : void 0;\s*if \(tabId === void 0\) \{[^}]+\})/,
    '$1\n  if (method === "Page.navigate") { const _navUrl = typeof params?.["url"] === "string" ? params["url"] : undefined; if (_navUrl && _isProtectedUrl(_navUrl)) throw new Error("slicc: refused: target is on a protected origin"); }',
    1
  );
  applied.push('B24-1-navigate-bridge');

  content = assertPatch(
    content,
    'legacy cdpAttachToTarget2',
    /(async function cdpAttachToTarget2\(params\) \{\s*const targetId = params\["targetId"\];\s*const tabId = tabIdFromTargetId\(targetId\);)/,
    '$1\n  { try { const _tab = await chrome.tabs.get(tabId); if (_tab && _isProtectedUrl(_tab.url)) throw new Error("slicc: refused: target is on a protected origin"); if (_tab?.pendingUrl && _isProtectedUrl(_tab.pendingUrl)) throw new Error("slicc: refused: target is on a protected origin"); } catch(_e) { if (_e instanceof Error && _e.message.startsWith("slicc: refused")) throw _e; } }',
    1
  );
  applied.push('B24-1-attach-legacy');

  content = assertPatch(
    content,
    'legacy cdpCreateTarget2',
    /(async function cdpCreateTarget2\(params\) \{\s*const url = params\["url"\] \?\? "about:blank";)/,
    '$1\n  if (_isProtectedUrl(url)) throw new Error("slicc: refused: target is on a protected origin");',
    1
  );
  applied.push('B24-1-create-legacy');

  content = assertPatch(
    content,
    'legacy Page.navigate refusal',
    /(async function cdpSendCommand\(method, params, sessionId\) \{\s*const tabId = sessionId \? sessionToTab\.get\(sessionId\) : void 0;\s*if \(tabId === void 0\) \{[^}]+\})/,
    '$1\n  if (method === "Page.navigate") { const _navUrl = typeof params?.["url"] === "string" ? params["url"] : undefined; if (_navUrl && _isProtectedUrl(_navUrl)) throw new Error("slicc: refused: target is on a protected origin"); }',
    1
  );
  applied.push('B24-1-navigate-legacy');

  content = assertPatch(
    content,
    'tabs.onUpdated navigation detach',
    /(installCdpProxyListeners\(\);)/,
    `$1
chrome.tabs.onUpdated.addListener(function _b24TabProtect(tabId, changeInfo, tab) {
  var _url = changeInfo.url || (tab && tab.pendingUrl);
  if (!_url || !_isProtectedUrl(_url)) return;
  var _bridgeDetached = new Set();
  for (var [_port, _state] of liveBridgePortStates) {
    var _sessions = [..._state.sessionToTab].filter(function(e) { return e[1] === tabId; }).map(function(e) { return e[0]; });
    if (!_sessions.length) continue;
    invalidatePortDebuggerAttachment(_state, tabId);
    _bridgeDetached.add(tabId);
    if (_state.channelId === null) continue;
    for (var _sid of _sessions) { try { _port.postMessage({ bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION, channelId: _state.channelId, kind: "cdp.event", method: "Target.detachedFromTarget", params: { sessionId: _sid, targetId: String(tabId) } }); } catch {} }
  }
  var _legSid; for (var [_ls, _lt] of sessionToTab) { if (_lt === tabId) { _legSid = _ls; break; } }
  if (_legSid !== void 0) { sessionToTab.delete(_legSid); forceReleaseDebuggerAttachment(tabId).catch(function() {}); notifyBridgeDebuggerDetached(tabId); }
  for (var _dt of _bridgeDetached) releaseDebuggerAttachment(_dt, "bridge").catch(function() {});
});`,
    1
  );
  applied.push('B24-1-tabs-onupdated');
} else {
  for (const p of patches.filter((p) => p.pr === 3977)) skipped.push(p.id);
}

if (pr3978needed) {
  content = assertPatch(
    content,
    'remove offscreen cdp-command relay',
    /if \(payload\.type === "cdp-command"\) relayCdpCommand\(payload\);\s*else if \(isTraySocketCommand\(payload\)\)/,
    'if (isTraySocketCommand(payload))',
    1
  );
  applied.push('B24-3-offscreen-relay');

  content = assertPatch(
    content,
    'remove legacy cdpCreateTarget2 addToSliccGroup',
    /await addToSliccGroup\(tab\.id\);\n {2}return \{ targetId: String\(tab\.id\) \};\n\}/,
    'return { targetId: String(tab.id) };\n}',
    1
  );
  applied.push('B24-3-legacy-create-sliccgroup');

  content = assertPatch(
    content,
    'remove tray-socket relay',
    /function relayTraySocketCommand\(command\) \{[\s\S]*?\n\}\nfunction handleRelayMessage/,
    'function relayTraySocketCommand(command) {}\nfunction handleRelayMessage',
    1
  );
  applied.push('B24-3-tray-socket-relay');
} else {
  for (const p of patches.filter((p) => p.pr === 3978)) skipped.push(p.id);
}

if (pr3979needed) {
  content = assertPatch(
    content,
    'sender gating in routeSwMessage',
    /(function routeSwMessage\(handlers, message, sender, sendResponse\) \{)/,
    '$1\n  if (!sender || typeof sender.id !== "string" || sender.id !== chrome.runtime.id || (typeof sender.url === "string" && !sender.url.startsWith("chrome-extension://" + chrome.runtime.id))) return false;',
    1
  );
  applied.push('B-SEC1-message-router');

  content = assertPatch(
    content,
    'sender gating in onConnect',
    /(chrome\.runtime\.onConnect\.addListener\(\(port\) => \{)/,
    '$1\n  if (port.sender?.id !== chrome.runtime.id || port.sender?.tab != null) return;',
    1
  );
  applied.push('B-SEC1-onconnect');
} else {
  for (const p of patches.filter((p) => p.pr === 3979)) skipped.push(p.id);
}

if (pr3980needed) {
  const encryptedStorageFn = [
    'var _secDbName = "slicc-secrets";',
    'var _secStoreName = "keys";',
    'var _secKeyId = "aes-gcm-secrets";',
    'var _secKeyPromise = null;',
    'function _secOpenDb() { return new Promise(function(resolve, reject) { if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB not available")); return; } var req = indexedDB.open(_secDbName, 1); req.onupgradeneeded = function() { var db = req.result; if (!db.objectStoreNames.contains(_secStoreName)) db.createObjectStore(_secStoreName); }; req.onsuccess = function() { resolve(req.result); }; req.onerror = function() { reject(req.error); }; }); }',
    'function _secIdbGet(db, key) { return new Promise(function(resolve, reject) { var tx = db.transaction(_secStoreName, "readonly"); var req2 = tx.objectStore(_secStoreName).get(key); req2.onsuccess = function() { resolve(req2.result); }; req2.onerror = function() { reject(req2.error); }; }); }',
    'function _secIdbPut(db, key, value) { return new Promise(function(resolve, reject) { var tx = db.transaction(_secStoreName, "readwrite"); tx.objectStore(_secStoreName).put(value, key); tx.oncomplete = function() { resolve(); }; tx.onerror = function() { reject(tx.error); }; }); }',
    'async function _secGetOrCreateKey() { var db = await _secOpenDb(); try { var existing = await _secIdbGet(db, _secKeyId); if (existing) return existing; var key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); await _secIdbPut(db, _secKeyId, key); return key; } finally { db.close(); } }',
    'function _secCachedKey() { if (!_secKeyPromise) _secKeyPromise = _secGetOrCreateKey(); return _secKeyPromise; }',
    'function _secToBase64(buf) { return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))); }',
    'function _secFromBase64(b64) { var bin = atob(b64); var arr = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return arr.buffer; }',
    'function _secIsEncrypted(v) { return typeof v === "object" && v !== null && typeof v.ct === "string" && typeof v.iv === "string"; }',
    'async function _secEncrypt(plaintext) { var key = await _secCachedKey(); var iv = crypto.getRandomValues(new Uint8Array(12)); var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(plaintext)); return { ct: _secToBase64(ct), iv: _secToBase64(iv.buffer) }; }',
    'async function _secDecrypt(encrypted) { try { var key = await _secCachedKey(); var plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: _secFromBase64(encrypted.iv) }, key, _secFromBase64(encrypted.ct)); return new TextDecoder().decode(plainBuf); } catch { return void 0; } }',
    'async function _secMigrate() { var all = await chrome.storage.local.get(null); for (var [k, v] of Object.entries(all)) { if (typeof v !== "string" || k.endsWith(DOMAINS_SUFFIX) || !(k + DOMAINS_SUFFIX in all)) continue; var enc = await _secEncrypt(v); await chrome.storage.local.set({ [k]: enc }); } }',
    'var _secMigrationDone = null;',
    'function _secEnsureMigrated() { if (!_secMigrationDone) _secMigrationDone = _secMigrate().catch(function(e) { console.error("[sw] secrets migration failed", e); }); return _secMigrationDone; }',
    'var _encryptedStorage = { async get(keys) { await _secEnsureMigrated(); var raw = await chrome.storage.local.get(keys); var result = {}; for (var [k, v] of Object.entries(raw)) { if (_secIsEncrypted(v)) { var dec = await _secDecrypt(v); if (dec !== void 0) result[k] = dec; } else { result[k] = v; } } return result; }, async set(items) { await _secEnsureMigrated(); var enc = {}; for (var [k, v] of Object.entries(items)) { if (typeof v === "string" && !k.endsWith(DOMAINS_SUFFIX)) { enc[k] = await _secEncrypt(v); } else { enc[k] = v; } } await chrome.storage.local.set(enc); }, async remove(keys) { await chrome.storage.local.remove(keys); } };',
  ].join('\n');

  content = assertPatch(
    content,
    'encrypted storage implementation',
    /var storageLocal = chrome\.storage\.local;/,
    `${encryptedStorageFn}\nvar storageLocal = _encryptedStorage;`,
    1
  );
  applied.push('B-SEC2-encrypted-storage');

  content = assertPatch(
    content,
    'buildSecretsPipeline uses encrypted storage',
    /(async function buildSecretsPipeline\(\) \{)/,
    '$1\n  await _secEnsureMigrated();',
    1
  );
  applied.push('B-SEC2-pipeline-migration');

  content = assertPatch(
    content,
    'mount-backends encrypted getter',
    /var chromeStorageSecretGetter = \{ async get\(key\) \{\s*const result = await chrome\.storage\.local\.get\(key\);/,
    'var chromeStorageSecretGetter = { async get(key) {\n  const result = await _encryptedStorage.get(key);',
    1
  );
  applied.push('B-SEC2-mount-backends');

  content = assertPatch(
    content,
    'oauth token uses encrypted storage',
    /await chrome\.storage\.local\.set\(\{ \[`oauth\.\$\{providerId\}\.token`\]/,
    'await _encryptedStorage.set({ [`oauth.${providerId}.token`]',
    1
  );
  applied.push('B-SEC2-oauth-storage');

  content = assertPatch(
    content,
    'listSecretsIncludingUnreadable for secrets page',
    /(async function listSecrets\(storage\) \{)/,
    `async function _listSecretsIncludingUnreadable() {
  await _secEnsureMigrated();
  var raw = await chrome.storage.local.get(null);
  var readable = [];
  var unreadableNames = new Set();
  for (var [k, v] of Object.entries(raw)) {
    if (k.endsWith(DOMAINS_SUFFIX)) { if (typeof v === "string") readable.push({ key: k, value: v }); continue; }
    if (_secIsEncrypted(v)) {
      var dec = await _secDecrypt(v);
      if (dec === void 0) { unreadableNames.add(k); } else { readable.push({ key: k, value: dec }); }
    } else if (typeof v === "string") { readable.push({ key: k, value: v }); }
  }
  var paired = pairEnvEntriesToSecrets(readable);
  var result = paired.map(function(e) { return { name: e.name, domains: e.domains, unreadable: false }; });
  for (var name of unreadableNames) {
    var dk = name + DOMAINS_SUFFIX;
    var dr = typeof raw[dk] === "string" ? raw[dk].split(",").filter(Boolean) : [];
    result.push({ name: name, domains: dr, unreadable: true });
  }
  result.sort(function(a, b) { return a.name.localeCompare(b.name); });
  return result;
}
$1`,
    1
  );
  applied.push('B-SEC2-list-unreadable');
} else {
  for (const p of patches.filter((p) => p.pr === 3980)) skipped.push(p.id);
}

writeFileSync(sixSwPath, content);

if (applied.length > 0) {
  process.stdout.write(`Applied ${applied.length} patches: ${applied.join(', ')}\n`);
}
if (skipped.length > 0) {
  process.stdout.write(
    `Skipped ${skipped.length} patches (already fixed upstream): ${skipped.join(', ')}\n`
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
