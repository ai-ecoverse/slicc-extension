import { existsSync, readFileSync } from 'node:fs';
import {
  alert,
  anchors,
  api,
  carriesSecret,
  commentBody,
  diffOf,
  foreignWriters,
  globs,
  injections,
  MARKER,
  opaque,
  output,
  place,
  quiet,
  redactVerdict,
  reviewBody,
  setCheck,
  sha,
  summary,
  validate,
} from './lib.mjs';

const env = process.env;
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const pull = event.pull_request;
const head = sha(pull.head.sha);
const base = sha(pull.base.sha);
const n = pull.number;
const runId = env.GITHUB_RUN_ID;
const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${runId}`;
const gh = api(env.GITHUB_REPOSITORY);

function verdictOf() {
  if (env.ARTIFACTS !== 'success')
    return { ok: false, problem: 'the verdict artifact is not the one the review job uploaded' };
  if (!env.VERDICT || !existsSync(env.VERDICT))
    return { ok: false, problem: 'the review left no verdict' };
  const raw = readFileSync(env.VERDICT, 'utf8');
  const secret = carriesSecret(raw, [env.GH_TOKEN, ...String(env.CERT_SECRETS ?? '').split('\n')]);
  if (secret) return { ok: false, secret };
  return validate(raw, head);
}

async function tidy() {
  const q =
    'query($o:String!,$r:String!,$n:Int!,$c:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$c){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:1){nodes{author{login} body}}}}}}}';
  const [o, r] = env.GITHUB_REPOSITORY.split('/');
  let cursor = null;
  let resolved = 0;
  for (let page = 0; page < 10; page++) {
    const t = (await gh.graphql(q, { o, r, n, c: cursor })).repository.pullRequest.reviewThreads;
    for (const th of t.nodes) {
      const first = th.comments.nodes[0];
      if (
        th.isResolved ||
        first?.author?.login !== 'github-actions' ||
        !first.body.includes(MARKER)
      )
        continue;
      await gh.graphql('mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id}}}', {
        t: th.id,
      });
      resolved++;
    }
    if (!t.pageInfo.hasNextPage) break;
    cursor = t.pageInfo.endCursor;
  }
  let dismissed = 0;
  for (let page = 1; page <= 10; page++) {
    const reviews = await gh.call(`pulls/${n}/reviews?per_page=100&page=${page}`);
    for (const rv of reviews) {
      if (rv.state !== 'CHANGES_REQUESTED' || rv.user?.login !== 'github-actions[bot]') continue;
      if (!rv.body?.includes(MARKER)) continue;
      await gh.call(`pulls/${n}/reviews/${rv.id}/dismissals`, 'PUT', {
        message: `superseded by cert-review on ${head.slice(0, 7)}`,
        event: 'DISMISS',
      });
      dismissed++;
    }
    if (reviews.length < 100) break;
  }
  console.log(
    `tidied: resolved ${resolved} earlier cert-review threads, dismissed ${dismissed} reviews`
  );
}

async function current() {
  const live = await gh.call(`pulls/${n}`);
  if (live.state === 'open' && live.head.sha === head) return true;
  console.log(`not posting: #${n} is ${live.state} at ${live.head.sha}, this run is for ${head}`);
  return false;
}

async function tidySafely() {
  try {
    await tidy();
  } catch (err) {
    console.log(`::warning title=cert-review::tidying earlier reviews failed: ${err.message}`);
  }
}

async function postReview({ conclusion, title, text, comments, files }) {
  const { inline, folded } = place(comments, anchors(files));
  const counts = { fail: 0, known: 0, note: 0 };
  for (const c of comments) counts[c.severity]++;
  const reviewEvent = conclusion === 'failure' ? 'REQUEST_CHANGES' : 'COMMENT';
  const body = (f) => reviewBody({ title, summary: text, head, runUrl, counts, folded: f });
  try {
    await gh.call(`pulls/${n}/reviews`, 'POST', {
      commit_id: head,
      event: reviewEvent,
      body: body(folded),
      comments: inline.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side,
        body: commentBody(c),
      })),
    });
    console.log(
      `posted ${reviewEvent}: ${inline.length} line comments, ${folded.length} in the body`
    );
  } catch (err) {
    if (err.status !== 422 || inline.length === 0) throw err;
    console.log(`line comments refused (${err.message.slice(0, 200)}); all go in the body`);
    await gh.call(`pulls/${n}/reviews`, 'POST', {
      commit_id: head,
      event: reviewEvent,
      body: body([...inline, ...folded]),
    });
  }
}

