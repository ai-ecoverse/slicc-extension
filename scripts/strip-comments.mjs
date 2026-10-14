import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const ext = join(root, '..', 'extension');

const catalog = JSON.parse(
  readFileSync(join(root, '..', 'node_modules/@ai-ecoverse/slicc-browsers/catalog.json'), 'utf8')
);
const { domains, schemes } = catalog.protectedOrigins;

const patches = JSON.parse(readFileSync(join(root, 'six-patches.json'), 'utf8'));

const guardFn = [
  `var _protDomains = ${JSON.stringify(domains)};`,
  `var _protSchemes = ${JSON.stringify(schemes)};`,
  'function _isProtectedUrl(url) {',
  '  try {',
  '    var u = new URL(url);',
  '    var s = u.protocol.slice(0, -1);',
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
} else {
  skipped.push('B24-3-offscreen-relay');
}

if (pr3979needed) {
  content = assertPatch(
    content,
    'sender gating in routeSwMessage',
    /(function routeSwMessage\(handlers, message, sender, sendResponse\) \{)/,
    '$1\n  if (!sender || typeof sender.id !== "string" || sender.id !== chrome.runtime.id || sender.tab != null) return false;',
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
