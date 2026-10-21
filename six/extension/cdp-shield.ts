import type { CDPPayload } from '@slicc/shared-ts';
import {
  ABOUT_WORLD,
  extensionOrigin,
  PROFILED,
  profiled,
  RESERVED_WORLD,
  scopedBinding,
  WORLD,
  Worlds,
} from './cdp-worlds.js';
import {
  isProtectedCookieDomain,
  isProtectedStorageKey,
  isProtectedTarget,
  isProtectedTargetType,
  isProtectedUrl,
  isUnparseableUrl,
  PROTECTED_RULES,
  refuseUnparseableDestination,
} from './protected-origins.js';

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

const FETCH_ANSWERS = new Set([
  'Fetch.continueRequest',
  'Fetch.fulfillRequest',
  'Fetch.failRequest',
  'Fetch.continueResponse',
  'Fetch.continueWithAuth',
  'Fetch.getResponseBody',
  'Fetch.takeResponseBodyAsStream',
]);

const FETCH_SETTLES = new Set([
  'Fetch.continueRequest',
  'Fetch.fulfillRequest',
  'Fetch.failRequest',
  'Fetch.continueResponse',
  'Fetch.continueWithAuth',
]);

const REFUSED_METHODS = new Map<string, string>([
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
    "ignoring certificate errors would let a forged seven's origin load",
  ],
  [
    'Security.setOverrideCertificateErrors',
    "overriding certificate errors would let a forged seven's origin load",
  ],
]);

export const COOKIES_REFUSAL = "slicc: refused: cookie is on seven's origin";
const UNSEEN_REFUSAL = 'slicc: refused: request was not seen by the shield';
const STREAM_REFUSAL = 'slicc: refused: stream handle was not opened through the shield';
const BODY_READ_REFUSAL =
  'slicc: refused: this paused response body was already read the other way';
const FETCH_READS = new Set(['Fetch.getResponseBody', 'Fetch.takeResponseBodyAsStream']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const REROUTE_REFUSAL =
  'slicc: refused: the rewritten request answered with a protected url, so the guard failed it';
const PAUSE_REFUSAL = 'slicc: refused: request was not paused toward this client';

export const GUARD_FETCH_PATTERN: CDPPayload = {
  urlPattern: '*',
  resourceType: 'Document',
  requestStage: 'Request',
};

const NAVIGATES = new Set(['Page.navigate', 'Network.loadNetworkResource']);

export const ABOUT_OTHER = 'slicc: refused: about: urls other than about:blank do not open';
export const ABOUT_STUCK = 'slicc: refused: the page did not open about:blank itself';
export const ABOUT_WRAPPED =
  'slicc: refused: view-source and other wrappers of about: urls do not open';

export function wrapsAbout(url: unknown, inner: readonly string[]): boolean {
  let text = url;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof text !== 'string' || !URL.canParse(text)) return false;
    const parsed = new URL(text);
    const scheme = parsed.protocol.slice(0, -1);
    if (scheme === 'about') return depth > 0;
    if (!inner.includes(scheme)) return false;
    text = parsed.href.slice(parsed.protocol.length);
  }
  return true;
}

export function aboutUrl(url: unknown): URL | undefined {
  if (typeof url !== 'string' || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === 'about:' ? parsed : undefined;
}

export function frameIn(tree: unknown, frameId: string | undefined): CDPPayload | undefined {
  const pending: unknown[] = [tree];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isObj(node)) continue;
    const frame = node['frame'];
    if (isObj(frame) && (frameId ? frame['id'] === frameId : frame['parentId'] === undefined)) {
      return frame;
    }
    if (Array.isArray(node['childFrames'])) pending.push(...node['childFrames']);
  }
  return undefined;
}

export function sameDocument(current: string, next: string): boolean {
  return next.includes('#') && current.split('#')[0] === next.split('#')[0];
}

function isObj(value: unknown): value is CDPPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function refuse(reason: string): never {
  throw new Error(reason.startsWith('slicc: refused: ') ? reason : `slicc: refused: ${reason}`);
}

export function webSocketAsHttp(url: string): string {
  const lower = url.toLowerCase();
  if (lower.startsWith('wss:')) return `https:${url.slice(4)}`;
  if (lower.startsWith('ws:')) return `http:${url.slice(3)}`;
  return url;
}

export function urlProtected(text: string, readOnly = false): boolean {
  return isProtectedUrl(text, readOnly) || isProtectedUrl(webSocketAsHttp(text), readOnly);
}

