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

const files = ['six-sw.js', 'sidepanel.js', 'secrets.js', 'capture-popup.js', 'picker-popup.js'];

for (const file of files) {
  const path = join(ext, file);
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  content = content.replace(/\/\*\*[\s\S]*?\*\//g, '');
  content = content.replace(/\/\*[^*][\s\S]*?\*\//g, '');
  content = content.replace(/\/\* @__PURE__ \*\/ /g, '');
  content = content.replace(/^\s*\/\/.*$/gm, '');
  content = content.replace(/\s+\/\/[^"'`\n]*$/gm, '');
  content = content.replace(/\n{3,}/g, '\n\n');
  if (file === 'six-sw.js') {
    content = `${guardFn}\n${content}`;
    content = content.replace(
      /(chrome\.webRequest\.onHeadersReceived\.addListener\(\n\s*\(details\) => \{)/g,
      '$1\n    if (_isProtectedUrl(details.url)) return;'
    );
  }
  writeFileSync(path, content);
}

const htmlFiles = ['sidepanel.html', 'secrets.html', 'capture-popup.html', 'picker-popup.html'];
for (const file of htmlFiles) {
  const path = join(ext, file);
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  content = content.replace(/<!--[\s\S]*?-->/g, '');
  content = content.replace(/\n{3,}/g, '\n\n');
  writeFileSync(path, content);
}
