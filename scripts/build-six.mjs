import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(resolve(root, 'six-import/src/service-worker.ts'))) {
  process.stdout.write('six-import/ not present, using committed build outputs\n');
  process.exit(0);
}

const aliasPlugin = {
  name: 'slicc-alias',
  setup(build) {
    build.onResolve({ filter: /^@slicc\/shared-ts$/ }, () => ({
      path: resolve(root, 'six-import/vendor/shared-ts/_barrel.ts'),
    }));
    build.onResolve({ filter: /\.\.\/\.\.\/webapp\/src\// }, (args) => {
      const relPath = args.path.replace('../../webapp/src/', '');
      return { path: resolve(root, 'six-import/vendor/webapp', relPath.replace(/\.js$/, '.ts')) };
    });
    build.onResolve({ filter: /^@ai-ecoverse\/cherry$/ }, () => ({
      path: resolve(root, 'scripts/cherry-stub.ts'),
    }));
  },
};

const commonDefine = {
  __SLICC_EXT_DEV__: 'false',
  __DEV__: 'false',
  global: 'globalThis',
};

async function bundleAndStrip(entry, outPath, opts = {}) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: opts.format ?? 'esm',
    write: false,
    minify: false,
    target: 'esnext',
    define: commonDefine,
    plugins: [aliasPlugin],
    legalComments: 'none',
    treeShaking: true,
  });
  const code = result.outputFiles[0].text;
  const minified = await esbuild.transform(code, {
    loader: 'js',
    legalComments: 'none',
    minifySyntax: false,
    minifyWhitespace: true,
    minifyIdentifiers: false,
    target: 'esnext',
  });
  const formatted = await esbuild.transform(minified.code, {
    loader: 'js',
    target: 'esnext',
  });
  writeFileSync(outPath, formatted.code);
}

await bundleAndStrip(
  resolve(root, 'six-import/src/service-worker.ts'),
  resolve(root, 'extension/six-sw.js')
);

await bundleAndStrip(
  resolve(root, 'six-import/src/sidepanel-entry.ts'),
  resolve(root, 'extension/sidepanel.js')
);

await bundleAndStrip(
  resolve(root, 'six-import/src/secrets-entry.ts'),
  resolve(root, 'extension/secrets.js'),
  { format: 'iife' }
);

process.stdout.write('Built six-sw.js, sidepanel.js, secrets.js\n');
