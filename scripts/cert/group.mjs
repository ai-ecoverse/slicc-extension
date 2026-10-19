import { readFileSync } from 'node:fs';
import { api, output, setCheck, sha, summary, WORKFLOW } from './lib.mjs';

const env = process.env;
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const head = sha(event.merge_group.head_sha);
const runId = env.GITHUB_RUN_ID;
const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${runId}`;
const gh = api(env.GITHUB_REPOSITORY);
const POST = 'cert / post';

const NOOP = ['cert / self-guard', 'cert / plan'];
const WAIT = Number(env.CERT_GROUP_WAIT_MS ?? 15000);

async function runsOf(memberHead) {
  const file = WORKFLOW.split('/').pop();
  const data = await gh.call(
    `actions/workflows/${file}/runs?event=pull_request_target&head_sha=${memberHead}&per_page=50`
  );
  return data.workflow_runs
    .filter(
      (r) =>
        r.path === WORKFLOW &&
        r.event === 'pull_request_target' &&
        r.head_sha === memberHead &&
        r.repository?.full_name === env.GITHUB_REPOSITORY
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
}

async function settled(memberHead) {
  for (let i = 0; ; i++) {
    const runs = await runsOf(memberHead);
    if (runs[0]?.status === 'completed' || !runs.length || i >= 6) return runs;
    await new Promise((r) => setTimeout(r, WAIT));
  }
}

async function verdictRun(memberHead, pr) {
  for (const r of await settled(memberHead)) {
    const url = r.html_url ?? `run ${r.id}`;
    if (r.status !== 'completed') return { problem: `${url} on this head is still ${r.status}` };
    const jobs = (await gh.call(`actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100`))
      .jobs;
    const noop =
      r.conclusion !== 'cancelled' &&
      jobs.length > 0 &&
      jobs.every((j) => j.conclusion === 'skipped') &&
      NOOP.every((n) => jobs.some((j) => j.name === n));
    if (noop) continue;
    const prs = r.pull_requests ?? [];
    if (
      !prs.some((p) => p.number === pr && p.base?.ref === 'main') ||
      prs.some((p) => p.base?.ref !== 'main')
    )
      return {
        problem: `${url} is not for #${pr} into main (${prs.map((p) => `#${p.number}→${p.base?.ref}`).join(', ') || 'no pull request'})`,
      };
    const post = jobs.find((j) => j.name === POST);
    if (post?.conclusion !== 'success')
      return {
        problem: `the newest cert-review on this head, ${url}, did not certify it (post: ${post?.conclusion ?? 'missing'})`,
      };
    return { run: r, post };
  }
  return { problem: `no cert-review run of ${WORKFLOW} on this head` };
}

async function member(m) {
  const at = `#${m.pr} ${String(m.head).slice(0, 7)}`;
  if (m.status !== 'PASS')
    return {
      ok: false,
      line: `${at}: cert-self-guard ${m.status}${m.reason ? ` (${m.reason})` : ''}`,
    };
  const found = await verdictRun(sha(m.head), m.pr);
  if (found.problem) return { ok: false, line: `${at}: ${found.problem}` };
  return {
    ok: true,
    line: `${at}: cert-review success (${found.run.html_url ?? `run ${found.run.id}`})`,
  };
}

let rows = [];
let problem = '';
let prs = [];
try {
  const receipt = JSON.parse(env.RECEIPT ?? '');
  if (receipt.head !== head)
    throw new Error(`the self-guard receipt is for ${receipt.head}, not ${head}`);
  if (!Array.isArray(receipt.members) || receipt.members.length === 0)
    throw new Error('the self-guard receipt names no members');
  if (env.GUARD !== 'PASS' && receipt.members.every((m) => m.status === 'PASS'))
    throw new Error(`cert-self-guard returned ${env.GUARD}`);
  prs = receipt.members.map((m) => `#${m.pr}`);
  for (const m of receipt.members) rows.push(await member(m));
} catch (err) {
  problem = err.message;
  rows = [];
}
const ok = !problem && rows.length > 0 && rows.every((r) => r.ok);
const conclusion = ok ? 'success' : 'failure';
const first = rows.find((r) => !r.ok);
const title = ok
  ? `group: ${prs.join(' ')} certified`
  : `group: not certified: ${problem || first?.line || 'no members'}`;
const text = problem
  ? `merge group lookup failed: ${problem}`
  : rows.map((r) => `- ${r.line}`).join('\n');
await setCheck(gh, { pr: 'group', head, runId, runUrl, conclusion, title, summary: text });
output({ checked: 'true' });
const line = `cert-review: ${conclusion} on merge group ${head}: ${title}`;
console.log(`${line}\n${text}`);
summary(`${line}\n\n${text}`);
process.exit(ok ? 0 : 1);
