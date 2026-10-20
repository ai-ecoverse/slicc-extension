import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHECK = 'cert-review';
export const MARKER = '<!-- cert-review v2 -->';
export const ACTIONS_APP = 15368;
export const WORKFLOW = '.github/workflows/cert-review.yml';

export function ourPath(path) {
  return path === WORKFLOW || path === `${WORKFLOW}@refs/heads/main`;
}

export function ourRun(run, repo) {
  const origin = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const url = String(run?.workflow_url ?? '');
  const here = [
    `${origin}/repos/${repo}/actions/workflows/`,
    `${origin}/repos/${repo}/actions/required_workflows/`,
  ];
  return (
    ourPath(run?.path) && run?.repository?.full_name === repo && here.some((p) => url.startsWith(p))
  );
}

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

export function baseOf(env, pull) {
  if (env.GITHUB_ACTIONS === 'true' && !env.BASE_SHA)
    throw new Error('BASE_SHA (the workflow commit) is not set');
  return sha(env.BASE_SHA || pull.base.sha);
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

export const MAX_DIFF_LINES = 15000;
const IMAGE = /\.(?:png|jpe?g|gif|webp|ico)$/i;

export function noop({ action, label, approval, changes }) {
  if (action === 'edited') return !changes?.base;
  return (action === 'labeled' || action === 'unlabeled') && label !== approval;
}

export function decide({
  fork,
  repo,
  baseRef,
  draft,
  approval,
  guard,
  receipt,
  head,
  paths,
  quiet,
  loud,
  size = 0,
}) {
  const failure = (title, summary) => ({ kind: 'decided', conclusion: 'failure', title, summary });
  if (baseRef !== 'main')
    return failure(
      'base: not main',
      `cert-review certifies pull requests into main only; this one targets ${baseRef}.`
    );
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
  if (size > MAX_DIFF_LINES)
    return failure(
      `fail: too large to certify (${size} annotated diff lines); split it`,
      `The annotated diff has ${size} lines, more than the ${MAX_DIFF_LINES} one review reads in full. Split the pull request.`
    );
  return { kind: 'review', behaviour };
}

export function diffSize(files) {
  return annotate(files).split('\n').length;
}

export function opaque(files, quiet, loud) {
  return files
    .filter((f) => f.binary && !IMAGE.test(f.path) && behaviourPaths([f.path], quiet, loud).length)
    .map((f) => ({
      path: f.path,
      line: 1,
      side: 'RIGHT',
      severity: 'fail',
      body: 'git treats this shipped or build file as binary, so the review could not read it. Make it text, or certify it another way.',
    }));
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

const CHUNK = 400;

function chunked(anchor, mark, text) {
  const out = [];
  for (let i = 0; i === 0 || i < text.length; i += CHUNK)
    out.push(`${anchor.padEnd(8)}${i === 0 ? mark : '…'} ${text.slice(i, i + CHUNK)}`);
  return out;
}

export function annotate(files) {
  const out = [];
  for (const f of files) {
    const how = `${STATUS[f.status] ?? f.status}${f.from ? ` from ${f.from}` : ''}${f.binary ? ', binary' : ''}`;
    out.push(`=== ${f.path} (${how})`);
    for (const l of f.lines) {
      if (l.kind === '@') out.push(l.text);
      else if (l.kind === '+') out.push(...chunked(`R${l.right}`, '+', l.text));
      else if (l.kind === '-') out.push(...chunked(`L${l.left}`, '-', l.text));
      else out.push(...chunked(`R${l.right}`, ' ', l.text));
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

const RUN = /[A-Za-z0-9+/=_-]{32,}/g;
const INTEGRITY = /^sha(?:256|384|512)-/;
const generic = (run) =>
  !INTEGRITY.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run);

export function redact(text) {
  let count = 0;
  const out = String(text).replace(RUN, (run) => {
    if (!generic(run)) return run;
    count++;
    return '[redacted]';
  });
  return { text: out, count };
}

export function redactVerdict(value) {
  let count = 0;
  const clean = (t) => {
    const r = redact(t);
    count += r.count;
    return r.text;
  };
  const comments = value.comments.map((c) => ({ ...c, body: clean(c.body) }));
  let summary = clean(value.summary);
  if (count) summary = `${summary} (${count} token-like string${count === 1 ? '' : 's'} redacted)`;
  return { value: { ...value, summary, comments }, count };
}

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
  return { ok: true, value };
}

const SECRET_SHAPES = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /ABSK[A-Za-z0-9+/=]{16,}/,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z0-9 ]*-----/,
];

export function carriesSecret(text, secrets = []) {
  const raw = String(text);
  for (const v of secrets.filter((x) => typeof x === 'string' && x.length >= 8)) {
    const b = Buffer.from(v);
    const forms = [
      v,
      JSON.stringify(v).slice(1, -1),
      b.toString('base64'),
      b.toString('base64').replace(/=+$/, ''),
      b.toString('base64url'),
      b.toString('hex'),
      encodeURIComponent(v),
      v.split('').reverse().join(''),
    ];
    const lower = raw.toLowerCase();
    if (forms.some((f) => raw.includes(f) || lower.includes(f.toLowerCase())))
      return 'a secret value this run holds';
  }
  const shape = SECRET_SHAPES.find((re) => re.test(raw));
  if (shape) return `a token-shaped string (${shape.source.slice(0, 16)}…)`;
  return '';
}

const CONTROLS = /[\u202a-\u202e\u2066-\u2069\u200b-\u200d\u2060\ufeff]/;
const REVIEWER =
  /\b(?:cert(?:ification)?[- ]review(?:er)?|certifier|reviewer|the review|verdict|certify|certified)\b/i;
const AIMED = [
  /["']?verdict["']?\s*[:=]\s*["']?(?:pass|success|certified)\b/i,
  /\bas the (?:cert(?:ification)?|security)? ?review(?:er)?\b/i,
  /\b(?:dear|attention|note to|hey) (?:ai|llm|claude|reviewer|certifier|model)\b/i,
  /\byou (?:are|must|should) (?:now )?(?:an? )?(?:ai|llm|language model|reviewer|certifier)\b/i,
  /\b(?:pass|approve|certify|accept|mark)\b[^.\n]{0,30}\b(?:this|the)\b[^.\n]{0,20}\b(?:change|pull request|pr|diff)\b/i,
];
const GENERIC = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your|the)\b[^.\n]{0,20}\b(?:instructions?|prompt|rules?|guidelines?)\b/i,
  /\bsystem prompt\b/i,
];

