import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const ext = join(root, '..', 'extension');

const catalog = JSON.parse(
  readFileSync(join(root, '..', 'node_modules/@ai-ecoverse/slicc-browsers/catalog.json'), 'utf8')
);
const { domains, schemes } = catalog.protectedOrigins;

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

const sixSwPath = join(ext, 'six-sw.js');
let content = readFileSync(sixSwPath, 'utf8');
content = `${guardFn}\n${content}`;
content = content.replace(
  /(chrome\.webRequest\.onHeadersReceived\.addListener\(\s*\(details\) => \{)/g,
  '$1\n    if (_isProtectedUrl(details.url)) return;'
);
content = content.replace(
  /(chrome\.webRequest\.onHeadersReceived\.addListener\()(onHandoffHeaders)/g,
  '$1(details) => { if (_isProtectedUrl(details.url)) return; return $2(details); }'
);
content = content.replace(
  /(async function cdpAttachToTarget\(params, state2, deps\) \{)/,
  '$1\n  { const _tab = await deps.getTab?.(parseInt(params["targetId"], 10)); if (_tab?.url && _isProtectedUrl(_tab.url)) throw new Error("slicc: refused: target is on a protected origin"); if (_tab?.pendingUrl && _isProtectedUrl(_tab.pendingUrl)) throw new Error("slicc: refused: target is on a protected origin"); }'
);
content = content.replace(
  /(async function cdpCreateTarget\(params, deps\) \{)/,
  '$1\n  { const _u = params["url"]; if (_u && _isProtectedUrl(_u)) throw new Error("slicc: refused: target is on a protected origin"); }'
);
writeFileSync(sixSwPath, content);

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