function conclude(found, verdict, problem) {
  const comments = [...found, ...(verdict?.comments ?? [])];
  const fails = comments.filter((c) => c.severity === 'fail').length;
  const titled = `fail: ${fails} finding${fails === 1 ? '' : 's'}`;
  if (!verdict && !fails)
    return {
      conclusion: 'failure',
      title: `incomplete: ${problem}; re-run`,
      text: `No valid verdict: ${problem}. Not certified; re-run the workflow.`,
      comments,
    };
  const pre = found.length
    ? `${found.length} finding(s) in code (prompt-injection text or files the review can't read). `
    : '';
  const text = verdict
    ? `${pre}${found.length ? `The review's own verdict was ${verdict.verdict}. ` : ''}${verdict.summary}`
    : `${pre}No valid verdict either (${problem}).`;
  return {
    conclusion: fails || !verdict ? 'failure' : 'success',
    title: fails ? titled : 'pass',
    text,
    comments,
  };
}

async function publish(r, files) {
  if (!(await current())) return;
  await tidySafely();
  if (r.conclusion === 'failure' || r.comments.length) await postReview({ ...r, files });
}

async function reviewed() {
  const files = diffOf(base, head);
  const found = [
    ...injections(files, globs(env.GUARD_PATHS), globs(env.INJECTION_ALLOW)),
    ...opaque(files, globs(env.QUIET), globs(env.LOUD)),
  ];
  const v = verdictOf();
  if (v.secret)
    return {
      conclusion: 'failure',
      title: 'incomplete: verdict carries a secret',
      text: `The verdict was withheld because it carries ${v.secret}. Nothing from it is posted.`,
    };
  const r = conclude(found, v.ok ? redactVerdict(v.value).value : null, v.problem);
  await publish(r, files);
  return r;
}

async function decided() {
  const plan = {
    conclusion: env.CONCLUSION === 'success' ? 'success' : 'failure',
    title: env.TITLE,
    text: env.SUMMARY,
  };
  if (!plan.title || !plan.text)
    return {
      conclusion: 'failure',
      title: 'incomplete: plan; re-run',
      text: 'The plan left no decision.',
    };
  if (plan.conclusion !== 'success') return plan;
  const files = diffOf(base, head);
  const found = injections(files, globs(env.GUARD_PATHS), globs(env.INJECTION_ALLOW));
  if (!found.length) {
    if (await current()) await tidySafely();
    return plan;
  }
  const r = conclude(found, { verdict: 'pass', summary: plan.text, comments: [] }, '');
  await publish(r, files);
  return r;
}

let r;
try {
  if (env.KIND === 'decided') r = await decided();
  else if (env.KIND === 'review') r = await reviewed();
  else
    r = {
      conclusion: 'failure',
      title: 'incomplete: plan; re-run',
      text: 'The plan did not finish.',
    };
} catch (err) {
  console.log(`::error title=cert-review::${err.message}`);
  r = {
    conclusion: 'failure',
    title: 'incomplete: post; re-run',
    text: `The verdict could not be posted (${err.message.slice(0, 300)}).`,
  };
}
try {
  const foreign = await foreignWriters(gh, head, {
    event: 'pull_request_target',
    job: 'cert / post',
    repo: env.GITHUB_REPOSITORY,
  });
  if (foreign.length) {
    const how = await alert(gh, head, foreign, runUrl);
    console.log(
      `::error title=cert-review::another workflow wrote cert-review on ${head} (alert issue ${how})`
    );
    r = {
      conclusion: 'failure',
      title: 'another workflow wrote cert-review',
      text: `Check runs named cert-review on this head that this workflow did not write: ${foreign.map((f) => `${f.url} (${f.reason})`).join('; ')}.`,
    };
  }
} catch (err) {
  r = {
    conclusion: 'failure',
    title: 'incomplete: writer check; re-run',
    text: `Listing the cert-review check runs on this head failed (${err.message.slice(0, 200)}).`,
  };
}
await setCheck(gh, {
  pr: n,
  head,
  runId,
  runUrl,
  conclusion: r.conclusion,
  title: r.title,
  summary: quiet(r.text),
});
output({ checked: 'true', conclusion: r.conclusion });
const line = `cert-review: ${r.conclusion} on ${head} (#${n}): ${r.title}`;
console.log(line);
summary(`${line}\n\n${r.text}`);
process.exit(r.conclusion === 'success' ? 0 : 1);
