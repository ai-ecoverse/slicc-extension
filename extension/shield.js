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
  return guard.url(text, options) || guard.url(webSocketAsHttp(text), options);
}

const SCHEME = /[a-z0-9+.-]/i;
const URL_END = /[\s"'<>`\\\u0000-\u001f]/;
const WEB_SCHEMES = ['https', 'http', 'wss', 'ws'];
const URL_KEYS = ['url', 'unreachableUrl', 'userTypedURL'];

const AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

function originOf(text) {
  try {
    const origin = new URL(text).origin;
    if (origin && origin !== 'null') return origin;
  } catch {}
  return AUTHORITY.exec(text)?.[0] ?? 'about:blank';
}

function urlAt(text, at, isProtected) {
  let start = at;
  while (start > 0 && at - start < 32 && SCHEME.test(text[start - 1])) start -= 1;
  while (start < at && !/[a-z]/i.test(text[start])) start += 1;
  let end = at + 3;
  while (end < text.length && !URL_END.test(text[end])) end += 1;
  if (start === at) return { start, end, hit: false };
  if (isProtected(text.slice(start, end))) return { start, end, hit: true };
  const scheme = text.slice(start, at).toLowerCase();
  const inner = WEB_SCHEMES.find((s) => scheme.length > s.length && scheme.endsWith(s));
  if (inner === undefined) return { start, end, hit: false };
  const from = at - inner.length;
  return { start: from, end, hit: isProtected(text.slice(from, end)) };
}

export function redactText(text, isProtected) {
  if (typeof text !== 'string' || !text.includes('://')) return text;
  let out = '';
  let last = 0;
  let at = text.indexOf('://');
  while (at >= 0) {
    const span = urlAt(text, at, isProtected);
    if (span.hit) {
      const match = text.slice(span.start, span.end);
      const origin = originOf(match);
      if (match !== origin && match !== `${origin}/`) {
        out += text.slice(last, span.start) + origin;
        last = span.end;
      }
    }
    at = text.indexOf('://', Math.max(span.end, at + 3));
  }
  return last === 0 ? text : out + text.slice(last);
}

export function namesProtectedUrl(text, isProtected) {
  if (typeof text !== 'string' || !text.includes('://')) return false;
  for (let at = text.indexOf('://'); at >= 0; ) {
    const span = urlAt(text, at, isProtected);
    if (span.hit) return true;
    at = text.indexOf('://', Math.max(span.end, at + 3));
  }
  return false;
}

function urlNamed(text, isProtected) {
  return typeof text === 'string' && text !== '' && isProtected(text);
}

export function redactProtected(value, isProtected) {
  if (typeof value === 'string') return redactText(value, isProtected);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let out = value;
    value.forEach((item, index) => {
      const next = redactProtected(item, isProtected);
      if (next === item) return;
      if (out === value) out = [...value];
      out[index] = next;
    });
    return out;
  }
  let out = value;
  for (const [key, item] of Object.entries(value)) {
    const next = redactProtected(item, isProtected);
    if (next === item) continue;
    if (out === value) out = { ...value };
    out[key] = next;
  }
  if ('urlFragment' in value && URL_KEYS.some((k) => urlNamed(value[k], isProtected))) {
    if (out === value) out = { ...value };
    delete out.urlFragment;
  }
  return out;
}

export function headersNameProtected(headers, isProtected) {
  if (Array.isArray(headers)) {
    return headers.some((header) => namesProtectedUrl(header?.value, isProtected));
  }
  if (headers === null || typeof headers !== 'object') return false;
  return Object.values(headers).some((value) => namesProtectedUrl(value, isProtected));
}

export function responseNamesProtected(method, params, isProtected) {
  if (headersNameProtected(params?.response?.headers, isProtected)) return true;
  if (headersNameProtected(params?.redirectResponse?.headers, isProtected)) return true;
  if (!method.endsWith('responseReceivedExtraInfo')) return false;
  return (
    headersNameProtected(params.headers, isProtected) ||
    namesProtectedUrl(params.headersText, isProtected)
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
const PROFILED_DOMAINS = ['Debugger.', 'Profiler.', 'HeapProfiler.'];
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