const SCHEME = /[a-z0-9+.-]/i;
const URL_END = /[\s"'<>`\u0000-\u001f]/;
const BOUNDARY = /[\s<>"'`=,;([{]/;
const SLASHES = /[\\/]{2}/g;
const JOINS = new Set([',', ';', '(', ')']);
const URL_CAP = 4096;
const NEXT_URL = /^(?:[a-z][a-z0-9+.-]*:)?[\\/]{2}[^\\/]/i;
export const KEY_COLLISION =
  'slicc: refused: two keys of this payload reduce to the same protected origin';
const WEB_SCHEMES = ['https', 'http', 'wss', 'ws'];
const URL_KEYS = ['url', 'unreachableUrl', 'userTypedURL'];
const TARGETS = new Set(['location', 'content-location', 'refresh', 'link']);

const AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

function originOf(text: string): string {
  try {
    const origin = new URL(text).origin;
    if (origin && origin !== 'null') return origin;
  } catch {}
  return AUTHORITY.exec(text)?.[0] ?? 'about:blank';
}

interface Span {
  start: number;
  end: number;
  url: string;
  hit: boolean;
}

function schemeStart(text: string, colon: number): number {
  let start = colon;
  while (start > 0 && colon - start < 32 && SCHEME.test(text[start - 1] ?? '')) start -= 1;
  while (start < colon && !/[a-z]/i.test(text[start] ?? '')) start += 1;
  return start;
}

function judged(text: string, start: number, end: number, prefix: string): Span {
  const url = prefix + text.slice(start, end).replace(/\\/g, '/');
  return { start, end, url, hit: urlProtected(url) };
}

function urlEnd(text: string, from: number, limit = text.length): number {
  const stop = Math.min(text.length, from + limit);
  let end = from;
  while (end < stop && !URL_END.test(text[end] ?? '')) {
    if (JOINS.has(text[end] ?? '') && NEXT_URL.test(text.slice(end + 1, end + 40))) {
      return text[end - 1] === ')' && end - 1 > from ? end - 1 : end;
    }
    end += 1;
  }
  return end;
}

function opening(text: string, at: number): { start: number; prefix: string } | undefined {
  const next = text[at + 2];
  if (next === undefined || next === '/' || next === '\\' || URL_END.test(next)) return undefined;
  if (text[at - 1] !== ':') {
    if (at > 0 && !BOUNDARY.test(text[at - 1] ?? '')) return undefined;
    return { start: at, prefix: 'https:' };
  }
  const start = schemeStart(text, at - 1);
  return start === at - 1 ? undefined : { start, prefix: '' };
}

function urlAt(text: string, at: number): Span {
  const miss = { start: at, end: at + 2, url: '', hit: false };
  const open = opening(text, at);
  if (!open) return miss;
  const capped = urlEnd(text, at + 2, URL_CAP);
  let span = judged(text, open.start, capped, open.prefix);
  if (!span.hit && open.prefix === '') {
    const scheme = text.slice(open.start, at - 1).toLowerCase();
    const inner = WEB_SCHEMES.find((w) => scheme.length > w.length && scheme.endsWith(w));
    if (inner !== undefined) span = judged(text, at - 1 - inner.length, capped, '');
  }
  if (!span.hit) return miss;
  if (capped - at - 2 < URL_CAP) return span;
  return { ...span, end: urlEnd(text, capped) };
}

function spans(text: unknown): Span[] {
  const out: Span[] = [];
  if (typeof text !== 'string' || !/[\\/]{2}/.test(text)) return out;
  SLASHES.lastIndex = 0;
  for (let found = SLASHES.exec(text); found; found = SLASHES.exec(text)) {
    const span = urlAt(text, found.index);
    if (span.hit) out.push(span);
    SLASHES.lastIndex = span.hit ? Math.max(span.end, found.index + 2) : found.index + 2;
  }
  return out;
}

export function redactText(text: string): string {
  let out = '';
  let last = 0;
  for (const span of spans(text)) {
    const origin = originOf(span.url);
    if (span.url === origin || span.url === `${origin}/`) continue;
    out += text.slice(last, span.start) + origin;
    last = span.end;
  }
  return last === 0 ? text : out + text.slice(last);
}

export function namesProtectedUrl(text: unknown): boolean {
  return spans(text).length > 0;
}

function cleaned(target: string): string {
  return target
    .replace(/[\t\n\r]/g, '')
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
    .replace(/^(['"])(.*)\1$/s, '$2');
}

function resolved(target: string, base: string): string {
  try {
    return new URL(cleaned(target), base || 'https://slicc.invalid/').href;
  } catch {
    return '';
  }
}

function targetSpans(name: string, line: string): Array<[number, number]> {
  const lower = name.toLowerCase();
  if (lower === 'link') {
    return [...line.matchAll(/<([^>]*)>/g)].map((m): [number, number] => [
      m.index + 1,
      m.index + 1 + (m[1] ?? '').length,
    ]);
  }
  if (lower !== 'refresh') return [[line.length - line.trimStart().length, line.length]];
  const named = /url\s*=\s*/i.exec(line);
  if (named) return [[named.index + named[0].length, line.length]];
  const bare = /^[\s\d.]*[;,]\s*/.exec(line);
  return bare ? [[bare[0].length, line.length]] : [];
}

function redactLine(name: string, line: string, base: string): { text: string; hit: boolean } {
  let out = '';
  let last = 0;
  let hit = false;
  for (const [start, end] of targetSpans(name, line)) {
    const url = resolved(line.slice(start, end), base);
    if (!url || !urlProtected(url)) continue;
    hit = true;
    out += line.slice(last, start) + originOf(url);
    last = end;
  }
  return { text: last === 0 ? line : out + line.slice(last), hit };
}

function headerTarget(
  name: unknown,
  value: unknown,
  base: string
): { text: unknown; hit: boolean } {
  if (typeof name !== 'string' || typeof value !== 'string' || !TARGETS.has(name.toLowerCase())) {
    return { text: value, hit: false };
  }
  const lines = value.split('\n').map((line) => redactLine(name, line, base));
  return { text: lines.map((l) => l.text).join('\n'), hit: lines.some((l) => l.hit) };
}

function headerNamed(name: unknown, value: unknown, base: string): boolean {
  return namesProtectedUrl(value) || headerTarget(name, value, base).hit;
}

export function redactHeaders(headers: unknown, base: string): unknown {
  if (Array.isArray(headers)) {
    let out: unknown[] = headers;
    headers.forEach((header: unknown, index) => {
      if (!isObj(header)) return;
      const next = headerTarget(header['name'], header['value'], base).text;
      if (next === header['value']) return;
      if (out === headers) out = [...headers];
      out[index] = { ...header, value: next };
    });
    return out;
  }
  if (!isObj(headers)) return headers;
  let out = headers;
  for (const [name, value] of Object.entries(headers)) {
    const next = headerTarget(name, value, base).text;
    if (next === value) continue;
    if (out === headers) out = { ...headers };
    out[name] = next;
  }
  return out;
}

function redactHeadersText(text: string, base: string): string {
  const parts = text.split(/(\r?\n)/);
  let changed = false;
  const out = parts.map((part) => {
    const found = /^([^:]+):(.*)$/s.exec(part);
    if (!found) return part;
    const name = found[1] ?? '';
    const value = found[2] ?? '';
    const next = headerTarget(name.trim(), value, base).text;
    if (next === value) return part;
    changed = true;
    return `${name}:${String(next)}`;
  });
  return changed ? out.join('') : text;
}

function urlNamed(text: unknown): boolean {
  return typeof text === 'string' && text !== '' && urlProtected(text);
}

function withHeaders(value: Record<string, unknown>): Record<string, unknown> {
  let out = value;
  const request = value['request'];
  if (Array.isArray(value['responseHeaders'])) {
    const base = isObj(request) ? (str(request['url']) ?? '') : '';
    const next = redactHeaders(value['responseHeaders'], base);
    if (next !== value['responseHeaders']) out = { ...out, responseHeaders: next };
  }
  const url = str(value['url']) ?? '';
  if (isObj(value['headers'])) {
    const next = redactHeaders(value['headers'], url);
    if (next !== value['headers']) out = { ...out, headers: next };
  }
  const text = str(value['headersText']);
  if (text !== undefined) {
    const next = redactHeadersText(text, url);
    if (next !== text) out = { ...out, headersText: next };
  }
  return out;
}

function redactKeys(source: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(source);
  const renamed = keys.map((key) => redactText(key));
  if (renamed.every((key, index) => key === keys[index])) return source;
  if (new Set(renamed).size !== renamed.length) throw new Error(KEY_COLLISION);
  return Object.fromEntries(keys.map((key, index) => [renamed[index], source[key]]));
}

export function redactProtected<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let out: unknown[] = value;
    value.forEach((item: unknown, index) => {
      const next = redactProtected(item);
      if (next === item) return;
      if (out === value) out = [...value];
      out[index] = next;
    });
    return out as T;
  }
  const original = value as Record<string, unknown>;
  const source = redactKeys(withHeaders(original));
  let out = source;
  for (const [key, item] of Object.entries(source)) {
    const next = redactProtected(item);
    if (next === item) continue;
    if (out === source) out = { ...source };
    out[key] = next;
  }
  if ('urlFragment' in original && URL_KEYS.some((k) => urlNamed(original[k]))) {
    if (out === original) out = { ...original };
    delete out['urlFragment'];
  }
  return out as T;
}

export function headersNameProtected(headers: unknown, base = ''): boolean {
  if (Array.isArray(headers)) {
    return headers.some(
      (header) => isObj(header) && headerNamed(header['name'], header['value'], base)
    );
  }
  if (!isObj(headers)) return false;
  return Object.entries(headers).some(([name, value]) => headerNamed(name, value, base));
}

function responseNamesProtected(method: string, params: CDPPayload): boolean {
  const response = params['response'];
  const redirect = params['redirectResponse'];
  if (isObj(response) && headersNameProtected(response['headers'], str(response['url']))) {
    return true;
  }
  if (isObj(redirect) && headersNameProtected(redirect['headers'], str(redirect['url']))) {
    return true;
  }
  if (!method.endsWith('responseReceivedExtraInfo')) return false;
  const text = str(params['headersText']) ?? '';
  return (
    headersNameProtected(params['headers']) ||
    namesProtectedUrl(text) ||
    redactHeadersText(text, '') !== text
  );
}

function binaryHeadersNameProtected(binary: unknown): boolean {
  if (typeof binary !== 'string' || binary === '') return false;
  try {
    return namesProtectedUrl(atob(binary));
  } catch {
    return true;
  }
}

function answerNamesProtected(params: CDPPayload, base: string): boolean {
  return (
    headersNameProtected(params['responseHeaders'], base) ||
    headersNameProtected(params['headers'], base) ||
    binaryHeadersNameProtected(params['binaryResponseHeaders'])
  );
}

export function treeNamesProtected(tree: unknown): boolean {
  const pending: unknown[] = [tree];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isObj(node)) continue;
    const frame = isObj(node['frame']) ? node['frame'] : {};
    for (const key of ['url', 'unreachableUrl']) {
      const url = str(frame[key]);
      if (url && urlProtected(url)) return true;
    }
    if (Array.isArray(node['childFrames'])) pending.push(...node['childFrames']);
  }
  return false;
}

const DISCOVERY_EVENTS = new Set([
  'Target.targetCreated',
  'Target.targetInfoChanged',
  'Target.targetDestroyed',
  'Target.targetCrashed',
]);

const ERROR_PAGE_READS = new Set([
  'Page.captureSnapshot',
  'Page.getResourceContent',
  'Page.searchInResource',
]);

export function mentions(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('://') && urlProtected(value, true);
  if (Array.isArray(value)) return value.some(mentions);
  if (isObj(value)) return Object.values(value).some(mentions);
  return false;
}

function storageEntryProtected(key: string, item: unknown): boolean {
  if (FREE_FORM.has(key)) return false;
  if (typeof item !== 'string') return namesProtectedStorage(item);
  if (ORIGIN_KEYS.has(key) && urlProtected(item, true)) return true;
  if (key === 'storageKey') return isProtectedStorageKey(item);
  if (key === 'cacheId') return isProtectedStorageKey(item.split('|')[0] ?? '');
  return false;
}

export function namesProtectedStorage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(namesProtectedStorage);
  if (!isObj(value)) return false;
  return Object.entries(value).some(([key, item]) => storageEntryProtected(key, item));
}

