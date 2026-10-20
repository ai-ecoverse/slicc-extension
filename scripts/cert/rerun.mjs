import { readFileSync } from 'node:fs';
import { api, ourRun, output, sha } from './lib.mjs';

const env = process.env;
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const repo = env.GITHUB_REPOSITORY;
const gh = api(repo);
const n = event.pull_request.number;

function done(verdict, line, code = 0) {
  console.log(`cert-review rerun: ${verdict} #${n}: ${line}`);
  output({ verdict });
  process.exit(code);
}

if (event.pull_request.head.repo?.full_name !== repo) done('noop', 'a fork head is never reviewed');
const live = await gh.call(`pulls/${n}`);
if (live.state !== 'open') done('noop', `the pull request is ${live.state}`);
if (live.draft === true) done('noop', 'the pull request is a draft');
if (live.base?.ref !== 'main') done('noop', `the pull request targets ${live.base?.ref}`);
const head = sha(live.head.sha);
const runs = [];
for (let page = 1; ; page++) {
  if (page > 10) done('failure', `more than 1000 pull_request_target runs on ${head}`, 1);
  const data = await gh.call(
    `actions/runs?event=pull_request_target&head_sha=${head}&per_page=100&page=${page}`
  );
  runs.push(...data.workflow_runs);
  if (data.workflow_runs.length < 100) break;
}
const ours = runs
  .filter((r) => ourRun(r, repo) && r.head_sha === head && r.event === 'pull_request_target')
  .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
const newest = ours[0];
if (!newest) done('failure', `no cert-review run on ${head} to re-run`, 1);
if (newest.status !== 'completed')
  done(
    'skipped',
    `run ${newest.id} on ${head} is still ${newest.status}, and its post reads the live pull request`
  );
let changed = 0;
for (const path of ['.github/workflows/cert-review.yml', 'scripts/cert']) {
  const [last] = await gh.call(`commits?sha=main&path=${encodeURIComponent(path)}&per_page=1`);
  changed = Math.max(changed, Date.parse(last?.commit?.committer?.date ?? 0) || 0);
}
if (Date.parse(newest.created_at) < changed)
  done(
    'stale',
    `run ${newest.id} on ${head} predates main's current cert-review code, so a re-run would replay old code: push a commit to re-certify`
  );
try {
  await gh.call(`actions/runs/${newest.id}/rerun`, 'POST', {});
} catch (err) {
  done(
    'failure',
    `re-running run ${newest.id} failed (${err.message.slice(0, 200)}): push a commit to re-certify`,
    1
  );
}
done('rerun', `re-ran every job of run ${newest.id} on ${head}`);
