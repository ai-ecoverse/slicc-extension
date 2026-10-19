import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHECK = 'cert-review';
export const MARKER = '<!-- cert-review v2 -->';
export const ACTIONS_APP = 15368;
export const WORKFLOW = '.github/workflows/cert-review.yml';

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA = JSON.parse(readFileSync(join(here, 'verdict.schema.json'), 'utf8'));

export function git(...args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function sha(value) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error(`not a commit sha: ${value}`);
  return value;
}

export function mergeBase(base, head) {
  return sha(git('merge-base', sha(base), sha(head)).trim());
}

export function changes(base, head) {
  const fields = git(
    'diff',
    '--find-renames',
    '--name-status',
    '-z',
    mergeBase(base, head),
    sha(head),
    '--'
  ).split('\0');
  const out = [];
  while (fields.length && fields[0]) {
    const status = fields.shift();
    if (!/^(?:[AMDTUX]|[RC]\d+)$/.test(status)) throw new Error(`unexpected git status ${status}`);
    if (/^[RC]/.test(status)) {
      const from = fields.shift();
      const path = fields.shift();
      if (!from || !path) throw new Error('missing renamed path');
      out.push({ status: status[0], from, path });
    } else {
      const path = fields.shift();
      if (!path) throw new Error('missing changed path');
      out.push({ status, path });
    }
  }
  return out;
}

export function touchedPaths(files) {
  return [...new Set(files.flatMap((f) => (f.from ? [f.from, f.path] : [f.path])))];
}

function segment(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '*') {
      while (text[i + 1] === '*') i++;
      out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[\\^$.+()|{}[\]]/g, '\\$&');
  }
  return out;
}

export function glob(pattern) {
  const parts = pattern.split('/');
  let source = '';
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    if (part === '**') source += last ? '.+' : '(?:[^/]+/)*';
    else source += segment(part) + (last ? '' : '/');
  });
  return new RegExp(`^${source}$`);
}

export function globs(text) {
  return String(text ?? '')
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function matchesAny(path, patterns) {
  return patterns.some((p) => glob(p).test(path));
}

export function behaviourPaths(paths, quiet, loud) {
  return paths.filter((p) => !matchesAny(p, quiet) || matchesAny(p, loud));
}

const list = (paths) =>
  `${paths.slice(0, 8).join(', ')}${paths.length > 8 ? `, +${paths.length - 8}` : ''}`;

export function noop({ action, label, approval }) {
  return (action === 'labeled' || action === 'unlabeled') && label !== approval;
}

export function decide({ fork, repo, draft, approval, guard, receipt, head, paths, quiet, loud }) {
  const failure = (title, summary) => ({ kind: 'decided', conclusion: 'failure', title, summary });
  if (fork)
    return failure(
      `fork: push the branch to ${repo}`,
      `cert-review does not review pull requests from forks: push the branch to ${repo} and open the pull request from there.`
    );
  if (draft)
    return failure(
      'draft: not reviewed (mark ready)',
      'A draft pull request is not reviewed. Mark it ready for review to start the cert review.'
    );
  let member;
  try {
    member = JSON.parse(receipt ?? '').members?.find((m) => m.head === head);
  } catch {}
  if (guard === 'FAIL' && member?.status === 'FAIL' && member.touched?.length)
    return failure(
      'needs coordinator review',
      `This pull request changes the cert path (${list(member.touched)}). A lane coordinator's ${approval} label, applied after the current head, approves it; a push clears it.`
    );
  if (guard !== 'PASS' || member?.status !== 'PASS')
    return failure(
      'incomplete: cert-self-guard; re-run',
      `cert-self-guard returned ${guard || 'nothing'}${member?.reason ? ` (${member.reason})` : ''}${member ? '' : ', with no receipt for this head'}.`
    );
  const behaviour = behaviourPaths(paths, quiet, loud);
  if (behaviour.length === 0)
    return {
      kind: 'decided',
      conclusion: 'success',
      title: `not behaviour: ${list(paths)}`.slice(0, 200),
      summary: `No behaviour change: every changed file is a test or documentation outside the shipped tree (${list(paths)}).`,
    };
  return { kind: 'review', behaviour };
}

export function fileDiff(base, head, file) {
  const paths = file.from ? [file.from, file.path] : [file.path];
  return git(
    'diff',
    '--find-renames',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '-U3',
    mergeBase(base, head),
    sha(head),
    '--',
    ...paths
  );
}

export function parseHunks(text) {
  const out = [];
  let left = 0;
  let right = 0;
  let inHunk = false;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) {
      left = Number(m[1]);
      right = Number(m[2]);
      inHunk = true;
      out.push({ kind: '@', text: raw });
      continue;
    }
    if (!inHunk) continue;
    const c = raw[0];
    if (c === '+') out.push({ kind: '+', right: right++, text: raw.slice(1) });
    else if (c === '-') out.push({ kind: '-', left: left++, text: raw.slice(1) });
    else if (c === ' ') out.push({ kind: ' ', left: left++, right: right++, text: raw.slice(1) });
  }
  return out;
}