function hostOf(text: string): string | undefined {
  try {
    return new URL(text).hostname || undefined;
  } catch {
    return undefined;
  }
}

function siteProtected(site: string): boolean {
  if (urlProtected(site)) return true;
  const host = hostOf(site);
  return host !== undefined && isProtectedCookieDomain(host);
}

function cookieProtected(cookie: unknown): boolean {
  if (!isObj(cookie)) return false;
  const domain = str(cookie['domain']);
  if (domain && isProtectedCookieDomain(domain)) return true;
  const url = str(cookie['url']);
  if (url && siteProtected(url)) return true;
  const partition = cookie['partitionKey'];
  if (typeof partition === 'string') return siteProtected(partition);
  const top = isObj(partition) ? str(partition['topLevelSite']) : undefined;
  return top !== undefined && siteProtected(top);
}

export function cookieRefused(params: CDPPayload): boolean {
  const cookies = params['cookies'];
  if (Array.isArray(cookies)) return cookies.some(cookieProtected);
  return cookieProtected(params);
}

export function cookieUrlUnparseable(params: CDPPayload): boolean {
  const urls = params['urls'];
  const cookies = params['cookies'];
  return [
    ...(Array.isArray(urls) ? urls : []),
    params['url'],
    ...(Array.isArray(cookies) ? cookies.map((c) => (isObj(c) ? c['url'] : undefined)) : []),
  ].some((url) => typeof url === 'string' && isUnparseableUrl(url));
}