export function injectionOf(text) {
  if (CONTROLS.test(text)) return 'fail-control';
  const generic = GENERIC.some((re) => re.test(text));
  if (AIMED.some((re) => re.test(text)) || (generic && REVIEWER.test(text))) return 'fail-aimed';
  if (generic) return 'note';
  return '';
}

export function injections(files, exempt, allow = []) {
  const hits = [];
  for (const f of files) {
    if (matchesAny(f.path, exempt)) continue;
    const allowed = matchesAny(f.path, allow);
    for (const l of f.lines) {
      if (l.kind !== '+') continue;
      const kind = injectionOf(l.text);
      if (!kind) continue;
      if (kind === 'fail-control')
        hits.push({
          path: f.path,
          line: l.right,
          side: 'RIGHT',
          severity: 'fail',
          body: 'An invisible bidirectional or zero-width control character in an added line: it can hide text from a human reviewer. Remove it; there is no override.',
        });
      else if (kind === 'fail-aimed' && !allowed)
        hits.push({
          path: f.path,
          line: l.right,
          side: 'RIGHT',
          severity: 'fail',
          body: "Possible prompt injection aimed at the certifier: text in the change addresses the reviewer or claims a verdict. Remove it, or list the path in the caller's injection-allow (guard-protected) if it is a test fixture.",
        });
      else
        hits.push({
          path: f.path,
          line: l.right,
          side: 'RIGHT',
          severity: 'note',
          body: 'Instruction-shaped text (for example "system prompt" or "ignore previous instructions"). Not a failure by itself; the review was told to treat this line as suspect data.',
        });
    }
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
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(route, method, body);
      } catch (err) {
        const transient = !err.status || err.status >= 500;
        if (method !== 'GET' || !transient || attempt >= 2) throw err;
        await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
      }
    }
  };
  const once = async (route, method, body) => {
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

const EXTERNAL = /^v2:[^:]+:([0-9a-f]{40}):([1-9]\d*):([1-9]\d*)$/;

async function checkWrites(gh, ref) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const data = await gh.call(
      `commits/${sha(ref)}/check-runs?check_name=${CHECK}&filter=all&per_page=100&page=${page}`
    );
    for (const c of data.check_runs.filter((x) => x.name === CHECK)) {
      const m = EXTERNAL.exec(c.external_id ?? '');
      out.push({
        url: c.html_url ?? `check run ${c.id}`,
        who: c.app?.slug ?? String(c.app?.id),
        ours: c.app?.id === ACTIONS_APP,
        head: m?.[1],
        run: m?.[2],
        attempt: m?.[3],
        said: c.status === 'completed' ? c.conclusion : 'pending',
        kind: 'check run',
      });
    }
    if (data.check_runs.length < 100) return out;
  }
  throw new Error('more than 1000 cert-review check runs on this head');
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const STATE = { success: 'success', pending: 'pending' };

