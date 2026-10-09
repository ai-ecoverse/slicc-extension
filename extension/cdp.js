export function trusted(sender, extensionId) {
  if (!sender || sender.id !== extensionId || !URL.canParse(sender.url)) return false;
  const { protocol, hostname } = new URL(sender.url);
  return protocol === 'https:' && (hostname === 'sliccy.ai' || hostname.endsWith('.sliccy.ai'));
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

async function create(params, api) {
  const url = typeof params.url === 'string' ? params.url : 'about:blank';
  if (params.newWindow === true) {
    const created = await api.windows.create({
      url,
      type: params.decorated === false ? 'popup' : 'normal',
      focused: params.background !== true,
    });
    const tabId = created?.tabs?.[0]?.id;
    if (typeof tabId !== 'number') throw new Error('chrome.windows.create did not return a tab id');
    return { targetId: String(tabId) };
  }
  const tab = await api.tabs.create({ url, active: false });
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
      return create(params, api);
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
  };
  let closed = false;
  let chain = Promise.resolve();

  function post(message) {
    if (closed) return;
    try {
      port.postMessage(message);
    } catch {
      return undefined;
    }
  }

  function onEvent(source, method, params) {
    const sessionId = sessionFor(state, source?.tabId);
    if (sessionId === undefined) return;
    post({ method, params: params ?? {}, sessionId });
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
    const owned = [...state.ownedTabs];
    state.ownedTabs.clear();
    state.sessionToTab.clear();
    state.attachRefCounts.clear();
    for (const tabId of owned) api.debugger.detach({ tabId }).catch(() => undefined);
  }

  api.debugger.onEvent.addListener(onEvent);
  api.debugger.onDetach.addListener(onDetach);
  port.onDisconnect.addListener(close);

  return {
    handle(message) {
      if (!isCdp(message)) return false;
      if (!closed) chain = chain.then(() => run(message)).catch(() => undefined);
      return true;
    },
    close,
    settled: () => chain,
  };
}

export function listen(port, extensionId, api) {
  if (port.name !== 'slicc-fetch' || !trusted(port.sender, extensionId)) {
    port.disconnect();
    return null;
  }
  return openCdp(port, api);
}
