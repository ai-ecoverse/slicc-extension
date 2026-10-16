import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
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

const cacheDir = process.env.SIX_CACHE_DIR;
const sixDir = cacheDir ? resolve(cacheDir, sixRef) : mkdtempSync(resolve(tmpdir(), 'slicc-six-'));

function cleanup() {
  if (!cacheDir) rmSync(sixDir, { recursive: true, force: true });
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

if (existsSync(resolve(sixDir, '.git'))) {
  process.stdout.write(`Reusing ai-ecoverse/slicc at ${sixRef} from ${sixDir}\n`);
} else {
  const partial = cacheDir ? `${sixDir}.partial` : sixDir;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  process.stdout.write(`Fetching ai-ecoverse/slicc at ${sixRef}…\n`);
  execFileSync(
    'git',
    [
      'clone',
      '--depth',
      '1',
      '--branch',
      sixRef,
      'https://github.com/ai-ecoverse/slicc.git',
      partial,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (partial !== sixDir) {
    rmSync(sixDir, { recursive: true, force: true });
    renameSync(partial, sixDir);
  }
}

const sha = execFileSync('git', ['-C', sixDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
process.stdout.write(`Checked out ${sixRef} (${sha})\n`);

const rootRequire = createRequire(resolve(root, 'package.json'));

const sixBrowsers = JSON.parse(
  readFileSync(resolve(sixDir, 'packages/chrome-extension/package.json'), 'utf8')
).dependencies?.['@ai-ecoverse/slicc-browsers'];
if (sixBrowsers) {
  const ours = rootRequire('@ai-ecoverse/slicc-browsers/package.json').version;
  const probe = mkdtempSync(resolve(tmpdir(), 'slicc-six-browsers-'));
  try {
    const tarball = execFileSync(
      'npm',
      ['pack', `@ai-ecoverse/slicc-browsers@${sixBrowsers}`, '--silent'],
      {
        cwd: probe,
        encoding: 'utf8',
      }
    ).trim();
    execFileSync('tar', ['xzf', tarball], { cwd: probe });
    const theirRules = JSON.parse(
      readFileSync(resolve(probe, 'package/catalog.json'), 'utf8')
    ).protectedOrigins;
    const ourRules = rootRequire('@ai-ecoverse/slicc-browsers').protectedOrigins;
    const theirGuard = readFileSync(resolve(probe, 'package/protected.mjs'), 'utf8');
    const ourGuard = readFileSync(
      rootRequire.resolve('@ai-ecoverse/slicc-browsers/protected.mjs'),
      'utf8'
    );
    if (JSON.stringify(theirRules) !== JSON.stringify(ourRules) || theirGuard !== ourGuard) {
      process.stderr.write(
        `six pins @ai-ecoverse/slicc-browsers@${sixBrowsers}, we pin ${ours}, and their protected rules differ\n`
      );
      process.exit(1);
    }
    process.stdout.write(
      `slicc-browsers protected rules identical: six ${sixBrowsers}, ours ${ours}\n`
    );
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

mkdirSync(resolve(root, 'six-import'), { recursive: true });
writeFileSync(
  resolve(root, 'six-import/manifest.json'),
  readFileSync(resolve(sixDir, 'packages/chrome-extension/manifest.json'), 'utf8')
);

const chromeExtSrc = resolve(sixDir, 'packages/chrome-extension/src');
const sharedTsIndex = resolve(sixDir, 'packages/shared-ts/src/index.ts');

if (!existsSync(resolve(chromeExtSrc, 'service-worker.ts'))) {
  process.stderr.write(`service-worker.ts not found in ${chromeExtSrc}\n`);
  process.exit(1);
}

const aliasPlugin = {
  name: 'slicc-alias',
  setup(build) {
    build.onResolve({ filter: /^@ai-ecoverse\/slicc-browsers(\/.*)?$/ }, (args) => ({
      path: rootRequire.resolve(args.path),
    }));
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
