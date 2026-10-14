import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

await esbuild.build({
  entryPoints: [resolve(root, 'six-import/src/service-worker.ts')],
  bundle: true,
  format: 'esm',
  outfile: resolve(root, 'extension/six-sw.js'),
  minify: false,
  target: 'esnext',
  define: {
    __SLICC_EXT_DEV__: 'false',
    __DEV__: 'false',
    global: 'globalThis',
  },
  plugins: [aliasPlugin],
  legalComments: 'none',
  treeShaking: true,
  banner: { js: '' },
});

await esbuild.build({
  entryPoints: [resolve(root, 'six-import/src/sidepanel-entry.ts')],
  bundle: true,
  format: 'esm',
  outfile: resolve(root, 'extension/sidepanel.js'),
  minify: false,
  target: 'esnext',
  define: {
    __SLICC_EXT_DEV__: 'false',
    __DEV__: 'false',
  },
  plugins: [aliasPlugin],
  legalComments: 'none',
});

await esbuild.build({
  entryPoints: [resolve(root, 'six-import/src/secrets-entry.ts')],
  bundle: true,
  format: 'iife',
  outfile: resolve(root, 'extension/secrets.js'),
  minify: false,
  target: 'esnext',
  define: {
    __SLICC_EXT_DEV__: 'false',
    __DEV__: 'false',
  },
  plugins: [aliasPlugin],
  legalComments: 'none',
});

process.stdout.write('Built six-sw.js, sidepanel.js, secrets.js\n');
