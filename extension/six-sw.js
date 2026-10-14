var _protDomains = ["sliccy.ai"];
var _protSchemes = ["https","http"];
function _isProtectedUrl(url) {
  try {
    var u = new URL(url);
    var s = u.protocol.slice(0, -1);
    if (!_protSchemes.includes(s)) return false;
    var h = u.hostname.toLowerCase();
    if (h.endsWith(".")) h = h.slice(0, -1);
    return _protDomains.some(function(d) { return h === d || h.endsWith("." + d); });
  } catch { return false; }
}

var SLICC_HOSTED_ORIGIN = "https://www.sliccy.ai";

function unmaskString(pipeline, hostname, value) {
  const { text } = pipeline.unmaskBody(value, hostname);
  return { text, changed: text !== value };
}
function unmaskCdpFrame(frame, hostname, pipeline) {
  if (!frame || typeof frame !== "object") return { frame, changed: false };
  if (!pipeline.hasSecrets()) return { frame, changed: false };
  const method = frame.method;
  const params = frame.params;
  if (!params || typeof params !== "object") return { frame, changed: false };
  if (method === "Runtime.evaluate") {
    const p = params;
    if (typeof p.expression !== "string") return { frame, changed: false };
    const { text, changed } = unmaskString(pipeline, hostname, p.expression);
    if (!changed) return { frame, changed: false };
    return {
      frame: { ...frame, params: { ...p, expression: text } },
      changed: true
    };
  }
  if (method === "Input.insertText") {
    const p = params;
    if (typeof p.text !== "string") return { frame, changed: false };
    const { text, changed } = unmaskString(pipeline, hostname, p.text);
    if (!changed) return { frame, changed: false };
    return {
      frame: { ...frame, params: { ...p, text } },
      changed: true
    };
  }
  if (method === "Runtime.callFunctionOn") {
    const p = params;
    if (!Array.isArray(p.arguments)) return { frame, changed: false };
    let argsChanged = false;
    const nextArgs = p.arguments.map((arg) => {
      if (!arg || typeof arg !== "object") return arg;
      const a = arg;
      if (typeof a.value !== "string") return arg;
      const { text, changed } = unmaskString(pipeline, hostname, a.value);
      if (!changed) return arg;
      argsChanged = true;
      return { ...a, value: text };
    });
    if (!argsChanged) return { frame, changed: false };
    return {
      frame: { ...frame, params: { ...p, arguments: nextArgs } },
      changed: true
    };
  }
  return { frame, changed: false };
}

var KNOWN_PREFIXES = [
  "ghp_",

  "gho_",

  "ghu_",

  "ghs_",

  "ghr_",

  "github_pat_",

  "sk-",

  "pk-",

  "xoxb-",

  "xoxp-",

  "xoxa-",

  "xoxs-",

  "AKIA",

  "ABIA",

  "ACCA",

  "ASIA",

  "sk-ant-",

  "Bearer "

];
var SORTED_PREFIXES = [...KNOWN_PREFIXES].sort((a, b) => b.length - a.length);
function detectPrefix(value) {
  for (const p of SORTED_PREFIXES) {
    if (value.startsWith(p)) return p;
  }
  return "";
}
async function hmacSha256(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return new Uint8Array(sig);
}
function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacSha256Hex(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, message);
  return toHex(new Uint8Array(sig));
}
async function mask(sessionId, secretName, realValue) {
  const prefix = detectPrefix(realValue);
  const remainder = realValue.slice(prefix.length);
  const hmac = await hmacSha256(sessionId + secretName, realValue);
  let hex2 = toHex(hmac);
  while (hex2.length < remainder.length) hex2 += hex2;
  const maskedRemainder = hex2.slice(0, remainder.length);
  return prefix + maskedRemainder;
}
var MIN_MASKABLE_SECRET_LENGTH = 9;
function buildScrubber(secrets) {
  const eligible = secrets.filter((s) => s.realValue.length >= MIN_MASKABLE_SECRET_LENGTH);
  if (eligible.length === 0) return (t) => t;
  const sorted = [...eligible].sort((a, b) => b.realValue.length - a.realValue.length);
  return (text) => {
    let result = text;
    for (const { realValue, maskedValue } of sorted) {
      if (result.includes(realValue)) {
        result = result.split(realValue).join(maskedValue);
      }
    }
    return result;
  };
}
function domainMatches(pattern, hostname) {
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();
  if (p === "*") return true;
  if (!p.startsWith("*.")) {
    return p === h;
  }
  const suffix = p.slice(1);
  return h.length > suffix.length && h.endsWith(suffix);
}
function isAllowedDomain(patterns, hostname) {
  return patterns.some((p) => domainMatches(p, hostname));
}
function matchesDomains(hostname, patterns) {
  return isAllowedDomain(patterns, hostname);
}

function indexOfBytes(haystack, needle, from = 0) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
function replaceAllBytes(haystack, needle, replacement) {
  if (indexOfBytes(haystack, needle) < 0) return haystack;
  const out = [];
  let i = 0;
  while (i < haystack.length) {
    const idx = indexOfBytes(haystack, needle, i);
    if (idx < 0) {
      for (let k = i; k < haystack.length; k++) out.push(haystack[k]);
      break;
    }
    for (let k = i; k < idx; k++) out.push(haystack[k]);
    for (let k = 0; k < replacement.length; k++) out.push(replacement[k]);
    i = idx + needle.length;
  }
  return new Uint8Array(out);
}
var HMAC_SIGN_HEADER = "x-slicc-hmac-sign";
var SecretsPipeline = class {
  sessionId;
  source;
  sessionStore;
  maskedToSecret =  new Map();
  
  exportPairs = [];
  
  exportShortPairs = [];

  consumableShortSecrets =  new Map();

  byName =  new Map();
  scrubber = (t) => t;
  constructor(opts) {
    this.sessionId = opts.sessionId;
    this.source = opts.source;
    this.sessionStore = opts.sessionStore;
  }
  async reload() {
    const all = await this.source.listAll();
    const persistedNames = new Set(all.map((s) => s.name));
    const session = (this.sessionStore?.listAll() ?? []).filter((s) => !persistedNames.has(s.name));
    const merged = [...all, ...session];
    const next =  new Map();
    const nextShort =  new Map();
    for (const s of merged) {
      if (s.value.length < MIN_MASKABLE_SECRET_LENGTH) {
        console.warn(
          `[slicc:secrets] secret "${s.name}" not masked: value shorter than ${MIN_MASKABLE_SECRET_LENGTH} chars`
        );
        nextShort.set(s.name, {
          name: s.name,
          realValue: s.value,
          maskedValue: s.value,
          domains: s.domains
        });
        continue;
      }
      const maskedValue = await mask(this.sessionId, s.name, s.value);
      next.set(maskedValue, {
        name: s.name,
        realValue: s.value,
        maskedValue,
        domains: s.domains
      });
    }
    this.maskedToSecret = next;
    this.exportPairs = Array.from(next.values());
    this.exportShortPairs = Array.from(nextShort.values());
    this.consumableShortSecrets = nextShort;
    const nextByName =  new Map();
    for (const ms of next.values()) nextByName.set(ms.name, ms);
    for (const ms of nextShort.values()) {
      if (nextByName.has(ms.name)) {
        console.warn(
          `[slicc:secrets] secret "${ms.name}" registered as both maskable and short-consumable`
        );
      }
      nextByName.set(ms.name, ms);
    }
    this.byName = nextByName;
    const pairs = Array.from(next.values()).map((ms) => ({
      realValue: ms.realValue,
      maskedValue: ms.maskedValue
    }));
    this.scrubber = buildScrubber(pairs);
  }
  async maskOne(name, value) {
    return mask(this.sessionId, name, value);
  }
  hasSecrets() {
    return this.maskedToSecret.size > 0;
  }
  getMaskedEntries() {
    const entries = [];
    for (const ms of this.maskedToSecret.values()) {
      entries.push({ name: ms.name, maskedValue: ms.maskedValue, domains: ms.domains });
    }
    for (const ms of this.consumableShortSecrets.values()) {
      entries.push({ name: ms.name, maskedValue: ms.maskedValue, domains: ms.domains });
    }
    return entries;
  }
  
  unmask(text, hostname) {
    let result = text;
    for (const [maskedValue, ms] of this.maskedToSecret) {
      if (!result.includes(maskedValue)) continue;
      if (!matchesDomains(hostname, ms.domains)) {
        return { text, forbidden: { secretName: ms.name, hostname } };
      }
      result = result.split(maskedValue).join(ms.realValue);
    }
    return { text: result };
  }
  
  unmaskBody(text, hostname) {
    let result = text;
    for (const [maskedValue, ms] of this.maskedToSecret) {
      if (!result.includes(maskedValue)) continue;
      if (!matchesDomains(hostname, ms.domains)) continue;
      result = result.split(maskedValue).join(ms.realValue);
    }
    return { text: result };
  }
  unmaskAuthorizationBasic(headerValue, hostname) {
    const pattern = /^Basic\s+(.+)$/;
    const match = pattern.exec(headerValue);
    if (!match) return { value: headerValue };
    let decoded;
    try {
      decoded = atob(match[1].trim());
    } catch {
      return { value: headerValue };
    }
    const colon = decoded.indexOf(":");
    if (colon < 0) return { value: headerValue };
    let user = decoded.slice(0, colon);
    let pass = decoded.slice(colon + 1);
    let touched = false;
    for (const [maskedValue, ms] of this.maskedToSecret) {
      if (user.includes(maskedValue) || pass.includes(maskedValue)) {
        if (!matchesDomains(hostname, ms.domains)) {
          return { value: headerValue, forbidden: { secretName: ms.name, hostname } };
        }
        if (user.includes(maskedValue)) user = user.split(maskedValue).join(ms.realValue);
        if (pass.includes(maskedValue)) pass = pass.split(maskedValue).join(ms.realValue);
        touched = true;
      }
    }
    if (!touched) return { value: headerValue };
    return { value: `Basic ${btoa(`${user}:${pass}`)}` };
  }
  extractAndUnmaskUrlCredentials(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { url: rawUrl };
    }
    if (!parsed.username && !parsed.password) return { url: rawUrl };
    let user = decodeURIComponent(parsed.username);
    let pass = decodeURIComponent(parsed.password);
    const host = parsed.host;
    let touched = false;
    for (const [maskedValue, ms] of this.maskedToSecret) {
      if (user.includes(maskedValue) || pass.includes(maskedValue)) {
        if (!matchesDomains(host, ms.domains)) {
          return { url: rawUrl, forbidden: { secretName: ms.name, hostname: host } };
        }
        if (user.includes(maskedValue)) {
          user = user.split(maskedValue).join(ms.realValue);
          touched = true;
        }
        if (pass.includes(maskedValue)) {
          pass = pass.split(maskedValue).join(ms.realValue);
          touched = true;
        }
      }
    }
    const synthetic = touched && (user || pass) ? `Basic ${btoa(`${user}:${pass}`)}` : void 0;
    parsed.username = "";
    parsed.password = "";
    return { url: parsed.toString(), syntheticAuthorization: synthetic };
  }
  
  unmaskHeaders(headers, hostname) {
    for (const [key, val] of Object.entries(headers)) {
      if (key.toLowerCase() === "authorization" && /^Basic\s/i.test(val)) {
        const basic = this.unmaskAuthorizationBasic(val, hostname);
        if (basic.forbidden) return { forbidden: basic.forbidden };
        headers[key] = basic.value;
        continue;
      }
      const { text, forbidden } = this.unmask(val, hostname);
      if (forbidden) return { forbidden };
      headers[key] = text;
    }
    return {};
  }
  
  async signHmac(spec, body, hostname, now = Date.now) {
    const sep = spec.indexOf(":");
    if (sep < 0) return {};
    const secretName = spec.slice(0, sep).trim();
    const rest = spec.slice(sep + 1);
    const sep2 = rest.indexOf(":");
    const headerName = (sep2 < 0 ? rest : rest.slice(0, sep2)).trim();
    const timestampHeader = sep2 < 0 ? void 0 : rest.slice(sep2 + 1).trim();
    if (!secretName || !headerName) return {};
    if (timestampHeader === "") return {};
    const ms = this.byName.get(secretName);
    if (!ms) {
      console.warn(`[slicc:secrets] signHmac: no secret named "${secretName}"`);
      return {};
    }
    if (!matchesDomains(hostname, ms.domains)) {
      return { forbidden: { secretName: ms.name, hostname } };
    }
    if (timestampHeader) {
      const timestampValue = String(Math.floor(now() / 1e3));
      const message = new Uint8Array(body.length + timestampValue.length + 1);
      message.set(new TextEncoder().encode(`${timestampValue}.`), 0);
      message.set(body, timestampValue.length + 1);
      const signatureHex2 = await hmacSha256Hex(ms.realValue, message);
      return { headerName, signatureHex: signatureHex2, timestampHeaderName: timestampHeader, timestampValue };
    }
    const signatureHex = await hmacSha256Hex(ms.realValue, body);
    return { headerName, signatureHex };
  }
  unmaskBodyBytes(body, hostname) {
    let out = body;
    const enc = new TextEncoder();
    for (const [maskedValue, ms] of this.maskedToSecret) {
      if (!matchesDomains(hostname, ms.domains)) continue;
      const needle = enc.encode(maskedValue);
      const replacement = enc.encode(ms.realValue);
      out = replaceAllBytes(out, needle, replacement);
    }
    return { bytes: out };
  }
  scrubResponse(text) {
    return this.scrubber(text);
  }
  scrubResponseBytes(bytes) {
    let out = bytes;
    const enc = new TextEncoder();
    for (const [maskedValue, ms] of this.maskedToSecret) {
      const needle = enc.encode(ms.realValue);
      const replacement = enc.encode(maskedValue);
      out = replaceAllBytes(out, needle, replacement);
    }
    return out;
  }
  scrubHeaders(headers) {
    const out = {};
    headers.forEach((v, k) => {
      out[k] = this.scrubber(v);
    });
    return out;
  }
  
  redactForExport(texts) {
    const base = this.exportPairs.length;
    const markers = this.exportPairs.map((pair, index) => ({
      values: [pair.realValue, pair.maskedValue].filter(Boolean),
      marker: `\u27E6REDACTED:known-secret:k${index + 1}\u27E7`
    }));
    const shortMarkers = this.exportShortPairs.map((pair, index) => ({
      values: [pair.realValue],
      marker: `\u27E6REDACTED:known-secret:k${base + index + 1}\u27E7`
    }));
    const allMarkers = [...markers, ...shortMarkers];
    let redactionCount = 0;
    return {
      texts: texts.map((input) => {
        let output = input;
        for (const { values, marker } of allMarkers) {
          for (const value of values) {
            const occurrences = output.split(value).length - 1;
            redactionCount += occurrences;
            output = output.replaceAll(value, marker);
          }
        }
        return output;
      }),
      redactionCount
    };
  }
};

