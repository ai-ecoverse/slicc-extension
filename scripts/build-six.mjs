import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'six/extension');

async function bundle(entry, out, format) {
  const built = await esbuild.build({
    entryPoints: [resolve(src, entry)],
    absWorkingDir: root,
    tsconfig: resolve(root, 'tsconfig.json'),
    bundle: true,
    format,
    write: false,
    minify: false,
    target: 'esnext',
    define: { __SLICC_EXT_DEV__: 'false', __DEV__: 'false', global: 'globalThis' },
    legalComments: 'none',
    treeShaking: true,
  });
  const squeezed = await esbuild.transform(built.outputFiles[0].text, {
    loader: 'js',
    legalComments: 'none',
    minifyWhitespace: true,
    target: 'esnext',
  });
  const formatted = await esbuild.transform(squeezed.code, { loader: 'js', target: 'esnext' });
  writeFileSync(resolve(root, 'extension', out), formatted.code);
}

await bundle('service-worker.ts', 'six-sw.js', 'esm');
await bundle('sidepanel-entry.ts', 'sidepanel.js', 'esm');
await bundle('secrets-entry.ts', 'secrets.js', 'iife');
process.stdout.write('Built six-sw.js, sidepanel.js, secrets.js from six/\n');
