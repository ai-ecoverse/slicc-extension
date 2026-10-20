import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { summary } from '@ai-ecoverse/slicc-browsers/guard-runner';

const require = createRequire(import.meta.url);

export const DISCOVERY_SKIP = 'not-supported:targetDiscovery (awaiting slicc-browsers 1.13.1)';
export const DISCOVERY_IDS = [
  'C8.protected-error-page',
  'C8.protected-error-page.query',
  'C8.protected-error-page.fragment',
  'C8.protected-document-restore',
  'C8.protected-error-page-sticky',
  'C8.protected-error-page-sticky.query',
  'C8.protected-error-page-sticky.fragment',
];

export function installedVectors() {
  const path = require.resolve('@ai-ecoverse/slicc-browsers/package.json');
  return JSON.parse(readFileSync(path, 'utf8')).version;
}

export function deferred(results, transport, version) {
  if (transport !== 'six-bridge' || version !== '1.13.0') return results;
  return results.map((row) =>
    DISCOVERY_IDS.includes(row.id)
      ? { ...row, control: 'skip', guarded: 'skip', live: 'skip', reason: DISCOVERY_SKIP }
      : row
  );
}

export const capabilities = {
  autoAttach: false,
  browserSession: false,
  browserContexts: false,
  extensionWorld: true,
};

export const entries = {
  seven: { origin: 'https://seven.sliccy.ai', path: '/doc?n=guard-client' },
  'six-bridge': { origin: 'https://www.sliccy.ai', path: '/doc?n=guard-client&slicc=leader' },
};

export function targets(transport) {
  const own = entries[transport].origin;
  return {
    seven: 'https://seven.sliccy.ai',
    vault: 'https://vault.sliccy.ai',
    'vault-x': 'https://vault-x.sliccy.ai',
    apex: 'https://sliccy.ai',
    own,
    client: own,
    ordinary: 'https://ordinary.test',
    cross: 'https://cross.test',
    'ordinary-same-site': null,
  };
}

const verdict = (row) => `${row.control}/${row.guarded}/${row.live}`;

export function report(set, raw, sha, transport, version = installedVectors()) {
  const results = deferred(raw, transport, version);
  const value = summary({
    set,
    results,
    guard: 'slicc-extension',
    sha: `${sha} transport=${transport}`,
  });
  const failed = results.filter((row) => [row.control, row.guarded, row.live].includes('fail'));
  const informational = results
    .filter((row) => row.ran || row.notes)
    .map((row) => ({
      id: row.id,
      target: row.target,
      variant: row.variant,
      legs: verdict(row),
      ran: row.ran,
      notes: row.notes,
    }));
  const passed = results.filter((row) => verdict(row) === 'pass/pass/pass');
  return {
    line: value.line,
    pass: value.pass && failed.length === 0,
    skips: value.skips,
    counts: value.counts,
    passed: passed.length,
    passedClean: passed.filter((row) => !row.ran && !row.notes).length,
    notRun: value.notRun,
    missing: value.missing,
    informational,
    failed,
    results,
  };
}
