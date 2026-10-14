import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sixRef = process.env.SIX_REF || readFileSync(resolve(root, '.six-tag'), 'utf8').trim();

if (!sixRef) {
  process.stderr.write('No six ref: set SIX_REF or check .six-tag\n');
  process.exit(1);
}

process.stdout.write(`Resolved six ref: ${sixRef}\n`);

const sixDir = mkdtempSync(resolve(tmpdir(), 'slicc-six-'));

function cleanup() {
  rmSync(sixDir, { recursive: true, force: true });
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(1);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(1);
});

process.stdout.write(`Fetching ai-ecoverse/slicc at ${sixRef}…\n`);
execFileSync(
  'git',
  ['clone', '--depth', '1', '--branch', sixRef, 'https://github.com/ai-ecoverse/slicc.git', sixDir],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);

const sha = execFileSync('git', ['-C', sixDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
process.stdout.write(`Checked out ${sixRef} (${sha})\n`);

const chromeExtSrc = resolve(sixDir, 'packages/chrome-extension/src');
const sharedTsIndex = resolve(sixDir, 'packages/shared-ts/src/index.ts');

if (!existsSync(resolve(chromeExtSrc, 'service-worker.ts'))) {
  process.stderr.write(`service-worker.ts not found in ${chromeExtSrc}\n`);
  process.exit(1);
}

const aliasPlugin = {
  name: 'slicc-alias',
  setup(build) {
    build.onResolve({ filter: /^@slicc\/shared-ts$/ }, () => ({
      path: sharedTsIndex,
    }));
    build.onResolve({ filter: /^@ai-ecoverse\/cherry(\/embed-ui)?$/ }, () => ({
      path: resolve(sixDir, 'packages/cherry/src/embed-ui.ts'),
    }));
    build.onResolve({ filter: /^@earendil-works\// }, () => ({
      path: resolve(sixDir, 'packages/cherry/src/embed-ui.ts'),
      sideEffects: false,
    }));
    build.onResolve({ filter: /\.\.\/\.\.\/webapp\/src\// }, (args) => {
      const relPath = args.path.replace('../../webapp/src/', '');
      const tsPath = resolve(sixDir, 'packages/webapp/src', relPath.replace(/\.js$/, '.ts'));
      if (existsSync(tsPath)) return { path: tsPath };
      const jsPath = resolve(sixDir, 'packages/webapp/src', relPath);
      if (existsSync(jsPath)) return { path: jsPath };
      return { path: tsPath, sideEffects: false };
    });
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
  resolve(chromeExtSrc, 'service-worker.ts'),
  resolve(root, 'extension/six-sw.js')
);

await bundleAndStrip(
  resolve(chromeExtSrc, 'sidepanel-entry.ts'),
  resolve(root, 'extension/sidepanel.js')
);

await bundleAndStrip(
  resolve(chromeExtSrc, 'secrets-entry.ts'),
  resolve(root, 'extension/secrets.js'),
  { format: 'iife' }
);

writeFileSync(resolve(root, '.six-ref'), `${sixRef} ${sha}\n`);

process.stdout.write(`Built six-sw.js, sidepanel.js, secrets.js from ${sixRef}\n`);
