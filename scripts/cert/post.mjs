import { existsSync, readFileSync } from 'node:fs';
import {
  anchors,
  api,
  commentBody,
  diffOf,
  globs,
  injections,
  MARKER,
  output,
  place,
  quiet,
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
  return validate(readFileSync(env.VERDICT, 'utf8'), head);
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

async function reviewed() {
  const files = diffOf(base, head);
  const hits = injections(files, globs(env.GUARD_PATHS));
  const v = verdictOf();
  let comments = hits;
  let conclusion = 'failure';
  let title;
  let text;
  if (v.ok) {
    comments = [...hits, ...v.value.comments];
    const fails = comments.filter((c) => c.severity === 'fail').length;
    conclusion = fails ? 'failure' : 'success';
    title = fails ? `fail: ${fails} finding${fails === 1 ? '' : 's'}` : 'pass';
    text = hits.length
      ? `Possible prompt injection on ${hits.length} added line(s); the review's own verdict was ${v.value.verdict}. ${v.value.summary}`
      : v.value.summary;
  } else if (hits.length) {
    title = `fail: ${hits.length} finding${hits.length === 1 ? '' : 's'}`;
    text = `Possible prompt injection on ${hits.length} added line(s), and no valid verdict (${v.problem}).`;
  } else {
    title = `incomplete: ${v.problem}; re-run`;
    text = `No valid verdict: ${v.problem}. Not certified; re-run the workflow.`;
  }
  if ((conclusion === 'failure' || comments.length) && (await current())) {
    await tidySafely();
    await postReview({ conclusion, title, text, comments, files });
  } else if (conclusion === 'success' && (await current())) await tidySafely();
  return { conclusion, title, text };
}

let r;
try {
  if (env.KIND === 'decided') {
    r = {
      conclusion: env.CONCLUSION === 'success' ? 'success' : 'failure',
      title: env.TITLE,
      text: env.SUMMARY,
    };
    if (!r.title || !r.text)
      r = {
        conclusion: 'failure',
        title: 'incomplete: plan; re-run',
        text: 'The plan left no decision.',
      };
    if (r.conclusion === 'success' && (await current())) await tidySafely();
  } else if (env.KIND === 'review') r = await reviewed();
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
