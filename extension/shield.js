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

export function urlProtected(guard, text) {
  if (typeof text !== 'string' || text === '') return false;
  return guard.url(text) || guard.url(webSocketAsHttp(text));
}

function storageNamed(guard, key, item) {
  if (ORIGIN_KEYS.has(key) && urlProtected(guard, item)) return true;
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
  if (Array.isArray(p.urls) && p.urls.some((u) => siteProtected(guard, u))) return true;
  return cookieProtected(guard, p);
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
  return urlProtected(guard, concrete);
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
  return (
    `if ((function () { var p = location.protocol; if (${any}.indexOf(p) >= 0) return true; ` +
    `if (${privileged}.indexOf(p) >= 0 && ${exceptions}.indexOf(p + "//" + location.hostname.toLowerCase()) < 0) return true; ` +
    'var h = ("" + (document.domain || location.hostname || "")).toLowerCase(); ' +
    'if (h.slice(-1) === ".") h = h.slice(0, -1); if (h === "") return false; ' +
    `if (${hosts}.indexOf(h) >= 0) return true; ` +
    `return ${domains}.some(function (d) { return h === d || h.slice(-d.length - 1) === "." + d; }); ` +
    '})()) { throw "slicc: refused: init script on a protected origin"; }\n'
  );
}