var SessionSecretStore = class {
  entries =  new Map();
  
  set(name, value, domains = []) {
    this.entries.set(name, { name, value, domains: [...domains] });
  }
  
  get(name) {
    return this.entries.get(name)?.value;
  }
  
  getRecord(name) {
    const r = this.entries.get(name);
    return r ? { name: r.name, value: r.value, domains: [...r.domains] } : void 0;
  }
  has(name) {
    return this.entries.has(name);
  }
  
  setDomains(name, domains) {
    const r = this.entries.get(name);
    if (!r) return false;
    r.domains = [...domains];
    return true;
  }
  delete(name) {
    return this.entries.delete(name);
  }
  
  listAll() {
    return Array.from(this.entries.values()).map((r) => ({
      name: r.name,
      value: r.value,
      domains: [...r.domains]
    }));
  }
  
  list() {
    return Array.from(this.entries.values()).map((r) => ({
      name: r.name,
      domains: [...r.domains]
    }));
  }
  size() {
    return this.entries.size;
  }
};
function previewSecret(value, edge = 4) {
  const len = value.length;
  if (len === 0) return "";
  if (len <= 2) return "\u2026";
  const e = Math.min(Math.max(1, edge), Math.floor((len - 1) / 2));
  return `${value.slice(0, e)}\u2026${value.slice(len - e)}`;
}

var CHUNK_SIZE = 32768;
function nodeBuffer() {
  return globalThis.Buffer;
}
var STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})?$/;
function base64ToUint8(b64) {
  const B = nodeBuffer();
  if (B) {
    if (!STRICT_BASE64_RE.test(b64)) {
      throw new Error("Invalid base64 string");
    }
    return new Uint8Array(B.from(b64, "base64"));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
function uint8ToBase64(bytes) {
  const B = nodeBuffer();
  if (B) {
    return B.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.byteLength));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

var SIGNED_ALGORITHM = "AWS4-HMAC-SHA256";
var EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
function hex(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}
async function sha256(data) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return hex(digest);
}
async function hmacSha2562(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}
function ymd(d) {
  const pad = (n) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}
function iso8601(d) {
  const pad = (n) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
function canonicalUri(url) {
  const segments = url.pathname.split("/");
  const encoded = segments.map(
    (s) => encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    )
  );
  const path = encoded.join("/");
  return path === "" ? "/" : path;
}
function canonicalQuery(url) {
  const params = [];
  for (const [k, v] of url.searchParams.entries()) {
    params.push([k, v]);
  }
  params.sort(
    ([ak, av], [bk, bv]) => ak === bk ? av < bv ? -1 : av > bv ? 1 : 0 : ak < bk ? -1 : 1
  );
  return params.map(
    ([k, v]) => `${encodeURIComponent(k).replace(/\+/g, "%20")}=${encodeURIComponent(v).replace(/\+/g, "%20")}`
  ).join("&");
}
function canonicalHeaders(headers) {
  const entries = Object.entries(headers).map(
    ([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]
  );
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const canonical = entries.map(([k, v]) => `${k}:${v}
`).join("");
  const signed = entries.map(([k]) => k).join(";");
  return { canonical, signed };
}
async function signSigV4(req, creds, region, service = "s3", now =  new Date()) {
  const date = ymd(now);
  const dateTime = iso8601(now);
  const bodyBytes = req.body ?? new Uint8Array(0);
  const bodyHash = bodyBytes.byteLength === 0 ? EMPTY_BODY_HASH : await sha256(bodyBytes);
  const headers = {
    ...req.headers,
    host: req.headers.host ?? req.headers.Host ?? req.url.host,
    "x-amz-date": dateTime
  };
  if (service === "s3") {
    headers["x-amz-content-sha256"] = bodyHash;
  }
  if (creds.sessionToken) {
    headers["x-amz-security-token"] = creds.sessionToken;
  }
  delete headers.Host;
  const { canonical: canonicalHeadersStr, signed: signedHeaders } = canonicalHeaders(headers);
  const canonicalRequest = [
    req.method,
    canonicalUri(req.url),
    canonicalQuery(req.url),
    canonicalHeadersStr,
    signedHeaders,
    bodyHash
  ].join("\n");
  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    SIGNED_ALGORITHM,
    dateTime,
    credentialScope,
    await sha256(new TextEncoder().encode(canonicalRequest))
  ].join("\n");
  const kDate = await hmacSha2562(new TextEncoder().encode(`AWS4${creds.secretAccessKey}`), date);
  const kRegion = await hmacSha2562(kDate, region);
  const kService = await hmacSha2562(kRegion, service);
  const kSigning = await hmacSha2562(kService, "aws4_request");
  const signature = hex(await hmacSha2562(kSigning, stringToSign));
  const authorization = `${SIGNED_ALGORITHM} Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    ...req,
    headers: {
      ...headers,
      Authorization: authorization
    }
  };
}

var ALLOWED_METHODS = ["GET", "PUT", "POST", "DELETE", "HEAD"];
var PROFILE_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
var HOP_BY_HOP =  new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
var DA_ORIGIN = "https://admin.da.live";
var DA_ALLOWED_ORIGINS =  new Set([DA_ORIGIN, "https://api.aem.live"]);
function isAllowedMethod(m) {
  return typeof m === "string" && ALLOWED_METHODS.includes(m);
}
var ProfileNotConfiguredError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ProfileNotConfiguredError";
  }
};
async function resolveS3Profile(name, store) {
  const accessKeyId = await store.get(`s3.${name}.access_key_id`);
  const secretAccessKey = await store.get(`s3.${name}.secret_access_key`);
  if (!accessKeyId) {
    throw new ProfileNotConfiguredError(
      `profile '${name}' missing required field 'access_key_id'. Set it via: secret set s3.${name}.access_key_id <value>`
    );
  }
  if (!secretAccessKey) {
    throw new ProfileNotConfiguredError(
      `profile '${name}' missing required field 'secret_access_key'. Set it via: secret set s3.${name}.secret_access_key <value>`
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: await store.get(`s3.${name}.session_token`),
    region: await store.get(`s3.${name}.region`) ?? "us-east-1",
    endpoint: await store.get(`s3.${name}.endpoint`),
    pathStyle: await store.get(`s3.${name}.path_style`) === "true"
  };
}
function buildS3Url(profile, bucket, key, query) {
  let host;
  if (profile.endpoint) {
    try {
      host = new URL(profile.endpoint).host;
    } catch {
      throw new Error(`profile endpoint is not a valid URL: ${profile.endpoint}`);
    }
  } else {
    host = `s3.${profile.region}.amazonaws.com`;
  }
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const encodedBucket = encodeURIComponent(bucket);
  const pathPart = profile.pathStyle ? `${encodedBucket}/${encodedKey}` : encodedKey;
  const hostPart = profile.pathStyle ? host : `${encodedBucket}.${host}`;
  const url = new URL(`https://${hostPart}/${pathPart}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  return url;
}
function passthroughHeaders(upstream) {
  const out = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      out[key] = value;
    }
  });
  return out;
}
async function executeS3SignAndForward(env, store, fetchImpl = fetch) {
  if (typeof env?.profile !== "string" || env.profile.length === 0 || !PROFILE_NAME_REGEX.test(env.profile)) {
    return {
      ok: false,
      error: "invalid profile name (allowed: alphanumeric, dot, underscore, hyphen)",
      errorCode: "invalid_profile"
    };
  }
  if (!isAllowedMethod(env.method)) {
    return { ok: false, error: "invalid method", errorCode: "invalid_request" };
  }
  if (typeof env.bucket !== "string" || env.bucket.length === 0) {
    return { ok: false, error: "invalid bucket", errorCode: "invalid_request" };
  }
  if (typeof env.key !== "string") {
    return { ok: false, error: "invalid key", errorCode: "invalid_request" };
  }
  let profile;
  try {
    profile = await resolveS3Profile(env.profile, store);
  } catch (err) {
    if (err instanceof ProfileNotConfiguredError) {
      return { ok: false, error: err.message, errorCode: "profile_not_configured" };
    }
    throw err;
  }
  let url;
  try {
    url = buildS3Url(profile, env.bucket, env.key, env.query);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "failed to build URL",
      errorCode: "invalid_request"
    };
  }
  const body = typeof env.bodyBase64 === "string" && env.bodyBase64.length > 0 ? base64ToUint8(env.bodyBase64) : void 0;
  const signed = await signSigV4(
    {
      method: env.method,
      url,
      headers: { ...env.headers ?? {}, Host: url.host },
      body
    },
    {
      accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.secretAccessKey,
      sessionToken: profile.sessionToken
    },
    profile.region,
    "s3"
  );
  let upstream;
  try {
    upstream = await fetchImpl(url.toString(), {
      method: signed.method,
      headers: signed.headers,
      body: signed.body
    });
  } catch (err) {
    return {
      ok: false,
      error: `S3 fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "fetch_failed"
    };
  }
  const upstreamBody = new Uint8Array(await upstream.arrayBuffer());
  return {
    ok: true,
    status: upstream.status,
    headers: passthroughHeaders(upstream),
    bodyBase64: uint8ToBase64(upstreamBody)
  };
}
async function executeDaSignAndForward(env, fetchImpl = fetch) {
  if (typeof env?.imsToken !== "string" || env.imsToken.length === 0) {
    return { ok: false, error: "imsToken is required", errorCode: "invalid_request" };
  }
  if (!isAllowedMethod(env.method)) {
    return { ok: false, error: "invalid method", errorCode: "invalid_request" };
  }
  if (typeof env.path !== "string" || !env.path.startsWith("/")) {
    return {
      ok: false,
      error: "path must be a string starting with /",
      errorCode: "invalid_request"
    };
  }
  const origin = env.origin ?? DA_ORIGIN;
  if (!DA_ALLOWED_ORIGINS.has(origin)) {
    return {
      ok: false,
      error: `origin '${origin}' is not an allowed DA upstream`,
      errorCode: "invalid_request"
    };
  }
  let url;
  try {
    url = new URL(origin + env.path);
    if (env.query) {
      for (const [k, v] of Object.entries(env.query)) {
        url.searchParams.set(k, v);
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "failed to build URL",
      errorCode: "invalid_request"
    };
  }
  const body = typeof env.bodyBase64 === "string" && env.bodyBase64.length > 0 ? base64ToUint8(env.bodyBase64) : void 0;
  let upstream;
  try {
    upstream = await fetchImpl(url.toString(), {
      method: env.method,
      headers: {
        ...env.headers ?? {},
        Authorization: `Bearer ${env.imsToken}`
      },
      body
    });
  } catch (err) {
    return {
      ok: false,
      error: `DA fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "fetch_failed"
    };
  }
  const upstreamBody = new Uint8Array(await upstream.arrayBuffer());
  return {
    ok: true,
    status: upstream.status,
    headers: passthroughHeaders(upstream),
    bodyBase64: uint8ToBase64(upstreamBody)
  };
}