export function dropProtectedCookies(result: CDPPayload): void {
  const cookies = result['cookies'];
  if (Array.isArray(cookies)) result['cookies'] = cookies.filter((c) => !cookieProtected(c));
}

function stripProtectedAssociated(params: CDPPayload): void {
  const cookies = params['associatedCookies'];
  if (!Array.isArray(cookies)) return;
  params['associatedCookies'] = cookies.filter(
    (item) => !(isObj(item) && cookieProtected(item['cookie']))
  );
}

export function redacted(info: CDPPayload): CDPPayload {
  let origin = 'about:blank';
  try {
    const parsed = new URL(str(info['url']) ?? '');
    if (parsed.origin !== 'null') origin = parsed.origin;
  } catch {}
  return { ...info, url: origin, title: origin };
}

export function redactHistory(result: CDPPayload): void {
  const entries = result['entries'];
  if (!Array.isArray(entries)) return;
  result['entries'] = entries.map((entry) => {
    if (!isObj(entry)) return entry;
    const url = str(entry['url']) ?? '';
    const typed = str(entry['userTypedURL']) ?? '';
    if (!urlProtected(url) && !urlProtected(typed)) return entry;
    const origin = str(redacted({ url: urlProtected(url) ? url : typed })['url']) ?? 'about:blank';
    return { ...entry, url: origin, userTypedURL: origin, title: origin };
  });
}

export function requestUrl(params: CDPPayload): string | undefined {
  const request = params['request'];
  const response = params['response'];
  return (
    (isObj(request) ? str(request['url']) : undefined) ??
    (isObj(response) ? str(response['url']) : undefined) ??
    str(params['url'])
  );
}

function requestKey(params: CDPPayload | undefined): string | undefined {
  return str(params?.['requestId']) ?? str(params?.['interceptionId']);
}

export function initScriptGuard(): string {
  const rules = JSON.stringify({
    s: PROTECTED_RULES.schemes,
    h: PROTECTED_RULES.hosts,
    d: PROTECTED_RULES.domains,
    p: PROTECTED_RULES.protectedSchemes,
    x: PROTECTED_RULES.schemeExceptions,
  });
  const refusal = JSON.stringify(PROTECTED_RULES.refusal);
  return (
    `if((function(r,o){function q(s,h){return r.p.indexOf(s)>=0&&r.x.indexOf(s+'://'+h)<0}` +
    `var l=self.location;if(l&&q(l.protocol.slice(0,-1),l.hostname.toLowerCase()))return true;` +
    `try{var u=new URL(o),h=u.hostname.toLowerCase().replace(/\\.$/,''),` +
    `s=u.protocol.slice(0,-1);return q(s,h)||r.s.indexOf(s)>=0&&(r.h.indexOf(h)>=0||r.d.some(function(d){` +
    `return h===d||h.slice(-d.length-1)==='.'+d}))}catch(e){return false}})(${rules},self.origin))` +
    `throw new Error(${refusal});\n`
  );
}

function wildcard(pattern: string, text: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] ?? '';
    if (c === '\\' && i + 1 < pattern.length) {
      i += 1;
      re += (pattern[i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's').test(text);
}

export function patternMatches(pattern: unknown, paused: CDPPayload): boolean {
  if (!isObj(pattern)) return false;
  const stage =
    'responseStatusCode' in paused || 'responseErrorReason' in paused ? 'Response' : 'Request';
  if ((str(pattern['requestStage']) ?? 'Request') !== stage) return false;
  const type = str(pattern['resourceType']);
  if (type !== undefined && type !== str(paused['resourceType'])) return false;
  return wildcard(str(pattern['urlPattern']) ?? '*', requestUrl(paused) ?? '');
}

class Bounded<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly limit: number) {}
  get(key: string): V | undefined {
    return this.map.get(key);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  delete(key: string): V | undefined {
    const value = this.map.get(key);
    this.map.delete(key);
    return value;
  }
}

export interface ShieldEvent {
  method: string;
  params?: CDPPayload;
}

type Send = (method: string, params?: CDPPayload) => Promise<CDPPayload>;

interface ClientFetch {
  patterns: unknown[];
  handleAuthRequests: boolean;
}

export class TabShield {
  private readonly requests = new Bounded<boolean>(5000);
  private readonly held = new Bounded<ShieldEvent[]>(500);
  private readonly frames = new Bounded<string[]>(1000);
  private readonly forwarded = new Bounded<true>(2000);
  private readonly pausedUrls = new Bounded<string>(2000);
  private readonly bodyReads = new Bounded<string>(2000);
  private readonly streams = new Bounded<true>(500);
  private readonly failedDocuments = new Bounded<true>(200);
  private readonly hiddenFrames = new Bounded<true>(1000);
  private readonly namedBodies = new Bounded<true>(2000);
  private readonly hops = new Bounded<string>(500);
  private readonly reroutes = new Map<string, (allowed: boolean) => void>();
  private readonly worlds = new Worlds();
  private clientFetch: ClientFetch | null = null;
  private mainFrameId = '';
  private blockedFlag = false;

  constructor(
    private readonly send: Send,
    private readonly onBlocked: () => void
  ) {}

  get blocked(): boolean {
    return this.blockedFlag;
  }

  private readyPromise: Promise<void> | null = null;

  install(): Promise<void> {
    if (!this.readyPromise) this.readyPromise = this.arm();
    return this.readyPromise;
  }

  private async arm(): Promise<void> {
    await this.send('Fetch.enable', this.fetchParams());
    await this.send('Network.setBypassServiceWorker', { bypass: true });
    await this.inventoryFrames();
    await this.send('Runtime.enable', {});
  }

