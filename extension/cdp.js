if (typeof URL.canParse !== 'function') {
  URL.canParse = function (url, base) {
    try {
      new URL(url, base);
      return true;
    } catch {
      return false;
    }
  };
}

import { protectedOrigins } from './protected.mjs';
import { protectedRules } from './protected-rules.js';
import { seven } from './seven.js';
import {
  ABOUT_OTHER,
  ABOUT_STUCK,
  ABOUT_WORLD,
  ABOUT_WRAPPED,
  aboutUrl,
  assignExpression,
  binaryHeadersNameProtected,
  bodyMethod,
  boundIds,
  COOKIES,
  cookieReader,
  cookieRefused,
  cookieSetter,
  cookieUrlUnparseable,
  dropProtectedCookies,
  EXTENSION_FRAME,
  extensionOrigin,
  foreignFrame,
  frameIn,
  frameSets,
  headersNameProtected,
  hopMatches,
  hopOf,
  initScriptPrefix,
  NetworkStreams,
  namesProtectedStorage,
  nodeSelectors,
  PROFILED,
  patternMatches,
  patternProtected,
  profiled,
  pruneSealed,
  pruneSnapshot,
  RESERVED_WORLD,
  redactProtected,
  redactText,
  refusedOutright,
  requestKey,
  requestUrl,
  resolveFrameOrigins,
  responseNamesProtected,
  sameDocument,
  scopedBinding,
  sealedEvent,
  sealedNodes,
  sealedRead,
  streamRead,
  strictGuard,
  stripProtectedCookies,
  treeNamesProtected,
  UNSEEN,
  UNWATCHED,
  UrlStream,
  unknownFrame,
  urlProtected,
  WORLD,
  Worlds,
  wholePage,
  withoutCookieHeaders,
  withoutSetCookie,
  wrapsAbout,
} from './shield.js';

const guard = strictGuard(protectedOrigins(protectedRules), protectedRules);
const prefix = initScriptPrefix(protectedRules);
const ERROR_PAGE = 'chrome-error://chromewebdata/';

