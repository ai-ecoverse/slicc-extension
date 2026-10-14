import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const ext = join(root, '..', 'extension');

const files = ['six-sw.js', 'sidepanel.js', 'secrets.js', 'capture-popup.js'];

for (const file of files) {
  const path = join(ext, file);
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  content = content.replace(/\/\*\*[\s\S]*?\*\//g, '');
  content = content.replace(/\/\* @__PURE__ \*\/ /g, '');
  content = content.replace(/^\/\/.*$/gm, '');
  content = content.replace(/ \/\/[^"'`]*$/gm, '');
  content = content.replace(/\n{3,}/g, '\n\n');
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