export function diffOf(base, head) {
  return changes(base, head).map((file) => {
    const text = fileDiff(base, head, file);
    const lines = parseHunks(text);
    return { ...file, binary: lines.length === 0 && /^Binary files /m.test(text), lines };
  });
}

const STATUS = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
};

export function annotate(files) {
  const out = [];
  for (const f of files) {
    const how = `${STATUS[f.status] ?? f.status}${f.from ? ` from ${f.from}` : ''}${f.binary ? ', binary' : ''}`;
    out.push(`=== ${f.path} (${how})`);
    for (const l of f.lines) {
      if (l.kind === '@') out.push(l.text);
      else if (l.kind === '+') out.push(`R${l.right}`.padEnd(8) + `+ ${l.text}`);
      else if (l.kind === '-') out.push(`L${l.left}`.padEnd(8) + `- ${l.text}`);
      else out.push(`R${l.right}`.padEnd(8) + `  ${l.text}`);
    }
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

export function anchors(files) {
  const set = new Set();
  for (const f of files)
    for (const l of f.lines) {
      if (l.right !== undefined) set.add(`${f.path}\0RIGHT\0${l.right}`);
      if (l.left !== undefined) set.add(`${f.path}\0LEFT\0${l.left}`);
    }
  return set;
}

function closedObject(value, schema, at, problems) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${at} is not an object`);
    return;
  }
  for (const key of Object.keys(value))
    if (!(key in schema.properties)) problems.push(`${at} has an unknown key ${key}`);
  for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${at} lacks ${key}`);
  for (const [key, sub] of Object.entries(schema.properties))
    if (key in value) closed(value[key], sub, `${at}.${key}`, problems);
}

function closedArray(value, schema, at, problems) {
  if (!Array.isArray(value)) {
    problems.push(`${at} is not an array`);
    return;
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems)
    problems.push(`${at} has more than ${schema.maxItems} items`);
  value.forEach((item, i) => {
    closed(item, schema.items, `${at}[${i}]`, problems);
  });
}

function closedString(value, schema, at, problems) {
  if (typeof value !== 'string') {
    problems.push(`${at} is not a string`);
    return;
  }
  if (schema.minLength !== undefined && value.trim().length < schema.minLength)
    problems.push(`${at} is shorter than ${schema.minLength}`);
  if (schema.maxLength !== undefined && value.length > schema.maxLength)
    problems.push(`${at} is longer than ${schema.maxLength}`);
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
    problems.push(`${at} does not match ${schema.pattern}`);
}

function closedInteger(value, schema, at, problems) {
  if (!Number.isSafeInteger(value)) problems.push(`${at} is not an integer`);
  else if (schema.minimum !== undefined && value < schema.minimum)
    problems.push(`${at} is below ${schema.minimum}`);
}

const CLOSED = {
  object: closedObject,
  array: closedArray,
  string: closedString,
  integer: closedInteger,
};

