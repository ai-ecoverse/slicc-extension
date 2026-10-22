const ORIGIN_KEYS = new Set([
  'origin',
  'securityOrigin',
  'ownerOrigin',
  'issuerOrigin',
  'topLevelOrigin',
  'topLevelSite',
  'embeddedOrigin',
  'requestingOrigin',
  'scopeURL',
  'manifestId',
]);

const FREE_FORM = new Set([
  'expression',
  'arguments',
  'value',
  'headers',
  'postData',
  'functionDeclaration',
  'source',
  'text',
  'body',
  'data',
  'message',
]);

const BODY_METHODS = new Set([
  'Network.getResponseBody',
  'Network.searchInResponseBody',
  'Network.streamResourceContent',
  'Network.getResponseBodyForInterception',
  'Network.takeResponseBodyForInterceptionAsStream',
  'Network.getRequestPostData',
  'Network.replayXHR',
  'Fetch.getResponseBody',
  'Fetch.takeResponseBodyAsStream',
  'Audits.getEncodedResponse',
]);

const COOKIE_SETTERS = new Set([
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Storage.setCookies',
  'Page.deleteCookie',
]);

const COOKIE_READERS = new Set([
  'Network.getCookies',
  'Network.getAllCookies',
  'Storage.getCookies',
  'Page.getCookies',
]);

const OUTRIGHT = new Map([
  [
    'Target.exposeDevToolsProtocol',
    'Target.exposeDevToolsProtocol would give a page the whole browser',
  ],
  [
    'Target.sendMessageToTarget',
    'Target.sendMessageToTarget is refused: attach with flatten: true instead',
  ],
  [
    'Target.attachToBrowserTarget',
    'Target.attachToBrowserTarget would give a page the whole browser',
  ],
  ['Target.setAutoAttach', 'Target.setAutoAttach is not supported: attach to each target'],
  ['Target.autoAttachRelated', 'Target.autoAttachRelated is not supported: attach to each target'],
  ['Tracing.start', "Tracing.start records every target, seven's included"],
  [
    'Network.loadNetworkResource',
    "Network.loadNetworkResource follows redirects the guard cannot see, into seven's pages too",
  ],
  ['Extensions.loadUnpacked', "Extensions.loadUnpacked can reach seven's origin"],
  ['Network.clearBrowserCookies', "Network.clearBrowserCookies would clear seven's cookies"],
  ['Storage.clearCookies', "Storage.clearCookies would clear seven's cookies"],
  ['Browser.resetPermissions', "Browser.resetPermissions would reset seven's permissions"],
  [
    'Security.setIgnoreCertificateErrors',
    "Security.setIgnoreCertificateErrors would weaken TLS for seven's tabs",
  ],
]);

export const COOKIES = "slicc: refused: cookies on seven's origin";
export const UNSEEN = 'slicc: refused: unknown request';

export function refusedOutright(method, params, sessionId) {
  const reason = OUTRIGHT.get(method);
  if (reason) return `slicc: refused: ${reason}`;
  if (
    (method === 'Browser.setPermission' || method === 'Browser.grantPermissions') &&
    typeof params?.origin !== 'string'
  ) {
    return "slicc: refused: browser-wide permissions would reach seven's origin";
  }
  if (method.startsWith('Fetch.') && typeof sessionId !== 'string') {
    return "slicc: refused: Fetch on the browser itself would intercept seven's requests; use a page session";
  }
  return undefined;
}

export function bodyMethod(method) {
  return BODY_METHODS.has(method);
}

export function cookieSetter(method) {
  return COOKIE_SETTERS.has(method);
}

export function cookieReader(method) {
  return COOKIE_READERS.has(method);
}

export function webSocketAsHttp(url) {
  const lower = url.toLowerCase();
  if (lower.startsWith('wss:')) return `https:${url.slice(4)}`;
  if (lower.startsWith('ws:')) return `http:${url.slice(3)}`;
  return url;
}

export function urlProtected(guard, text, options = {}) {
  if (typeof text !== 'string' || text === '') return false;
  if (guard.url(text, options)) return true;
  const web = webSocketAsHttp(text);
  return web !== text && guard.url(web, options);
}

