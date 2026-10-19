import { readFileSync } from 'node:fs';
import { decide, diffOf, diffSize, globs, noop, output, sha, touchedPaths } from './lib.mjs';

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

const fork = pull.head.repo?.full_name !== repo;
const files = fork ? [] : diffOf(sha(env.BASE_SHA || pull.base.sha), head);
const paths = touchedPaths(files);
const d = decide({
  fork,
  repo,
  baseRef: pull.base.ref,
  size: diffSize(files),
  draft: pull.draft === true,
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
