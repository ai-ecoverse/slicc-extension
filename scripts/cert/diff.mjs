import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { annotate, diffOf, sha } from './lib.mjs';

const env = process.env;
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const pull = event.pull_request;
const head = sha(pull.head.sha);
const base = sha(pull.base.sha);
const out = env.CERT_DIR;
const template = env.CERT_PROMPT;
if (!out || !template) throw new Error('CERT_DIR and CERT_PROMPT are required');
mkdirSync(out, { recursive: true });

const files = diffOf(base, head);
writeFileSync(join(out, 'diff.txt'), annotate(files));
writeFileSync(
  join(out, 'files.json'),
  `${JSON.stringify(
    files.map((f) => ({ path: f.path, status: f.status, from: f.from, binary: f.binary })),
    null,
    2
  )}\n`
);
const values = {
  REPO: env.GITHUB_REPOSITORY,
  PR: String(pull.number),
  HEAD: head,
  BASE: base,
  WORKSPACE: env.GITHUB_WORKSPACE ?? process.cwd(),
  DIFF: join(out, 'diff.txt'),
  FILES: join(out, 'files.json'),
};
const prompt = readFileSync(template, 'utf8').replace(
  /\{\{([A-Z]+)\}\}/g,
  (m, k) => values[k] ?? m
);
writeFileSync(join(out, 'prompt.txt'), prompt);
console.log(
  `cert-review: ${files.length} files, ${files.reduce((n, f) => n + f.lines.length, 0)} diff lines for #${pull.number} ${head}`
);
