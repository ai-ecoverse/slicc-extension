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

const guard = protectedOrigins(protectedRules);

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

function refusal() {
  throw new Error(protectedRules.refusal);
}

function blocked(url, opener, previous = false) {
  return guard.target({ url: textOf(url), opener, previous });
}

function demand(url, source = {}) {
  if (blocked(url, source.opener, source.previous === true)) refusal();
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

async function openerOf(api, tab) {
  if (typeof tab?.openerTabId !== 'number') return 'unprotected';
  let opener;
  try {
    opener = await api.tabs.get(tab.openerTabId);
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

async function demandTab(api, tab) {
  const opener = await openerOf(api, tab);
  const url = textOf(tab?.url);
  const pending = textOf(tab?.pendingUrl);
  if (blocked(url, opener)) refusal();
  if (pending && pending !== url && blocked(pending, opener, guard.url(url))) refusal();
  return { opener, url };
}

const _sixHosts = ['www.sliccy.ai'];
const _exL = ['www', 'vault', 'vault-preview', 'get', 'mcpcat'];
const _exP = ['vault-'];

function allowedHost(hostname) {
  if (!hostname.endsWith('.sliccy.ai') || hostname === 'sliccy.ai') return false;
  const label = hostname.slice(0, -'.sliccy.ai'.length);
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
    throw new Error(`Invalid targetId: ${targetId}`);
  }
  return tabId;
}

function sessionFor(state, tabId) {
  for (const [sessionId, attached] of state.sessionToTab) {
    if (attached === tabId) return sessionId;
  }
  return undefined;
}

function forget(state, tabId) {
  state.ownedTabs.delete(tabId);
  state.attachRefCounts.delete(tabId);
  state.pageUrl.delete(tabId);
  state.mainFrameId.delete(tabId);
  for (const [sessionId, attached] of state.sessionToTab) {
    if (attached === tabId) state.sessionToTab.delete(sessionId);
  }
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

async function targets(api) {
  const listed = api.tabs.query({});
  const active = api.tabs
    .query({ active: true, lastFocusedWindow: true })
    .then((found) => (typeof found[0]?.id === 'number' ? found[0].id : undefined))
    .catch(() => undefined);
  const [tabs, activeId] = await Promise.all([listed, active]);
  return {
    targetInfos: tabs
      .filter((tab) => typeof tab.id === 'number')
      .map((tab) => ({
        targetId: String(tab.id),
        type: 'page',
        title: tab.title ?? '',
        url: tab.url ?? '',
        attached: false,
        active: tab.id === activeId,
      })),
  };
}

async function create(params, state, api) {
  const url = typeof params.url === 'string' ? params.url : '';
  if (guard.target({ url })) refusal();
  if (params.newWindow === true) {
    const created = await api.windows.create({
      url: url || 'about:blank',
      type: params.decorated === false ? 'popup' : 'normal',
      focused: params.background !== true,
    });
    const tabId = created?.tabs?.[0]?.id;
    if (typeof tabId !== 'number') throw new Error('chrome.windows.create did not return a tab id');
    return { targetId: String(tabId) };
  }
  const tab = await api.tabs.create({ url: url || 'about:blank', active: false });
  if (typeof tab?.id !== 'number') throw new Error('chrome.tabs.create did not return a tab id');
  return { targetId: String(tab.id) };
}

async function close(params, state, api) {
  const tabId = tabFrom(readTargetId(params));
  const owned = state.ownedTabs.has(tabId);
  forget(state, tabId);
  if (owned) await api.debugger.detach({ tabId }).catch(() => undefined);
  await api.tabs.remove(tabId);
  return { success: true };
}

async function attach(params, state, api) {
  if (params.flatten !== true) throw new Error('only flatten: true is supported');
  const targetId = readTargetId(params);
  const tabId = tabFrom(targetId);
  const tab = await readTab(api, tabId);
  const seen = await demandTab(api, tab);
  state.pageUrl.set(tabId, seen.url);
  if (!state.ownedTabs.has(tabId)) {
    await api.debugger.attach({ tabId }, '1.3');
    state.ownedTabs.add(tabId);
  }
  state.sessionToTab.set(targetId, tabId);
  state.attachRefCounts.set(tabId, (state.attachRefCounts.get(tabId) ?? 0) + 1);
  return { sessionId: targetId };
}

async function detach(params, state, api) {
  const sessionId = params.sessionId;
  if (typeof sessionId !== 'string') return {};
  const tabId = state.sessionToTab.get(sessionId);
  if (tabId === undefined) return {};
  const next = (state.attachRefCounts.get(tabId) ?? 1) - 1;
  if (next > 0) {
    state.attachRefCounts.set(tabId, next);
    return {};
  }
  const owned = state.ownedTabs.has(tabId);
  forget(state, tabId);
  if (owned) await api.debugger.detach({ tabId }).catch(() => undefined);
  return {};
}

async function pass(message, state, api) {
  const { method, params, sessionId } = message;
  const tabId = typeof sessionId === 'string' ? state.sessionToTab.get(sessionId) : undefined;
  if (tabId === undefined) {
    throw new Error(
      `No tab attached for sessionId: ${sessionId ?? '(none)'}. Attach to a target first.`
    );
  }
  const seen = await demandTab(api, await readTab(api, tabId));
  state.pageUrl.set(tabId, seen.url);
  if (method === 'Page.navigate') {
    demand(params?.url, { opener: 'unprotected', previous: guard.url(seen.url) });
  }
  if (method === 'Page.bringToFront') await activate(api, tabId);
  const result = await api.debugger.sendCommand({ tabId }, method, params);
  return result ?? {};
}

async function dispatch(message, state, api) {
  const params = bag(message.params);
  switch (message.method) {
    case 'Target.getTargets':
      return targets(api);
    case 'Target.createTarget':
      return create(params, state, api);
    case 'Target.closeTarget':
      return close(params, state, api);
    case 'Target.activateTarget':
      await activate(api, tabFrom(readTargetId(params)));
      return {};
    case 'Target.attachToTarget':
      return attach(params, state, api);
    case 'Target.detachFromTarget':
      return detach(params, state, api);
    default:
      return pass(message, state, api);
  }
}

function openCdp(port, api) {
  const state = {
    sessionToTab: new Map(),
    attachRefCounts: new Map(),
    ownedTabs: new Set(),
    pageUrl: new Map(),
    mainFrameId: new Map(),
  };
  let closed = false;
  let chain = Promise.resolve();
  let pending = Promise.resolve();

  function post(message) {
    if (closed) return;
    try {
      port.postMessage(message);
    } catch {
      return undefined;
    }
  }

  function destination(method, params) {
    if (params === null || typeof params !== 'object') return '';
    if (method === 'Page.frameNavigated') return textOf(params.frame?.url);
    if (method === 'Page.navigatedWithinDocument' || method === 'Page.frameRequestedNavigation') {
      return textOf(params.url);
    }
    if (method === 'Network.requestWillBeSent' && params.type === 'Document') {
      return textOf(params.request?.url);
    }
    if (method === 'Target.targetInfoChanged') return textOf(params.targetInfo?.url);
    return '';
  }

  function release(tabId) {
    const sessionId = sessionFor(state, tabId);
    const owned = state.ownedTabs.has(tabId);
    if (sessionId === undefined && !owned) return;
    if (sessionId !== undefined) {
      post({
        method: 'Target.detachedFromTarget',
        params: { sessionId, targetId: String(tabId) },
        sessionId,
      });
    }
    forget(state, tabId);
    if (owned) void api.debugger.detach({ tabId }).catch(() => undefined);
  }

  function leaves(tabId, next) {
    if (!next) return false;
    return blocked(next, 'unprotected', guard.url(state.pageUrl.get(tabId) ?? ''));
  }

  function protectedOrigin(origin) {
    if (!origin || origin === 'null' || origin === '://') return false;
    return guard.url(origin);
  }

  function onEvent(source, method, params) {
    const tabId = source?.tabId;
    if (method === 'Page.frameNavigated' && !params?.frame?.parentId) {
      state.mainFrameId.set(tabId, textOf(params?.frame?.id));
      const origin = textOf(params?.frame?.securityOrigin);
      if (protectedOrigin(origin)) {
        release(tabId);
        return;
      }
    }
    if (method === 'Runtime.executionContextCreated') {
      const ctx = params?.context;
      const frameId = textOf(ctx?.auxData?.frameId);
      const mainId = state.mainFrameId.get(tabId);
      if (
        ctx?.auxData?.isDefault &&
        frameId &&
        mainId &&
        frameId === mainId &&
        protectedOrigin(textOf(ctx?.origin))
      ) {
        release(tabId);
        return;
      }
    }
    const sessionId = sessionFor(state, tabId);
    if (sessionId === undefined) return;
    const next = destination(method, params);
    if (leaves(tabId, next)) {
      release(tabId);
      return;
    }
    if (next && !blocked(next, 'unknown')) state.pageUrl.set(tabId, next);
    post({ method, params: params ?? {}, sessionId });
  }

  function onUpdated(tabId, changeInfo, tab) {
    if (sessionFor(state, tabId) === undefined && !state.ownedTabs.has(tabId)) return;
    const pending = textOf(changeInfo?.pendingUrl) || textOf(tab?.pendingUrl);
    if (leaves(tabId, textOf(changeInfo?.url)) || leaves(tabId, pending)) {
      release(tabId);
      return;
    }
    void recheck(tabId);
  }

  async function recheck(tabId) {
    if (sessionFor(state, tabId) === undefined && !state.ownedTabs.has(tabId)) return;
    try {
      const seen = await demandTab(api, await readTab(api, tabId));
      if (sessionFor(state, tabId) === undefined && !state.ownedTabs.has(tabId)) return;
      state.pageUrl.set(tabId, seen.url);
    } catch {
      release(tabId);
    }
  }

  function onDetach(source) {
    const tabId = source?.tabId;
    const sessionId = sessionFor(state, tabId);
    if (sessionId === undefined) return;
    forget(state, tabId);
    post({
      method: 'Target.detachedFromTarget',
      params: { sessionId, targetId: String(tabId) },
      sessionId,
    });
  }

  async function run(message) {
    try {
      post({ id: message.id, result: await dispatch(message, state, api) });
    } catch (error) {
      post({ id: message.id, error: String(error?.message ?? error) });
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    api.debugger.onEvent.removeListener(onEvent);
    api.debugger.onDetach.removeListener(onDetach);
    api.tabs.onUpdated?.removeListener(onUpdated);
    const owned = [...state.ownedTabs];
    state.ownedTabs.clear();
    state.sessionToTab.clear();
    state.attachRefCounts.clear();
    for (const tabId of owned) api.debugger.detach({ tabId }).catch(() => undefined);
  }

  api.debugger.onEvent.addListener(onEvent);
  api.debugger.onDetach.addListener(onDetach);
  api.tabs.onUpdated?.addListener(onUpdated);
  port.onDisconnect.addListener(close);

  return {
    handle(message) {
      if (!isCdp(message)) return false;
      if (!closed) {
        const serial =
          message.method === 'Target.attachToTarget' ||
          message.method === 'Target.detachFromTarget' ||
          message.method === 'Target.closeTarget' ||
          message.method === 'Target.createTarget';
        const task = serial
          ? (chain = chain.then(() => run(message)).catch(() => undefined))
          : run(message).catch(() => undefined);
        pending = Promise.all([pending, task]).then(() => undefined);
      }
      return true;
    },
    close,
    settled: () => pending,
  };
}

export function listen(port, extensionId, api) {
  if (port.name !== 'slicc-fetch') return null;
  if (!trusted(port.sender, extensionId)) {
    port.disconnect();
    return null;
  }
  return openCdp(port, api);
}