const BACKEND = { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' };
const FETCH_ANSWERS = new Set([
  'Fetch.continueRequest',
  'Fetch.fulfillRequest',
  'Fetch.failRequest',
  'Fetch.continueResponse',
  'Fetch.continueWithAuth',
]);
const FETCH_READS = new Set(['Fetch.getResponseBody', 'Fetch.takeResponseBodyAsStream']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SETTLES = new Set([
  'Network.responseReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
]);
const REROUTE =
  'slicc: refused: the rewritten request answered with a protected url, so the guard failed it';
const BODY_READ = 'slicc: refused: this paused response body was already read the other way';
const ERROR_PAGE_READS = new Set([
  'Page.captureSnapshot',
  'Page.getResourceContent',
  'Page.searchInResource',
]);

function anyProtected(text, options) {
  return urlProtected(guard, text, options);
}

function redacted(value, method) {
  return redactProtected(value, anyProtected, method);
}

function unfolded(text) {
  return textOf(text).replace(/=\r?\n/g, '');
}

function snapshotChecked(result) {
  const data = unfolded(result.data);
  if (redactText(data, anyProtected) !== data) refusal();
}

function headersProtected(params, base) {
  return (
    headersNameProtected(params.responseHeaders, anyProtected, base) ||
    headersNameProtected(params.headers, anyProtected, base) ||
    binaryHeadersNameProtected(params.binaryResponseHeaders, anyProtected)
  );
}

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

function refusal() {
  throw new Error(protectedRules.refusal);
}

const RELATIVE = "slicc: refused: a relative url would open one of the extension's own pages";
const NAVIGATES = new Set(['Page.navigate', 'Network.loadNetworkResource']);

function unparseableDestination(url) {
  if (typeof url === 'string' && /^\s*[a-z][a-z0-9+.-]*:/i.test(url) && guard.unparseable(url)) {
    throw new Error(protectedRules.unparseableRefusal);
  }
}

function relative(url) {
  return typeof url === 'string' && url !== '' && !URL.canParse(url);
}

function unfragmented(url) {
  const at = url.indexOf('#');
  return at < 0 ? url : url.slice(0, at);
}

function redactedUrl(url) {
  try {
    const origin = new URL(url).origin;
    return origin && origin !== 'null' ? origin : 'about:blank';
  } catch {
    return 'about:blank';
  }
}

function blocked(url, opener, previous = false) {
  return guard.target({ url: textOf(url), opener, previous });
}

function uiType(type) {
  return (
    typeof type === 'string' && guard.target({ url: 'about:blank', opener: 'unprotected', type })
  );
}

async function readTab(api, tabId) {
  try {
    const tab = await api.tabs.get(tabId);
    if (tab && typeof tab === 'object') return tab;
  } catch {
    refusal();
  }
  refusal();
}

const sources = new Map();
const tracked = new WeakSet();

function trackSources(api) {
  if (tracked.has(api)) return;
  tracked.add(api);
  api.webNavigation?.onCreatedNavigationTarget?.addListener((details) => {
    if (typeof details?.tabId === 'number' && typeof details?.sourceTabId === 'number') {
      sources.set(details.tabId, details.sourceTabId);
    }
  });
  api.tabs.onRemoved?.addListener((tabId) => sources.delete(tabId));
}

function openerIdOf(tab) {
  const source = sources.get(tab?.id);
  if (typeof source === 'number') return source;
  return typeof tab?.openerTabId === 'number' ? tab.openerTabId : undefined;
}

async function classifyOpener(api, openerId) {
  let opener;
  try {
    opener = await api.tabs.get(openerId);
  } catch {
    return 'unknown';
  }
  const url = textOf(opener?.url);
  const pending = textOf(opener?.pendingUrl);
  if (blocked(url, 'unprotected')) return 'protected';
  if (pending && pending !== url && blocked(pending, 'unprotected', guard.url(url))) {
    return 'protected';
  }
  if (blocked(url, 'unknown')) return 'unknown';
  if (pending && pending !== url && blocked(pending, 'unknown', guard.url(url))) return 'unknown';
  return 'unprotected';
}

async function openerOf(api, tab) {
  const ids = new Set();
  if (typeof tab?.openerTabId === 'number') ids.add(tab.openerTabId);
  const source = sources.get(tab?.id);
  if (typeof source === 'number') ids.add(source);
  let worst = 'unprotected';
  for (const id of ids) {
    const found = await classifyOpener(api, id);
    if (found === 'protected') return found;
    if (found === 'unknown') worst = found;
  }
  return worst;
}

async function demandTab(api, tab) {
  const opener = await openerOf(api, tab);
  const url = textOf(tab?.url);
  const pending = textOf(tab?.pendingUrl);
  if (blocked(url, opener)) refusal();
  if (pending && pending !== url && blocked(pending, opener, guard.url(url))) refusal();
  return { opener, url };
}

async function tabBlocked(api, tab) {
  try {
    await demandTab(api, tab);
    return false;
  } catch {
    return true;
  }
}

const _sixHosts = ['www.sliccy.ai'];
const _exL = seven.excludedLabels;
const _exP = seven.excludedLabelPrefixes;
const _d = `.${seven.domain}`;

function allowedHost(hostname) {
  if (!hostname.endsWith(_d)) return false;
  const label = hostname.slice(0, -_d.length);
  if (!label) return false;
  if (_sixHosts.includes(hostname)) return true;
  if (_exL.includes(label) || _exP.some((p) => label.startsWith(p))) return false;
  return true;
}

export function trusted(sender, extensionId) {
  if (!sender || sender.id !== extensionId || !URL.canParse(sender.url)) return false;
  const { protocol, hostname } = new URL(sender.url);
  return protocol === 'https:' && allowedHost(hostname);
}

export function internal(sender, extensionId) {
  if (!sender || sender.id !== extensionId) return false;
  const prefix = 'chrome-extension://' + extensionId;
  return typeof sender.url === 'string' && sender.url.startsWith(prefix);
}

function isCdp(message) {
  return (
    message !== null &&
    typeof message === 'object' &&
    typeof message.id === 'number' &&
    typeof message.method === 'string'
  );
}

function bag(params) {
  return params !== null && typeof params === 'object' ? params : {};
}

function readTargetId(params) {
  const targetId = params.targetId;
  if (typeof targetId !== 'string') throw new Error(`Invalid targetId: ${String(targetId)}`);
  return targetId;
}

function tabFrom(targetId) {
  const tabId = Number.parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0 || String(tabId) !== targetId) {
    throw new Error(`slicc: refused: Invalid targetId: ${targetId} is not a tab`);
  }
  return tabId;
}

function version() {
  const userAgent = textOf(globalThis.navigator?.userAgent);
  const found = /(?:Chrome|Chromium)\/([\d.]+)/.exec(userAgent);
  return {
    protocolVersion: '1.3',
    product: `Chrome/${found ? found[1] : '0.0.0.0'}`,
    revision: '',
    userAgent,
    jsVersion: '',
  };
}

async function activate(api, tabId) {
  try {
    const tab = await api.tabs.update(tabId, { active: true });
    if (typeof tab?.windowId === 'number') {
      await api.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    return undefined;
  }
}

function bounded(promise, ms, label) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no answer in ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function plainContinue(params) {
  return Object.keys(params).every((key) => key === 'requestId');
}

function outgoing(message, params) {
  if (message.method === 'Page.addScriptToEvaluateOnNewDocument') {
    return { ...params, source: prefix + textOf(params.source) };
  }
  if (message.params === undefined && message.method !== 'Runtime.addBinding') return undefined;
  return params;
}

class Connection {
  constructor(port, api) {
    this.port = port;
    this.api = api;
    trackSources(api);
    this.state = {
      sessions: new Map(),
      tabs: new Map(),
      ownedTabs: new Set(),
      inflight: new Map(),
      seen: new Set(),
      failed: new Map(),
      streams: new Map(),
      cut: new Set(),
      discover: false,
      counter: 0,
    };
    this.closed = false;
    this.chain = Promise.resolve();
    this.pending = Promise.resolve();
    this.onEvent = this.onEvent.bind(this);
    this.onDetach = this.onDetach.bind(this);
    this.onUpdated = this.onUpdated.bind(this);
    this.onCreated = this.onCreated.bind(this);
    this.onRemoved = this.onRemoved.bind(this);
    this.onSource = this.onSource.bind(this);
    this.shutdown = this.shutdown.bind(this);
    api.debugger.onEvent.addListener(this.onEvent);
    api.debugger.onDetach.addListener(this.onDetach);
    api.tabs.onUpdated?.addListener(this.onUpdated);
    api.tabs.onCreated?.addListener(this.onCreated);
    api.tabs.onRemoved?.addListener(this.onRemoved);
    api.webNavigation?.onCreatedNavigationTarget?.addListener(this.onSource);
    port.onDisconnect.addListener(this.shutdown);
  }

  post(message, method = message.method) {
    if (this.closed) return;
    let out;
    try {
      out = redacted(message, method);
    } catch (error) {
      if (typeof message?.id !== 'number') return;
      out = { id: message.id, error: String(error?.message ?? error) };
    }
    try {
      this.port.postMessage(out);
    } catch {
      return undefined;
    }
  }

  tabState(tabId) {
    return this.state.tabs.get(tabId);
  }

  sessionsOf(tabId) {
    return [...(this.tabState(tabId)?.sessions ?? [])];
  }

  inflight(tabId, command) {
    let entry;
    const dropped = new Promise((_, reject) => {
      entry = reject;
    });
    let set = this.state.inflight.get(tabId);
    if (!set) {
      set = new Set();
      this.state.inflight.set(tabId, set);
    }
    set.add(entry);
    return Promise.race([command, dropped]).finally(() => {
      set.delete(entry);
      if (set.size === 0 && this.state.inflight.get(tabId) === set)
        this.state.inflight.delete(tabId);
    });
  }

  drop(tabId) {
    const set = this.state.inflight.get(tabId);
    if (!set) return;
    this.state.inflight.delete(tabId);
    for (const reject of set) reject(new Error('Target detached'));
  }

  send(tabId, method, params) {
    return this.inflight(tabId, this.api.debugger.sendCommand({ tabId }, method, params));
  }

  failedAt(tabId, url) {
    const failed = this.state.failed.get(tabId);
    return Boolean(failed) && unfragmented(textOf(url)) === failed;
  }

  view(tab) {
    if (!this.failedAt(tab?.id, tab?.url)) return tab;
    const pendingUrl = this.failedAt(tab.id, tab.pendingUrl) ? '' : tab.pendingUrl;
    return { ...tab, url: ERROR_PAGE, title: '', pendingUrl };
  }

  async read(tabId) {
    return this.view(await readTab(this.api, tabId));
  }

  async confirmed(tabId) {
    const tab = await readTab(this.api, tabId);
    if (this.tabState(tabId) || !this.failedAt(tabId, tab.url)) return this.view(tab);
    const frame = await this.api.webNavigation
      ?.getFrame?.({ tabId, frameId: 0 })
      .catch(() => undefined);
    if (frame?.errorOccurred !== true) this.state.failed.delete(tabId);
    return this.view(tab);
  }

  info(tab) {
    const url = textOf(tab.url);
    const pending = textOf(tab.pendingUrl);
    const shown = urlProtected(guard, url) ? redactedUrl(url) : url;
    const hidden = shown !== url || urlProtected(guard, pending);
    const reported = shown || (urlProtected(guard, pending) ? redactedUrl(pending) : pending);
    const out = {
      targetId: String(tab.id),
      type: 'page',
      title: hidden ? (reported === url ? '' : reported) : (tab.title ?? ''),
      url: reported,
      attached: this.sessionsOf(tab.id).length > 0,
      canAccessOpener: false,
    };
    const openerId = openerIdOf(tab);
    if (openerId !== undefined) out.openerId = String(openerId);
    return out;
  }

  forget(tabId) {
    this.drop(tabId);
    const tab = this.tabState(tabId);
    if (tab) for (const sessionId of tab.sessions) this.state.sessions.delete(sessionId);
    this.state.tabs.delete(tabId);
    this.state.ownedTabs.delete(tabId);
  }

  release(tabId) {
    const sessions = this.sessionsOf(tabId);
    const owned = this.state.ownedTabs.has(tabId);
    if (sessions.length === 0 && !owned) return;
    for (const sessionId of sessions) this.state.cut.add(sessionId);
    while (this.state.cut.size > 1000) this.state.cut.delete(this.state.cut.values().next().value);
    this.forget(tabId);
    for (const sessionId of sessions) {
      this.post({
        method: 'Target.detachedFromTarget',
        params: { sessionId, targetId: String(tabId) },
        sessionId,
      });
    }
    if (owned) void this.api.debugger.detach({ tabId }).catch(() => undefined);
  }

  async applyFetch(tabId) {
    const tab = this.tabState(tabId);
    if (!tab) return;
    const patterns = [BACKEND];
    let handleAuthRequests = false;
    for (const sessionId of tab.sessions) {
      const session = this.state.sessions.get(sessionId);
      if (!session?.patterns) continue;
      patterns.push(...session.patterns);
      handleAuthRequests ||= session.auth;
    }
    await this.send(tabId, 'Fetch.enable', { patterns, handleAuthRequests });
  }

  async targets() {
    const listed = this.api.tabs.query({});
    const active = this.api.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then((found) => (typeof found[0]?.id === 'number' ? found[0].id : undefined))
      .catch(() => undefined);
    const [tabs, activeId] = await Promise.all([listed, active]);
    const targetInfos = [];
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      this.state.seen.add(tab.id);
      targetInfos.push({ ...this.info(tab), active: tab.id === activeId });
    }
    return { targetInfos };
  }

  async targetInfo(params) {
    if (typeof params.targetId !== 'string') {
      return {
        targetInfo: {
          targetId: 'browser',
          type: 'browser',
          title: '',
          url: '',
          attached: true,
          canAccessOpener: false,
        },
      };
    }
    const tabId = tabFrom(params.targetId);
    const tab = await readTab(this.api, tabId);
    this.state.seen.add(tabId);
    return { targetInfo: this.info(tab) };
  }

  async discover(params) {
    const on = params.discover === true;
    const was = this.state.discover;
    this.state.discover = on;
    if (!on || was) return {};
    const tabs = await this.api.tabs.query({});
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      this.state.seen.add(tab.id);
      this.post({ method: 'Target.targetCreated', params: { targetInfo: this.info(tab) } });
    }
    return {};
  }

  async create(params) {
    const url = typeof params.url === 'string' ? params.url : '';
    unparseableDestination(url);
    if (relative(url)) throw new Error(RELATIVE);
    if (wrapsAbout(url, protectedRules.innerSchemes)) throw new Error(ABOUT_WRAPPED);
    if (guard.target({ url })) refusal();
    if (params.newWindow === true) {
      const created = await this.api.windows.create({
        url: url || 'about:blank',
        type: params.decorated === false ? 'popup' : 'normal',
        focused: typeof params.focus === 'boolean' ? params.focus : params.background === false,
      });
      const tabId = created?.tabs?.[0]?.id;
      if (typeof tabId !== 'number')
        throw new Error('chrome.windows.create did not return a tab id');
      return this.opened(created.tabs[0]);
    }
    const tab = await bounded(
      this.api.tabs.create({ url: url || 'about:blank', active: false }),
      10000,
      'Target.createTarget'
    );
    if (typeof tab?.id !== 'number') throw new Error('chrome.tabs.create did not return a tab id');
    return this.opened(tab);
  }

  async opened(tab) {
    const landed = [textOf(tab.pendingUrl), textOf(tab.url)];
    if (landed.some((url) => url && guard.url(url))) {
      await this.api.tabs.remove(tab.id).catch(() => undefined);
      refusal();
    }
    return { targetId: String(tab.id) };
  }

  async guarded(params) {
    const tabId = tabFrom(readTargetId(params));
    await demandTab(this.api, await this.confirmed(tabId));
    return tabId;
  }

  async closeTarget(params) {
    const tabId = await this.guarded(params);
    const owned = this.state.ownedTabs.has(tabId);
    const sessions = this.sessionsOf(tabId);
    this.forget(tabId);
    for (const sessionId of sessions) {
      this.post({
        method: 'Target.detachedFromTarget',
        params: { sessionId, targetId: String(tabId) },
        sessionId,
      });
    }
    if (owned) {
      await bounded(this.api.debugger.detach({ tabId }), 5000, 'detach').catch(() => undefined);
    }
    await bounded(this.api.tabs.remove(tabId), 10000, 'Target.closeTarget');
    return { success: true };
  }

  async inventory(tabId, tab) {
    let tree;
    try {
      tree = await bounded(this.send(tabId, 'Page.getFrameTree', {}), 5000, 'frames');
    } catch {
      return false;
    }
    const main = tree?.frameTree?.frame;
    if (!main || typeof main.id !== 'string' || main.id === '') return false;
    if (this.protectedOrigin(textOf(main.securityOrigin))) return false;
    if (await this.inheritedProtected(tabId, main)) return false;
    if (!tab.mainFrameId) tab.mainFrameId = main.id;
    const pending = [...(tree.frameTree.childFrames ?? [])];
    while (pending.length > 0) {
      const node = pending.pop();
      const frame = node?.frame;
      if (typeof frame?.id === 'string' && (await this.inheritedProtected(tabId, frame))) {
        tab.frames.set(frame.id, true);
      }
      if (Array.isArray(node?.childFrames)) pending.push(...node.childFrames);
    }
    return true;
  }

  async frameOf(tabId, frameId) {
    const tree = await bounded(this.send(tabId, 'Page.getFrameTree', {}), 5000, 'frames');
    return frameIn(tree?.frameTree, frameId);
  }

  async documentOrigin(tabId, frameId) {
    const world = await bounded(
      this.send(tabId, 'Page.createIsolatedWorld', { frameId, worldName: ABOUT_WORLD }),
      5000,
      'origin'
    );
    const answer = await bounded(
      this.send(tabId, 'Runtime.evaluate', {
        expression: 'self.origin',
        contextId: world?.executionContextId,
        returnByValue: true,
      }),
      5000,
      'origin'
    );
    const origin = answer?.result?.value;
    if (answer?.exceptionDetails || typeof origin !== 'string') throw new Error('no origin');
    return origin;
  }

  async inheritedProtected(tabId, frame) {
    let current = frame;
    for (let attempt = 0; attempt < 5; attempt++) {
      const url = textOf(current?.url);
      if (this.protectedOrigin(textOf(current?.securityOrigin)) || urlProtected(guard, url)) {
        return true;
      }
      if (url !== '' && !url.startsWith('about:')) return false;
      try {
        return this.protectedOrigin(await this.documentOrigin(tabId, textOf(current.id)));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      current = await this.frameOf(tabId, textOf(frame.id)).catch(() => undefined);
      if (!current) return true;
    }
    return true;
  }

  async openBlank(tabId, params, about) {
    if (about.pathname !== 'blank') throw new Error(ABOUT_OTHER);
    const url = about.href;
    const before = await this.frameOf(tabId, textOf(params.frameId));
    if (!before) throw new Error('No frame with given id found');
    const world = await this.send(tabId, 'Page.createIsolatedWorld', {
      frameId: before.id,
      worldName: ABOUT_WORLD,
    });
    const ran = await this.send(tabId, 'Runtime.evaluate', {
      expression: assignExpression(url),
      contextId: world?.executionContextId,
    });
    if (ran?.exceptionDetails) throw new Error(ABOUT_STUCK);
    if (sameDocument(`${textOf(before.url)}${textOf(before.urlFragment)}`, url)) {
      return { frameId: before.id };
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const now = await this.frameOf(tabId, before.id);
      if (!now || now.loaderId === before.loaderId) continue;
      if (this.protectedOrigin(textOf(now.securityOrigin))) refusal();
      if (await this.inheritedProtected(tabId, now)) refusal();
      return { frameId: before.id, loaderId: now.loaderId, isDownload: false };
    }
    throw new Error(ABOUT_STUCK);
  }

  async attach(params) {
    if (params.flatten !== true) throw new Error('only flatten: true is supported');
    const targetId = readTargetId(params);
    const tabId = tabFrom(targetId);
    const seen = await demandTab(this.api, await this.confirmed(tabId));
    let tab = this.tabState(tabId);
    if (!tab) {
      if (!this.state.ownedTabs.has(tabId)) {
        await bounded(
          this.api.debugger.attach({ tabId }, '1.3'),
          10000,
          'Target.attachToTarget'
        ).catch((error) => {
          if (foreignFrame(error)) throw new Error(EXTENSION_FRAME);
          throw error;
        });
        this.state.ownedTabs.add(tabId);
      }
      tab = {
        sessions: new Set(),
        mainFrameId: '',
        pageUrl: seen.url,
        frames: new Map(),
        worlds: new Worlds(),
        runtime: new Set(),
        requests: new Map(),
        networkStreams: new NetworkStreams(anyProtected),
        held: new Map(),
        settled: new Set(),
        hops: new Map(),
        reroutes: new Map(),
        paused: new Map(),
      };
      this.state.tabs.set(tabId, tab);
      try {
        await bounded(this.applyFetch(tabId), 10000, 'Target.attachToTarget');
      } catch (error) {
        this.forget(tabId);
        await bounded(this.api.debugger.detach({ tabId }), 5000, 'detach').catch(() => undefined);
        throw error;
      }
      const unwatched = !(await this.inventory(tabId, tab))
        ? protectedRules.refusal
        : await this.watchRuntime(tabId);
      if (unwatched) {
        this.forget(tabId);
        await bounded(this.api.debugger.detach({ tabId }), 5000, 'detach').catch(() => undefined);
        throw new Error(unwatched);
      }
      await bounded(
        this.send(tabId, 'Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        }),
        5000,
        'children'
      ).catch(() => undefined);
    }
    tab.pageUrl = seen.url;
    const sessionId = this.state.sessions.has(targetId)
      ? `${targetId}.${++this.state.counter}`
      : targetId;
    this.state.cut.delete(sessionId);
    this.state.sessions.set(sessionId, { tabId, patterns: null, auth: false });
    tab.sessions.add(sessionId);
    this.state.seen.add(tabId);
    const current = await readTab(this.api, tabId).catch(() => undefined);
    if (current) {
      this.post({
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...this.info(current), attached: true },
          waitingForDebugger: false,
        },
      });
    }
    return { sessionId };
  }

  async watchRuntime(tabId) {
    try {
      await bounded(this.send(tabId, 'Runtime.enable', {}), 10000, 'runtime');
      return undefined;
    } catch {
      return UNWATCHED;
    }
  }

  async settlePaused(tabId, sessionId) {
    const tab = this.tabState(tabId);
    if (!tab) return;
    for (const [requestId, entry] of tab.paused) {
      if (entry.owner !== sessionId || entry.claimed) continue;
      await this.advance(tabId, requestId, entry).catch(() => undefined);
    }
  }

  async detach(params) {
    const sessionId = params.sessionId;
    if (typeof sessionId !== 'string') return {};
    const session = this.state.sessions.get(sessionId);
    if (!session) return {};
    const { tabId } = session;
    const tab = this.tabState(tabId);
    this.state.sessions.delete(sessionId);
    tab?.sessions.delete(sessionId);
    tab?.runtime.delete(sessionId);
    if (tab && tab.sessions.size > 0) {
      await bounded(this.settlePaused(tabId, sessionId), 5000, 'detach').catch(() => undefined);
      await bounded(this.applyFetch(tabId), 5000, 'detach').catch(() => undefined);
      return {};
    }
    const owned = this.state.ownedTabs.has(tabId);
    this.forget(tabId);
    if (owned) {
      await bounded(this.api.debugger.detach({ tabId }), 5000, 'detach').catch(() => undefined);
    }
    return {};
  }

  candidates(tabId, paused, after) {
    const out = [];
    let passed = after === undefined;
    for (const sessionId of this.sessionsOf(tabId)) {
      if (!passed) {
        if (sessionId === after) passed = true;
        continue;
      }
      const session = this.state.sessions.get(sessionId);
      if (!session?.patterns) continue;
      if (paused.authChallenge !== undefined) {
        const matched = session.patterns.some((p) =>
          patternMatches({ ...p, requestStage: 'Request' }, paused)
        );
        if (session.auth && matched) out.push(sessionId);
        continue;
      }
      if (session.patterns.some((p) => patternMatches(p, paused))) out.push(sessionId);
    }
    return out;
  }

  async advance(tabId, requestId, entry) {
    const tab = this.tabState(tabId);
    if (!tab) return;
    const [next] = this.candidates(tabId, entry.params, entry.owner);
    if (next !== undefined) {
      entry.owner = next;
      entry.claimed = false;
      this.post({ method: entry.method, params: entry.params, sessionId: next });
      return;
    }
    tab.paused.delete(requestId);
    if (entry.method === 'Fetch.authRequired') {
      await this.answer(tabId, 'Fetch.continueWithAuth', {
        requestId,
        authChallengeResponse: { response: 'Default' },
      });
      return;
    }
    await this.answer(tabId, 'Fetch.continueRequest', { requestId });
  }

  async rerouted(tabId, tab, requestId, params) {
    const waiting = tab.reroutes.get(requestId);
    const settled =
      params.responseStatusCode !== undefined || params.responseErrorReason !== undefined;
    if (!waiting || !settled) return false;
    tab.reroutes.delete(requestId);
    const url = requestUrl(params);
    const named =
      urlProtected(guard, url) || headersNameProtected(params.responseHeaders, anyProtected, url);
    if (named && typeof params.networkId === 'string') tab.requests.set(params.networkId, true);
    waiting(!named);
    if (!named) return false;
    await this.send(tabId, 'Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    return true;
  }

  async reroute(tabId, tab, requestId, params) {
    const seen = new Promise((resolve) => tab.reroutes.set(requestId, resolve));
    try {
      await this.answer(tabId, 'Fetch.continueRequest', { ...params, interceptResponse: true });
    } catch (error) {
      tab.reroutes.delete(requestId);
      throw error;
    }
    const late = new Promise((resolve) => setTimeout(resolve, 10000, true));
    const allowed = await Promise.race([seen, late]);
    tab.reroutes.delete(requestId);
    if (!allowed) throw new Error(REROUTE);
    return {};
  }

  async onPaused(tabId, method, params) {
    const tab = this.tabState(tabId);
    if (!tab) return;
    const requestId = textOf(params?.requestId);
    if (await this.rerouted(tabId, tab, requestId, params ?? {})) return;
    const url = requestUrl(params);
    const frameId = textOf(params?.frameId);
    const isProtected = urlProtected(guard, url) || tab.frames.get(frameId) === true;
    if (typeof params?.networkId === 'string') {
      const before = tab.requests.get(params.networkId) === true;
      tab.requests.set(params.networkId, before || isProtected);
    }
    if (isProtected) {
      const atRequest =
        params.responseStatusCode === undefined && params.responseErrorReason === undefined;
      if (method === 'Fetch.authRequired') {
        await this.send(tabId, 'Fetch.continueWithAuth', {
          requestId,
          authChallengeResponse: { response: 'Default' },
        }).catch(() => undefined);
        return;
      }
      if (params.resourceType === 'Document' && atRequest) {
        await this.protectedDocument(tabId, tab, requestId, frameId, url);
        return;
      }
      await this.send(tabId, 'Fetch.continueRequest', { requestId }).catch(() => undefined);
      return;
    }
    const named = headersNameProtected(params.responseHeaders, anyProtected, url);
    if (named && typeof params.networkId === 'string') tab.requests.set(params.networkId, true);
    const [first] = this.candidates(tabId, params);
    if (first === undefined) {
      if (method === 'Fetch.authRequired') {
        await this.send(tabId, 'Fetch.continueWithAuth', {
          requestId,
          authChallengeResponse: { response: 'Default' },
        }).catch(() => undefined);
        return;
      }
      await this.send(tabId, 'Fetch.continueRequest', { requestId }).catch(() => undefined);
      return;
    }
    tab.paused.set(requestId, { owner: first, params, method, named });
    this.post({ method, params, sessionId: first });
  }

  frameProtected(tab, frameId) {
    return typeof frameId === 'string' && tab.frames.get(frameId) === true;
  }

  frameHidden(tab, frame) {
    const origin = frame.securityOrigin;
    if (this.frameProtected(tab, frame.id) || unknownFrame(frame)) return true;
    if (extensionOrigin(frame.url) || extensionOrigin(origin)) return true;
    if (this.protectedOrigin(origin)) return true;
    return [frame.url, frame.unreachableUrl].some(
      (url) => typeof url === 'string' && url !== '' && urlProtected(guard, url)
    );
  }

  async seal(tabId, tab, method, params) {
    const tree = await bounded(this.send(tabId, 'Page.getFrameTree', {}), 5000, 'frames').catch(
      () => refusal()
    );
    await resolveFrameOrigins(tree?.frameTree, tab.uncertain ?? new Set(), (id) =>
      this.documentOrigin(tabId, id)
    );
    const frames = frameSets(tree?.frameTree, (frame) => this.frameHidden(tab, frame));
    if (frames.visible.size === 0) refusal();
    const seal = { ...frames, nodes: new Set() };
    tab.seal = seal;
    if (frames.sealed.size === 0) return seal;
    if (typeof params.frameId === 'string' && !frames.visible.has(params.frameId)) refusal();
    if (method === 'DOMSnapshot.captureSnapshot') return seal;
    const snapshot = await bounded(
      this.send(tabId, 'DOMSnapshot.captureSnapshot', { computedStyles: [] }),
      10000,
      'snapshot'
    ).catch(() => refusal());
    seal.nodes = sealedNodes(snapshot, frames.visible);
    if (seal.nodes.size === 0) return seal;
    if (wholePage(method)) refusal();
    const { backend, dom, objects } = nodeSelectors(params);
    const ids = [...backend];
    for (const nodeId of dom) ids.push(await this.backendOf(tabId, { nodeId }, true));
    for (const objectId of objects) ids.push(await this.backendOf(tabId, { objectId }, false));
    if (ids.some((id) => seal.nodes.has(id))) refusal();
    return seal;
  }

  async backendOf(tabId, params, strict) {
    try {
      return (await this.send(tabId, 'DOM.describeNode', params))?.node?.backendNodeId;
    } catch (error) {
      if (strict) throw error;
      return undefined;
    }
  }

  async unseal(tabId, tab, seal, method, result) {
    if (method === 'DOMSnapshot.captureSnapshot') return pruneSnapshot(result, seal.visible);
    if (seal.sealed.size === 0) return result;
    this.cutNodes(tab, pruneSealed(result, seal));
    if (seal.nodes.size === 0) return result;
    if (seal.nodes.has(result.backendNodeId) || seal.sealed.has(result.frameId)) refusal();
    if (typeof result.nodeId === 'number') {
      if (seal.nodes.has(await this.backendOf(tabId, { nodeId: result.nodeId }, false))) refusal();
    }
    if (Array.isArray(result.nodeIds)) {
      const kept = [];
      for (const nodeId of result.nodeIds) {
        const id = await this.backendOf(tabId, { nodeId }, false);
        if (!seal.nodes.has(id)) kept.push(nodeId);
      }
      result.nodeIds = kept;
    }
    return result;
  }

  cutNodes(tab, ids) {
    tab.cut ??= new Set();
    for (const id of ids) tab.cut.add(id);
    while (tab.cut.size > 100000) tab.cut.delete(tab.cut.values().next().value);
  }

  async sealEvent(tabId, tab, method, p) {
    if (method === 'DOM.documentUpdated') {
      tab.cut?.clear();
      return true;
    }
    try {
      await this.seal(tabId, tab, method, {
        ...p,
        nodeId: p.nodeId ?? p.parentId ?? p.parentNodeId ?? p.hostId ?? p.insertionPointId,
      });
    } catch {
      return false;
    }
    if (sealedEvent(p, tab.cut ?? new Set())) {
      this.cutNodes(tab, boundIds(p));
      return false;
    }
    const seal = {
      nodes: tab.seal?.nodes ?? new Set(),
      sealed: { has: (id) => this.frameProtected(tab, id) || tab.seal?.sealed.has(id) === true },
      visible: {
        has: (id) =>
          !this.frameProtected(tab, id) &&
          (tab.frames.get(id) === false || tab.seal?.visible.has(id) === true),
      },
    };
    try {
      this.cutNodes(tab, pruneSealed(p, seal));
    } catch {
      return false;
    }
    return true;
  }

  checkParams(method, params, tab) {
    if ((cookieSetter(method) || cookieReader(method)) && cookieUrlUnparseable(guard, params)) {
      throw new Error(protectedRules.unparseableRefusal);
    }
    unparseableDestination(params.url);
    if (NAVIGATES.has(method) && relative(params.url)) throw new Error(RELATIVE);
    if (NAVIGATES.has(method) && wrapsAbout(params.url, protectedRules.innerSchemes)) {
      throw new Error(ABOUT_WRAPPED);
    }
    if (cookieSetter(method)) {
      if (cookieRefused(guard, params)) throw new Error(COOKIES);
    } else if (
      urlProtected(guard, textOf(params.url), { readOnly: method.startsWith('Debugger.') })
    ) {
      refusal();
    }
    if (namesProtectedStorage(guard, params)) refusal();
    if (this.frameProtected(tab, params.frameId)) refusal();
    if (profiled(method) && tab.worlds.foreign) throw new Error(PROFILED);
    if (params.worldName === ABOUT_WORLD) throw new Error(RESERVED_WORLD);
    if (tab.worlds.named(params.worldName)) throw new Error(WORLD);
    const world = tab.worlds.refusal(params);
    if (world) throw new Error(world);
    if (method === 'Fetch.enable') {
      const patterns = Array.isArray(params.patterns) ? params.patterns : [];
      if (patterns.some((p) => patternProtected(guard, protectedRules.domains, p))) refusal();
    }
  }

  async check(method, params, tabId, sessionId) {
    const tab = this.tabState(tabId);
    this.checkParams(method, params, tab);
    if (method === 'Page.navigateToHistoryEntry') {
      const history = await this.send(tabId, 'Page.getNavigationHistory', {});
      const entry = (history?.entries ?? []).find((item) => item.id === params.entryId);
      if (urlProtected(guard, textOf(entry?.url))) refusal();
    }
    if (FETCH_ANSWERS.has(method) || FETCH_READS.has(method)) {
      this.checkPaused(tab, method, params, sessionId);
    } else if (bodyMethod(method)) {
      const known = tab.requests.get(textOf(requestKey(params)));
      if (known === true) refusal();
      if (known !== false) throw new Error(UNSEEN);
    }
    if (ERROR_PAGE_READS.has(method)) await this.checkErrorPage(tabId);
    if (
      (method === 'IO.read' || method === 'IO.close') &&
      !this.state.streams.has(textOf(params.handle))
    ) {
      throw new Error(UNSEEN);
    }
  }

  checkPaused(tab, method, params, sessionId) {
    const entry = tab.paused.get(textOf(params.requestId));
    if (!entry || entry.owner !== sessionId || entry.claimed) throw new Error(UNSEEN);
    if (FETCH_ANSWERS.has(method) && headersProtected(params, requestUrl(entry.params))) refusal();
    if (FETCH_READS.has(method)) {
      if (entry.named) refusal();
      if (entry.read !== undefined && entry.read !== method) throw new Error(BODY_READ);
      entry.read = method;
    }
    if (FETCH_ANSWERS.has(method)) entry.claimed = true;
  }

  async checkErrorPage(tabId) {
    const tree = await this.send(tabId, 'Page.getFrameTree', {});
    if (treeNamesProtected(tree?.frameTree, anyProtected)) refusal();
  }

  async admit(tabId, tab, method, params, sessionId) {
    const view = await this.read(tabId);
    try {
      return await demandTab(this.api, view);
    } catch (error) {
      if (!this.held(tab, method, params, sessionId)) throw error;
      return demandTab(this.api, { ...view, pendingUrl: '' });
    }
  }

  held(tab, method, params, sessionId) {
    if (!FETCH_ANSWERS.has(method) && !FETCH_READS.has(method)) return false;
    return tab?.paused.get(textOf(params?.requestId))?.owner === sessionId;
  }

  async answer(tabId, method, params) {
    try {
      return (await this.send(tabId, method, params)) ?? {};
    } catch (error) {
      if (/Invalid InterceptionId|not found|No such request/i.test(String(error?.message))) {
        throw new Error(UNSEEN);
      }
      throw error;
    }
  }

  sessionOf(sessionId) {
    const session = typeof sessionId === 'string' ? this.state.sessions.get(sessionId) : undefined;
    if (session) return session;
    if (this.state.cut.has(sessionId)) refusal();
    throw new Error(
      `No tab attached for sessionId: ${sessionId ?? '(none)'}. Attach to a target first.`
    );
  }

  async sessionCommand(message, params) {
    const { method, sessionId } = message;
    const session = this.sessionOf(sessionId);
    const { tabId } = session;
    const tab = this.tabState(tabId);
    const seen = await this.admit(tabId, tab, method, params, sessionId);
    tab.pageUrl = seen.url;
    if (method.startsWith('Target.')) {
      throw new Error(`slicc: refused: ${method} is not supported on a page session`);
    }
    await this.check(method, params, tabId, sessionId);
    if (method === 'Fetch.enable') {
      session.patterns = Array.isArray(params.patterns) ? params.patterns : [{ urlPattern: '*' }];
      session.auth = params.handleAuthRequests === true;
      await this.applyFetch(tabId);
      return {};
    }
    if (method === 'Fetch.disable') {
      session.patterns = null;
      session.auth = false;
      await this.settlePaused(tabId, sessionId);
      await this.applyFetch(tabId);
      return {};
    }
    if (FETCH_ANSWERS.has(method)) {
      const requestId = textOf(params.requestId);
      const entry = tab.paused.get(requestId);
      if (method === 'Fetch.continueRequest' && plainContinue(params)) {
        await this.advance(tabId, requestId, entry);
        return {};
      }
      tab.paused.delete(requestId);
      if (method === 'Fetch.continueRequest' && params.url !== undefined) {
        return this.reroute(tabId, tab, requestId, params);
      }
      return this.answer(tabId, method, params);
    }
    const forwarded = outgoing(message, params);
    if (method === 'Runtime.enable' || method === 'Runtime.disable') {
      return this.runtimeSwitch(tab, method, sessionId);
    }
    const about = method === 'Page.navigate' ? aboutUrl(params.url) : undefined;
    if (about) return this.openBlank(tabId, params, about);
    if (method === 'Page.bringToFront') await activate(this.api, tabId);
    const seal = sealedRead(method) ? await this.seal(tabId, tab, method, params) : undefined;
    let result = (await this.send(tabId, method, forwarded)) ?? {};
    if (seal) result = await this.unseal(tabId, tab, seal, method, result);
    if (method === 'Page.captureSnapshot') snapshotChecked(result);
    await this.learn(tabId, tab, method, result);
    if (cookieReader(method)) result = dropProtectedCookies(guard, result);
    if (typeof result.stream === 'string') this.openStream(result.stream);
    if (method === 'IO.resolveBlob' && typeof result.uuid === 'string') {
      this.openStream(`blob:${result.uuid}`);
    }
    return this.readResult(tab, method, params, result);
  }

  readResult(tab, method, params, result) {
    if (method === 'IO.close') this.state.streams.delete(textOf(params.handle));
    if (method === 'IO.read') return streamRead(this.state.streams.get(params.handle), result);
    if (method === 'Network.streamResourceContent') {
      return tab.networkStreams.buffer(textOf(params.requestId), result);
    }
    return result;
  }

  openStream(handle) {
    this.state.streams.set(handle, new UrlStream(anyProtected));
  }

  async learn(tabId, tab, method, result) {
    tab.worlds.learn(result);
    if (method === 'Page.createIsolatedWorld') tab.worlds.seen(result.executionContextId);
    if (method === 'Page.getFrameTree' || method === 'Page.getResourceTree') {
      await resolveFrameOrigins(result.frameTree, tab.uncertain ?? new Set(), (id) =>
        this.documentOrigin(tabId, id)
      );
      this.pruneFrames(tab, result.frameTree);
    }
  }

  runtimeSwitch(tab, method, sessionId) {
    if (method === 'Runtime.disable') {
      tab.runtime.delete(sessionId);
      return {};
    }
    if (tab.runtime.has(sessionId)) return {};
    tab.runtime.add(sessionId);
    for (const context of tab.worlds.visible()) {
      this.post({ method: 'Runtime.executionContextCreated', params: { context }, sessionId });
    }
    return {};
  }

  async dispatch(message) {
    const params = bag(message.params);
    const outright = refusedOutright(message.method, params, message.sessionId);
    if (outright) throw new Error(outright);
    switch (message.method) {
      case 'Target.getTargets':
        return this.targets();
      case 'Target.getTargetInfo':
        return this.targetInfo(params);
      case 'Target.setDiscoverTargets':
        return this.discover(params);
      case 'Target.createTarget':
        return this.create(params);
      case 'Target.closeTarget':
        return this.closeTarget(params);
      case 'Target.activateTarget':
        await activate(this.api, await this.guarded(params));
        return {};
      case 'Target.attachToTarget':
        return this.attach(params);
      case 'Target.detachFromTarget':
        return this.detach(params);
      case 'Browser.getVersion':
        return version();
      default:
        return this.sessionCommand(
          message,
          message.method === 'Runtime.addBinding' ? scopedBinding(params) : params
        );
    }
  }

  leaves(tab, next) {
    if (!next) return false;
    return blocked(next, 'unprotected', guard.url(tab.pageUrl ?? ''));
  }

  protectedOrigin(origin) {
    if (!origin || origin === 'null' || origin === '://') return false;
    return guard.url(origin);
  }

  isMain(tab, frameId) {
    return !tab.mainFrameId || !frameId || frameId === tab.mainFrameId;
  }

  mentions(value, depth = 0) {
    if (depth > 12) return false;
    if (typeof value === 'string') {
      return value.includes('://') && urlProtected(guard, value, { readOnly: true });
    }
    if (Array.isArray(value)) return value.some((item) => this.mentions(item, depth + 1));
    if (value !== null && typeof value === 'object') {
      return Object.values(value).some((item) => this.mentions(item, depth + 1));
    }
    return false;
  }

  classify(tab, params) {
    const id = params?.requestId;
    if (typeof id !== 'string') return undefined;
    const url = requestUrl(params);
    if (!url && params.documentURL === undefined && params.frameId === undefined) {
      return tab.requests.get(id);
    }
    const started =
      urlProtected(guard, textOf(params.documentURL)) ||
      urlProtected(guard, textOf(params.initiator?.url)) ||
      this.frameProtected(tab, params.frameId);
    const isProtected = started || urlProtected(guard, url);
    const value = tab.requests.get(id) === true || isProtected;
    if (url || started) tab.requests.set(id, value);
    return tab.requests.get(id);
  }

  broadcast(tabId, method, params) {
    const tab = this.tabState(tabId);
    const runtime = method.startsWith('Runtime.');
    tab?.worlds.learn(params);
    for (const sessionId of this.sessionsOf(tabId)) {
      if (runtime && !tab?.runtime.has(sessionId)) continue;
      this.post({ method, params, sessionId });
    }
  }

  hop(tabId, tab, method, p) {
    if (method !== 'Network.requestWillBeSent' || typeof p.requestId !== 'string') return false;
    const from = textOf(p.redirectResponse?.url);
    if (!from || urlProtected(guard, from) || !urlProtected(guard, textOf(p.request?.url))) {
      return false;
    }
    tab.requests.set(p.requestId, true);
    tab.held.delete(p.requestId);
    if (this.frameProtected(tab, p.frameId) || tab.worlds.hides(p)) return true;
    if (tab.hops.get(p.requestId) !== 'done') tab.hops.set(p.requestId, hopOf(p.redirectResponse));
    if (tab.hops.size > 500) tab.hops.delete(tab.hops.keys().next().value);
    const out = stripProtectedCookies(guard, p);
    const redirect = withoutSetCookie(out.redirectResponse);
    this.broadcast(tabId, method, {
      ...out,
      request: { ...out.request, headers: withoutCookieHeaders(out.request?.headers) },
      redirectResponse: {
        ...redirect,
        requestHeaders: withoutCookieHeaders(redirect.requestHeaders),
      },
    });
    return true;
  }

  redirectExtra(tabId, tab, method, params, known) {
    if (method !== 'Network.responseReceivedExtraInfo') return false;
    if (!REDIRECTS.has(params.statusCode) || typeof params.requestId !== 'string') return false;
    const id = params.requestId;
    const awaited = hopMatches(tab.hops.get(id), params);
    const named = responseNamesProtected(method, params, anyProtected);
    if (known === true ? !awaited : !named) return false;
    tab.hops.set(id, 'done');
    tab.requests.set(id, true);
    this.broadcast(tabId, method, withoutSetCookie(stripProtectedCookies(guard, params)));
    return true;
  }

  deliver(tabId, tab, method, params) {
    const id = typeof params?.requestId === 'string' ? params.requestId : undefined;
    const known = this.classify(tab, params);
    if (this.redirectExtra(tabId, tab, method, params, known)) return;
    if (known === true) {
      tab.held.delete(id);
      return;
    }
    let out = params;
    if (method.startsWith('Network.')) out = stripProtectedCookies(guard, out);
    if (this.mentions(out) || responseNamesProtected(method, out, anyProtected)) {
      if (id !== undefined) {
        tab.requests.set(id, true);
        tab.held.delete(id);
      }
      return;
    }
    if (id !== undefined && method.endsWith('ExtraInfo') && !tab.settled.has(id)) {
      const held = tab.held.get(id) ?? [];
      held.push([method, out]);
      tab.held.set(id, held);
      if (tab.held.size > 500) tab.held.delete(tab.held.keys().next().value);
      return;
    }
    this.broadcast(tabId, method, out);
    if (id !== undefined && SETTLES.has(method)) {
      const held = tab.held.get(id) ?? [];
      tab.held.delete(id);
      if (known !== false) return;
      tab.settled.add(id);
      if (tab.settled.size > 5000) tab.settled.delete(tab.settled.values().next().value);
      for (const [m, p] of held) this.broadcast(tabId, m, p);
    }
  }

  async protectedDocument(tabId, tab, requestId, frameId, url) {
    if (this.isMain(tab, frameId)) this.state.failed.set(tabId, unfragmented(url));
    await this.send(tabId, 'Fetch.failRequest', {
      requestId,
      errorReason: 'BlockedByClient',
    }).catch(() => undefined);
  }

  watchChild(tabId, method, p) {
    const url = textOf(p.targetInfo?.url);
    const hidden = urlProtected(guard, url) || uiType(p.targetInfo?.type);
    if (method === 'Target.attachedToTarget') {
      if (hidden) {
        void this.api.debugger
          .sendCommand({ tabId }, 'Target.detachFromTarget', { sessionId: textOf(p.sessionId) })
          .catch(() => undefined);
        return;
      }
      const sessionId = textOf(p.sessionId);
      if (!sessionId) return;
      void this.api.debugger
        .sendCommand({ tabId, sessionId }, 'Runtime.runIfWaitingForDebugger', {})
        .catch(() => undefined);
      return;
    }
    if (method === 'Target.targetInfoChanged' && hidden) {
      void this.api.debugger
        .sendCommand({ tabId }, 'Target.detachFromTarget', {
          targetId: textOf(p.targetInfo?.targetId),
        })
        .catch(() => undefined);
    }
  }

  headsToProtected(method, p) {
    if (method === 'Network.requestWillBeSent') {
      return p.type === 'Document' && urlProtected(guard, textOf(p.request?.url));
    }
    if (
      method === 'Page.frameRequestedNavigation' ||
      method === 'Page.frameStartedNavigating' ||
      method === 'Page.frameScheduledNavigation'
    ) {
      return urlProtected(guard, textOf(p.url));
    }
    return false;
  }

  watchFrame(tabId, tab, frame) {
    const url = textOf(frame.url);
    const isProtected =
      this.protectedOrigin(textOf(frame.securityOrigin)) || urlProtected(guard, url);
    if (!frame.parentId && url.startsWith('chrome-error:')) {
      tab.mainFrameId = textOf(frame.id);
      return urlProtected(guard, textOf(frame.unreachableUrl));
    }
    if (!frame.parentId) {
      this.state.failed.delete(tabId);
      tab.mainFrameId = textOf(frame.id);
      if (isProtected || this.leaves(tab, url)) {
        this.release(tabId);
        return true;
      }
      tab.pageUrl = url;
    }
    if (typeof frame.id === 'string') tab.frames.set(frame.id, isProtected);
    return isProtected;
  }

  watchContext(tabId, tab, ctx) {
    const frameId = textOf(ctx.auxData?.frameId);
    const isProtected = this.protectedOrigin(textOf(ctx.origin));
    if (isProtected && ctx.auxData?.isDefault && frameId && frameId === tab.mainFrameId) {
      this.release(tabId);
      return true;
    }
    const kind = tab.worlds.hideable(ctx, tab.mainFrameId, (origin) =>
      this.protectedOrigin(origin)
    );
    if (
      ctx.auxData?.isDefault !== false &&
      frameId &&
      frameId !== tab.mainFrameId &&
      unknownFrame({ securityOrigin: ctx.origin, url: ctx.origin })
    ) {
      tab.uncertain ??= new Set();
      tab.uncertain.add(frameId);
      while (tab.uncertain.size > 1000) tab.uncertain.delete(tab.uncertain.values().next().value);
    }
    if (tab.worlds.add(ctx, kind)) this.quietProfilers(tabId);
    return kind !== undefined;
  }

  pruneFrames(tab, tree) {
    if (!Array.isArray(tree?.childFrames)) return;
    tree.childFrames = tree.childFrames.filter((node) => {
      const frame = node?.frame ?? {};
      const hidden = this.frameHidden(tab, frame);
      if (hidden && typeof frame.id === 'string') tab.frames.set(frame.id, true);
      return !hidden;
    });
    for (const node of tree.childFrames) this.pruneFrames(tab, node);
  }

  quietProfilers(tabId) {
    for (const method of ['Debugger.disable', 'Profiler.disable', 'HeapProfiler.disable']) {
      void this.send(tabId, method, {}).catch(() => undefined);
    }
  }

  watch(tabId, tab, method, p) {
    if (this.headsToProtected(method, p)) return true;
    if (method === 'Page.frameNavigated') return this.watchFrame(tabId, tab, p.frame ?? {});
    if (method === 'Runtime.executionContextCreated') {
      return this.watchContext(tabId, tab, p.context ?? {});
    }
    if (method === 'Runtime.executionContextDestroyed') {
      return tab.worlds.remove(p.executionContextId);
    }
    if (method === 'Runtime.executionContextsCleared') {
      tab.worlds.clear();
      return false;
    }
    if (method === 'Page.navigatedWithinDocument' && this.isMain(tab, textOf(p.frameId))) {
      const next = textOf(p.url);
      if (this.leaves(tab, next)) {
        this.release(tabId);
        return true;
      }
      if (next) tab.pageUrl = next;
    }
    return false;
  }

  async onEvent(source, method, params) {
    if (typeof source?.sessionId === 'string') return;
    const tabId = source?.tabId;
    const tab = this.tabState(tabId);
    if (!tab) return;
    const p = params ?? {};
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      tab.networkStreams.end(textOf(p.requestId));
    }
    if (method === 'Network.dataReceived' && typeof p.data === 'string') {
      try {
        tab.networkStreams.read(textOf(p.requestId), p.data);
      } catch {
        return;
      }
    }
    if (method === 'Fetch.requestPaused' || method === 'Fetch.authRequired') {
      void this.onPaused(tabId, method, p).catch(() => undefined);
      return;
    }
    if (method.startsWith('Target.')) {
      this.watchChild(tabId, method, p);
      return;
    }
    if (this.hop(tabId, tab, method, p)) return;
    if (this.watch(tabId, tab, method, p)) return;
    if (profiled(method) && tab.worlds.foreign) return;
    if (tab.worlds.hides(p)) return;
    if (this.frameProtected(tab, p.frameId)) return;
    if (sealedRead(method) && !(await this.sealEvent(tabId, tab, method, p))) return;
    this.deliver(tabId, tab, method, p);
  }

  async announce(tab, created) {
    if (!this.state.discover || typeof tab?.id !== 'number') return;
    if (await tabBlocked(this.api, this.view(tab))) this.release(tab.id);
    const known = this.state.seen.has(tab.id);
    this.state.seen.add(tab.id);
    this.post({
      method: known && !created ? 'Target.targetInfoChanged' : 'Target.targetCreated',
      params: { targetInfo: this.info(tab) },
    });
  }

  onSource(details) {
    if (!this.state.discover || !this.state.seen.has(details?.tabId)) return;
    void this.api.tabs
      .get(details.tabId)
      .then((tab) => this.announce(tab, false))
      .catch(() => undefined);
  }

  onCreated(tab) {
    void this.announce(tab, true).catch(() => undefined);
  }

  onUpdated(tabId, changeInfo, tab) {
    const change = changeInfo ?? {};
    const current = { id: tabId, ...(tab ?? {}) };
    const t = this.tabState(tabId);
    const same = change.url !== undefined && this.failedAt(tabId, change.url);
    if (change.url !== undefined && !same) this.state.failed.delete(tabId);
    if (t || this.state.ownedTabs.has(tabId)) {
      const probe = t ?? { pageUrl: '' };
      if (!same && this.leaves(probe, textOf(change.url))) {
        this.release(tabId);
      } else {
        void this.recheck(tabId);
      }
    }
    if (!this.state.discover) return;
    if (change.url === undefined && change.title === undefined && change.pendingUrl === undefined) {
      return;
    }
    void this.announce(current, false).catch(() => undefined);
  }

  onRemoved(tabId) {
    this.state.failed.delete(tabId);
    this.release(tabId);
    if (this.state.seen.delete(tabId) && this.state.discover) {
      this.post({ method: 'Target.targetDestroyed', params: { targetId: String(tabId) } });
    }
  }

  async recheck(tabId) {
    if (!this.tabState(tabId) && !this.state.ownedTabs.has(tabId)) return;
    try {
      const current = await this.read(tabId);
      const url = textOf(current?.url);
      if (blocked(url, await openerOf(this.api, current))) {
        this.release(tabId);
        return;
      }
      const tab = this.tabState(tabId);
      if (tab) tab.pageUrl = url;
    } catch {
      this.release(tabId);
    }
  }

  onDetach(source) {
    const tabId = source?.tabId;
    if (!this.state.tabs.has(tabId) && !this.state.ownedTabs.has(tabId)) return;
    const sessions = this.sessionsOf(tabId);
    this.forget(tabId);
    for (const sessionId of sessions) {
      this.post({
        method: 'Target.detachedFromTarget',
        params: { sessionId, targetId: String(tabId) },
        sessionId,
      });
    }
  }

  async run(message) {
    try {
      this.post({ id: message.id, result: await this.dispatch(message) }, message.method);
    } catch (error) {
      this.post({ id: message.id, error: String(error?.message ?? error) });
    }
  }

  shutdown() {
    if (this.closed) return;
    this.closed = true;
    this.api.debugger.onEvent.removeListener(this.onEvent);
    this.api.debugger.onDetach.removeListener(this.onDetach);
    this.api.tabs.onUpdated?.removeListener(this.onUpdated);
    this.api.tabs.onCreated?.removeListener(this.onCreated);
    this.api.tabs.onRemoved?.removeListener(this.onRemoved);
    this.api.webNavigation?.onCreatedNavigationTarget?.removeListener(this.onSource);
    const owned = [...this.state.ownedTabs];
    for (const tabId of [...this.state.inflight.keys()]) this.drop(tabId);
    this.state.ownedTabs.clear();
    this.state.sessions.clear();
    this.state.tabs.clear();
    for (const tabId of owned) this.api.debugger.detach({ tabId }).catch(() => undefined);
  }

  handle(message) {
    if (!isCdp(message)) return false;
    if (!this.closed) {
      const serial =
        message.method === 'Target.attachToTarget' ||
        message.method === 'Target.detachFromTarget' ||
        message.method === 'Target.closeTarget' ||
        message.method === 'Target.createTarget';
      const task = serial
        ? (this.chain = this.chain.then(() => this.run(message)).catch(() => undefined))
        : this.run(message).catch(() => undefined);
      this.pending = Promise.all([this.pending, task]).then(() => undefined);
    }
    return true;
  }

  close() {
    this.shutdown();
  }

  settled() {
    return this.pending;
  }
}

export function listen(port, extensionId, api) {
  if (port.name !== 'slicc-fetch') return null;
  if (!trusted(port.sender, extensionId)) {
    port.disconnect();
    return null;
  }
  return new Connection(port, api);
}
