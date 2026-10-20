import { readFileSync } from 'node:fs';
import {
  api,
  baseOf,
  decide,
  diffOf,
  diffSize,
  globs,
  livePull,
  noop,
  output,
  sha,
  touchedPaths,
} from './lib.mjs';

const env = process.env;
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const pull = event.pull_request;
const head = sha(pull.head.sha);
const repo = env.GITHUB_REPOSITORY;

if (
  noop({
    action: event.action,
    label: event.label?.name,
    approval: env.APPROVAL,
    changes: event.changes,
  })
) {
  console.log(`cert-review plan: noop (${event.action} ${event.label?.name ?? ''})`);
  output({ kind: 'noop' });
  process.exit(0);
}

let live;
try {
  live = await livePull(api(repo), pull);
} catch (err) {
  console.log(`cert-review plan: failure #${pull.number} ${head}: ${err.message}`);
  output({
    kind: 'decided',
    conclusion: 'failure',
    title: err.moved
      ? 'incomplete: the head moved; a newer run reviews it'
      : 'incomplete: plan; re-run',
    summary: err.moved
      ? `${err.message}. This run's head is not the pull request's head any more.`
      : `Reading the live pull request failed: ${err.message}.`,
  });
  process.exit(0);
}
const fork = live.head.repo?.full_name !== repo;
const files = fork ? [] : diffOf(baseOf(env, pull), head);
const paths = touchedPaths(files);
const d = decide({
  fork,
  repo,
  baseRef: live.base.ref,
  size: diffSize(files),
  draft: live.draft === true,
  approval: env.APPROVAL,
  guard: env.GUARD,
  receipt: env.RECEIPT,
  head,
  paths,
  quiet: globs(env.QUIET),
  loud: globs(env.LOUD),
});
if (d.kind === 'review') {
  console.log(
    `cert-review plan: review #${pull.number} ${head}, ${d.behaviour.length} behaviour files`
  );
  output({ kind: 'review' });
} else {
  console.log(`cert-review plan: ${d.conclusion} #${pull.number} ${head}: ${d.title}`);
  output({ kind: 'decided', conclusion: d.conclusion, title: d.title, summary: d.summary });
}
