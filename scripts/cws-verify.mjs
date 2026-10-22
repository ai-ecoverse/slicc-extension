import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { crc32, inflateRawSync } from 'node:zlib';
import { isMain } from './is-main.mjs';

const ITEM = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';
const UPDATE_URL = 'https://clients2.google.com/service/update2/crx';
const INSERTED = `{\n"update_url": "${UPDATE_URL}",\n\n`;

export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('no zip end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const size = buf.readUInt32LE(pos + 20);
    const plain = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    if (size === 0xffffffff || local === 0xffffffff) throw new Error('zip64 is not expected');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localName = buf
      .subarray(local + 30, local + 30 + buf.readUInt16LE(local + 26))
      .toString('utf8');
    if (localName !== name) throw new Error(`zip entry ${name} has local name ${localName}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    if (data.length !== plain || crc32(data) !== crc)
      throw new Error(`zip entry ${name} fails its size or CRC`);
    if (entries.has(name)) throw new Error(`duplicate zip entry ${name}`);
    entries.set(name, data);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function crxZip(crx) {
  if (crx.subarray(0, 4).toString('latin1') !== 'Cr24') throw new Error('not a CRX file');
  if (crx.readUInt32LE(4) !== 3) throw new Error(`CRX version ${crx.readUInt32LE(4)}, expected 3`);
  return crx.subarray(12 + crx.readUInt32LE(8));
}

export function compare(crx, zip) {
  const store = unzip(crxZip(crx));
  const release = unzip(zip);
  const problems = [];
  const metadata = [...store.keys()].filter(
    (n) => n === '_metadata/' || n.startsWith('_metadata/')
  );
  if (!metadata.length) problems.push('the store crx has no _metadata/');
  if ([...release.keys()].some((n) => n.startsWith('_metadata/')))
    problems.push('the release zip carries _metadata/');
  for (const name of store.keys())
    if (!metadata.includes(name) && !release.has(name))
      problems.push(`only in the store crx: ${name}`);
  for (const name of release.keys())
    if (!store.has(name)) problems.push(`only in the release zip: ${name}`);
  let files = 0;
  for (const [name, bytes] of release) {
    const s = store.get(name);
    if (!s) continue;
    files++;
    let theirs = s;
    if (name === 'manifest.json') {
      const text = s.toString('utf8');
      if (!text.startsWith(INSERTED)) {
        problems.push(
          'the store manifest.json does not start with the update_url line the store inserts'
        );
        continue;
      }
      theirs = Buffer.from(`{\n${text.slice(INSERTED.length)}`, 'utf8');
    }
    if (!theirs.equals(bytes)) problems.push(`${name} differs`);
  }
  return { ok: problems.length === 0, problems, files, metadata: metadata.length };
}

export function sameZip(a, b) {
  const x = unzip(a);
  const y = unzip(b);
  const problems = [];
  for (const name of x.keys()) if (!y.has(name)) problems.push(`only in the release zip: ${name}`);
  for (const name of y.keys()) if (!x.has(name)) problems.push(`only in the rebuild: ${name}`);
  for (const [name, bytes] of x)
    if (y.has(name) && !y.get(name).equals(bytes))
      problems.push(`${name} differs from the rebuild`);
  return problems;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function get(url, headers = {}) {
  const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`GET ${url.split('?')[0]}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function live(item) {
  const xml = (
    await get(`${UPDATE_URL}?prodversion=146.0&acceptformat=crx3&x=id%3D${item}%26uc`)
  ).toString('utf8');
  const check = /<updatecheck\b[^>]*>/i.exec(xml)?.[0] ?? '';
  const attr = (k) => new RegExp(`\\b${k}="([^"]+)"`).exec(check)?.[1];
  const version = attr('version');
  const codebase = attr('codebase');
  const hash = attr('hash_sha256');
  if (!version || !codebase || !/^[0-9a-f]{64}$/.test(hash ?? ''))
    throw new Error('the update XML names no version, codebase and hash_sha256');
  const crx = await get(codebase);
  if (sha256(crx) !== hash)
    throw new Error('the downloaded crx does not match the update XML hash_sha256');
  return { version, crx, hash };
}

function github(repo, token) {
  const origin = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const h = { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' };
  const call = async (route, method = 'GET', body) => {
    const r = await fetch(`${origin}/repos/${repo}/${route}`, {
      method,
      headers: {
        ...h,
        accept: 'application/vnd.github+json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error(`GitHub ${method} ${route}: HTTP ${r.status}`);
    return r.json();
  };
  const asset = (id) =>
    get(`${origin}/repos/${repo}/releases/assets/${id}`, {
      ...h,
      accept: 'application/octet-stream',
    });
  return { call, asset };
}

async function tagCommit(gh, tag) {
  let ref = await gh.call(`git/ref/tags/${tag}`);
  for (let i = 0; ref.object.type === 'tag' && i < 5; i++)
    ref = { object: (await gh.call(`git/tags/${ref.object.sha}`)).object };
  if (ref.object.type !== 'commit') throw new Error(`${tag} does not resolve to a commit`);
  return ref.object.sha;
}

async function recorded(gh, commit, key) {
  const runs = (
    await gh.call(`commits/${commit}/check-runs?check_name=cws-verify&filter=all&per_page=100`)
  ).check_runs;
  return runs.some((c) => c.external_id === key && c.conclusion === 'success');
}

export async function probe({ repo, token, item }) {
  const gh = github(repo, token);
  const { version, crx, hash } = await live(item);
  const tag = `v${version}`;
  const commit = await tagCommit(gh, tag);
  const onMain = (await gh.call(`compare/main...${commit}`)).status;
  if (!['identical', 'behind'].includes(onMain))
    throw new Error(
      `the store serves ${version}, and ${tag} (${commit}) is not on main (${onMain})`
    );
  return {
    gh,
    version,
    tag,
    commit,
    crx,
    hash,
    done: await recorded(gh, commit, `${version}:${hash}`),
  };
}

export async function verifyLive({ repo, token, item, expect, rebuilt }) {
  const p = await probe({ repo, token, item });
  if (expect && p.version !== expect)
    throw new Error(`the store moved from ${expect} to ${p.version} during the run; re-run`);
  if (p.done)
    return { ...p, result: { ok: true, problems: [], files: 0 }, how: 'already recorded' };
  if (!rebuilt) throw new Error(`${p.tag} is not verified yet and no rebuild of it was given`);
  const release = await p.gh.call(`releases/tags/${p.tag}`);
  const asset = release.assets?.find((a) => a.name === 'slicc-extension.zip');
  if (release.draft || !asset)
    throw new Error(`release ${p.tag} has no published slicc-extension.zip`);
  const zip = await p.gh.asset(asset.id);
  const onMain = (await p.gh.call(`compare/main...${p.commit}`)).status;
  const result = compare(p.crx, zip);
  result.problems.push(...sameZip(zip, rebuilt));
  if (!['identical', 'behind'].includes(onMain))
    result.problems.push(`${p.tag} (${p.commit}) is not on main (${onMain})`);
  result.ok = result.problems.length === 0;
  return { ...p, result };
}

async function record({ gh, version, tag, commit, hash, result, runUrl }) {
  const conclusion = result.ok ? 'success' : 'failure';
  const summary = result.ok
    ? `The Chrome Web Store serves ${version}. Its crx, minus _metadata/ and the update_url line, is byte-identical to ${tag}'s slicc-extension.zip (${result.files} files). That zip is identical to a rebuild from ${tag}, and ${tag} is on main.`
    : `The Chrome Web Store serves ${version}, and it is not ${tag} as released and rebuilt:\n${result.problems.map((p) => `- ${p}`).join('\n')}`;
  await gh.call('check-runs', 'POST', {
    name: 'cws-verify',
    head_sha: commit,
    external_id: `${version}:${hash}`,
    details_url: runUrl,
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title: result.ok ? `store ${version} = ${tag}` : `store ${version} != ${tag}`,
      summary,
    },
  });
  return 'recorded';
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      crx: { type: 'string' },
      zip: { type: 'string' },
      probe: { type: 'boolean' },
      expect: { type: 'string' },
      rebuilt: { type: 'string' },
    },
  });
  const env = process.env;
  const where = { repo: env.GITHUB_REPOSITORY, token: env.GH_TOKEN, item: env.ITEM_ID || ITEM };
  try {
    if (values.crx || values.zip) {
      const r = compare(readFileSync(values.crx), readFileSync(values.zip));
      if (values.rebuilt)
        r.problems.push(...sameZip(readFileSync(values.zip), readFileSync(values.rebuilt)));
      if (r.problems.length) throw new Error(r.problems.join('; '));
      console.log(
        `cws-verify: PASS ${values.crx} minus _metadata/ and update_url = ${values.zip} (${r.files} files)`
      );
    } else if (values.probe) {
      const p = await probe(where);
      const line = `version=${p.version}\ntag=${p.tag}\nrecorded=${p.done}\n`;
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, line);
      console.log(
        `cws-verify probe: the store serves ${p.version} (${p.tag} at ${p.commit}), ${p.done ? 'already verified' : 'not verified yet'}`
      );
    } else {
      const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
      const v = await verifyLive({
        ...where,
        expect: values.expect,
        rebuilt: values.rebuilt ? readFileSync(values.rebuilt) : undefined,
      });
      const how = v.how ?? (await record({ ...v, runUrl }));
      if (!v.result.ok)
        throw new Error(
          `store ${v.version} != ${v.tag}: ${v.result.problems.join('; ')} (check ${how})`
        );
      console.log(
        `cws-verify: PASS store ${v.version} = ${v.tag}, released and rebuilt, on main at ${v.commit} (check ${how})`
      );
    }
  } catch (err) {
    console.log(`cws-verify: FAIL ${err.message}`);
    process.exit(1);
  }
}
