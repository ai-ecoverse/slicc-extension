import { summary } from '@ai-ecoverse/slicc-browsers/guard-runner';

export function capabilities(transport) {
  return {
    autoAttach: false,
    browserSession: false,
    browserContexts: false,
    extensionWorld: true,
    discovery: transport === 'seven',
  };
}

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

export function report(set, results, sha, transport) {
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