function closed(value, schema, at, problems) {
  if ('const' in schema) {
    if (value !== schema.const) problems.push(`${at} is not ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum) {
    if (!schema.enum.includes(value))
      problems.push(`${at} is not one of ${schema.enum.join(', ')}`);
    return;
  }
  const check = CLOSED[schema.type];
  if (!check) problems.push(`${at}: unsupported schema`);
  else check(value, schema, at, problems);
}

const tokenish = (text) =>
  (String(text).match(/[A-Za-z0-9+/=_-]{32,}/g) ?? []).some(
    (run) => /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run)
  );

export function validate(text, head) {
  if (Buffer.byteLength(text) > 65536)
    return { ok: false, problem: 'the verdict is larger than 64 KB' };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'the verdict is not JSON' };
  }
  const problems = [];
  closed(value, SCHEMA, 'verdict', problems);
  if (problems.length) return { ok: false, problem: problems.slice(0, 5).join('; ') };
  if (value.head !== head)
    return { ok: false, problem: `the verdict is for ${value.head}, not ${head}` };
  const fails = value.comments.filter((c) => c.severity === 'fail').length;
  if (value.verdict === 'pass' && fails)
    return { ok: false, problem: `the verdict is pass but ${fails} comment(s) are fail` };
  if (value.verdict === 'fail' && !fails)
    return { ok: false, problem: 'the verdict is fail but no comment is fail' };
  const texts = [value.summary, ...value.comments.flatMap((c) => [c.path, c.body])];
  if (texts.some(tokenish))
    return {
      ok: false,
      problem: 'the review text contains a token-like string, so none of it is posted',
    };
  return { ok: true, value };
}

const INJECTION = [
  /[\u202a-\u202e\u2066-\u2069]/,
  /[\u200b-\u200d\u2060\ufeff]/,
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your|the)\b[^.\n]{0,20}\b(?:instructions?|prompt|rules?|guidelines?)\b/i,
  /\bsystem prompt\b/i,
  /["']?verdict["']?\s*[:=]\s*["']?(?:pass|success|certified)\b/i,
  /\bas the (?:cert(?:ification)?|security)? ?review(?:er)?\b/i,
  /\b(?:dear|attention|note to|hey) (?:ai|llm|claude|reviewer|certifier|model)\b/i,
  /\byou (?:are|must|should) (?:now )?(?:an? )?(?:ai|llm|language model|reviewer|certifier)\b/i,
];

export function injections(files, exempt) {
  const hits = [];
  for (const f of files) {
    if (matchesAny(f.path, exempt)) continue;
    for (const l of f.lines)
      if (l.kind === '+' && INJECTION.some((re) => re.test(l.text)))
        hits.push({
          path: f.path,
          line: l.right,
          side: 'RIGHT',
          severity: 'fail',
          body: 'Possible prompt injection aimed at the certifier: text in the change addresses the reviewer or claims a verdict. Remove it; there is no override.',
        });
  }
  return hits;
}

export function quiet(text) {
  return String(text)
    .replace(/@(?=[A-Za-z0-9-])/g, '@\u200b')
    .replace(/<!--/g, '&lt;!--');
}

export function place(comments, set) {
  const inline = [];
  const folded = [];
  for (const c of comments) {
    if (set.has(`${c.path}\0${c.side}\0${c.line}`)) inline.push(c);
    else folded.push(c);
  }
  return { inline, folded };
}

export function reviewBody({ title, summary, head, runUrl, counts, folded }) {
  const lines = [
    `**cert-review: ${quiet(title)}** on ${head.slice(0, 7)}: ${quiet(summary)}`,
    `${counts.fail} fail, ${counts.known} known, ${counts.note} note.`,
    ...folded.map((c) => `- ${c.severity} \`${quiet(c.path)}:${c.line}\` ${quiet(c.body)}`),
    '',
    `[run](${runUrl})`,
    MARKER,
  ];
  return lines.join('\n');
}

export function commentBody(c) {
  return `**${c.severity}** ${quiet(c.body)}\n\n${MARKER}`;
}

export function api(repo, token = process.env.GH_TOKEN) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`invalid repository ${repo}`);
  const origin = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const call = async (route, method = 'GET', body) => {
    const url = route.startsWith('/') ? `${origin}${route}` : `${origin}/repos/${repo}/${route}`;
    const r = await fetch(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(`GitHub ${method} ${route}: HTTP ${r.status} ${text.slice(0, 300)}`);
      err.status = r.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  };
  const graphql = async (query, variables) => {
    const data = await call('/graphql', 'POST', { query, variables });
    if (data.errors?.length)
      throw new Error(`GraphQL: ${data.errors.map((e) => e.message).join('; ')}`);
    return data.data;
  };
  return { call, graphql };
}

export function setCheck(gh, { pr, head, runId, runUrl, conclusion, title, summary }) {
  return gh.call('check-runs', 'POST', {
    name: CHECK,
    head_sha: sha(head),
    external_id: `v2:${pr}:${head}:${runId}`,
    details_url: runUrl,
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    output: { title: String(title).slice(0, 200), summary: String(summary).slice(0, 60000) },
  });
}

export function output(values) {
  const lines = Object.entries(values).map(
    ([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}`
  );
  if (process.env.GITHUB_OUTPUT)
    execFileSync('sh', ['-c', 'cat >> "$GITHUB_OUTPUT"'], { input: `${lines.join('\n')}\n` });
}

export function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY)
    execFileSync('sh', ['-c', 'cat >> "$GITHUB_STEP_SUMMARY"'], { input: `${text}\n` });
}
