import { waitFor } from '@ai-ecoverse/slicc-browsers/guard-driver.mjs';
import { summary } from '@ai-ecoverse/slicc-browsers/guard-runner';

export const sendMs = 40000;

export function settled(promise, ms, what) {
  let done = false;
  const work = Promise.resolve(promise).finally(() => {
    done = true;
  });
  const bound = waitFor(() => done, ms).then((ok) => {
    if (!ok) throw new Error(`${what}: no answer in ${ms} ms`);
  });
  return Promise.race([work, bound]);
}

export function send(cdp, method, params = {}, sessionId = undefined, ms = sendMs) {
  return settled(cdp.send(method, params, sessionId), ms, method);
}

export async function until(check, ms, what) {
  let value;
  const held = async () => {
    value = await check();
    return value;
  };
  if (await waitFor(held, ms, 100)) return value;
  throw new Error(`guard client: ${what} within ${ms} ms`);
}

export async function waitEvent(events, predicate, ms, from = 0) {
  let index = from;
  let found;
  const look = () => {
    for (; index < events.length; index++) {
      if (!predicate(events[index])) continue;
      found = events[index];
      return true;
    }
    return false;
  };
  if (look() || (await waitFor(look, ms))) return found;
  throw new Error(`waitEvent: no event in ${ms} ms`);
}

export function carrier(tally, { step, out, side }) {
  if (!step?.redirectSecret || !out?.ok) return tally;
  const result = out.result ?? {};
  const fields = [
    `networkBodyPath=${result.networkBodyPath ?? 'none'}`,
    `requestsTerminated=${result.requestsTerminated ?? 'none'}`,
    `hopsRedacted=${result.hopsRedacted ?? 'none'}`,
  ];
  for (const field of fields) {
    const key = `${step.redirectSecret} ${side} ${field}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return tally;
}

export function carriers(list) {
  const total = {};
  for (const tally of list)
    for (const [key, count] of Object.entries(tally ?? {})) total[key] = (total[key] ?? 0) + count;
  return Object.fromEntries(Object.entries(total).sort(([a], [b]) => a.localeCompare(b)));
}

export function capabilities(transport) {
  return {
    autoAttach: false,
    browserSession: false,
    browserContexts: false,
    extensionWorld: true,
    discovery: transport === 'seven',
    clientExit: true,
    siteIsolationOff: true,
    inboundDelay: true,
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
  const incomplete = results.filter((row) =>
    [row.control, row.guarded, row.live].includes('incomplete')
  );
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
    forged: value.forged,
    informational,
    failed,
    incomplete,
    results,
  };
}

const where = (row) => `${row.id} ${row.target} ${row.variant}`;

export function strict(value) {
  const results = value.results ?? [];
  const problems = [];
  if (results.length === 0) problems.push('no rows ran');
  else if (value.passed === 0) problems.push(`all ${results.length} rows skipped or not run`);
  for (const row of results)
    if ([row.control, row.guarded, row.live].includes('skip') && !row.reason)
      problems.push(`skip without a reason: ${where(row)}`);
  for (const row of value.failed) problems.push(`failed: ${where(row)} ${row.why ?? ''}`.trim());
  for (const row of value.incomplete)
    problems.push(`incomplete: ${where(row)} ${row.why ?? ''}`.trim());
  for (const row of value.forged) problems.push(`forged: ${where(row)} ${row.why}`);
  for (const row of value.missing) problems.push(`missing: ${where(row)}`);
  if (!value.pass) problems.push(`not a pass: ${value.line}`);
  if (!/^GUARD-PASS /.test(value.line ?? '')) problems.push(`no GUARD-PASS line: ${value.line}`);
  return problems;
}