async function statusWrites(gh, ref, repo) {
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const target = new RegExp(
    `^${escape(server)}/${escape(repo)}/actions/runs/([1-9]\\d*)/attempts/([1-9]\\d*)$`
  );
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const data = await gh.call(`commits/${sha(ref)}/statuses?per_page=100&page=${page}`);
    for (const st of data.filter((x) => x.context === CHECK)) {
      const m = target.exec(st.target_url ?? '');
      out.push({
        url: st.target_url || `status ${st.id}`,
        who: st.creator?.login ?? 'unknown',
        ours: st.creator?.login === 'github-actions[bot]',
        head: m ? ref : undefined,
        run: m?.[1],
        attempt: m?.[2],
        said: STATE[st.state] ?? 'failure',
        kind: 'status',
      });
    }
    if (data.length < 100) return out;
  }
  throw new Error('more than 1000 statuses on this head');
}

async function judge(gh, w, ref, { event, job, repo }) {
  let run;
  try {
    run = await gh.call(`actions/runs/${w.run}`);
  } catch {
    return `run ${w.run} does not exist`;
  }
  if (!ourRun(run, repo) || run.event !== event || run.head_sha !== ref)
    return `run ${w.run} is ${run.path} on ${run.event}, not ${WORKFLOW} on ${event} for this head`;
  const jobs = (await gh.call(`actions/runs/${run.id}/attempts/${w.attempt}/jobs?per_page=100`))
    .jobs;
  const writer = jobs.find((j) => j.name === job);
  if (!writer) return `run ${w.run} has no ${job} job`;
  if (writer.status !== 'completed') return '';
  const said = w.said === 'success';
  const did = writer.conclusion === 'success';
  if (said !== did && !(writer.conclusion === 'cancelled' && !said))
    return `says ${w.said}, but run ${w.run}'s ${job} job ended ${writer.conclusion}`;
  return '';
}

export async function foreignWriters(gh, ref, how) {
  const foreign = [];
  const seen = new Set();
  const all = [...(await checkWrites(gh, ref)), ...(await statusWrites(gh, ref, how.repo))];
  for (const w of all) {
    const why = (reason) => foreign.push({ url: w.url, app: w.who, reason });
    const key = `${w.run}:${w.attempt}`;
    if (!w.ours) why(`written by ${w.who}`);
    else if (!w.run || w.head !== ref) why('names no run of this workflow for this head');
    else if (w.said === 'pending') continue;
    else if (seen.has(key)) why(`a second cert-review write for run ${w.run} attempt ${w.attempt}`);
    else {
      seen.add(key);
      const reason = await judge(gh, w, ref, how);
      if (reason) why(reason);
    }
  }
  return foreign;
}

export async function alert(gh, ref, foreign, runUrl) {
  const title = `cert-review: another workflow wrote cert-review on ${ref.slice(0, 12)}`;
  const open = await gh.call('issues?state=open&per_page=100');
  if (open.some((i) => i.title === title)) return 'already open';
  await gh.call('issues', 'POST', {
    title,
    body: `${foreign.map((f) => `- ${f.url} (${f.app}): ${f.reason}`).join('\n')}\n\nFound by ${runUrl}. The required cert-review check on ${ref} is failed until the foreign writer is removed.`,
  });
  return 'opened';
}

export async function livePull(gh, event) {
  const live = await gh.call(`pulls/${event.number}`);
  if (live.head?.sha !== event.head.sha)
    throw new Error(
      `#${event.number} is now at ${live.head?.sha}, this run is for ${event.head.sha}`
    );
  return live;
}

export function setCheck(gh, { head, runUrl, conclusion, title }) {
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
  return gh.call(`statuses/${sha(head)}`, 'POST', {
    state: conclusion === 'success' ? 'success' : 'failure',
    context: CHECK,
    description: String(title).slice(0, 140),
    target_url: `${runUrl}/attempts/${attempt}`,
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