  private async inventoryFrames(): Promise<void> {
    const tree = await this.send('Page.getFrameTree', {});
    const root = tree['frameTree'];
    const main = isObj(root) && isObj(root['frame']) ? str(root['frame']['id']) : undefined;
    if (!main) refuse(PROTECTED_RULES.refusal);
    this.mainFrameId = main;
    const pending: unknown[] = [root];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!isObj(node)) continue;
      const frame = isObj(node['frame']) ? node['frame'] : {};
      const url = `${str(frame['url']) ?? ''}${str(frame['urlFragment']) ?? ''}`;
      const origin = str(frame['securityOrigin']) ?? '';
      const id = str(frame['id']);
      if (id) this.frames.set(id, [url, origin]);
      if (id && id !== main && (extensionOrigin(url) || extensionOrigin(origin))) {
        this.hiddenFrames.set(id, true);
        continue;
      }
      if (urlProtected(url) || urlProtected(origin)) refuse(PROTECTED_RULES.refusal);
      if (await this.inheritedProtected(frame)) refuse(PROTECTED_RULES.refusal);
      if (Array.isArray(node['childFrames'])) pending.push(...node['childFrames']);
    }
  }

  private fetchParams(): CDPPayload {
    const client = this.clientFetch;
    const patterns = client ? client.patterns : [];
    return {
      patterns: [GUARD_FETCH_PATTERN, ...patterns],
      handleAuthRequests: client?.handleAuthRequests === true,
    };
  }

  failedBeforeCommit(url: string): boolean {
    return this.failedDocuments.has(url.split('#')[0] ?? url);
  }

  block(): void {
    if (this.blockedFlag) return;
    this.blockedFlag = true;
    this.onBlocked();
  }

  async command(
    method: string,
    params: CDPPayload | undefined,
    forward: Send
  ): Promise<CDPPayload> {
    const input = method === 'Runtime.addBinding' ? scopedBinding(params ?? {}) : (params ?? {});
    if (this.blockedFlag) refuse(PROTECTED_RULES.refusal);
    await this.admit(method, input);
    if (method === 'Runtime.enable' || method === 'Runtime.disable') return {};
    const about = method === 'Page.navigate' ? aboutUrl(input['url']) : undefined;
    if (about) return this.openBlank(input, about);
    const rewritten = this.rewrite(method, input);
    if (rewritten === null) return {};
    const settles = FETCH_SETTLES.has(method);
    const pauseId = String(input['requestId']);
    let read: string | undefined;
    if (settles) {
      if (!this.forwarded.has(pauseId)) refuse(PAUSE_REFUSAL);
      this.forwarded.delete(pauseId);
      read = this.bodyReads.delete(pauseId);
    }
    const reroute = this.pendingReroute(method, input, pauseId);
    let result: CDPPayload;
    try {
      result = await forward(
        method,
        params === undefined && rewritten === input ? undefined : rewritten
      );
    } catch (err) {
      this.reroutes.delete(pauseId);
      if (settles && !/Invalid InterceptionId/i.test(String(err))) {
        this.forwarded.set(pauseId, true);
        if (read !== undefined) this.bodyReads.set(pauseId, read);
      }
      throw err;
    }
    if (reroute !== undefined) await this.settleReroute(pauseId, reroute);
    if (this.blockedFlag) refuse(PROTECTED_RULES.refusal);
    return this.after(method, result ?? {});
  }

  private pendingReroute(
    method: string,
    params: CDPPayload,
    id: string
  ): Promise<boolean> | undefined {
    if (method !== 'Fetch.continueRequest' || params['url'] === undefined) return undefined;
    return new Promise<boolean>((resolve) => this.reroutes.set(id, resolve));
  }

  private async settleReroute(id: string, reroute: Promise<boolean>): Promise<void> {
    const late = new Promise<boolean>((resolve) => setTimeout(resolve, 10000, true));
    const allowed = await Promise.race([reroute, late]);
    this.reroutes.delete(id);
    if (!allowed) refuse(REROUTE_REFUSAL);
  }

  private rerouted(paused: CDPPayload, id: string): boolean {
    const waiting = this.reroutes.get(id);
    const settled =
      paused['responseStatusCode'] !== undefined || paused['responseErrorReason'] !== undefined;
    if (!waiting || !settled) return false;
    this.reroutes.delete(id);
    const url = requestUrl(paused) ?? '';
    const named = urlProtected(url) || headersNameProtected(paused['responseHeaders'], url);
    waiting(!named);
    if (!named) return false;
    const networkId = str(paused['networkId']);
    if (networkId) this.requests.set(networkId, true);
    this.answer('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' });
    return true;
  }

  visibleContexts(): CDPPayload[] {
    return this.worlds.visible();
  }

  private async frameOf(frameId: string | undefined): Promise<CDPPayload | undefined> {
    const tree = await this.send('Page.getFrameTree', {});
    return frameIn(tree['frameTree'], frameId);
  }

  private async documentOrigin(frameId: string): Promise<string> {
    const world = await this.send('Page.createIsolatedWorld', { frameId, worldName: ABOUT_WORLD });
    const answer = await this.send('Runtime.evaluate', {
      expression: 'self.origin',
      contextId: world['executionContextId'],
      returnByValue: true,
    });
    const result = answer['result'];
    const origin = isObj(result) ? str(result['value']) : undefined;
    if (answer['exceptionDetails'] !== undefined || origin === undefined) {
      throw new Error('no origin');
    }
    return origin;
  }

  private async inheritedProtected(frame: CDPPayload): Promise<boolean> {
    const frameId = str(frame['id']) ?? '';
    let current: CDPPayload | undefined = frame;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const url = str(current['url']) ?? '';
      if (urlProtected(url) || urlProtected(str(current['securityOrigin']) ?? '')) return true;
      if (url !== '' && !url.startsWith('about:')) return false;
      try {
        return urlProtected(await this.documentOrigin(frameId));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      current = await this.frameOf(frameId).catch(() => undefined);
      if (!current) return true;
    }
    return true;
  }

  private async openBlank(params: CDPPayload, about: URL): Promise<CDPPayload> {
    if (about.pathname !== 'blank') refuse(ABOUT_OTHER);
    const url = about.href;
    const before = await this.frameOf(str(params['frameId']));
    if (!before) throw new Error('No frame with given id found');
    const frameId = str(before['id']) ?? '';
    const world = await this.send('Page.createIsolatedWorld', { frameId, worldName: ABOUT_WORLD });
    const ran = await this.send('Runtime.evaluate', {
      expression: `location.assign(${JSON.stringify(url)})`,
      contextId: world['executionContextId'],
    });
    if (ran['exceptionDetails'] !== undefined) refuse(ABOUT_STUCK);
    const current = `${str(before['url']) ?? ''}${str(before['urlFragment']) ?? ''}`;
    if (sameDocument(current, url)) return { frameId };
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const now = await this.frameOf(frameId);
      if (!now || now['loaderId'] === before['loaderId']) continue;
      if (
        this.blockedFlag ||
        urlProtected(str(now['securityOrigin']) ?? '') ||
        (await this.inheritedProtected(now))
      ) {
        refuse(PROTECTED_RULES.refusal);
      }
      return { frameId, loaderId: now['loaderId'], isDownload: false };
    }
    refuse(ABOUT_STUCK);
  }

  private async admit(method: string, params: CDPPayload): Promise<void> {
    const outright = REFUSED_METHODS.get(method);
    if (outright) refuse(outright);
    this.admitBrowserWide(method, params);
    this.admitUrls(method, params);
    if (namesProtectedStorage(params)) refuse(PROTECTED_RULES.refusal);
    this.admitFrame(params);
    this.admitWorlds(method, params);
    this.admitRequestIds(method, params);
    if (method === 'Page.navigateToHistoryEntry') await this.admitHistory(params);
    if (ERROR_PAGE_READS.has(method)) {
      const tree = await this.send('Page.getFrameTree', {});
      if (treeNamesProtected(tree['frameTree'])) refuse(PROTECTED_RULES.refusal);
    }
  }

  private admitBrowserWide(method: string, params: CDPPayload): void {
    if (
      (method === 'Browser.setPermission' || method === 'Browser.grantPermissions') &&
      !str(params['origin'])
    ) {
      refuse("browser-wide permissions would reach seven's origin");
    }
    if (method === 'Target.getTargetInfo' && params['targetId'] !== undefined) {
      refuse('Target.getTargetInfo of another target is not supported on a page session');
    }
    if (method === 'Target.setAutoAttach' && params['autoAttach'] === true) {
      refuse('auto-attach is not supported by the extension bridge');
    }
    if (method === 'Network.setBypassServiceWorker' && params['bypass'] !== true) {
      refuse("service workers stay bypassed so seven's pages cannot load from cache");
    }
  }

  private admitUrls(method: string, params: CDPPayload): void {
    if ((COOKIE_SETTERS.has(method) || COOKIE_READERS.has(method)) && cookieUrlUnparseable(params))
      refuse(PROTECTED_RULES.unparseableRefusal);
    if (COOKIE_SETTERS.has(method)) {
      if (cookieRefused(params)) refuse(COOKIES_REFUSAL);
      return;
    }
    const url = str(params['url']);
    refuseUnparseableDestination(url);
    if (NAVIGATES.has(method) && url !== undefined && url !== '' && !URL.canParse(url)) {
      refuse("a relative url would open one of the extension's own pages");
    }
    if (NAVIGATES.has(method) && wrapsAbout(url, PROTECTED_RULES.innerSchemes)) {
      refuse(ABOUT_WRAPPED);
    }
    if (url && urlProtected(url, method.startsWith('Debugger.'))) refuse(PROTECTED_RULES.refusal);
  }

  private admitFrame(params: CDPPayload): void {
    const frameId = str(params['frameId']);
    if (frameId && this.frameProtected(frameId)) refuse(PROTECTED_RULES.refusal);
  }

  private admitWorlds(method: string, params: CDPPayload): void {
    if (profiled(method) && this.worlds.foreign) refuse(PROFILED);
    if (params['worldName'] === ABOUT_WORLD) refuse(RESERVED_WORLD);
    if (this.worlds.named(params['worldName'])) refuse(WORLD);
    const reason = this.worlds.refusal(params);
    if (reason) refuse(reason);
  }

  private admitPaused(method: string, id: string, params: CDPPayload): void {
    if (answerNamesProtected(params, this.pausedUrls.get(id) ?? '')) {
      refuse(PROTECTED_RULES.refusal);
    }
    if (!FETCH_READS.has(method)) return;
    if (this.namedBodies.has(id)) refuse(PROTECTED_RULES.refusal);
    const read = this.bodyReads.get(id);
    if (read !== undefined && read !== method) refuse(BODY_READ_REFUSAL);
    this.bodyReads.set(id, method);
  }

  private admitRequestIds(method: string, params: CDPPayload): void {
    if (FETCH_ANSWERS.has(method)) {
      const id = str(params['requestId']);
      if (!id || !this.forwarded.has(id)) refuse(PAUSE_REFUSAL);
      this.admitPaused(method, id, params);
      return;
    }
    if (BODY_METHODS.has(method)) {
      const id = requestKey(params);
      const state = id ? this.requests.get(id) : undefined;
      if (state === undefined) refuse(UNSEEN_REFUSAL);
      if (state) refuse(PROTECTED_RULES.refusal);
      return;
    }
    if (method === 'IO.read' && !this.streams.has(str(params['handle']) ?? ''))
      refuse(STREAM_REFUSAL);
  }

  private async admitHistory(params: CDPPayload): Promise<void> {
    const history = await this.send('Page.getNavigationHistory', {});
    const entries = Array.isArray(history['entries']) ? history['entries'] : [];
    const entry = entries.find((e) => isObj(e) && e['id'] === params['entryId']);
    const url = isObj(entry) ? (str(entry['url']) ?? '') : '';
    if (urlProtected(url)) refuse(PROTECTED_RULES.refusal);
  }

  private rewrite(method: string, params: CDPPayload): CDPPayload | null {
    if (method === 'Fetch.enable') {
      const patterns = Array.isArray(params['patterns'])
        ? params['patterns']
        : [{ urlPattern: '*' }];
      this.clientFetch = { patterns, handleAuthRequests: params['handleAuthRequests'] === true };
      return this.fetchParams();
    }
    if (method === 'Fetch.disable') {
      this.clientFetch = null;
      void this.send('Fetch.enable', this.fetchParams()).catch(() => this.block());
      return null;
    }
    if (method === 'Fetch.continueRequest' && params['url'] !== undefined) {
      return { ...params, interceptResponse: true };
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      return { ...params, source: initScriptGuard() + (str(params['source']) ?? '') };
    }
    if (method === 'Page.addScriptToEvaluateOnLoad') {
      return { ...params, scriptSource: initScriptGuard() + (str(params['scriptSource']) ?? '') };
    }
    return params;
  }

  private after(method: string, result: CDPPayload): CDPPayload {
    if (method === 'Page.captureSnapshot') {
      const data = (str(result['data']) ?? '').replace(/=\r?\n/g, '');
      if (redactText(data) !== data) refuse(PROTECTED_RULES.refusal);
    }
    this.worlds.learn(result);
    if (method === 'Page.createIsolatedWorld') this.worlds.seen(result['executionContextId']);
    const stream = str(result['stream']);
    if (stream) this.streams.set(stream, true);
    const resource = result['resource'];
    const resourceStream = isObj(resource) ? str(resource['stream']) : undefined;
    if (resourceStream) this.streams.set(resourceStream, true);
    if (method === 'Page.getFrameTree') this.pruneFrames(result['frameTree']);
    if (method === 'Page.getResourceTree') this.pruneFrames(result['frameTree']);
    if (COOKIE_READERS.has(method)) dropProtectedCookies(result);
    if (method === 'Page.getNavigationHistory') redactHistory(result);
    if (method === 'Target.getTargetInfo' && isObj(result['targetInfo'])) {
      const info = result['targetInfo'];
      if (isProtectedTargetType(info['type'])) refuse(PROTECTED_RULES.refusal);
      if (isProtectedTarget(str(info['url']) ?? '', false, 'unknown'))
        result['targetInfo'] = redacted(info);
    }
    return result;
  }

  onEvent(method: string, params: CDPPayload | undefined): ShieldEvent[] {
    const p = params ?? {};
    if (method === 'Fetch.requestPaused') return this.onPaused(p);
    if (method === 'Fetch.authRequired') return this.onAuth(p);
    this.track(p);
    if (this.watchCommit(method, p)) return [];
    if (profiled(method) && this.worlds.foreign) return [];
    if (this.worlds.hides(p)) return [];
    if (this.frameProtected(str(p['frameId']) ?? '')) return [];
    if (DISCOVERY_EVENTS.has(method)) return [];
    if (method.startsWith('Target.')) {
      if (isObj(p['targetInfo']) && isProtectedTargetType(p['targetInfo']['type'])) return [];
      return [this.redactTarget(method, p)];
    }
    return this.deliver({ method, params: p });
  }

  private initiatedByProtected(paused: CDPPayload): boolean {
    if (this.frameProtected(str(paused['frameId']) ?? '')) return true;
    const request = paused['request'];
    const headers = isObj(request) && isObj(request['headers']) ? request['headers'] : {};
    return Object.entries(headers).some(([name, value]) => {
      const lower = name.toLowerCase();
      return (
        (lower === 'referer' || lower === 'origin') &&
        value !== 'null' &&
        urlProtected(str(value) ?? '')
      );
    });
  }

  private onPaused(paused: CDPPayload): ShieldEvent[] {
    const id = str(paused['requestId']) ?? '';
    if (this.rerouted(paused, id)) return [];
    const protectedUrl = urlProtected(requestUrl(paused) ?? '');
    const tainted = protectedUrl || this.initiatedByProtected(paused);
    this.requests.set(id, tainted);
    const networkId = str(paused['networkId']);
    if (networkId) this.requests.set(networkId, tainted || this.requests.get(networkId) === true);
    if (protectedUrl && paused['resourceType'] === 'Document') {
      this.failedDocuments.set((requestUrl(paused) ?? '').split('#')[0] ?? '', true);
      this.answer('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' });
      return [];
    }
    if (headersNameProtected(paused['responseHeaders'], requestUrl(paused))) {
      this.namedBodies.set(id, true);
      if (networkId) this.requests.set(networkId, true);
    }
    const wanted =
      this.clientFetch?.patterns.some((pattern) => patternMatches(pattern, paused)) === true;
    if (tainted || this.blockedFlag || !wanted) {
      this.answer('Fetch.continueRequest', { requestId: id });
      return [];
    }
    this.forwarded.set(id, true);
    this.pausedUrls.set(id, requestUrl(paused) ?? '');
    return [{ method: 'Fetch.requestPaused', params: paused }];
  }

  private onAuth(event: CDPPayload): ShieldEvent[] {
    const id = str(event['requestId']) ?? '';
    const protectedUrl = urlProtected(requestUrl(event) ?? '') || this.requests.get(id) === true;
    if (protectedUrl || this.blockedFlag || this.clientFetch?.handleAuthRequests !== true) {
      this.answer('Fetch.continueWithAuth', {
        requestId: id,
        authChallengeResponse: { response: 'Default' },
      });
      return [];
    }
    this.forwarded.set(id, true);
    return [{ method: 'Fetch.authRequired', params: event }];
  }

  private answer(method: string, params: CDPPayload): void {
    this.send(method, params).catch(() => {});
  }

  private track(params: CDPPayload): void {
    const id = str(params['requestId']);
    const url = requestUrl(params);
    if (!id || url === undefined) return;
    const initiator = params['initiator'];
    const fromProtected =
      urlProtected(str(params['documentURL']) ?? '') ||
      urlProtected(isObj(initiator) ? (str(initiator['url']) ?? '') : '') ||
      this.frameProtected(str(params['frameId']) ?? '');
    const tainted = fromProtected || urlProtected(url) || this.requests.get(id) === true;
    this.requests.set(id, tainted);
  }

  private frameProtected(frameId: string): boolean {
    if (!frameId) return false;
    if (this.hiddenFrames.has(frameId)) return true;
    return (this.frames.get(frameId) ?? []).some((url) => urlProtected(url));
  }

  private watchCommit(method: string, params: CDPPayload): boolean {
    if (method === 'Page.frameNavigated' && isObj(params['frame'])) {
      const frame = params['frame'];
      const url = `${str(frame['url']) ?? ''}${str(frame['urlFragment']) ?? ''}`;
      const origin = str(frame['securityOrigin']) ?? '';
      const id = str(frame['id']);
      if (id) this.frames.set(id, [url, origin]);
      if (frame['parentId'] === undefined) {
        if (id) this.mainFrameId = id;
        if (urlProtected(url) || urlProtected(origin)) this.block();
        return false;
      }
      if (id && (extensionOrigin(url) || extensionOrigin(origin))) {
        this.hiddenFrames.set(id, true);
        return true;
      }
      return false;
    }
    if (method === 'Runtime.executionContextDestroyed') {
      return this.worlds.remove(params['executionContextId']);
    }
    if (method === 'Runtime.executionContextsCleared') {
      this.worlds.clear();
      return false;
    }
    if (method === 'Runtime.executionContextCreated' && isObj(params['context'])) {
      return this.watchContext(params['context']);
    }
    return false;
  }

  private watchContext(context: CDPPayload): boolean {
    const aux = isObj(context['auxData']) ? context['auxData'] : {};
    const origin = str(context['origin']) ?? '';
    const frame = str(aux['frameId']);
    let kind = this.worlds.kindOf(context, urlProtected);
    if (aux['isDefault'] !== false && kind === undefined) {
      if (frame) this.frames.set(frame, [...(this.frames.get(frame) ?? []), origin]);
      const child = frame !== undefined && frame !== this.mainFrameId;
      if (child && (extensionOrigin(origin) || (frame && this.hiddenFrames.has(frame)))) {
        if (frame) this.hiddenFrames.set(frame, true);
        kind = 'foreign';
      } else if (urlProtected(origin)) {
        this.block();
        return true;
      }
    }
    if (this.worlds.add(context, kind)) this.quietProfilers();
    return kind !== undefined;
  }

  private pruneFrames(tree: unknown): void {
    if (!isObj(tree) || !Array.isArray(tree['childFrames'])) return;
    const kept = tree['childFrames'].filter((node: unknown) => {
      const frame = isObj(node) && isObj(node['frame']) ? node['frame'] : {};
      const id = str(frame['id']) ?? '';
      const hidden =
        this.frameProtected(id) ||
        extensionOrigin(frame['url']) ||
        extensionOrigin(frame['securityOrigin']);
      if (hidden && id) this.hiddenFrames.set(id, true);
      return !hidden;
    });
    tree['childFrames'] = kept;
    for (const node of kept) this.pruneFrames(node);
  }

  private quietProfilers(): void {
    for (const method of ['Debugger.disable', 'Profiler.disable', 'HeapProfiler.disable']) {
      this.send(method, {}).catch(() => {});
    }
  }

  private redactTarget(method: string, params: CDPPayload): ShieldEvent {
    const info = params['targetInfo'];
    if (!isObj(info)) return { method, params };
    const opener = str(info['openerId']) ? 'unknown' : undefined;
    if (!isProtectedTarget(str(info['url']) ?? '', false, opener)) return { method, params };
    return { method, params: { ...params, targetInfo: redacted(info) } };
  }

  private redirectHop(params: CDPPayload, id: string): boolean {
    const redirect = params['redirectResponse'];
    const from = isObj(redirect) ? str(redirect['url']) : undefined;
    if (!from || urlProtected(from) || !urlProtected(requestUrl(params) ?? '')) return false;
    this.requests.set(id, true);
    this.held.delete(id);
    if (this.hops.get(id) !== 'done') this.hops.set(id, 'await');
    return true;
  }

  private redirectExtra(params: CDPPayload, id: string): boolean {
    const status = params['statusCode'];
    if (typeof status !== 'number' || !REDIRECTS.has(status)) return false;
    const awaited = this.hops.get(id) === 'await';
    const named = responseNamesProtected('Network.responseReceivedExtraInfo', params);
    if (this.requests.get(id) === true ? !awaited : !named) return false;
    this.hops.set(id, 'done');
    this.requests.set(id, true);
    stripProtectedAssociated(params);
    return true;
  }

  private redirected(event: ShieldEvent, id: string | undefined): boolean {
    const params = event.params ?? {};
    if (!id) return false;
    if (event.method === 'Network.requestWillBeSent') return this.redirectHop(params, id);
    if (event.method === 'Network.responseReceivedExtraInfo') return this.redirectExtra(params, id);
    return false;
  }

  private deliver(event: ShieldEvent): ShieldEvent[] {
    const params = event.params ?? {};
    const id = str(params['requestId']);
    if (this.redirected(event, id)) return [event];
    if (id && this.requests.get(id) === true) {
      this.held.delete(id);
      return [];
    }
    if (mentions(params) || responseNamesProtected(event.method, params)) {
      if (id) {
        this.requests.set(id, true);
        this.held.delete(id);
      }
      return [];
    }
    if (id && event.method.endsWith('ExtraInfo')) {
      stripProtectedAssociated(params);
      if (this.requests.get(id) === undefined) {
        this.held.set(id, [...(this.held.get(id) ?? []), event]);
        return [];
      }
    }
    const released = id && this.requests.get(id) === false ? (this.held.delete(id) ?? []) : [];
    this.worlds.learn(params);
    return [event, ...released];
  }
}