var DOMAINS_SUFFIX = "_DOMAINS";
function parseDomainsCsv(raw) {
  return raw.split(",").map((domain) => domain.trim()).filter((domain) => domain.length > 0);
}
function pairEnvEntriesToSecrets(entries) {
  const values =  new Map();
  const domains =  new Map();
  const order = [];
  for (const entry of entries) {
    if (entry.key.endsWith(DOMAINS_SUFFIX)) {
      const name = entry.key.slice(0, -DOMAINS_SUFFIX.length);
      if (name) domains.set(name, parseDomainsCsv(entry.value));
    } else {
      if (!values.has(entry.key)) order.push(entry.key);
      values.set(entry.key, entry.value);
    }
  }
  return order.flatMap((name) => {
    const value = values.get(name);
    const allowedDomains = domains.get(name);
    return value !== void 0 && allowedDomains?.length ? [{ name, value, domains: allowedDomains }] : [];
  });
}

var LEADER_EXT_ID_QUERY_NAME = "ext";

function parseLinkHeader(input, baseUrl) {
  if (input == null) return [];
  let headerString;
  if (Array.isArray(input)) {
    headerString = input.join(", ").replace(/\n/g, ", ");
  } else if (typeof input === "string") {
    headerString = input.replace(/\n/g, ", ");
  } else {
    return [];
  }
  if (headerString.length === 0) return [];
  const out = [];
  const len = headerString.length;
  let i = 0;
  while (i < len) {
    i = skipOWS(headerString, i);
    if (i >= len) break;
    if (headerString[i] !== "<") {
      i = skipToNextValue(headerString, i);
      continue;
    }
    const uriEnd = headerString.indexOf(">", i + 1);
    if (uriEnd === -1) break;
    const rawUri = headerString.slice(i + 1, uriEnd);
    i = uriEnd + 1;
    const rawParams = [];
    while (i < len) {
      i = skipOWS(headerString, i);
      if (i >= len) break;
      if (headerString[i] === ",") {
        i++;
        break;
      }
      if (headerString[i] !== ";") {
        i = skipToNextValue(headerString, i);
        break;
      }
      i++;
      i = skipOWS(headerString, i);
      const nameStart = i;
      while (i < len && isTokenChar(headerString.charCodeAt(i))) i++;
      if (i < len && headerString[i] === "*") i++;
      if (nameStart === i) {
        i = skipToNextValue(headerString, i);
        break;
      }
      const name = headerString.slice(nameStart, i).toLowerCase();
      i = skipOWS(headerString, i);
      let value = "";
      if (i < len && headerString[i] === "=") {
        i++;
        i = skipOWS(headerString, i);
        if (i < len && headerString[i] === '"') {
          const r = readQuotedString(headerString, i);
          value = r.value;
          i = r.end;
        } else {
          const start = i;
          while (i < len && headerString[i] !== ";" && headerString[i] !== "," && !isOWSChar(headerString[i]))
            i++;
          value = headerString.slice(start, i);
        }
      }
      rawParams.push([name, value]);
    }
    const link = buildLink(rawUri, rawParams, baseUrl);
    if (link) out.push(link);
  }
  return out;
}
function skipOWS(s, i) {
  while (i < s.length && (s[i] === " " || s[i] === "	")) i++;
  return i;
}
function isOWSChar(c) {
  return c === " " || c === "	";
}
function skipToNextValue(s, i) {
  let inQuote = false;
  while (i < s.length) {
    const c = s[i];
    if (inQuote) {
      if (c === "\\" && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (c === '"') inQuote = false;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ",") return i + 1;
    }
    i++;
  }
  return i;
}
function readQuotedString(s, i) {
  i++;
  let result = "";
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i++;
      if (i < s.length) {
        result += s[i];
        i++;
      }
    } else if (c === '"') {
      return { value: result, end: i + 1 };
    } else {
      result += c;
      i++;
    }
  }
  return { value: result, end: i };
}
function isTokenChar(code) {
  if (code >= 48 && code <= 57) return true;
  if (code >= 65 && code <= 90) return true;
  if (code >= 97 && code <= 122) return true;
  switch (code) {
    case 33:

    case 35:

    case 36:

    case 37:

    case 38:

    case 39:

    case 42:

    case 43:

    case 45:

    case 46:

    case 94:

    case 95:

    case 96:

    case 124:

    case 126:
      return true;
  }
  return false;
}
function buildLink(rawUri, rawParams, baseUrl) {
  const params = {};
  const extOverrides = {};
  for (const [name, value] of rawParams) {
    if (name.endsWith("*")) {
      const decoded = decodeExtValue(value);
      if (decoded != null) extOverrides[name.slice(0, -1)] = decoded;
      continue;
    }
    if (name === "rel" && "rel" in params) continue;
    params[name] = value;
  }
  for (const [name, value] of Object.entries(extOverrides)) {
    params[name] = value;
  }
  const href = resolveURI(rawUri, baseUrl);
  const anchor = params.anchor != null ? resolveURI(params.anchor, baseUrl) : void 0;
  const relRaw = params.rel ?? "";
  const rel = relRaw.split(/[ \t]+/).filter((s) => s.length > 0);
  const link = { href, rel, params };
  if (anchor != null) link.anchor = anchor;
  if (params.type != null) link.type = params.type;
  if (params.title != null) link.title = params.title;
  if (params.hreflang != null) link.hreflang = params.hreflang;
  return link;
}
function resolveURI(ref, baseUrl) {
  if (!baseUrl) return ref;
  try {
    return new URL(ref, baseUrl).toString();
  } catch {
    return ref;
  }
}
function decodeExtValue(value) {
  const firstQuote = value.indexOf("'");
  if (firstQuote === -1) return null;
  const secondQuote = value.indexOf("'", firstQuote + 1);
  if (secondQuote === -1) return null;
  const charset = value.slice(0, firstQuote).toLowerCase();
  if (charset !== "utf-8") return null;
  try {
    return decodeURIComponent(value.slice(secondQuote + 1));
  } catch {
    return null;
  }
}
function getLinkHeaderValuesFromWebRequest(headers) {
  if (!headers) return [];
  const out = [];
  for (const h of headers) {
    if (h.name.toLowerCase() !== "link") continue;
    if (typeof h.value === "string" && h.value.length > 0) out.push(h.value);
  }
  return out;
}

var HANDOFF_REL = `${SLICC_HOSTED_ORIGIN}/rel/handoff`;
var UPSKILL_REL = `${SLICC_HOSTED_ORIGIN}/rel/upskill`;
function canonicaliseUpskillPath(raw) {
  const trimmed = raw.replace(/\/+$/, "");
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("/skill.md")) return trimmed.slice(0, -"/skill.md".length);
  if (lower === "skill.md") return "";
  return trimmed;
}
var SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
var SAFE_PATH_RE = /^[A-Za-z0-9._/-]+$/;
var MAX_BRANCH_LEN = 250;
var MAX_PATH_LEN = 1024;
function isSafeUpskillBranch(value) {
  if (value.length === 0 || value.length > MAX_BRANCH_LEN) return false;
  if (!SAFE_BRANCH_RE.test(value)) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) return false;
  if (value.includes("..")) return false;
  if (value.endsWith(".lock")) return false;
  return true;
}
function isSafeUpskillPath(value) {
  if (value.length === 0 || value.length > MAX_PATH_LEN) return false;
  if (!SAFE_PATH_RE.test(value)) return false;
  if (value.startsWith("-") || value.startsWith("/")) return false;
  if (value.includes("..")) return false;
  return true;
}
function applyUpskillParams(result, params) {
  const branch = params.branch;
  if (typeof branch === "string" && isSafeUpskillBranch(branch)) result.branch = branch;
  const pathParam = params.path;
  if (typeof pathParam === "string" && pathParam.length > 0) {
    const canon = canonicaliseUpskillPath(pathParam);
    if (canon.length > 0 && isSafeUpskillPath(canon)) result.path = canon;
  }
}
function extractHandoff(links) {
  for (const link of links) {
    if (link.rel.includes(HANDOFF_REL)) {
      const result = { verb: "handoff", target: link.href };
      if (link.title != null && link.title.length > 0) result.instruction = link.title;
      return result;
    }
    if (link.rel.includes(UPSKILL_REL)) {
      const result = { verb: "upskill", target: link.href };
      if (link.title != null && link.title.length > 0) result.instruction = link.title;
      applyUpskillParams(result, link.params);
      return result;
    }
  }
  return null;
}
function handoffFingerprint(input) {
  return [
    input.verb,
    input.target,
    input.branch ?? "",
    input.path ?? "",
    input.instruction ?? ""
  ].join("\0");
}
function extractHandoffFromWebRequest(headers, baseUrl) {
  const values = getLinkHeaderValuesFromWebRequest(headers);
  if (values.length === 0) return { match: null, links: [] };
  const links = parseLinkHeader(values, baseUrl);
  return { match: extractHandoff(links), links };
}

var EXTENSION_BRIDGE_PROTOCOL_VERSION = 1;
var EXTENSION_BRIDGE_PORT_NAME = "slicc.cdp-bridge";
var KINDS =  new Set([
  "handshake.hello",
  "handshake.welcome",
  "handshake.rejected",
  "cdp.request",
  "cdp.response",
  "cdp.event",
  "extension.lick",
  "extension.discovery",
  "leader.join-url",
  "extension.open-settings"
]);
function isExtensionBridgeEnvelope(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = value;
  return v.bridge === EXTENSION_BRIDGE_PROTOCOL_VERSION && typeof v.channelId === "string" && typeof v.kind === "string" && KINDS.has(v.kind);
}
function isBridgeVersionMismatch(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = value;
  return typeof v.bridge === "number" && v.bridge !== EXTENSION_BRIDGE_PROTOCOL_VERSION && typeof v.channelId === "string" && typeof v.kind === "string";
}