const SCHEME = /[a-z0-9+.-]/i;
const LETTER = /[a-z]/i;
const URL_END = /[\s"'<>`\u0000-\u001f]/;
const BOUNDARY = /[\s<>"'`=,;([{]/;
const ANCHORS = /(?:https?|wss?):[\\/]*|[\\/]{2,}/gi;
const ANCHOR = /(?:https?|wss?):|[\\/]{2}/i;
const IGNORED = /[\t\n\r]+/g;
const HAS_IGNORED = /[\t\n\r]/;
const JOINS = new Set([',', ';', '(', ')']);
const URL_CAP = 4096;
const HOST_CAP = 300;
const SEEN_CAP = 4096;
const AUTHORITY_END = /[\\/?#@]/g;
const TAIL = URL_CAP + 64;
const PIECE = 65536;
const NEXT_URL = /^(?:[a-z][a-z0-9+.-]*:)?[\\/]{2,}[^\\/]/i;
const ENCODED_KEYS = ['body', 'data', 'content', 'postData'];
export const KEY_COLLISION =
  'slicc: refused: two keys of this payload reduce to the same protected origin';
export const ENCODED = 'slicc: refused: an encoded payload names a protected url';
const WEB_SCHEMES = ['https', 'http', 'wss', 'ws'];
const URL_KEYS = ['url', 'unreachableUrl', 'userTypedURL'];
const TARGETS = new Set(['location', 'content-location', 'refresh', 'link']);

const AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

function originOf(text) {
  try {
    const origin = new URL(text).origin;
    if (origin && origin !== 'null') return origin;
  } catch {}
  return AUTHORITY.exec(text)?.[0] ?? 'about:blank';
}

function slashed(text) {
  return text.replace(/\\/g, '/');
}

function normalized(text) {
  if (!HAS_IGNORED.test(text)) return { text, cuts: [], breaks: undefined };
  const parts = [];
  const cuts = [];
  let length = 0;
  let last = 0;
  IGNORED.lastIndex = 0;
  for (let found = IGNORED.exec(text); found; found = IGNORED.exec(text)) {
    parts.push(text.slice(last, found.index));
    length += found.index - last;
    last = found.index + found[0].length;
    cuts.push([length, last]);
  }
  parts.push(text.slice(last));
  return { text: parts.join(''), cuts, breaks: new Set(cuts.map(([at]) => at)) };
}

function original(n, at) {
  let low = 0;
  let high = n.cuts.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (n.cuts[mid][0] <= at) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found < 0 ? at : n.cuts[found][1] + at - n.cuts[found][0];
}

function originalEnd(n, end) {
  return end === 0 ? 0 : original(n, end - 1) + 1;
}

function schemeStarts(text, colon, breaks) {
  let start = colon;
  while (start > 0 && colon - start < 32 && SCHEME.test(text[start - 1])) start -= 1;
  while (start < colon && !LETTER.test(text[start])) start += 1;
  if (start === colon) return [];
  const out = [start];
  for (let at = start + 1; at < colon; at += 1) {
    if (breaks?.has(at) && LETTER.test(text[at])) out.push(at);
  }
  const scheme = text.slice(start, colon).toLowerCase();
  const inner = WEB_SCHEMES.find((w) => scheme.length > w.length && scheme.endsWith(w));
  if (inner !== undefined) out.push(colon - inner.length);
  return out;
}

function openings(text, at, anchor, breaks) {
  if (anchor[0] !== '/' && anchor[0] !== '\\') {
    return schemeStarts(text, at + anchor.indexOf(':'), breaks).map((start) => [start, '']);
  }
  if (text[at - 1] === ':') return schemeStarts(text, at - 1, breaks).map((start) => [start, '']);
  if (at > 0 && !BOUNDARY.test(text[at - 1]) && !breaks?.has(at)) return [];
  return [[at, 'https:']];
}

function stopFrom(text, from, breaks) {
  let end = from;
  while (end < text.length && !URL_END.test(text[end])) {
    if (end > from && breaks?.has(end) && NEXT_URL.test(text.slice(end, end + 40))) {
      return { at: end, join: false };
    }
    if (JOINS.has(text[end]) && NEXT_URL.test(text.slice(end + 1, end + 40))) {
      return { at: end, join: true };
    }
    end += 1;
  }
  return { at: end, join: false };
}

function urlEnd(memo, text, from, breaks) {
  if (!(memo.from <= from && from < memo.stop.at)) {
    memo.from = from;
    memo.stop = stopFrom(text, from, breaks);
  }
  const { at, join } = memo.stop;
  return join && text[at - 1] === ')' && at - 1 > from ? at - 1 : at;
}

function authorityEnd(memo, text, from) {
  if (memo.authority < from) {
    memo.ats = [];
    AUTHORITY_END.lastIndex = from;
    let found = AUTHORITY_END.exec(text);
    while (found && found[0] === '@') {
      memo.ats.push(found.index);
      found = AUTHORITY_END.exec(text);
    }
    memo.authority = found?.index ?? text.length;
  }
  return memo.authority;
}

function hostStart(memo, run, end) {
  let low = 0;
  let high = memo.ats.length - 1;
  let found = run - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (memo.ats[mid] < end) {
      found = Math.max(found, memo.ats[mid]);
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found + 1;
}

function judge(memo, url, isProtected) {
  const known = memo.seen.get(url);
  if (known !== undefined) return known;
  const hit = isProtected(url);
  if (memo.seen.size < SEEN_CAP) memo.seen.set(url, hit);
  return hit;
}

function urlAt(memo, text, found, breaks, isProtected) {
  const at = found.index;
  const run = at + found[0].length;
  const next = text[run];
  if (next === undefined || URL_END.test(next)) return undefined;
  const starts = openings(text, at, found[0], breaks);
  if (starts.length === 0) return undefined;
  const end = urlEnd(memo, text, run, breaks);
  const hostEnd = Math.min(end, authorityEnd(memo, text, run));
  const host = hostStart(memo, run, hostEnd);
  const pending = hostEnd === text.length ? memo.pending : undefined;
  if (pending?.start === -1) {
    pending.start = starts[0][0];
    pending.run = run;
  }
  const long = memo.work > memo.budget && hostEnd - host > HOST_CAP;
  if (long && pending) return undefined;
  for (const [start, prefix] of starts) {
    const scheme = prefix + slashed(text.slice(start, run));
    memo.work += run - start + hostEnd - host;
    if (!long && !judge(memo, scheme + text.slice(host, hostEnd), isProtected)) continue;
    return { start, end, url: prefix + slashed(text.slice(start, end)) };
  }
  return undefined;
}

function scan(n, isProtected, pending) {
  const out = [];
  const { text, breaks } = n;
  if (!ANCHOR.test(text)) return out;
  const memo = {
    from: -1,
    stop: { at: -1, join: false },
    authority: -1,
    ats: [],
    pending,
    work: 0,
    budget: 4 * text.length + 65536,
    seen: new Map(),
  };
  ANCHORS.lastIndex = 0;
  for (let found = ANCHORS.exec(text); found; found = ANCHORS.exec(text)) {
    const span = urlAt(memo, text, found, breaks, isProtected);
    if (!span) continue;
    out.push(span);
    ANCHORS.lastIndex = Math.max(span.end, ANCHORS.lastIndex);
  }
  return out;
}

function bare(span) {
  const origin = originOf(span.url);
  return span.url === origin || span.url === `${origin}/` ? undefined : origin;
}

export function redactText(text, isProtected) {
  if (typeof text !== 'string') return text;
  const n = normalized(text);
  let out = '';
  let last = 0;
  for (const span of scan(n, isProtected)) {
    const origin = bare(span);
    if (origin === undefined) continue;
    out += text.slice(last, original(n, span.start)) + origin;
    last = originalEnd(n, span.end);
  }
  return last === 0 ? text : out + text.slice(last);
}

export function namesProtectedUrl(text, isProtected) {
  return typeof text === 'string' && scan(normalized(text), isProtected).length > 0;
}

function tailOf(text) {
  return text
    .replace(IGNORED, '\n')
    .replace(/[\\/]{3,}/g, '//')
    .slice(-TAIL);
}

function carried(joined, text, pending) {
  if (pending.start === -1 || pending.start >= text.length - TAIL) return tailOf(joined);
  const scheme = text.slice(pending.start, pending.run).replace(/[\\/]{3,}/g, '//');
  return scheme + text.slice(Math.max(pending.run, text.length - URL_CAP));
}

export class UrlStream {
  constructor(isProtected) {
    this.isProtected = isProtected;
    this.head = '';
    this.named = false;
    this.refused = false;
  }

  push(chunk, isProtected = this.isProtected) {
    const head = this.head;
    const joined = head + chunk;
    const n = normalized(joined);
    let out = '';
    let last = head.length;
    let open = '';
    const pending = { start: -1, run: -1 };
    for (const span of scan(n, isProtected, pending)) {
      const start = original(n, span.start);
      const end = originalEnd(n, span.end);
      if (end === joined.length && joined.length - start > URL_CAP) open = originOf(span.url);
      const origin = bare(span);
      if (end <= head.length || origin === undefined) continue;
      this.named = true;
      out += joined.slice(last, Math.max(start, last)) + (start >= head.length ? origin : '');
      last = end;
    }
    this.head = open ? `${open}/` : carried(joined, n.text, pending);
    return last === head.length ? chunk : out + joined.slice(last);
  }

  pushEncoded(encoded) {
    const readOnly = (url) => this.isProtected(url, { readOnly: true });
    const clean = /[^A-Za-z0-9+/=]/.test(encoded) ? encoded.replace(/[\t\n\f\r ]+/g, '') : encoded;
    for (let at = 0; at < clean.length && !this.named; at += PIECE) {
      let piece;
      try {
        piece = atob(clean.slice(at, at + PIECE));
      } catch {
        this.named = true;
        return;
      }
      this.push(piece, readOnly);
    }
  }
}

export function encodedNamesProtected(encoded, isProtected) {
  const stream = new UrlStream(isProtected);
  stream.pushEncoded(encoded);
  return stream.named;
}

export function streamRead(stream, result) {
  if (stream.refused) throw new Error(ENCODED);
  if (typeof result?.data !== 'string') return result;
  if (result.base64Encoded !== true) {
    const data = stream.push(result.data);
    return data === result.data ? result : { ...result, data };
  }
  stream.pushEncoded(result.data);
  if (!stream.named) return result;
  stream.refused = true;
  throw new Error(ENCODED);
}

export class NetworkStreams {
  constructor(isProtected) {
    this.isProtected = isProtected;
    this.streams = new Map();
  }

  buffer(id, result) {
    if (!this.streams.has(id)) {
      if (!id || this.streams.size >= 500) throw new Error(ENCODED);
      this.streams.set(id, new UrlStream(this.isProtected));
    }
    this.read(id, result.bufferedData);
    return result;
  }

  read(id, data) {
    const stream = this.streams.get(id);
    if (!stream) throw new Error(ENCODED);
    streamRead(stream, { data, base64Encoded: true });
  }

  end(id) {
    this.streams.delete(id);
  }
}

function encodedNamed(value, isProtected, method) {
  const keys = value.base64Encoded === true ? [...ENCODED_KEYS] : [];
  if (method === 'Network.dataReceived') keys.push('data');
  if (method === 'Network.streamResourceContent') keys.push('bufferedData');
  if (method === 'Audits.getEncodedResponse') keys.push('body');
  if (
    (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') &&
    value.opcode === 2
  )
    keys.push('payloadData');
  return keys.some(
    (key) => typeof value[key] === 'string' && encodedNamesProtected(value[key], isProtected)
  );
}

function cleaned(target) {
  return target
    .replace(/[\t\n\r]/g, '')
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
    .replace(/^(['"])(.*)\1$/s, '$2');
}

function resolved(target, base) {
  try {
    return new URL(cleaned(target), base || 'https://slicc.invalid/').href;
  } catch {
    return '';
  }
}

function targetSpans(name, line) {
  const lower = name.toLowerCase();
  if (lower === 'link') {
    return [...line.matchAll(/<([^>]*)>/g)].map((m) => [m.index + 1, m.index + 1 + m[1].length]);
  }
  if (lower !== 'refresh') return [[line.length - line.trimStart().length, line.length]];
  const named = /url\s*=\s*/i.exec(line);
  if (named) return [[named.index + named[0].length, line.length]];
  const bare = /^[\s\d.]*[;,]\s*/.exec(line);
  return bare ? [[bare[0].length, line.length]] : [];
}

function redactLine(name, line, base, isProtected) {
  let out = '';
  let last = 0;
  let hit = false;
  for (const [start, end] of targetSpans(name, line)) {
    const url = resolved(line.slice(start, end), base);
    if (!url || !isProtected(url)) continue;
    hit = true;
    out += line.slice(last, start) + originOf(url);
    last = end;
  }
  return { text: last === 0 ? line : out + line.slice(last), hit };
}

function headerTarget(name, value, base, isProtected) {
  if (typeof name !== 'string' || typeof value !== 'string' || !TARGETS.has(name.toLowerCase())) {
    return { text: value, hit: false };
  }
  const lines = value.split('\n').map((line) => redactLine(name, line, base, isProtected));
  return { text: lines.map((l) => l.text).join('\n'), hit: lines.some((l) => l.hit) };
}

function headerNamed(name, value, base, isProtected) {
  return namesProtectedUrl(value, isProtected) || headerTarget(name, value, base, isProtected).hit;
}

export function redactHeaders(headers, base, isProtected) {
  if (Array.isArray(headers)) {
    let out = headers;
    headers.forEach((header, index) => {
      const next = headerTarget(header?.name, header?.value, base, isProtected).text;
      if (next === header?.value) return;
      if (out === headers) out = [...headers];
      out[index] = { ...header, value: next };
    });
    return out;
  }
  if (headers === null || typeof headers !== 'object') return headers;
  let out = headers;
  for (const [name, value] of Object.entries(headers)) {
    const next = headerTarget(name, value, base, isProtected).text;
    if (next === value) continue;
    if (out === headers) out = { ...headers };
    out[name] = next;
  }
  return out;
}

function textOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function redactHeadersText(text, base, isProtected) {
  const parts = text.split(/(\r?\n)/);
  let changed = false;
  const out = parts.map((part) => {
    const found = /^([^:]+):(.*)$/s.exec(part);
    if (!found) return part;
    const next = headerTarget(found[1].trim(), found[2], base, isProtected).text;
    if (next === found[2]) return part;
    changed = true;
    return `${found[1]}:${next}`;
  });
  return changed ? out.join('') : text;
}

function urlNamed(text, isProtected) {
  return typeof text === 'string' && text !== '' && isProtected(text);
}

function withHeaders(value, isProtected) {
  let out = value;
  if (Array.isArray(value.responseHeaders)) {
    const base = typeof value.request?.url === 'string' ? value.request.url : '';
    const next = redactHeaders(value.responseHeaders, base, isProtected);
    if (next !== value.responseHeaders) out = { ...out, responseHeaders: next };
  }
  const base = typeof value.url === 'string' ? value.url : '';
  if (value.headers && typeof value.headers === 'object') {
    const next = redactHeaders(value.headers, base, isProtected);
    if (next !== value.headers) out = { ...out, headers: next };
  }
  if (typeof value.headersText === 'string') {
    const next = redactHeadersText(value.headersText, base, isProtected);
    if (next !== value.headersText) out = { ...out, headersText: next };
  }
  return out;
}

function redactKeys(source, isProtected) {
  const keys = Object.keys(source);
  const renamed = keys.map((key) => redactText(key, isProtected));
  if (renamed.every((key, index) => key === keys[index])) return source;
  if (new Set(renamed).size !== renamed.length) throw new Error(KEY_COLLISION);
  return Object.fromEntries(keys.map((key, index) => [renamed[index], source[key]]));
}

export function redactProtected(value, isProtected, method) {
  if (typeof value === 'string') return redactText(value, isProtected);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let out = value;
    value.forEach((item, index) => {
      const next = redactProtected(item, isProtected, method);
      if (next === item) return;
      if (out === value) out = [...value];
      out[index] = next;
    });
    return out;
  }
  if (encodedNamed(value, isProtected, method)) throw new Error(ENCODED);
  const source = withHeaders(value, isProtected);
  let out = redactKeys(source, isProtected);
  const keyed = out;
  for (const [key, item] of Object.entries(keyed)) {
    const next = redactProtected(item, isProtected, method);
    if (next === item) continue;
    if (out === source || out === keyed) out = { ...keyed };
    out[key] = next;
  }
  if ('urlFragment' in value && URL_KEYS.some((k) => urlNamed(value[k], isProtected))) {
    if (out === value) out = { ...value };
    delete out.urlFragment;
  }
  return out;
}

export function headersNameProtected(headers, isProtected, base = '') {
  if (Array.isArray(headers)) {
    return headers.some((header) => headerNamed(header?.name, header?.value, base, isProtected));
  }
  if (headers === null || typeof headers !== 'object') return false;
  return Object.entries(headers).some(([name, value]) =>
    headerNamed(name, value, base, isProtected)
  );
}

export function responseNamesProtected(method, params, isProtected) {
  const response = params?.response;
  const redirect = params?.redirectResponse;
  if (headersNameProtected(response?.headers, isProtected, response?.url)) return true;
  if (headersNameProtected(redirect?.headers, isProtected, redirect?.url)) return true;
  if (!method.endsWith('responseReceivedExtraInfo')) return false;
  return (
    headersNameProtected(params.headers, isProtected) ||
    namesProtectedUrl(params.headersText, isProtected) ||
    redactHeadersText(textOrEmpty(params.headersText), '', isProtected) !==
      textOrEmpty(params.headersText)
  );
}

export function binaryHeadersNameProtected(binary, isProtected) {
  if (typeof binary !== 'string' || binary === '') return false;
  try {
    return namesProtectedUrl(atob(binary), isProtected);
  } catch {
    return true;
  }
}

export function treeNamesProtected(tree, isProtected) {
  const pending = [tree];
  while (pending.length > 0) {
    const node = pending.pop();
    const frame = node?.frame;
    for (const key of ['url', 'unreachableUrl']) {
      if (typeof frame?.[key] === 'string' && isProtected(frame[key])) return true;
    }
    if (Array.isArray(node?.childFrames)) pending.push(...node.childFrames);
  }
  return false;
}

function storageNamed(guard, key, item) {
  if (ORIGIN_KEYS.has(key) && urlProtected(guard, item, { readOnly: true })) return true;
  if ((key === 'storageKey' || key === 'storageKeys') && guard.storageKey(item)) return true;
  return key === 'cacheId' && guard.storageKey(item.split('|')[0] ?? '');
}

export function namesProtectedStorage(guard, value) {
  if (Array.isArray(value)) return value.some((item) => namesProtectedStorage(guard, item));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => {
    if (FREE_FORM.has(key)) return false;
    if (typeof item === 'string') return storageNamed(guard, key, item);
    if (key === 'storageKeys' && Array.isArray(item)) {
      return item.some((k) => typeof k === 'string' && guard.storageKey(k));
    }
    return namesProtectedStorage(guard, item);
  });
}

function hostOf(text) {
  try {
    return new URL(text).hostname;
  } catch {
    return '';
  }
}

function siteProtected(guard, site) {
  if (urlProtected(guard, site)) return true;
  const host = hostOf(site);
  return host !== '' && guard.cookieDomain(host);
}

function cookieProtected(guard, cookie) {
  if (cookie === null || typeof cookie !== 'object') return false;
  if (
    typeof cookie.domain === 'string' &&
    cookie.domain !== '' &&
    guard.cookieDomain(cookie.domain)
  ) {
    return true;
  }
  if (typeof cookie.url === 'string' && siteProtected(guard, cookie.url)) return true;
  const key = cookie.partitionKey;
  if (typeof key === 'string') return siteProtected(guard, key);
  if (key && typeof key.topLevelSite === 'string') return siteProtected(guard, key.topLevelSite);
  return false;
}

export function cookieRefused(guard, params) {
  const p = params ?? {};
  if (Array.isArray(p.cookies)) return p.cookies.some((cookie) => cookieProtected(guard, cookie));
  return cookieProtected(guard, p);
}

const FORBIDDEN_HOST = /[\u0000-\u0020%\u007f#/:<>?@[\\\]^|]/;

function parsed(text) {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

export function strictGuard(base, rules) {
  const noncanonical = (text) => {
    if (typeof text !== 'string') return false;
    let u = parsed(text);
    for (let i = 0; u && rules.innerSchemes.includes(u.protocol.slice(0, -1)) && i < 8; i += 1) {
      u = parsed(u.href.slice(u.protocol.length));
    }
    if (!u?.hostname || u.hostname.startsWith('[')) return false;
    return FORBIDDEN_HOST.test(u.hostname);
  };
  const failClosed = rules.unparseable === 'protected';
  return {
    ...base,
    url: (text, options = {}) =>
      base.url(text, options) || (failClosed && !options.readOnly && noncanonical(text)),
    target: (info) => base.target(info) || (failClosed && noncanonical(info?.url)),
    unparseable: (text) => base.unparseable(text) || noncanonical(text),
  };
}

export function cookieUrlUnparseable(guard, params) {
  const p = params ?? {};
  const urls = [
    ...(Array.isArray(p.urls) ? p.urls : []),
    p.url,
    ...(Array.isArray(p.cookies) ? p.cookies.map((cookie) => cookie?.url) : []),
  ];
  return urls.some((url) => typeof url === 'string' && guard.unparseable(url));
}

export function dropProtectedCookies(guard, result) {
  if (!result || !Array.isArray(result.cookies)) return result;
  return { ...result, cookies: result.cookies.filter((cookie) => !cookieProtected(guard, cookie)) };
}

export function stripProtectedCookies(guard, params) {
  if (!params || typeof params !== 'object') return params;
  let out = params;
  for (const key of ['associatedCookies', 'blockedCookies', 'exemptedCookies']) {
    if (!Array.isArray(out[key])) continue;
    out = {
      ...out,
      [key]: out[key].filter((item) => !cookieProtected(guard, item?.cookie ?? item)),
    };
  }
  if (Array.isArray(out.cookies)) {
    out = { ...out, cookies: out.cookies.filter((cookie) => !cookieProtected(guard, cookie)) };
  }
  return out;
}

const SET_COOKIE = /^set-cookie$/i;
const CACHED = ['fromDiskCache', 'fromServiceWorker', 'fromPrefetchCache', 'fromEarlyHints'];

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : String(headers[key]);
}

export function hopOf(redirect) {
  if (CACHED.some((key) => redirect?.[key] === true)) return 'done';
  return { status: redirect?.status, location: headerValue(redirect?.headers, 'location') };
}

export function hopMatches(hop, params) {
  if (hop === null || typeof hop !== 'object') return false;
  return (
    params.statusCode === hop.status && headerValue(params.headers, 'location') === hop.location
  );
}

function textWithoutSetCookie(text) {
  const out = [];
  let dropping = false;
  for (const line of text.split(/(?<=\n)/)) {
    if (/^set-cookie\s*:/i.test(line)) dropping = true;
    else if (!/^[ \t]/.test(line)) dropping = false;
    if (!dropping) out.push(line);
  }
  return out.join('');
}

export function withoutCookieHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return headers;
  if (!Object.keys(headers).some((k) => /^cookie$/i.test(k))) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !/^cookie$/i.test(key)));
}

export function withoutSetCookie(params) {
  let out = params;
  const headers = params.headers;
  if (
    headers &&
    typeof headers === 'object' &&
    Object.keys(headers).some((k) => SET_COOKIE.test(k))
  ) {
    const kept = Object.entries(headers).filter(([key]) => !SET_COOKIE.test(key));
    out = { ...out, headers: Object.fromEntries(kept) };
  }
  if (typeof params.headersText === 'string') {
    const text = textWithoutSetCookie(params.headersText);
    if (text !== params.headersText) out = { ...out, headersText: text };
  }
  return out;
}

export function requestKey(params) {
  if (typeof params?.requestId === 'string') return params.requestId;
  if (typeof params?.interceptionId === 'string') return params.interceptionId;
  return undefined;
}

export function requestUrl(params) {
  const u = params?.request?.url ?? params?.response?.url ?? params?.url;
  return typeof u === 'string' ? u : '';
}

export function patternProtected(guard, domains, pattern) {
  const text = typeof pattern?.urlPattern === 'string' ? pattern.urlPattern : '*';
  const lower = text.toLowerCase();
  if (domains.some((d) => lower.includes(d))) return true;
  const concrete = text.replace(/\\(.)/g, '$1').replace(/\*/g, '').replace(/\?/g, 'a');
  return urlProtected(guard, concrete, { readOnly: true });
}

function globRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      out += pattern[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else if (c === '*') {
      out += '.*';
    } else if (c === '?') {
      out += '.';
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, 's');
}

export function patternMatches(pattern, paused) {
  const stage = pattern.requestStage ?? 'Request';
  const atResponse =
    paused.responseStatusCode !== undefined || paused.responseErrorReason !== undefined;
  if ((stage === 'Response') !== atResponse) return false;
  if (pattern.resourceType && pattern.resourceType !== paused.resourceType) return false;
  return globRegExp(pattern.urlPattern ?? '*').test(requestUrl(paused));
}

export function initScriptPrefix(rules) {
  const domains = JSON.stringify(rules.domains);
  const hosts = JSON.stringify(rules.hosts);
  const any = JSON.stringify(rules.anySchemes.map((s) => `${s}:`));
  const privileged = JSON.stringify(rules.protectedSchemes.map((s) => `${s}:`));
  const exceptions = JSON.stringify(rules.schemeExceptions);
  const web = JSON.stringify(rules.schemes.map((s) => `${s}:`));
  return (
    `if ((function () { var p = location.protocol; if (${any}.indexOf(p) >= 0) return true; ` +
    `if (${privileged}.indexOf(p) >= 0 && ${exceptions}.indexOf(p + "//" + location.hostname.toLowerCase()) < 0) return true; ` +
    'try { var o = new URL(self.origin), s = o.protocol, oh = o.hostname.toLowerCase().replace(/\\.$/, ""); ' +
    `if (${any}.indexOf(s) >= 0) return true; ` +
    `if (${privileged}.indexOf(s) >= 0 && ${exceptions}.indexOf(s + "//" + oh) < 0) return true; ` +
    `if (${web}.indexOf(s) >= 0 && (${hosts}.indexOf(oh) >= 0 || ${domains}.some(function (d) { return oh === d || oh.slice(-d.length - 1) === "." + d; }))) return true; ` +
    '} catch (e) {} ' +
    'var h = ("" + (document.domain || location.hostname || "")).toLowerCase(); ' +
    'if (h.slice(-1) === ".") h = h.slice(0, -1); if (h === "") return false; ' +
    `if (${hosts}.indexOf(h) >= 0) return true; ` +
    `return ${domains}.some(function (d) { return h === d || h.slice(-d.length - 1) === "." + d; }); ` +
    '})()) { throw "slicc: refused: init script on a protected origin"; }\n'
  );
}

export const ABOUT_OTHER = 'slicc: refused: about: urls other than about:blank do not open';
export const ABOUT_STUCK = 'slicc: refused: the page did not open about:blank itself';
export const ABOUT_WORLD = 'slicc-navigate';
export const ABOUT_WRAPPED =
  'slicc: refused: view-source and other wrappers of about: urls do not open';

export function wrapsAbout(url, inner) {
  let text = url;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof text !== 'string' || !URL.canParse(text)) return false;
    const parsed = new URL(text);
    const scheme = parsed.protocol.slice(0, -1);
    if (scheme === 'about') return depth > 0;
    if (!inner.includes(scheme)) return false;
    text = parsed.href.slice(parsed.protocol.length);
  }
  return true;
}

export function aboutUrl(url) {
  if (typeof url !== 'string' || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== 'about:') return undefined;
  return parsed;
}

export function frameIn(tree, frameId) {
  const pending = [tree];
  while (pending.length > 0) {
    const node = pending.pop();
    const frame = node?.frame;
    if (frame && (frameId ? frame.id === frameId : !frame.parentId)) return frame;
    if (Array.isArray(node?.childFrames)) pending.push(...node.childFrames);
  }
  return undefined;
}

export function sameDocument(current, next) {
  return next.includes('#') && current.split('#')[0] === next.split('#')[0];
}

export function assignExpression(url) {
  return `location.assign(${JSON.stringify(url)})`;
}

export const WORLD = 'slicc: refused: that execution context belongs to a browser extension';
export const UNSEEN_CONTEXT =
  'slicc: refused: that execution context or object is not exposed to browser automation';
export const PROFILED =
  'slicc: refused: a browser extension runs scripts in this page, and profiling it would expose them';
export const RESERVED_WORLD = 'slicc: refused: that world name is reserved for the guard';

const EXTENSION_SCHEMES = [
  'chrome-extension:',
  'moz-extension:',
  'safari-web-extension:',
  'ms-browser-extension:',
];
const PROFILED_DOMAINS = ['Debugger.', 'DOMDebugger.', 'Profiler.', 'HeapProfiler.'];
const OBJECT_KEY = /^(objectId|\w+ObjectId)$/;
const OPAQUE_KEYS = new Set(['value', 'unserializableValue', 'expression', 'functionDeclaration']);

export function extensionOrigin(origin) {
  if (typeof origin !== 'string') return false;
  const lower = origin.toLowerCase();
  return EXTENSION_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

export function profiled(method) {
  return PROFILED_DOMAINS.some((domain) => method.startsWith(domain));
}

export function objectContext(objectId) {
  const found = /^-?\d+\.(-?\d+)\.-?\d+$/.exec(objectId);
  return found ? Number(found[1]) : undefined;
}

export function selectors(value, out = [], depth = 0) {
  if (depth > 16) {
    out.push({ kind: 'deep' });
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) selectors(item, out, depth + 1);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value)) {
    if (OPAQUE_KEYS.has(key)) continue;
    if ((key === 'contextId' || key === 'executionContextId') && typeof item === 'number') {
      out.push({ kind: 'id', value: item });
    } else if (key === 'uniqueContextId' || key === 'executionContextUniqueId') {
      out.push({ kind: 'unique', value: item });
    } else if (OBJECT_KEY.test(key)) {
      out.push({ kind: 'object', value: item });
    } else if (key === 'executionContextName') {
      out.push({ kind: 'name', value: item });
    } else if (item !== null && typeof item === 'object') {
      selectors(item, out, depth + 1);
    }
  }
  return out;
}

export class Worlds {
  constructor() {
    this.ids = new Map();
    this.uniques = new Map();
    this.names = new Set();
    this.handles = new Map();
    this.foreign = false;
  }

  learn(value, depth = 0) {
    if (depth > 16 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) this.learn(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (OBJECT_KEY.test(key) && typeof item === 'string') {
        this.handles.delete(item);
        this.handles.set(item, true);
        if (this.handles.size > 50000) this.handles.delete(this.handles.keys().next().value);
      } else {
        this.learn(item, depth + 1);
      }
    }
  }

  hideable(context, mainFrameId, protectedOrigin) {
    const aux = context?.auxData ?? {};
    const origin = typeof context?.origin === 'string' ? context.origin : '';
    if (aux.isDefault !== true && context?.name === ABOUT_WORLD) return 'ours';
    if (aux.isDefault !== true && (extensionOrigin(origin) || protectedOrigin(origin))) {
      return 'foreign';
    }
    if (aux.isDefault === true && protectedOrigin(origin) && aux.frameId !== mainFrameId) {
      return 'foreign';
    }
    return undefined;
  }

  add(context, kind) {
    const hidden = kind !== undefined;
    if (typeof context?.id === 'number') {
      const before = this.ids.get(context.id);
      this.ids.set(context.id, { hidden: hidden || before?.hidden === true, context });
    }
    if (typeof context?.uniqueId === 'string') {
      this.uniques.set(context.uniqueId, hidden || this.uniques.get(context.uniqueId) === true);
    }
    if (hidden && typeof context?.name === 'string') this.names.add(context.name);
    const latched = kind === 'foreign' && !this.foreign;
    if (kind === 'foreign') this.foreign = true;
    return latched;
  }

  seen(id) {
    if (typeof id !== 'number' || this.ids.has(id)) return;
    this.ids.set(id, { hidden: false, context: undefined });
  }

  remove(id) {
    const entry = this.ids.get(id);
    if (entry?.hidden) return true;
    this.ids.delete(id);
    return false;
  }

  clear() {
    for (const [id, entry] of this.ids) if (!entry.hidden) this.ids.delete(id);
  }

  visible() {
    return [...this.ids.entries()]
      .filter(([, entry]) => !entry.hidden && entry.context)
      .sort(([a], [b]) => a - b)
      .map(([, entry]) => entry.context);
  }

  named(name) {
    return typeof name === 'string' && this.names.has(name);
  }

  verdict(selector) {
    if (selector.kind === 'deep') return UNSEEN_CONTEXT;
    if (selector.kind === 'name') {
      return typeof selector.value === 'string' && this.names.has(selector.value)
        ? WORLD
        : undefined;
    }
    const id = selector.value;
    if (selector.kind === 'unique') {
      if (typeof id !== 'string' || !this.uniques.has(id)) return UNSEEN_CONTEXT;
      return this.uniques.get(id) ? WORLD : undefined;
    }
    if (selector.kind === 'object') {
      const context = typeof id === 'string' ? objectContext(id) : undefined;
      if (this.ids.get(context)?.hidden) return WORLD;
      return typeof id === 'string' && this.handles.has(id) ? undefined : UNSEEN_CONTEXT;
    }
    const entry = typeof id === 'number' ? this.ids.get(id) : undefined;
    if (!entry) return UNSEEN_CONTEXT;
    return entry.hidden ? WORLD : undefined;
  }

  refusal(params) {
    for (const selector of selectors(params)) {
      const reason = this.verdict(selector);
      if (reason) return reason;
    }
    return undefined;
  }

  hides(params) {
    return selectors(params).some((selector) => {
      if (selector.kind === 'deep') return true;
      if (selector.kind === 'name') return false;
      return this.verdict(selector) === WORLD;
    });
  }
}

export const EXTENSION_FRAME =
  "slicc: refused: another browser extension has a frame in this tab, and Chrome doesn't let one extension debug another's frames";

export function foreignFrame(error) {
  return /chrome-extension:\/\/ URL of different extension/i.test(String(error?.message ?? error));
}

export function scopedBinding(params) {
  if (params.executionContextId !== undefined || params.executionContextName !== undefined) {
    return params;
  }
  return { ...params, executionContextName: '' };
}

export const UNWATCHED =
  "slicc: refused: the guard couldn't start watching this tab's execution contexts, so it doesn't attach";

const SEALED_DOMAINS = [
  'DOM.',
  'DOMSnapshot.',
  'Accessibility.',
  'CSS.',
  'Overlay.',
  'DOMDebugger.',
  'LayerTree.',
  'Animation.',
];
const NODE_KEY = /^(?:[a-z]+N|n)odeIds?$/;
const NODE_EVENT_KEYS = ['nodeId', 'parentId', 'parentNodeId', 'insertionPointId', 'hostId'];
export const DEEP = 'slicc: refused: that reply nests too deeply to check for protected frames';
const WHOLE_PAGE = new Set(['DOM.performSearch', 'DOMSnapshot.getSnapshot']);

const REALM_READS = new Set([
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.getProperties',
  'Runtime.getExceptionDetails',
  'Runtime.compileScript',
  'Runtime.globalLexicalScopeNames',
  'Runtime.queryObjects',
  'Runtime.runScript',
  'Runtime.awaitPromise',
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Runtime.bindingCalled',
]);

export async function resolveFrameOrigins(tree, uncertain, readOrigin) {
  const pending = [...(Array.isArray(tree?.childFrames) ? tree.childFrames : [])];
  while (pending.length > 0) {
    const node = pending.pop();
    const frame = node?.frame;
    if (!frame || typeof frame.id !== 'string') continue;
    if (
      (typeof frame.url === 'string' && /^about:(?:blank|srcdoc)(?:[?#]|$)/i.test(frame.url)) ||
      uncertain.has(frame.id)
    ) {
      frame.securityOrigin = await readOrigin(frame.id).catch(() => 'null');
    }
    if (Array.isArray(node.childFrames)) pending.push(...node.childFrames);
  }
}

export function unknownFrame(frame) {
  if (typeof frame.securityOrigin !== 'string' || typeof frame.url !== 'string') return true;
  try {
    const origin = new URL(frame.securityOrigin);
    new URL(frame.url);
    return origin.origin === 'null';
  } catch {
    return true;
  }
}

export function sealedRead(method) {
  return REALM_READS.has(method) || SEALED_DOMAINS.some((domain) => method.startsWith(domain));
}

export function wholePage(method) {
  return WHOLE_PAGE.has(method) || REALM_READS.has(method) || method.startsWith('CSS.');
}

export function frameSets(tree, hidden) {
  const visible = new Set();
  const sealed = new Set();
  const pending = [[tree, false, true]];
  while (pending.length > 0) {
    const [node, above, top] = pending.pop();
    const frame = node?.frame;
    if (!frame || typeof frame.id !== 'string') continue;
    const shut = above || (!top && hidden(frame));
    (shut ? sealed : visible).add(frame.id);
    for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) {
      pending.push([child, shut, false]);
    }
  }
  return { visible, sealed };
}

export function sealedNodes(snapshot, visible) {
  const strings = Array.isArray(snapshot?.strings) ? snapshot.strings : [];
  const documents = Array.isArray(snapshot?.documents) ? snapshot.documents : [];
  const nodes = new Set();
  documents.forEach((doc) => {
    if (visible.has(strings[doc?.frameId])) return;
    for (const id of doc?.nodes?.backendNodeId ?? []) nodes.add(id);
  });
  return nodes;
}

export function nodeSelectors(params) {
  const out = { backend: [], dom: [], objects: [] };
  for (const [key, value] of Object.entries(params ?? {})) {
    if (key === 'objectId' && typeof value === 'string') out.objects.push(value);
    if (!NODE_KEY.test(key)) continue;
    const list = (Array.isArray(value) ? value : [value]).filter((id) => typeof id === 'number');
    out[key.startsWith('backend') ? 'backend' : 'dom'].push(...list);
  }
  return out;
}

export function boundIds(node, out = [], depth = 0) {
  if (depth > 1000) throw new Error(DEEP);
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) boundIds(item, out, depth + 1);
    return out;
  }
  if (typeof node.nodeId === 'number' && node.nodeId > 0) out.push(node.nodeId);
  for (const value of Object.values(node)) boundIds(value, out, depth + 1);
  return out;
}

function sealedItem(item, seal) {
  if (item === null || typeof item !== 'object') return false;
  if (seal.nodes.has(item.backendNodeId) || seal.nodes.has(item.backendDOMNodeId)) return true;
  return typeof item.nodeId === 'string' && seal.sealed.has(item.frameId);
}

function pruneList(list, seal, cut) {
  const gone = new Set();
  let kept = list.filter((item) => {
    if (!sealedItem(item, seal)) return true;
    if (item.nodeId !== undefined) gone.add(item.nodeId);
    boundIds(item, cut);
    return false;
  });
  for (let grew = true; grew; ) {
    grew = false;
    kept = kept.filter((item) => {
      if (!gone.has(item?.parentId)) return true;
      if (item.nodeId !== undefined) gone.add(item.nodeId);
      boundIds(item, cut);
      grew = true;
      return false;
    });
  }
  return kept;
}

export function pruneSealed(value, seal, cut = [], depth = 0) {
  if (depth > 1000) throw new Error(DEEP);
  if (value === null || typeof value !== 'object') return cut;
  if (Array.isArray(value)) {
    for (const item of value) pruneSealed(item, seal, cut, depth + 1);
    return cut;
  }
  const inner = value.contentDocument;
  if (
    inner &&
    (seal.nodes.has(inner.backendNodeId) ||
      typeof value.frameId !== 'string' ||
      !seal.visible.has(value.frameId))
  ) {
    boundIds(inner, cut);
    delete value.contentDocument;
  }
  for (const [key, item] of Object.entries(value)) {
    if (sealedItem(item, seal)) {
      boundIds(item, cut);
      delete value[key];
      continue;
    }
    if (Array.isArray(item)) value[key] = pruneList(item, seal, cut);
    pruneSealed(value[key], seal, cut, depth + 1);
  }
  return cut;
}

export function sealedEvent(params, cut) {
  return NODE_EVENT_KEYS.some((key) => cut.has(params?.[key]));
}

const RARE_STRINGS = [
  'shadowRootType',
  'textValue',
  'inputValue',
  'pseudoType',
  'pseudoIdentifier',
  'currentSourceURL',
  'originURL',
];
const DOCUMENT_STRINGS = [
  'documentURL',
  'title',
  'baseURL',
  'contentLanguage',
  'encodingName',
  'publicId',
  'systemId',
  'frameId',
];

export function pruneSnapshot(snapshot, visible) {
  const strings = Array.isArray(snapshot?.strings) ? snapshot.strings : [];
  const documents = Array.isArray(snapshot?.documents) ? snapshot.documents : [];
  const index = new Map();
  documents.forEach((doc, at) => {
    if (visible.has(strings[doc?.frameId])) index.set(at, index.size);
  });
  const fresh = [];
  const seen = new Map();
  const str = (at) => {
    if (typeof at !== 'number' || at < 0) return at;
    if (!seen.has(at)) {
      seen.set(at, fresh.length);
      fresh.push(typeof strings[at] === 'string' ? strings[at] : '');
    }
    return seen.get(at);
  };
  const all = (list) => (Array.isArray(list) ? list.map(str) : list);
  const nested = (list) => (Array.isArray(list) ? list.map(all) : list);
  const kept = documents
    .filter((_, at) => index.has(at))
    .map((doc) => {
      const out = { ...doc };
      for (const key of DOCUMENT_STRINGS) out[key] = str(doc[key]);
      const nodes = { ...(doc.nodes ?? {}) };
      nodes.nodeName = all(nodes.nodeName);
      nodes.nodeValue = all(nodes.nodeValue);
      nodes.attributes = nested(nodes.attributes);
      for (const key of RARE_STRINGS) {
        if (nodes[key]) nodes[key] = { ...nodes[key], value: all(nodes[key].value) };
      }
      const content = nodes.contentDocumentIndex;
      if (content) {
        const pairs = (content.index ?? [])
          .map((node, at) => [node, index.get(content.value?.[at])])
          .filter(([, target]) => target !== undefined);
        nodes.contentDocumentIndex = {
          index: pairs.map(([node]) => node),
          value: pairs.map(([, target]) => target),
        };
      }
      out.nodes = nodes;
      if (doc.layout) {
        out.layout = {
          ...doc.layout,
          styles: nested(doc.layout.styles),
          text: all(doc.layout.text),
          blendedBackgroundColors: all(doc.layout.blendedBackgroundColors),
        };
      }
      return out;
    });
  return { ...snapshot, documents: kept, strings: fresh };
}