var LEADER_TAB_ID_KEY = "slicc_leader_tab_id";
var BRIDGE_ALLOWED_ORIGINS = [SLICC_HOSTED_ORIGIN];
function senderUrlIsLeaderTab(rawUrl) {
  if (!rawUrl) return false;
  try {
    return new URL(rawUrl).searchParams.get("slicc") === "leader";
  } catch {
    return false;
  }
}
async function validateBridgePin(sender, deps) {
  const allowed = deps.allowedOrigins ?? BRIDGE_ALLOWED_ORIGINS;
  if (!sender) return { ok: false, reason: "no-sender" };
  if (!sender.origin || !allowed.includes(sender.origin)) {
    return { ok: false, reason: "origin-not-allowed" };
  }
  const senderTabId = sender.tab?.id;
  if (typeof senderTabId !== "number") {
    return { ok: false, reason: "no-sender-tab" };
  }
  if (sender.frameId !== 0) {
    return { ok: false, reason: "not-top-frame" };
  }
  const storedTabId = await deps.readStoredLeaderTabId();
  if (storedTabId === void 0) {
    if (senderUrlIsLeaderTab(sender.url) && deps.writeStoredLeaderTabId) {
      await deps.writeStoredLeaderTabId(senderTabId);
      return { ok: true };
    }
    return { ok: false, reason: "leader-tab-not-pinned" };
  }
  if (storedTabId !== senderTabId) {
    return { ok: false, reason: "sender-tab-not-leader" };
  }
  return { ok: true };
}
var welcomedLeaderPorts =  new Map();
var liveBridgePortStates =  new Map();
function invalidatePortDebuggerAttachment(state2, tabId) {
  state2.ownedTabs.delete(tabId);
  state2.attachRefCounts.delete(tabId);
  for (const [sessionId, attachedTabId] of state2.sessionToTab) {
    if (attachedTabId === tabId) state2.sessionToTab.delete(sessionId);
  }
}
function notifyBridgeDebuggerDetached(tabId) {
  for (const [port, state2] of liveBridgePortStates) {
    const detachedSessionIds = [...state2.sessionToTab].filter(([, attachedTabId]) => attachedTabId === tabId).map(([sessionId]) => sessionId);
    invalidatePortDebuggerAttachment(state2, tabId);
    if (state2.channelId === null) continue;
    for (const sessionId of detachedSessionIds) {
      try {
        port.postMessage({
          bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
          channelId: state2.channelId,
          kind: "cdp.event",
          method: "Target.detachedFromTarget",
          params: { sessionId, targetId: String(tabId) }
        });
      } catch {
      }
    }
  }
}
function postLickToWelcomedLeaderPorts(lick) {
  let delivered = 0;
  for (const [port, channelId] of welcomedLeaderPorts) {
    try {
      port.postMessage({
        ...lick,
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId
      });
      delivered += 1;
    } catch {
    }
  }
  return delivered;
}
function postOpenSettingsToWelcomedLeaderPorts() {
  let delivered = 0;
  for (const [port, channelId] of welcomedLeaderPorts) {
    try {
      port.postMessage({
        kind: "extension.open-settings",
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId
      });
      delivered += 1;
    } catch {
    }
  }
  return delivered;
}
function postDiscoveryToWelcomedLeaderPorts(discovery) {
  let delivered = 0;
  for (const [port, channelId] of welcomedLeaderPorts) {
    try {
      port.postMessage({
        ...discovery,
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId
      });
      delivered += 1;
    } catch {
    }
  }
  return delivered;
}
async function readStoredLeaderTabIdFromSession() {
  try {
    const result = await chrome.storage.session.get(LEADER_TAB_ID_KEY);
    const raw = result[LEADER_TAB_ID_KEY];
    return typeof raw === "number" ? raw : void 0;
  } catch {
    return void 0;
  }
}
async function writeStoredLeaderTabIdToSession(tabId) {
  try {
    await chrome.storage.session.set({ [LEADER_TAB_ID_KEY]: tabId });
  } catch {
  }
}
function buildDefaultBridgeSwDeps(overrides) {
  const base = {
    readStoredLeaderTabId: readStoredLeaderTabIdFromSession,
    writeStoredLeaderTabId: writeStoredLeaderTabIdToSession,
    maybeUnmaskCdpFrame: async (_tabId, _method, params) => params,
    attachDebugger: async (tabId) => {
      await chrome.debugger.attach({ tabId }, "1.3");
      return true;
    },
    detachDebugger: async (tabId) => {
      await chrome.debugger.detach({ tabId }).catch(() => {
      });
    },
    sendDebuggerCommand: async (tabId, method, params) => {
      const result = await chrome.debugger.sendCommand({ tabId }, method, params);
      return result ?? {};
    },
    subscribeDebuggerEvents: (handler) => {
      const wrapped = (source, method, params) => handler(source.tabId, method, params);
      chrome.debugger.onEvent.addListener(wrapped);
      return () => chrome.debugger.onEvent.removeListener(wrapped);
    },
    queryTabs: () => chrome.tabs.query({}),
    queryActiveTabId: async () => {
      try {
        const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return typeof t?.id === "number" ? t.id : void 0;
      } catch {
        return void 0;
      }
    },
    getTab: async (tabId) => {
      try {
        return await chrome.tabs.get(tabId);
      } catch {
        return void 0;
      }
    },
    createTab: async (url) => {
      const tab = await chrome.tabs.create({ url, active: false });
      return tab.id;
    },
    removeTab: (tabId) => chrome.tabs.remove(tabId),
    activateTab: async (tabId) => {
      try {
        const tab = await chrome.tabs.update(tabId, { active: true });
        if (typeof tab?.windowId === "number") {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } catch {
      }
    }
  };
  return { ...base, ...overrides ?? {} };
}
async function handleBridgePortConnect(port, deps) {
  if (port.name !== EXTENSION_BRIDGE_PORT_NAME) return;
  const state2 = {
    channelId: null,
    sessionToTab:  new Map(),
    attachRefCounts:  new Map(),
    ownedTabs:  new Set(),
    unsubscribeEvents: null
  };
  let pinned = false;
  let rejected = false;
  const earlyQueue = [];
  const runMessage = (raw) => {
    handleBridgeMessage(port, state2, raw, deps).catch((err) => {
      console.error("[slicc-bridge-sw] handleBridgeMessage threw", err);
    });
  };
  port.onMessage.addListener((raw) => {
    if (rejected) return;
    if (!pinned) {
      earlyQueue.push(raw);
      return;
    }
    runMessage(raw);
  });
  port.onDisconnect.addListener(() => {
    welcomedLeaderPorts.delete(port);
    liveBridgePortStates.delete(port);
    if (state2.unsubscribeEvents) {
      state2.unsubscribeEvents();
      state2.unsubscribeEvents = null;
    }
    for (const tabId of state2.ownedTabs) {
      deps.detachDebugger(tabId).catch(() => {
      });
    }
    state2.ownedTabs.clear();
    state2.sessionToTab.clear();
    state2.attachRefCounts.clear();
  });
  const pin = await validateBridgePin(port.sender, deps);
  if (!pin.ok) {
    rejected = true;
    try {
      port.postMessage({
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId: "rejected",
        kind: "handshake.rejected",
        reason: pin.reason ?? "pin-failed"
      });
    } catch {
    }
    try {
      port.disconnect();
    } catch {
    }
    return;
  }
  pinned = true;
  for (const raw of earlyQueue) runMessage(raw);
  earlyQueue.length = 0;
}
async function handleBridgeMessage(port, state2, raw, deps) {
  if (isBridgeVersionMismatch(raw)) {
    console.warn("[slicc-bridge-sw] bridge protocol version mismatch \u2014 update the older side", {
      peerVersion: raw.bridge,
      ourVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION
    });
    try {
      port.postMessage({
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId: raw.channelId,
        kind: "handshake.rejected",
        reason: "version-mismatch"
      });
      port.disconnect();
    } catch {
    }
    return;
  }
  if (!isExtensionBridgeEnvelope(raw)) return;
  const env = raw;
  if (state2.channelId === null) {
    if (env.kind !== "handshake.hello") {
      port.postMessage({
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId: env.channelId,
        kind: "handshake.rejected",
        reason: "expected-hello-first"
      });
      try {
        port.disconnect();
      } catch {
      }
      return;
    }
    state2.channelId = env.channelId;
    liveBridgePortStates.set(port, state2);
    state2.unsubscribeEvents = deps.subscribeDebuggerEvents((tabId, method, params) => {
      let sessionId;
      for (const [sid, tid] of state2.sessionToTab) {
        if (tid === tabId) {
          sessionId = sid;
          break;
        }
      }
      if (sessionId === void 0) return;
      const channelId = state2.channelId;
      if (channelId === null) return;
      try {
        port.postMessage({
          bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
          channelId,
          kind: "cdp.event",
          method,
          params,
          sessionId
        });
      } catch {
      }
    });
    port.postMessage({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: state2.channelId,
      kind: "handshake.welcome"
    });
    welcomedLeaderPorts.set(port, state2.channelId);
    return;
  }
  if (env.kind === "leader.join-url") {
    if (env.channelId !== state2.channelId) return;
    deps.onLeaderJoinUrl?.(env.joinUrl);
    return;
  }
  if (env.kind !== "cdp.request") return;
  if (env.channelId !== state2.channelId) return;
  const id = env.id;
  try {
    const result = await dispatchCdpCommand(env, state2, deps);
    port.postMessage({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: state2.channelId,
      kind: "cdp.response",
      id,
      result
    });
  } catch (err) {
    port.postMessage({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: state2.channelId,
      kind: "cdp.response",
      id,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
async function dispatchCdpCommand(req, state2, deps) {
  const { method, params, sessionId } = req;
  if (method === "Target.getTargets") return cdpGetTargets(state2, deps);
  if (method === "Target.attachToTarget") return cdpAttachToTarget(params ?? {}, state2, deps);
  if (method === "Target.detachFromTarget") return cdpDetachFromTarget(params ?? {}, state2, deps);
  if (method === "Target.createTarget") return cdpCreateTarget(params ?? {}, deps);
  if (method === "Target.closeTarget") return cdpCloseTarget(params ?? {}, state2, deps);
  const tabId = sessionId !== void 0 ? state2.sessionToTab.get(sessionId) : void 0;
  if (tabId === void 0) {
    throw new Error(
      `No tab attached for sessionId: ${sessionId ?? "(none)"}. Attach to a target first.`
    );
  }
  if (method === "Page.bringToFront") {
    await deps.activateTab(tabId);
  }
  const effectiveParams = await deps.maybeUnmaskCdpFrame(tabId, method, params);
  return deps.sendDebuggerCommand(tabId, method, effectiveParams);
}
async function cdpGetTargets(_state, deps) {
  const [tabs, activeId] = await Promise.all([deps.queryTabs(), deps.queryActiveTabId()]);
  const targetInfos = tabs.filter((t) => typeof t.id === "number").map((t) => ({
    targetId: String(t.id),
    type: "page",
    title: t.title ?? "",
    url: t.url ?? "",
    attached: false,
    active: t.id === activeId
  }));
  return { targetInfos };
}
async function cdpAttachToTarget(params, state2, deps) {
  const targetId = params["targetId"];
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error(`Invalid targetId: ${targetId}`);
  }
  if (!state2.ownedTabs.has(tabId)) {
    const attachedByThisPort = await deps.attachDebugger(tabId);
    if (attachedByThisPort) state2.ownedTabs.add(tabId);
  }
  const sessionId = targetId;
  state2.sessionToTab.set(sessionId, tabId);
  state2.attachRefCounts.set(tabId, (state2.attachRefCounts.get(tabId) ?? 0) + 1);
  return { sessionId };
}
async function cdpDetachFromTarget(params, state2, deps) {
  const sessionId = params["sessionId"];
  const tabId = state2.sessionToTab.get(sessionId);
  if (tabId === void 0) return {};
  const nextRefCount = (state2.attachRefCounts.get(tabId) ?? 1) - 1;
  if (nextRefCount > 0) {
    state2.attachRefCounts.set(tabId, nextRefCount);
    return {};
  }
  state2.attachRefCounts.delete(tabId);
  for (const [sid, attachedTabId] of state2.sessionToTab) {
    if (attachedTabId === tabId) state2.sessionToTab.delete(sid);
  }
  if (state2.ownedTabs.has(tabId)) {
    state2.ownedTabs.delete(tabId);
    await deps.detachDebugger(tabId);
  }
  return {};
}
async function cdpCreateTarget(params, deps) {
  const url = params["url"] ?? "about:blank";
  const tabId = await deps.createTab(url);
  return { targetId: String(tabId) };
}
async function cdpCloseTarget(params, state2, deps) {
  const targetId = params["targetId"];
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error(`Invalid targetId: ${targetId}`);
  }
  for (const [sid, tid] of state2.sessionToTab) {
    if (tid === tabId) state2.sessionToTab.delete(sid);
  }
  state2.attachRefCounts.delete(tabId);
  if (state2.ownedTabs.has(tabId)) {
    state2.ownedTabs.delete(tabId);
    await deps.detachDebugger(tabId);
  }
  await deps.removeTab(tabId);
  return { success: true };
}

var CHERRY_PANEL_PORT_NAME = "cherry-panel";

var panelPorts =  new Set();
var state = { kind: "join-url", state: "booting" };
var hasSeenReady = false;
var lastLeaderReloadAt = 0;
var LEADER_RELOAD_COOLDOWN_MS = 15e3;
var STORAGE_KEY = "cherryPanelState";
var loaded = false;
var loadPromise = null;
var recoveryDeps = null;
function setCherryPanelRecoveryDeps(deps) {
  recoveryDeps = deps;
}
function ensureLoaded() {
  loadPromise ??= (async () => {
    try {
      const saved = (await chrome.storage?.session?.get(STORAGE_KEY))?.[STORAGE_KEY];
      if (saved?.state) {
        state = saved.state;
        hasSeenReady = Boolean(saved.hasSeenReady);
        lastLeaderReloadAt = typeof saved.lastLeaderReloadAt === "number" ? saved.lastLeaderReloadAt : 0;
      }
    } catch {
    }
    loaded = true;
  })();
  return loadPromise;
}
function persist() {
  try {
    void chrome.storage?.session?.set({
      [STORAGE_KEY]: { state, hasSeenReady, lastLeaderReloadAt }
    });
  } catch {
  }
}
function broadcast() {
  for (const port of [...panelPorts]) {
    try {
      port.postMessage(state);
    } catch {
      panelPorts.delete(port);
    }
  }
}
function maybeRecoverLeader(now, reload) {
  if (!reload) return;
  if (now - lastLeaderReloadAt < LEADER_RELOAD_COOLDOWN_MS) return;
  lastLeaderReloadAt = now;
  persist();
  void reload();
}
async function handleCherryPanelConnect(port, deps) {
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
  });
  port.onMessage.addListener((raw) => {
    const msg = raw;
    if (msg?.kind === "focus-leader") {
      void deps.focusLeaderTab?.().catch(() => {
      });
      if (msg.openSettings !== false) deps.openSettingsOnLeader?.();
      return;
    }
    if (msg?.kind !== "hello") return;
    if (loaded) {
      panelPorts.add(port);
      port.postMessage(state);
    } else {
      void ensureLoaded().then(() => {
        panelPorts.add(port);
        port.postMessage(state);
      });
    }
  });
  await ensureLoaded();
  const wasDisconnected = state.state === "disconnected";
  const wasTrayGaveUp = wasDisconnected && hasSeenReady;
  if (wasDisconnected) {
    state = { kind: "join-url", state: "booting" };
    persist();
    broadcast();
  }
  await deps.ensureLeaderTab();
  if (wasTrayGaveUp) {
    maybeRecoverLeader(
      Date.now(),
      deps.reloadLeaderTabIfExists ?? recoveryDeps?.reloadLeaderTabIfExists
    );
  }
}
function setCherryPanelJoinUrl(joinUrl) {
  if (joinUrl) {
    state = { kind: "join-url", state: "ready", joinUrl };
    hasSeenReady = true;
  } else if (!hasSeenReady) {
    state = { kind: "join-url", state: "booting" };
  } else {
    state = { kind: "join-url", state: "disconnected" };
    maybeRecoverLeader(Date.now(), recoveryDeps?.reloadLeaderTabIfExists);
  }
  persist();
  broadcast();
}
function broadcastLeaderGone() {
  state = { kind: "join-url", state: "disconnected" };
  hasSeenReady = false;
  persist();
  broadcast();
}

var AI_CATALOG_REL = "ai-catalog";
function extractCatalog(links) {
  for (const link of links) {
    if (link.rel.includes(AI_CATALOG_REL)) {
      return { kind: "ai-catalog", url: link.href };
    }
  }
  return null;
}
function discoveryFingerprint(input) {
  return [input.origin ?? "", input.kind ?? "", input.url ?? ""].join("\0");
}
function extractCatalogFromWebRequest(headers, baseUrl) {
  const values = getLinkHeaderValuesFromWebRequest(headers);
  if (values.length === 0) return { match: null, links: [] };
  const links = parseLinkHeader(values, baseUrl);
  return { match: extractCatalog(links), links };
}

var TARGETS = [
  { kind: "ai-catalog", path: "/.well-known/ai-catalog.json" },
  { kind: "llms-txt", path: "/llms.txt" }
];
var DEFAULT_TIMEOUT_MS = 3e3;
async function probeWellKnown(origin, fetchImpl, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let base;
  try {
    base = new URL(origin).origin;
  } catch {
    return [];
  }
  const settled = await Promise.all(
    TARGETS.map((target) => probeOne(base, target, fetchImpl, timeoutMs))
  );
  return settled.filter((m) => m !== null);
}
async function probeOne(base, target, fetchImpl, timeoutMs) {
  const url = base + target.path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: ctrl.signal,
      redirect: "manual",
      credentials: "omit"
    });
    if (res.status !== 200) return null;
    if (!contentTypeOk(res.headers.get("content-type"), target.kind)) return null;
    return { kind: target.kind, url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function contentTypeOk(raw, kind) {
  if (raw == null) return true;
  const ct = raw.toLowerCase();
  if (ct.length === 0) return true;
  if (ct.includes("text/html") || ct.includes("application/xhtml")) return false;
  if (kind === "ai-catalog") {
    return ct.includes("json") || ct.includes("text/plain") || ct.includes("octet-stream");
  }
  return ct.includes("text/plain") || ct.includes("markdown") || ct.includes("octet-stream");
}

function createDiscoveryObserver(deps) {
  const seenFingerprints =  new Set();
  const probedOrigins =  new Set();
  const forward = (origin, kind, artifactUrl, pageUrl) => {
    const fingerprint = discoveryFingerprint({ origin, kind, url: artifactUrl });
    if (seenFingerprints.has(fingerprint)) return;
    const delivered = deps.emit({
      discoveryOrigin: origin,
      discoveryKind: kind,
      discoveryUrl: artifactUrl,
      url: pageUrl
    });
    if (delivered >= 1) seenFingerprints.add(fingerprint);
  };
  const probeOrigin = async (origin, pageUrl) => {
    if (probedOrigins.has(origin)) return;
    probedOrigins.add(origin);
    try {
      const matches = await probeWellKnown(origin, deps.fetchImpl, {
        timeoutMs: deps.probeTimeoutMs
      });
      for (const match of matches) forward(origin, match.kind, match.url, pageUrl);
    } catch {
    }
  };
  const isEnabled = deps.isEnabled ?? (() => true);
  const onHeaders = (detail) => {
    if (!isEnabled()) return;
    let url;
    try {
      url = new URL(detail.url);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    const origin = url.origin;
    const { match } = extractCatalogFromWebRequest(detail.responseHeaders, detail.url);
    if (match) forward(origin, match.kind, match.url, detail.url);
    void probeOrigin(origin, detail.url);
  };
  return { onHeaders };
}

function decodeForbiddenRequestHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "x-proxy-cookie") {
      result["cookie"] = value;
    } else if (lower === "x-proxy-origin") {
      result["origin"] = value;
    } else if (lower === "x-proxy-referer") {
      result["referer"] = value;
    } else if (lower.startsWith("x-proxy-proxy-")) {
      result[lower.replace(/^x-proxy-/, "")] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

var REQUEST_BODY_CAP = 32 * 1024 * 1024;
function extractSetCookies(headers) {
  const get = headers.getSetCookie;
  if (typeof get === "function") {
    return get.call(headers);
  }
  const joined = headers.get("set-cookie");
  return joined ? [joined] : [];
}
function buildResponseHeaders(scrubbed, upstream, pipeline) {
  const out = {};
  for (const [k, v] of Object.entries(scrubbed)) {
    const lower = k.toLowerCase();
    if (lower === "set-cookie" || lower.startsWith("x-proxy-")) continue;
    out[k] = v;
  }
  const setCookies = extractSetCookies(upstream);
  if (setCookies.length > 0) {
    out["X-Proxy-Set-Cookie"] = pipeline.scrubResponse(JSON.stringify(setCookies));
  }
  return out;
}
function send(port, msg) {
  port.postMessage(msg);
}
var decodeBase64Bytes = base64ToUint8;
var encodeBase64Bytes = uint8ToBase64;
function isForbiddenRequestHeader(name) {
  const lower = name.toLowerCase();
  return lower === "cookie" || lower === "origin" || lower === "referer" || lower.startsWith("proxy-");
}
function getDnr() {
  const c = globalThis.chrome;
  const dnr = c?.declarativeNetRequest;
  if (!dnr || typeof dnr.updateSessionRules !== "function") return null;
  return dnr;
}
var nextDnrRuleId = 1e6;
function randomFragmentToken() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
async function installForbiddenHeaderRule(url, headers) {
  const dnr = getDnr();
  const requestHeaders = [];
  for (const [k, v] of Object.entries(headers)) {
    if (isForbiddenRequestHeader(k)) {
      requestHeaders.push({ header: k.toLowerCase(), operation: "set", value: v });
    }
  }
  if (!dnr || requestHeaders.length === 0) {
    return { fetchUrl: url, cleanup: async () => {
    } };
  }
  const id = nextDnrRuleId++;
  const fragment = `slicc-req-${randomFragmentToken()}`;
  const fetchUrl = `${url.split("#")[0]}#${fragment}`;
  const rule = {
    id,
    priority: 100,
    condition: { urlFilter: fetchUrl, resourceTypes: ["xmlhttprequest"] },
    action: { type: "modifyHeaders", requestHeaders }
  };
  await dnr.updateSessionRules({ addRules: [rule] });
  let removed = false;
  const cleanup = async () => {
    if (removed) return;
    removed = true;
    try {
      await dnr.updateSessionRules({ removeRuleIds: [id] });
    } catch {
    }
  };
  return { fetchUrl, cleanup };
}
async function prepareUpstreamRequest(pipeline, msg) {
  const credsResult = pipeline.extractAndUnmaskUrlCredentials(msg.url);
  if (credsResult.forbidden) {
    return {
      error: `forbidden: ${credsResult.forbidden.secretName} on ${credsResult.forbidden.hostname}`
    };
  }
  const cleanedUrl = credsResult.url;
  const host = new URL(cleanedUrl).host;
  const headers = decodeForbiddenRequestHeaders(msg.headers);
  let hmacSpec;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === HMAC_SIGN_HEADER) {
      hmacSpec = headers[key];
      delete headers[key];
      break;
    }
  }
  const headersResult = pipeline.unmaskHeaders(headers, host);
  if (headersResult.forbidden) {
    return {
      error: `forbidden: ${headersResult.forbidden.secretName} on ${headersResult.forbidden.hostname}`
    };
  }
  if (credsResult.syntheticAuthorization && !("authorization" in headers)) {
    headers.authorization = credsResult.syntheticAuthorization;
  }
  if (!headers.origin) {
    try {
      headers.origin = new URL(cleanedUrl).origin;
    } catch {
    }
  }
  let body;
  if (msg.bodyBase64) {
    body = pipeline.unmaskBodyBytes(decodeBase64Bytes(msg.bodyBase64), host).bytes;
  }
  if (hmacSpec) {
    const signResult = await pipeline.signHmac(hmacSpec, body ?? new Uint8Array(0), host);
    if (signResult.forbidden) {
      return {
        error: `forbidden: ${signResult.forbidden.secretName} on ${signResult.forbidden.hostname}`
      };
    }
    if (signResult.headerName && signResult.signatureHex) {
      headers[signResult.headerName] = signResult.signatureHex;
    }
    if (signResult.timestampHeaderName && signResult.timestampValue) {
      headers[signResult.timestampHeaderName] = signResult.timestampValue;
    }
  }
  return { cleanedUrl, headers, body };
}
async function streamUpstreamResponse(port, pipeline, upstream) {
  const scrubbed = pipeline.scrubHeaders(upstream.headers);
  const respHeaders = buildResponseHeaders(scrubbed, upstream.headers, pipeline);
  send(port, {
    type: "response-head",
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders
  });
  if (upstream.body) {
    const reader = upstream.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const bodyScrubbed = pipeline.scrubResponseBytes(value);
      send(port, { type: "response-chunk", dataBase64: encodeBase64Bytes(bodyScrubbed) });
    }
  }
  send(port, { type: "response-end" });
}
async function processProxyRequest(port, pipeline, msg, signal) {
  try {
    const prepared = await prepareUpstreamRequest(pipeline, msg);
    if ("error" in prepared) {
      send(port, { type: "response-error", error: prepared.error });
      return;
    }
    const { cleanedUrl, headers, body } = prepared;
    const dnrRule = await installForbiddenHeaderRule(cleanedUrl, headers);
    try {
      const upstream = await fetch(dnrRule.fetchUrl, {
        method: msg.method,
        headers,
        body,
        signal
      });
      await streamUpstreamResponse(port, pipeline, upstream);
    } finally {
      await dnrRule.cleanup();
    }
  } catch (err) {
    send(port, {
      type: "response-error",
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
async function handleProxyMessage(port, pipelinePromise, raw, signal) {
  const msg = raw;
  if (msg.type !== "request") return;
  if (msg.requestBodyTooLarge) {
    send(port, {
      type: "response-head",
      status: 413,
      statusText: "Payload Too Large",
      headers: {}
    });
    send(port, { type: "response-end" });
    return;
  }
  let pipeline;
  try {
    pipeline = await pipelinePromise;
  } catch (err) {
    send(port, {
      type: "response-error",
      error: `fetch-proxy init failed: ${err instanceof Error ? err.message : String(err)}`
    });
    return;
  }
  await processProxyRequest(port, pipeline, msg, signal);
}
function handleFetchProxyConnectionAsync(port, pipelinePromise) {
  const ac = new AbortController();
  let started = false;
  port.onDisconnect.addListener(() => ac.abort());
  port.onMessage.addListener((raw) => {
    if (started) return;
    started = true;
    handleProxyMessage(port, pipelinePromise, raw, ac.signal).catch((err) => {
      send(port, {
        type: "response-error",
        error: err instanceof Error ? err.message : String(err)
      });
    });
  });
}

var SILENT_RENEW_TIMEOUT_MS = 1e4;
function buildWebAuthFlowOptions(url, interactive) {
  if (interactive) {
    return { url, interactive: true };
  }
  return {
    url,
    interactive: false,
    abortOnLoadForNonInteractive: false,
    timeoutMsForNonInteractive: SILENT_RENEW_TIMEOUT_MS
  };
}

async function listSecrets(storage) {
  const all = await storage.get(null);
  const entries = pairStorageEntries(all).map(({ name, domains }) => ({ name, domains }));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}
async function setSecret(storage, name, value, domains) {
  await storage.set({
    [name]: value,
    [name + DOMAINS_SUFFIX]: domains.join(",")
  });
}
async function deleteSecret(storage, name) {
  await storage.remove([name, name + DOMAINS_SUFFIX]);
}
async function listSecretsWithValues(storage) {
  const all = await storage.get(null);
  return pairStorageEntries(all);
}
function pairStorageEntries(all) {
  return pairEnvEntriesToSecrets(
    Object.entries(all).flatMap(
      ([key, value]) => typeof value === "string" ? [{ key, value }] : []
    )
  );
}

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var KEY = "_session.id";
async function readOrCreateSwSessionId() {
  const got = await chrome.storage.local.get(KEY);
  const existing = got[KEY];
  if (existing && UUID_RE.test(existing)) return existing;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ [KEY]: fresh });
  return fresh;
}

var LEADER_TAB_ID_KEY2 = "slicc_leader_tab_id";
var PROD_LEADER_TAB_URL = `${SLICC_HOSTED_ORIGIN}/?slicc=leader`;
var PROD_LEADER_TAB_URL_GLOB = `${SLICC_HOSTED_ORIGIN} new Set();
var HANDOFF_NOTIFIED_FINGERPRINTS_KEY = "slicc_handoff_notified_fingerprints";
var HANDOFF_NOTIFIED_FINGERPRINTS_MAX = 100;
var handoffNotifyChain = Promise.resolve();
function queueHandoffNotification(fingerprint, match, url) {
  handoffNotifyChain = handoffNotifyChain.then(() => notifyHandoffOncePerSession(fingerprint, match, url)).catch((err) => {
    console.warn("[slicc-sw] handoff notification dedup failed", err);
  });
}
async function notifyHandoffOncePerSession(fingerprint, match, url) {
  let stored = [];
  let readOk = true;
  try {
    const result = await chrome.storage.session.get(HANDOFF_NOTIFIED_FINGERPRINTS_KEY);
    const value = result[HANDOFF_NOTIFIED_FINGERPRINTS_KEY];
    if (Array.isArray(value)) stored = value.filter((v) => typeof v === "string");
  } catch (err) {
    console.warn("[slicc-sw] handoff fingerprint read failed", err);
    readOk = false;
  }
  for (const seen of stored) notifiedHandoffFingerprints.add(seen);
  if (stored.includes(fingerprint)) return;
  showHandoffNotification(match, url);
  if (!readOk) return;
  stored.push(fingerprint);
  await chrome.storage.session.set({
    [HANDOFF_NOTIFIED_FINGERPRINTS_KEY]: stored.slice(-HANDOFF_NOTIFIED_FINGERPRINTS_MAX)
  });
}
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (_isProtectedUrl(details.url)) return;
    const { match } = extractHandoffFromWebRequest(details.responseHeaders, details.url);
    if (!match) return;
    const fingerprint = handoffFingerprint(match);
    const alreadyNotified = notifiedHandoffFingerprints.has(fingerprint);
    notifiedHandoffFingerprints.add(fingerprint);
    const payload = {
      type: "navigate-lick",
      url: details.url,
      verb: match.verb,
      target: match.target,
      tabId: details.tabId >= 0 ? details.tabId : void 0
    };
    if (match.instruction) payload.instruction = match.instruction;
    if (match.branch) payload.branch = match.branch;
    if (match.path) payload.path = match.path;
    const tabId = details.tabId;
    const dispatch = (title) => {
      if (title) payload.title = title;
      postLickToWelcomedLeaderPorts({
        kind: "extension.lick",
        verb: payload.verb,
        target: payload.target,
        url: payload.url,
        ...payload.instruction ? { instruction: payload.instruction } : {},
        ...payload.branch ? { branch: payload.branch } : {},
        ...payload.path ? { path: payload.path } : {},
        ...payload.title ? { title: payload.title } : {}
      });
      chrome.runtime.sendMessage({ source: "service-worker", payload }).catch(() => {
      });
    };
    if (!alreadyNotified) queueHandoffNotification(fingerprint, match, details.url);
    if (tabId >= 0) {
      chrome.tabs.get(tabId).then((tab) => dispatch(tab.title)).catch(() => dispatch());
    } else {
      dispatch();
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders"]
);
var DISCOVERY_ENABLED_KEY = "slicc_discovery_enabled";
var DISCOVERY_ALLOWED_ORIGINS = false ? [...BRIDGE_ALLOWED_ORIGINS, ...BRIDGE_DEV_ORIGINS] : BRIDGE_ALLOWED_ORIGINS;
var discoveryLoaded = false;
var discoveryEnabled = false;
void chrome.storage.local.get(DISCOVERY_ENABLED_KEY).then((result) => {
  const r = result;
  discoveryEnabled = r[DISCOVERY_ENABLED_KEY] !== false;
  discoveryLoaded = true;
}).catch(() => {
  discoveryEnabled = true;
  discoveryLoaded = true;
});
chrome.storage.onChanged?.addListener?.((changes, area) => {
  if (area !== "local") return;
  const change = changes[DISCOVERY_ENABLED_KEY];
  if (change) {
    discoveryEnabled = change.newValue !== false;
    discoveryLoaded = true;
  }
});
chrome.runtime.onMessageExternal?.addListener?.(
  (message, sender) => {
    if (getMsgType(message) !== "discovery.set-enabled") return false;
    const origin = sender.origin ?? (() => {
      try {
        return new URL(sender.url ?? "").origin;
      } catch {
        return void 0;
      }
    })();
    if (!origin || !DISCOVERY_ALLOWED_ORIGINS.includes(origin)) return false;
    const enabled = message.enabled !== false;
    void chrome.storage.local.set({ [DISCOVERY_ENABLED_KEY]: enabled }).catch(() => {
    });
    return false;
  }
);
var discoveryObserver = createDiscoveryObserver({
  fetchImpl: (url, init) => fetch(url, init),
  emit: (discovery) => postDiscoveryToWelcomedLeaderPorts({ kind: "extension.discovery", ...discovery }),
  isEnabled: () => discoveryLoaded && discoveryEnabled
});
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (_isProtectedUrl(details.url)) return;
    discoveryObserver.onHeaders({
      url: details.url,
      responseHeaders: details.responseHeaders
    });
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["responseHeaders"]
);
var sessionToTab =  new Map();
var debuggerAttachmentOwners =  new Map();
var traySockets =  new Map();
async function acquireDebuggerAttachment(tabId, owner) {
  if (debuggerAttachmentOwners.has(tabId)) return false;
  await chrome.debugger.attach({ tabId }, "1.3");
  debuggerAttachmentOwners.set(tabId, owner);
  return true;
}
async function releaseDebuggerAttachment(tabId, owner) {
  if (debuggerAttachmentOwners.get(tabId) !== owner) return;
  debuggerAttachmentOwners.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {
  });
}
async function forceReleaseDebuggerAttachment(tabId) {
  if (!debuggerAttachmentOwners.has(tabId)) return;
  debuggerAttachmentOwners.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {
  });
}
chrome.runtime.onMessage.addListener(
  (message, _sender, _sendResponse) => {
    if (!isExtMsg(message)) return false;
    const msg = message;
    if (msg.source === "panel") {
      chrome.action.setBadgeText({ text: "" });
      const panelPayload = msg.payload;
      if (panelPayload.type === "oauth-request") {
        const oauthMsg = panelPayload;
        handleOAuthRequest(oauthMsg).then((result) => {
          chrome.runtime.sendMessage({
            source: "service-worker",
            payload: result
          }).catch((e) => {
            console.error("[slicc-sw] Failed to send OAuth result:", e);
          });
        }).catch((err) => {
          chrome.runtime.sendMessage({
            source: "service-worker",
            payload: {
              type: "oauth-result",
              providerId: oauthMsg.providerId,
              error: err instanceof Error ? err.message : String(err)
            }
          }).catch((e) => {
            console.error("[slicc-sw] Failed to send OAuth error:", e);
          });
        });
        return false;
      }
      return false;
    }
    if (msg.source === "offscreen") {
      const payload = msg.payload;
      if (payload.type === "cdp-command") {
        handleCdpCommand(payload).then((response) => {
          chrome.runtime.sendMessage({
            source: "service-worker",
            payload: response
          }).catch(() => {
          });
        }).catch((err) => {
          chrome.runtime.sendMessage({
            source: "service-worker",
            payload: {
              type: "cdp-response",
              id: payload.id,
              error: err instanceof Error ? err.message : String(err)
            }
          }).catch(() => {
          });
        });
        return false;
      }
      if (isTraySocketCommand(payload)) {
        void handleTraySocketCommand(payload).catch((err) => {
          void sendServiceWorkerMessage({
            type: "tray-socket-error",
            id: payload.id,
            error: err instanceof Error ? err.message : String(err)
          });
        });
        return false;
      }
      return false;
    }
    return false;
  }
);
function isExtMsg(msg) {
  return typeof msg === "object" && msg !== null && "source" in msg && "payload" in msg;
}
function isMountSignAndForwardRequest(msg) {
  return typeof msg === "object" && msg !== null && "type" in msg && "envelope" in msg && (msg.type === "mount.s3-sign-and-forward" || msg.type === "mount.da-sign-and-forward");
}
var chromeStorageSecretGetter = {
  async get(key) {
    const result = await chrome.storage.local.get(key);
    const value = result[key];
    return typeof value === "string" ? value : void 0;
  }
};
async function handleMountSignAndForward(msg) {
  if (msg.type === "mount.s3-sign-and-forward") {
    return executeS3SignAndForward(
      msg.envelope,
      chromeStorageSecretGetter
    );
  }
  return executeDaSignAndForward(msg.envelope);
}
chrome.runtime.onMessage.addListener(
  (message, _sender, sendResponse) => {
    if (!isMountSignAndForwardRequest(message)) return false;
    const respondError = (err) => {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        errorCode: "internal"
      });
    };
    try {
      handleMountSignAndForward(message).then((reply) => sendResponse(reply)).catch(respondError);
    } catch (err) {
      respondError(err);
    }
    return true;
  }
);
function isTraySocketCommand(payload) {
  return payload.type === "tray-socket-open" || payload.type === "tray-socket-send" || payload.type === "tray-socket-close";
}
async function handleTraySocketCommand(command) {
  switch (command.type) {
    case "tray-socket-open":
      openTraySocket(command);
      return;
    case "tray-socket-send": {
      const socket = traySockets.get(command.id);
      if (!socket) {
        throw new Error(`Tray socket ${command.id} is not open`);
      }
      socket.send(command.data);
      return;
    }
    case "tray-socket-close": {
      const socket = traySockets.get(command.id);
      traySockets.delete(command.id);
      socket?.close(command.code, command.reason);
      return;
    }
  }
}
function openTraySocket(command) {
  traySockets.get(command.id)?.close(1e3, "replaced");
  const socket = new WebSocket(command.url);
  traySockets.set(command.id, socket);
  socket.addEventListener("open", () => {
    void sendServiceWorkerMessage({
      type: "tray-socket-opened",
      id: command.id
    });
  });
  socket.addEventListener("message", (event) => {
    void sendServiceWorkerMessage({
      type: "tray-socket-message",
      id: command.id,
      data: typeof event.data === "string" ? event.data : String(event.data)
    });
  });
  socket.addEventListener("error", () => {
    if (traySockets.get(command.id) === socket) {
      traySockets.delete(command.id);
    }
    void sendServiceWorkerMessage({
      type: "tray-socket-error",
      id: command.id,
      error: "Tray leader WebSocket failed in extension service worker"
    });
  });
  socket.addEventListener("close", () => {
    if (traySockets.get(command.id) === socket) {
      traySockets.delete(command.id);
    }
    void sendServiceWorkerMessage({ type: "tray-socket-closed", id: command.id });
  });
}
async function sendServiceWorkerMessage(payload) {
  await chrome.runtime.sendMessage({
    source: "service-worker",
    payload
  });
}
async function handleCdpCommand(cmd) {
  const { id, method, params, sessionId } = cmd;
  try {
    let result;
    switch (method) {
      case "Target.getTargets":
        result = await cdpGetTargets2();
        break;
      case "Target.attachToTarget":
        result = await cdpAttachToTarget2(params);
        break;
      case "Target.detachFromTarget":
        result = await cdpDetachFromTarget2(params);
        break;
      case "Target.createTarget":
        result = await cdpCreateTarget2(params);
        break;
      case "Target.closeTarget":
        result = await cdpCloseTarget2(params);
        break;
      default:
        result = await cdpSendCommand(method, params, sessionId);
        break;
    }
    return { type: "cdp-response", id, result };
  } catch (err) {
    return {
      type: "cdp-response",
      id,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
async function cdpGetTargets2() {
  const [tabs, activeTabs] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, currentWindow: true })
  ]);
  const activeTabIds = new Set(activeTabs.map((t) => t.id));
  const targetInfos = tabs.filter((tab) => typeof tab.id === "number").map((tab) => ({
    targetId: String(tab.id),
    type: "page",
    title: tab.title ?? "",
    url: tab.url ?? "",
    attached: debuggerAttachmentOwners.has(tab.id),
    active: activeTabIds.has(tab.id)
  }));
  return { targetInfos };
}
async function cdpAttachToTarget2(params) {
  const targetId = params["targetId"];
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error(`Invalid targetId: ${targetId}`);
  }
  await acquireDebuggerAttachment(tabId, "legacy");
  const sessionId = targetId;
  sessionToTab.set(sessionId, tabId);
  return { sessionId };
}
async function cdpDetachFromTarget2(params) {
  const sessionId = params["sessionId"];
  const tabId = sessionToTab.get(sessionId);
  if (tabId !== void 0) {
    sessionToTab.delete(sessionId);
    const stillReferenced = [...sessionToTab.values()].includes(tabId);
    if (!stillReferenced) {
      await releaseDebuggerAttachment(tabId, "legacy");
    }
  }
  return {};
}
async function cdpCreateTarget2(params) {
  const url = params["url"] ?? "about:blank";
  const tab = await chrome.tabs.create({ url, active: false });
  await addToSliccGroup(tab.id);
  return { targetId: String(tab.id) };
}
async function cdpCloseTarget2(params) {
  const targetId = params["targetId"];
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error(`Invalid targetId: ${targetId}`);
  }
  for (const [sid, tid] of sessionToTab) {
    if (tid === tabId) sessionToTab.delete(sid);
  }
  await forceReleaseDebuggerAttachment(tabId);
  await chrome.tabs.remove(tabId);
  return { success: true };
}
var CDP_UNMASK_METHODS =  new Set([
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Input.insertText"
]);
async function maybeUnmaskCdpFrame(tabId, method, params) {
  if (!CDP_UNMASK_METHODS.has(method)) return params;
  if (!params || typeof params !== "object") return params;
  let hostname = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab?.url;
    if (typeof url === "string" && url.length > 0) {
      try {
        hostname = new URL(url).hostname || null;
      } catch {
        hostname = null;
      }
    }
  } catch {
    hostname = null;
  }
  if (!hostname) return params;
  const pipeline = await buildSecretsPipeline();
  await pipeline.reload();
  if (!pipeline.hasSecrets()) return params;
  const { frame, changed } = unmaskCdpFrame({ method, params }, hostname, pipeline);
  if (!changed) return params;
  const nextParams = frame.params;
  return nextParams ?? params;
}
async function cdpSendCommand(method, params, sessionId) {
  const tabId = sessionId ? sessionToTab.get(sessionId) : void 0;
  if (tabId === void 0) {
    throw new Error(
      `No tab attached for sessionId: ${sessionId ?? "(none)"}. Attach to a target first.`
    );
  }
  const effectiveParams = await maybeUnmaskCdpFrame(tabId, method, params);
  const result = await chrome.debugger.sendCommand({ tabId }, method, effectiveParams);
  return result ?? {};
}
chrome.debugger.onEvent.addListener(
  (source, method, params) => {
    if (!debuggerAttachmentOwners.has(source.tabId)) return;
    let sessionId;
    for (const [sid, tabId] of sessionToTab) {
      if (tabId === source.tabId) {
        sessionId = sid;
        break;
      }
    }
    const cdpEvent = {
      type: "cdp-event",
      method,
      params: sessionId ? { ...params, sessionId } : params ?? {}
    };
    chrome.runtime.sendMessage({
      source: "service-worker",
      payload: cdpEvent
    }).catch(() => {
    });
  }
);
async function handleOAuthRequest(msg) {
  const redirectUrl = await chrome.identity.launchWebAuthFlow(
    buildWebAuthFlowOptions(msg.authorizeUrl, msg.interactive ?? true)
  );
  if (!redirectUrl) {
    return {
      type: "oauth-result",
      providerId: msg.providerId,
      error: "OAuth flow was cancelled or returned no URL"
    };
  }
  const parsed = new URL(redirectUrl);
  const params = parsed.searchParams;
  const hashParams = new URLSearchParams(parsed.hash.slice(1));
  const error = params.get("error") || hashParams.get("error");
  if (error) {
    return {
      type: "oauth-result",
      providerId: msg.providerId,
      error: params.get("error_description") || hashParams.get("error_description") || error
    };
  }
  return {
    type: "oauth-result",
    providerId: msg.providerId,
    code: params.get("code") ?? void 0,
    state: params.get("state") ?? void 0,
    redirectUrl
  };
}
chrome.debugger.onDetach.addListener((source, _reason) => {
  debuggerAttachmentOwners.delete(source.tabId);
  for (const [sessionId, tabId] of sessionToTab) {
    if (tabId === source.tabId) {
      sessionToTab.delete(sessionId);
    }
  }
  notifyBridgeDebuggerDetached(source.tabId);
});
var sessionSecretStore = new SessionSecretStore();
var storageLocal = chrome.storage.local;
async function buildSecretsPipeline() {
  const sessionId = await readOrCreateSwSessionId();
  const source = {
    get: async (name) => {
      const fromSession = sessionSecretStore.get(name);
      if (fromSession !== void 0) return fromSession;
      const got = await chrome.storage.local.get(name);
      return got[name];
    },
    listAll: () => listSecretsWithValues(storageLocal)
  };
  return new SecretsPipeline({ sessionId, source, sessionStore: sessionSecretStore });
}
var bridgeSwDeps = buildDefaultBridgeSwDeps({

  writeStoredLeaderTabId: async (tabId) => {
    try {
      await writeStoredLeaderTabId(tabId);
    } catch {
    }
  },
  attachDebugger: (tabId) => acquireDebuggerAttachment(tabId, "bridge"),
  detachDebugger: (tabId) => releaseDebuggerAttachment(tabId, "bridge"),
  sendDebuggerCommand: async (tabId, method, params) => {
    const result = await chrome.debugger.sendCommand({ tabId }, method, params);
    return result ?? {};
  },
  maybeUnmaskCdpFrame,
  allowedOrigins: false ? [...BRIDGE_ALLOWED_ORIGINS, ...BRIDGE_DEV_ORIGINS] : BRIDGE_ALLOWED_ORIGINS,
  onLeaderJoinUrl: (joinUrl) => {
    setCherryPanelJoinUrl(joinUrl);
  }
});
function buildReloadedPipelinePromise() {
  return buildSecretsPipeline().then(async (p) => {
    await p.reload();
    return p;
  });
}
chrome.runtime.onConnectExternal.addListener((port) => {
  if (port.name === "fetch-proxy.fetch") {
    const pipelinePromise = (async () => {
      const pin = await validateBridgePin(port.sender, {
        readStoredLeaderTabId: bridgeSwDeps.readStoredLeaderTabId,
        writeStoredLeaderTabId: bridgeSwDeps.writeStoredLeaderTabId,
        allowedOrigins: bridgeSwDeps.allowedOrigins
      });
      if (!pin.ok) throw new Error(`fetch-proxy pin failed: ${pin.reason ?? "pin-failed"}`);
      return buildReloadedPipelinePromise();
    })();
    pipelinePromise.catch((err) => {
      console.error("[sw] external fetch-proxy init failed", err);
    });
    handleFetchProxyConnectionAsync(port, pipelinePromise);
    return;
  }
  if (port.name === "secrets.crud") {
    const pinPromise = validateBridgePin(port.sender, {
      readStoredLeaderTabId: bridgeSwDeps.readStoredLeaderTabId,
      writeStoredLeaderTabId: bridgeSwDeps.writeStoredLeaderTabId,
      allowedOrigins: bridgeSwDeps.allowedOrigins
    });
    pinPromise.catch((err) => {
      console.error("[sw] external secrets.crud pin check failed", err);
    });
    port.onMessage.addListener(async (raw) => {
      const id = raw?.id;
      let replied = false;
      const reply = (response) => {
        if (replied) return;
        replied = true;
        port.postMessage({ id, response });
      };
      let pin;
      try {
        pin = await pinPromise;
      } catch (err) {
        reply({
          error: `secrets.crud pin failed: ${err instanceof Error ? err.message : String(err)}`
        });
        return;
      }
      if (!pin.ok) {
        reply({ error: `secrets.crud pin failed: ${pin.reason ?? "pin-failed"}` });
        return;
      }
      const type = getMsgType(raw);
      const handler = type !== void 0 && isSecretsMessageType(type) ? SECRETS_HANDLERS[type] : void 0;
      if (!handler) {
        reply({ error: `unknown secrets type: ${type ?? "undefined"}` });
        return;
      }
      if (!handler(raw, reply)) {
        reply({ error: `malformed secrets request: ${type}` });
      }
    });
    return;
  }
  if (port.name === "mount.sign-and-forward") {
    const pinPromise = validateBridgePin(port.sender, {
      readStoredLeaderTabId: bridgeSwDeps.readStoredLeaderTabId,
      writeStoredLeaderTabId: bridgeSwDeps.writeStoredLeaderTabId,
      allowedOrigins: bridgeSwDeps.allowedOrigins
    });
    pinPromise.catch((err) => {
      console.error("[sw] external mount.sign-and-forward pin check failed", err);
    });
    port.onMessage.addListener(async (raw) => {
      const id = raw?.id;
      const reply = (response) => port.postMessage({ id, response });
      const replyError = (message) => reply({ ok: false, error: message, errorCode: "internal" });
      let pin;
      try {
        pin = await pinPromise;
      } catch (err) {
        replyError(
          `mount.sign-and-forward pin failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
      if (!pin.ok) {
        replyError(`mount.sign-and-forward pin failed: ${pin.reason ?? "pin-failed"}`);
        return;
      }
      if (!isMountSignAndForwardRequest(raw)) {
        replyError("invalid mount.sign-and-forward request");
        return;
      }
      try {
        reply(await handleMountSignAndForward(raw));
      } catch (err) {
        replyError(err instanceof Error ? err.message : String(err));
      }
    });
    return;
  }
  handleBridgePortConnect(port, bridgeSwDeps).catch((err) => {
    console.error("[slicc-sw] CDP bridge connect failed", err);
  });
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === CHERRY_PANEL_PORT_NAME) {
    chrome.action.setBadgeText({ text: "" }).catch(() => {
    });
    handleCherryPanelConnect(port, {
      ensureLeaderTab,
      reloadLeaderTabIfExists,
      focusLeaderTab,
      openSettingsOnLeader: () => {
        postOpenSettingsToWelcomedLeaderPorts();
      }
    }).catch((err) => console.error("[slicc-sw] handleCherryPanelConnect failed", err));
    return;
  }
  if (port.name !== "fetch-proxy.fetch") return;
  const pipelinePromise = buildReloadedPipelinePromise();
  pipelinePromise.catch((err) => {
    console.error("[sw] fetch-proxy init failed", err);
  });
  handleFetchProxyConnectionAsync(port, pipelinePromise);
});
function getMsgType(msg) {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return void 0;
  const t = msg.type;
  return typeof t === "string" ? t : void 0;
}
function getStringField(msg, field) {
  if (typeof msg !== "object" || msg === null || !(field in msg)) return void 0;
  const v = Reflect.get(msg, field);
  return typeof v === "string" ? v : void 0;
}
function getStringArrayField(msg, field) {
  if (typeof msg !== "object" || msg === null || !(field in msg)) return void 0;
  const v = Reflect.get(msg, field);
  if (!Array.isArray(v)) return void 0;
  return v.filter((d) => typeof d === "string");
}
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}
function runSecretsListMaskedEntries(_msg, sendResponse) {
  void (async () => {
    try {
      const pipeline = await buildSecretsPipeline();
      await pipeline.reload();
      sendResponse({ entries: pipeline.getMaskedEntries() });
    } catch (err) {
      console.error("[sw] secrets.list-masked-entries failed", err);
      sendResponse({ entries: [], error: errMsg(err) });
    }
  })();
  return true;
}
function runSecretsScrubToolResult(msg, sendResponse) {
  const text = getStringField(msg, "text");
  if (text === void 0) return false;
  void (async () => {
    try {
      const pipeline = await buildSecretsPipeline();
      await pipeline.reload();
      sendResponse({ text: pipeline.scrubResponse(text) });
    } catch {
      console.error("[sw] secrets.scrub-tool-result failed");
      sendResponse({ error: "secret scrub failed" });
    }
  })();
  return true;
}
function runSecretsListWithValuesForPipeline(_msg, sendResponse) {
  void (async () => {
    try {
      const sessionId = await readOrCreateSwSessionId();
      const persisted = await listSecretsWithValues(storageLocal);
      const persistedNames = new Set(persisted.map((e) => e.name));
      const session = sessionSecretStore.listAll().filter((s) => !persistedNames.has(s.name));
      const entries = [...persisted, ...session];
      sendResponse({ sessionId, entries });
    } catch (err) {
      console.error("[sw] secrets.list-with-values-for-pipeline failed", err);
      sendResponse({ sessionId: void 0, entries: [], error: errMsg(err) });
    }
  })();
  return true;
}
function runSecretsList(_msg, sendResponse) {
  void (async () => {
    try {
      const entries = await listSecrets(storageLocal);
      sendResponse({ entries });
    } catch (err) {
      console.error("[sw] secrets.list failed", err);
      sendResponse({ entries: [], error: errMsg(err) });
    }
  })();
  return true;
}
function runSecretsSet(msg, sendResponse) {
  const name = getStringField(msg, "name");
  const value = getStringField(msg, "value");
  const domains = getStringArrayField(msg, "domains");
  if (name === void 0 || value === void 0 || domains === void 0) return false;
  void (async () => {
    try {
      await setSecret(storageLocal, name, value, domains);
      sendResponse({ ok: true });
    } catch (err) {
      console.error("[sw] secrets.set failed", err);
      sendResponse({ ok: false, error: errMsg(err) });
    }
  })();
  return true;
}
function runSecretsDelete(msg, sendResponse) {
  const name = getStringField(msg, "name");
  if (name === void 0) return false;
  void (async () => {
    try {
      if (sessionSecretStore.has(name)) {
        sessionSecretStore.delete(name);
        sendResponse({ ok: true, removed: true, fromSession: true });
        return;
      }
      const existing = await listSecrets(storageLocal);
      if (!existing.some((e) => e.name === name)) {
        sendResponse({ ok: true, removed: false });
        return;
      }
      await deleteSecret(storageLocal, name);
      sendResponse({ ok: true, removed: true, fromSession: false });
    } catch (err) {
      console.error("[sw] secrets.delete failed", err);
      sendResponse({ ok: false, error: errMsg(err) });
    }
  })();
  return true;
}
function runSecretsSessionSet(msg, sendResponse) {
  const name = getStringField(msg, "name");
  const value = getStringField(msg, "value");
  const domains = getStringArrayField(msg, "domains");
  if (name === void 0 || value === void 0 || domains === void 0) return false;
  sessionSecretStore.set(name, value, domains);
  sendResponse({ ok: true });
  return true;
}
function runSecretsSessionList(_msg, sendResponse) {
  sendResponse({ entries: sessionSecretStore.list() });
  return true;
}
function runSecretsPeek(msg, sendResponse) {
  const name = getStringField(msg, "name");
  if (name === void 0) return false;
  void (async () => {
    try {
      const sessionRec = sessionSecretStore.getRecord(name);
      if (sessionRec) {
        sendResponse({
          record: {
            name,
            preview: previewSecret(sessionRec.value),
            domains: sessionRec.domains
          }
        });
        return;
      }
      const all = await listSecretsWithValues(storageLocal);
      const found = all.find((e) => e.name === name);
      sendResponse({
        record: found ? { name, preview: previewSecret(found.value), domains: found.domains } : void 0
      });
    } catch (err) {
      console.error("[sw] secrets.peek failed", err);
      sendResponse({ record: void 0, error: errMsg(err) });
    }
  })();
  return true;
}
function runSecretsSetDomains(msg, sendResponse) {
  const name = getStringField(msg, "name");
  const domains = getStringArrayField(msg, "domains");
  if (name === void 0 || domains === void 0) return false;
  void (async () => {
    try {
      if (sessionSecretStore.has(name)) {
        sessionSecretStore.setDomains(name, domains);
        sendResponse({ ok: true });
        return;
      }
      const all = await listSecretsWithValues(storageLocal);
      const found = all.find((e) => e.name === name);
      if (!found) {
        sendResponse({ ok: false, error: "secret not found" });
        return;
      }
      await setSecret(storageLocal, name, found.value, domains);
      sendResponse({ ok: true });
    } catch {
      console.error("[sw] secrets.set-domains failed");
      sendResponse({ ok: false, error: "secret scope update failed" });
    }
  })();
  return true;
}
async function runMaskOauthTokenWrite(providerId, accessToken, domains) {
  if (accessToken && domains) {
    await chrome.storage.local.set({
      [`oauth.${providerId}.token`]: accessToken,
      [`oauth.${providerId}.token_DOMAINS`]: domains
    });
  }
  const pipeline = await buildSecretsPipeline();
  await pipeline.reload();
  const name = `oauth.${providerId}.token`;
  return pipeline.getMaskedEntries().find((e) => e.name === name)?.maskedValue;
}
function runSecretsMaskOauthToken(msg, sendResponse) {
  const providerId = getStringField(msg, "providerId");
  if (providerId === void 0) return false;
  const accessToken = getStringField(msg, "accessToken");
  const domains = getStringField(msg, "domains");
  void (async () => {
    try {
      const maskedValue = await runMaskOauthTokenWrite(providerId, accessToken, domains);
      if (accessToken && domains && maskedValue === void 0) {
        console.warn("[sw] secrets.mask-oauth-token: entry missing after write");
        sendResponse({ maskedValue: void 0, error: "entry missing after write" });
        return;
      }
      sendResponse({ maskedValue });
    } catch {
      console.error("[sw] secrets.mask-oauth-token failed");
      sendResponse({ maskedValue: void 0, error: "OAuth token masking failed" });
    }
  })();
  return true;
}
function runSecretsRedactExport(msg, sendResponse) {
  const texts = getStringArrayField(msg, "texts");
  if (texts === void 0) return false;
  void (async () => {
    try {
      const pipeline = await buildSecretsPipeline();
      await pipeline.reload();
      const result = pipeline.redactForExport(texts);
      sendResponse(result);
    } catch (err) {
      console.error("[sw] secrets.redact-export failed", err);
      sendResponse({ error: errMsg(err) });
    }
  })();
  return true;
}
var SECRETS_HANDLERS = {
  "secrets.list-masked-entries": runSecretsListMaskedEntries,
  "secrets.scrub-tool-result": runSecretsScrubToolResult,
  "secrets.list-with-values-for-pipeline": runSecretsListWithValuesForPipeline,
  "secrets.list": runSecretsList,
  "secrets.set": runSecretsSet,
  "secrets.delete": runSecretsDelete,
  "secrets.session.set": runSecretsSessionSet,
  "secrets.session.list": runSecretsSessionList,
  "secrets.peek": runSecretsPeek,
  "secrets.set-domains": runSecretsSetDomains,
  "secrets.mask-oauth-token": runSecretsMaskOauthToken,
  "secrets.redact-export": runSecretsRedactExport
};
function isSecretsMessageType(type) {
  return Object.hasOwn(SECRETS_HANDLERS, type);
}
chrome.runtime.onMessage.addListener(
  (msg, _sender, sendResponse) => {
    const type = getMsgType(msg);
    if (type === void 0 || !isSecretsMessageType(type)) return false;
    const handler = SECRETS_HANDLERS[type];
    return handler(msg, sendResponse);
  }
);
export {
  appendLeaderExtIdParam,
  getLeaderTabOrigin,
  getLeaderTabUrl,
  getLeaderTabUrlGlob,
  leaderUrlHasExtId
};
