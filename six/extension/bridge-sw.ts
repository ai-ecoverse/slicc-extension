import {
  type CDPPayload,
  EXTENSION_BRIDGE_PORT_NAME,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
  type ExtensionBridgeCdpRequest,
  type ExtensionBridgeDiscovery,
  type ExtensionBridgeEnvelope,
  type ExtensionBridgeLick,
  type ExtensionBridgeOpenSettings,
  isBridgeVersionMismatch,
  isExtensionBridgeEnvelope,
  SLICC_HOSTED_ORIGIN,
  type TargetInfo,
} from '@slicc/shared-ts';
import {
  ABOUT_WRAPPED,
  Bounded,
  redacted,
  redactProtected,
  redactText,
  TabShield,
  wrapsAbout,
} from './cdp-shield.js';
import { EXTENSION_FRAME, foreignFrameError } from './cdp-worlds.js';
import { tabHasProtectedFrame } from './protected-frames-sw.js';
import {
  isProtectedTab,
  isProtectedTarget,
  isProtectedUrl,
  PROTECTED_REFUSAL,
  PROTECTED_RULES,
  refuseUnparseableDestination,
} from './protected-origins.js';

interface BridgeTargetAttachResult extends CDPPayload {
  sessionId: string;
}

type BridgeTargetDetachResult = CDPPayload;

interface BridgeTargetCreateResult extends CDPPayload {
  targetId: string;
}

interface BridgeTargetCloseResult extends CDPPayload {
  success: true;
}

interface BridgeTargetGetTargetsResult extends CDPPayload {
  targetInfos: TargetInfo[];
}

interface BridgeWindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  windowState: string;
}

interface BridgeGetWindowForTargetResult extends CDPPayload {
  windowId: number;
  bounds: BridgeWindowBounds;
}

interface BridgeGetWindowBoundsResult extends CDPPayload {
  bounds: BridgeWindowBounds;
}

export interface BridgeCreateWindowOptions {
  url: string;
  type: 'normal' | 'popup';
  focused: boolean;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
}

export interface BridgeChromeWindowInfo {
  windowId: number;
  tabId: number;
  left: number;
  top: number;
  width: number;
  height: number;
  state: string;
}

function readTargetIdParam(params: CDPPayload, label = 'targetId'): string {
  const targetId = params[label];
  if (typeof targetId !== 'string') {
    throw new Error(`Invalid targetId: ${String(targetId)}`);
  }
  return targetId;
}

function readCreateTargetUrl(params: CDPPayload): string {
  const url = params['url'];
  return typeof url === 'string' && url !== '' ? url : 'about:blank';
}

export const RELATIVE_REFUSAL =
  "slicc: refused: a relative url would open one of the extension's own pages";

function exactTabId(targetId: string): number {
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0 || String(tabId) !== targetId) {
    throw new Error(`slicc: refused: Invalid targetId: ${targetId} is not a tab`);
  }
  return tabId;
}

const ERROR_PAGE = 'chrome-error://chromewebdata/';
const DISCOVERY_REFUSAL =
  'slicc: refused: the extension bridge does not report target discovery events';

const failedTabs = new Bounded<Bounded<true>>(500);

function failedBefore(tabId: number, url: string | undefined): boolean {
  if (!url) return false;
  return failedTabs.get(String(tabId))?.has(url.split('#')[0] ?? url) === true;
}

function failuresOf(tabId: number): Bounded<true> {
  const known = failedTabs.get(String(tabId));
  if (known) return known;
  const fresh = new Bounded<true>(200);
  failedTabs.set(String(tabId), fresh);
  return fresh;
}

function failedView(tabId: number, tab: ChromeTab | undefined): ChromeTab | undefined {
  if (!tab || !failedBefore(tabId, tab.url)) return tab;
  const pending = failedBefore(tabId, tab.pendingUrl) ? '' : tab.pendingUrl;
  return { ...tab, url: ERROR_PAGE, pendingUrl: pending };
}

async function confirmFailure(tabId: number, deps: BridgeSwDeps): Promise<void> {
  const tab = await deps.getTab(tabId);
  if (!failedBefore(tabId, tab?.url) && !failedBefore(tabId, tab?.pendingUrl)) return;
  const tree = await deps.sendDebuggerCommand(tabId, 'Page.getFrameTree').catch(() => undefined);
  const frameTree = tree?.['frameTree'] as CDPPayload | undefined;
  const frame = frameTree?.['frame'] as CDPPayload | undefined;
  const unreachable = frame?.['unreachableUrl'];
  if (typeof unreachable === 'string' && failedBefore(tabId, unreachable)) return;
  failedTabs.get(String(tabId))?.clear();
}

async function protectedNow(tabId: number, deps: BridgeSwDeps): Promise<boolean> {
  return isProtectedTab(failedView(tabId, await deps.getTab(tabId)), deps.getTab);
}

async function guardedTab(params: CDPPayload, deps: BridgeSwDeps): Promise<number> {
  const tabId = exactTabId(readTargetIdParam(params));
  if (await protectedNow(tabId, deps)) throw new Error(PROTECTED_REFUSAL);
  return tabId;
}

const LEADER_TAB_ID_KEY = 'slicc_leader_tab_id';

export const BRIDGE_ALLOWED_ORIGINS: readonly string[] = [SLICC_HOSTED_ORIGIN];

export const BRIDGE_DEV_ORIGINS: readonly string[] = [
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

export interface BridgeSwDeps {
  readStoredLeaderTabId: () => Promise<number | undefined>;
  writeStoredLeaderTabId?: (tabId: number) => Promise<void>;
  maybeUnmaskCdpFrame: (
    tabId: number,
    method: string,
    params: CDPPayload | undefined
  ) => Promise<CDPPayload | undefined>;
  attachDebugger: (tabId: number) => Promise<boolean>;
  detachDebugger: (tabId: number) => Promise<void>;
  sendDebuggerCommand: (tabId: number, method: string, params?: CDPPayload) => Promise<CDPPayload>;
  subscribeDebuggerEvents: (
    handler: (tabId: number, method: string, params?: CDPPayload) => void
  ) => () => void;
  queryTabs: () => Promise<ChromeTab[]>;
  queryActiveTabId: () => Promise<number | undefined>;
  getTab: (tabId: number) => Promise<ChromeTab | undefined>;
  createTab: (url: string) => Promise<number>;
  createWindow: (opts: BridgeCreateWindowOptions) => Promise<BridgeChromeWindowInfo>;
  getWindow: (windowId: number) => Promise<BridgeChromeWindowInfo>;
  updateWindow: (
    windowId: number,
    props: {
      left?: number;
      top?: number;
      width?: number;
      height?: number;
      state?: string;
      focused?: boolean;
    }
  ) => Promise<BridgeChromeWindowInfo>;
  removeTab: (tabId: number) => Promise<void>;
  activateTab: (tabId: number) => Promise<void>;
  showTab: (tabId: number) => Promise<void>;
  allowedOrigins?: readonly string[];
  tabHasProtectedFrame?: (tabId: number) => Promise<boolean>;
  onLeaderJoinUrl?: (joinUrl: string | null) => void;
}

export interface PinResult {
  ok: boolean;
  reason?: string;
}

function senderUrlIsLeaderTab(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    return new URL(rawUrl).searchParams.get('slicc') === 'leader';
  } catch {
    return false;
  }
}

export async function validateBridgePin(
  sender: ChromeMessageSender | undefined,
  deps: Pick<BridgeSwDeps, 'readStoredLeaderTabId' | 'writeStoredLeaderTabId' | 'allowedOrigins'>
): Promise<PinResult> {
  const allowed = deps.allowedOrigins ?? BRIDGE_ALLOWED_ORIGINS;
  if (!sender) return { ok: false, reason: 'no-sender' };
  if (!sender.origin || !allowed.includes(sender.origin)) {
    return { ok: false, reason: 'origin-not-allowed' };
  }
  const senderTabId = sender.tab?.id;
  if (typeof senderTabId !== 'number') {
    return { ok: false, reason: 'no-sender-tab' };
  }
  if (sender.frameId !== 0) {
    return { ok: false, reason: 'not-top-frame' };
  }
  const storedTabId = await deps.readStoredLeaderTabId();
  if (storedTabId === undefined) {
    if (senderUrlIsLeaderTab(sender.url) && deps.writeStoredLeaderTabId) {
      await deps.writeStoredLeaderTabId(senderTabId);
      return { ok: true };
    }
    return { ok: false, reason: 'leader-tab-not-pinned' };
  }
  if (storedTabId !== senderTabId) {
    return { ok: false, reason: 'sender-tab-not-leader' };
  }
  return { ok: true };
}

interface PortState {
  channelId: string | null;
  sessionToTab: Map<string, number>;
  attachRefCounts: Map<number, number>;
  ownedTabs: Set<number>;
  runtimeTabs: Set<number>;
  pageSessions: Set<string>;
  lifecycleSessions: Set<string>;
  unsubscribeEvents: (() => void) | null;
  emit: (tabId: number, method: string, params?: CDPPayload) => void;
  announce: (method: string, params: CDPPayload) => void;
  cut: Set<string>;
  leaderTabId: number | undefined;
}

const welcomedLeaderPorts = new Map<ChromeRuntimePort, string>();
const fronts = new Map<number, { current: number; previous?: number }>();

export function noteBridgeTabActivated(info: { tabId: number; windowId: number }): void {
  fronts.set(info.windowId, { current: info.tabId, previous: fronts.get(info.windowId)?.current });
}

export function noteBridgeWindowRemoved(windowId: number): void {
  fronts.delete(windowId);
}

function frontBefore(windowId: number, tabId: number): number | undefined {
  const seen = fronts.get(windowId);
  return seen?.current === tabId ? seen.previous : seen?.current;
}

async function seedFronts(deps: BridgeSwDeps): Promise<void> {
  for (const tab of await deps.queryTabs()) {
    if (tab.active && typeof tab.id === 'number' && typeof tab.windowId === 'number') {
      if (!fronts.has(tab.windowId)) fronts.set(tab.windowId, { current: tab.id });
    }
  }
}

export function noteBridgeTabOpened(
  tabId: number | undefined,
  openerId: number | undefined,
  deps: BridgeSwDeps
): void {
  for (const state of liveBridgePortStates.values()) {
    keepLeaderFront(state, tabId, openerId, deps).catch(() => {});
  }
}

const FRAME_EVENTS = [
  'onBeforeNavigate',
  'onCommitted',
  'onDOMContentLoaded',
  'onCompleted',
  'onErrorOccurred',
  'onHistoryStateUpdated',
  'onReferenceFragmentUpdated',
  'onTabReplaced',
] as const;

export function installBridgeFrontListeners(deps: BridgeSwDeps): void {
  chrome.tabs.onActivated.addListener(noteBridgeTabActivated);
  chrome.windows.onRemoved.addListener(noteBridgeWindowRemoved);
  chrome.tabs.onCreated.addListener((tab) => noteBridgeTabOpened(tab.id, tab.openerTabId, deps));
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    noteBridgeTabChanged(details.tabId);
    noteBridgeTabChanged(details.sourceTabId);
    noteBridgeTabOpened(details.tabId, details.sourceTabId, deps);
  });
  for (const name of FRAME_EVENTS) chrome.webNavigation[name].addListener(noteBridgeFrames);
}

export function noteBridgeFrames(details: { tabId: number; replacedTabId?: number }): void {
  noteBridgeTabChanged(details.tabId);
  if (details.replacedTabId !== undefined) noteBridgeTabChanged(details.replacedTabId);
}

export function noteBridgeTabChanged(tabId: number): void {
  tabShields.get(tabId)?.invalidate();
}

async function keepLeaderFront(
  state: PortState,
  tabId: number | undefined,
  openerId: number | undefined,
  deps: BridgeSwDeps
): Promise<void> {
  const leader = state.leaderTabId;
  if (leader === undefined || tabId === undefined || openerId === undefined) return;
  if (!state.ownedTabs.has(openerId) && ![...state.sessionToTab.values()].includes(openerId)) {
    return;
  }
  const [opened, client] = await Promise.all([deps.getTab(tabId), deps.getTab(leader)]);
  const windowId = client?.windowId;
  if (!opened?.active || windowId === undefined || frontBefore(windowId, tabId) !== leader) return;
  if (opened.windowId === windowId) await deps.showTab(leader);
  else await deps.updateWindow(windowId, { focused: true });
}
const liveBridgePortStates = new Map<ChromeRuntimePort, PortState>();

function invalidatePortDebuggerAttachment(state: PortState, tabId: number): void {
  state.ownedTabs.delete(tabId);
  state.attachRefCounts.delete(tabId);
  for (const [sessionId, attachedTabId] of state.sessionToTab) {
    if (attachedTabId === tabId) {
      state.sessionToTab.delete(sessionId);
      state.pageSessions.delete(sessionId);
      state.lifecycleSessions.delete(sessionId);
    }
  }
  state.runtimeTabs.delete(tabId);
}

export function notifyBridgeDebuggerDetached(tabId: number): void {
  tabShields.delete(tabId);
  for (const [port, state] of liveBridgePortStates) {
    const detachedSessionIds = [...state.sessionToTab]
      .filter(([, attachedTabId]) => attachedTabId === tabId)
      .map(([sessionId]) => sessionId);
    invalidatePortDebuggerAttachment(state, tabId);
    if (state.channelId === null) continue;
    for (const sessionId of detachedSessionIds) {
      try {
        port.postMessage({
          bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
          channelId: state.channelId,
          kind: 'cdp.event',
          method: 'Target.detachedFromTarget',
          params: { sessionId, targetId: String(tabId) },
        } satisfies ExtensionBridgeEnvelope);
      } catch {}
    }
  }
}

export function noteBridgeMainFrameResponse(details: {
  tabId: number;
  url: string;
  type: string;
}): void {
  if (details.type !== 'main_frame' || !failedBefore(details.tabId, details.url)) return;
  failedTabs.get(String(details.tabId))?.clear();
}

export function checkBridgeTabProtection(tabId: number, url: string | undefined): Set<number> {
  if (url && !failedBefore(tabId, url)) failedTabs.get(String(tabId))?.clear();
  if (!url || !isProtectedUrl(url)) return new Set<number>();
  if (failedBefore(tabId, url)) return new Set<number>();
  return cutProtectedTab(tabId);
}

function cutProtectedTab(tabId: number): Set<number> {
  const detached = new Set<number>();
  tabShields.delete(tabId);
  failedTabs.get(String(tabId))?.clear();
  for (const [port, state] of liveBridgePortStates) {
    const detachedSessionIds = [...state.sessionToTab]
      .filter(([, tid]) => tid === tabId)
      .map(([sid]) => sid);
    if (detachedSessionIds.length === 0) continue;
    for (const sid of detachedSessionIds) state.cut.add(sid);
    while (state.cut.size > 1000) {
      const oldest = state.cut.values().next().value;
      if (oldest !== undefined) state.cut.delete(oldest);
    }
    invalidatePortDebuggerAttachment(state, tabId);
    detached.add(tabId);
    if (state.channelId === null) continue;
    for (const sessionId of detachedSessionIds) {
      try {
        port.postMessage({
          bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
          channelId: state.channelId,
          kind: 'cdp.event',
          method: 'Target.detachedFromTarget',
          params: { sessionId, targetId: String(tabId), reason: PROTECTED_REFUSAL },
        } satisfies ExtensionBridgeEnvelope);
      } catch {}
    }
  }
  return detached;
}

const tabShields = new Map<number, TabShield>();

export function __clearTabShieldsForTest(): void {
  tabShields.clear();
  failedTabs.clear();
  shieldFanouts.clear();
}

type DebuggerEventSink = (tabId: number, method: string, params?: CDPPayload) => void;
interface ShieldFanout {
  sinks: Set<DebuggerEventSink>;
  unsubscribe: () => void;
}
const shieldFanouts = new Map<BridgeSwDeps['subscribeDebuggerEvents'], ShieldFanout>();

function subscribeShieldedEvents(deps: BridgeSwDeps, sink: DebuggerEventSink): () => void {
  const source = deps.subscribeDebuggerEvents;
  let fanout = shieldFanouts.get(source);
  if (!fanout) {
    const sinks = new Set<DebuggerEventSink>();
    const unsubscribe = source((tabId, method, params) => {
      const shield = tabShields.get(tabId);
      if (!shield) return;
      const deliver = (events: Awaited<ReturnType<TabShield['onEvent']>>): void => {
        for (const event of events) {
          for (const each of [...sinks]) each(tabId, event.method, event.params);
        }
      };
      const events = shield.onEvent(method, params);
      if (Array.isArray(events)) deliver(events);
      else void events.then(deliver).catch(() => undefined);
    });
    fanout = { sinks, unsubscribe };
    shieldFanouts.set(source, fanout);
  }
  fanout.sinks.add(sink);
  const current = fanout;
  return () => {
    current.sinks.delete(sink);
    if (current.sinks.size === 0 && shieldFanouts.get(source) === current) {
      shieldFanouts.delete(source);
      current.unsubscribe();
    }
  };
}

async function ensureTabShield(tabId: number, deps: BridgeSwDeps): Promise<void> {
  const existing = tabShields.get(tabId);
  if (existing) {
    try {
      await existing.install();
      return;
    } catch {
      throw new Error(`${PROTECTED_REFUSAL} (the tab could not be guarded)`);
    }
  }
  const shield = new TabShield(
    (method, params) => deps.sendDebuggerCommand(tabId, method, params),
    () => {
      cutProtectedTab(tabId);
      deps.detachDebugger(tabId).catch(() => {});
    },
    failuresOf(tabId),
    () => deps.getTab(tabId),
    (id) => deps.getTab(id),
    () => chrome.webNavigation.getAllFrames({ tabId })
  );
  tabShields.set(tabId, shield);
  try {
    await shield.install();
  } catch {
    if (tabShields.get(tabId) === shield) tabShields.delete(tabId);
    throw new Error(`${PROTECTED_REFUSAL} (the tab could not be guarded)`);
  }
}

function tabInUse(tabId: number): boolean {
  for (const state of liveBridgePortStates.values()) {
    for (const tid of state.sessionToTab.values()) if (tid === tabId) return true;
  }
  return false;
}

async function releaseTabShield(tabId: number, deps: BridgeSwDeps): Promise<void> {
  if (!tabShields.has(tabId) || tabInUse(tabId)) return;
  tabShields.delete(tabId);
  await deps.sendDebuggerCommand(tabId, 'Fetch.disable').catch(() => {});
}

export function postLickToWelcomedLeaderPorts(
  lick: Omit<ExtensionBridgeLick, 'bridge' | 'channelId'>
): number {
  let delivered = 0;
  for (const [port, channelId] of welcomedLeaderPorts) {
    try {
      port.postMessage({
        ...lick,
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId,
      } satisfies ExtensionBridgeLick);
      delivered += 1;
    } catch {}
  }
  return delivered;
}

export function postOpenSettingsToWelcomedLeaderPorts(): number {
  let delivered = 0;
  for (const [port, channelId] of welcomedLeaderPorts) {
    try {
      port.postMessage({
        kind: 'extension.open-settings',
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId,
      } satisfies ExtensionBridgeOpenSettings);
      delivered += 1;
    } catch {}
  }
  return delivered;
}

export function postDiscoveryToWelcomedLeaderPorts(
  discovery: Omit<ExtensionBridgeDiscovery, 'bridge' | 'channelId'>
): number {
  let delivered = 0;
  for (const [port, channelId] of welcomedLeaderPorts) {
    try {
      port.postMessage({
        ...discovery,
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId,
      } satisfies ExtensionBridgeDiscovery);
      delivered += 1;
    } catch {}
  }
  return delivered;
}

export function __clearWelcomedLeaderPortsForTest(): void {
  welcomedLeaderPorts.clear();
  liveBridgePortStates.clear();
}

export async function readStoredLeaderTabIdFromSession(): Promise<number | undefined> {
  try {
    const result = await chrome.storage.session.get(LEADER_TAB_ID_KEY);
    const raw = result[LEADER_TAB_ID_KEY];
    return typeof raw === 'number' ? raw : undefined;
  } catch {
    return undefined;
  }
}

export async function writeStoredLeaderTabIdToSession(tabId: number): Promise<void> {
  try {
    await chrome.storage.session.set({ [LEADER_TAB_ID_KEY]: tabId });
  } catch {}
}

export function pickDefinedWindowFields<T extends object>(
  fields: T
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out = {} as { [K in keyof T]?: Exclude<T[K], undefined> };
  for (const key of Object.keys(fields) as Array<keyof T>) {
    const value = fields[key];
    if (value !== undefined) {
      out[key] = value as Exclude<(typeof fields)[typeof key], undefined>;
    }
  }
  return out;
}

export function chromeWindowInfoFromChrome(
  win: {
    id?: number;
    left?: number;
    top?: number;
    width?: number;
    height?: number;
    state?: string;
    tabs?: Array<{ id?: number }>;
  },
  label: string,
  tabIdFallback?: number
): BridgeChromeWindowInfo {
  if (typeof win.id !== 'number') {
    throw new Error(`${label} did not return a window id`);
  }
  const tabId = win.tabs?.[0]?.id;
  if (tabIdFallback === undefined && typeof tabId !== 'number') {
    throw new Error(`${label} did not return windowId/tabId`);
  }
  return {
    windowId: win.id,
    tabId: typeof tabId === 'number' ? tabId : (tabIdFallback as number),
    left: win.left ?? 0,
    top: win.top ?? 0,
    width: win.width ?? 0,
    height: win.height ?? 0,
    state: win.state ?? 'normal',
  };
}

export function buildDefaultBridgeSwDeps(overrides?: Partial<BridgeSwDeps>): BridgeSwDeps {
  const base: BridgeSwDeps = {
    readStoredLeaderTabId: readStoredLeaderTabIdFromSession,
    writeStoredLeaderTabId: writeStoredLeaderTabIdToSession,
    tabHasProtectedFrame,
    maybeUnmaskCdpFrame: async (_tabId, _method, params) => params,
    attachDebugger: async (tabId) => {
      await chrome.debugger.attach({ tabId }, '1.3');
      return true;
    },
    detachDebugger: async (tabId) => {
      await chrome.debugger.detach({ tabId }).catch(() => {});
    },
    sendDebuggerCommand: async (tabId, method, params) => {
      const result = await chrome.debugger.sendCommand({ tabId }, method, params);
      return result ?? {};
    },
    subscribeDebuggerEvents: (handler) => {
      const wrapped = (source: { tabId: number }, method: string, params?: CDPPayload): void =>
        handler(source.tabId, method, params);
      chrome.debugger.onEvent.addListener(wrapped);
      return () => chrome.debugger.onEvent.removeListener(wrapped);
    },
    queryTabs: () => chrome.tabs.query({}),
    queryActiveTabId: async () => {
      try {
        const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return typeof t?.id === 'number' ? t.id : undefined;
      } catch {
        return undefined;
      }
    },
    getTab: async (tabId) => {
      try {
        return await chrome.tabs.get(tabId);
      } catch {
        return undefined;
      }
    },
    createTab: async (url) => {
      const tab = await chrome.tabs.create({ url, active: false });
      return tab.id;
    },
    createWindow: async (opts) => {
      const created = await chrome.windows.create({
        url: opts.url,
        type: opts.type,
        focused: opts.focused,
        ...pickDefinedWindowFields({
          width: opts.width,
          height: opts.height,
          left: opts.left,
          top: opts.top,
          state: opts.state,
        }),
      });
      return chromeWindowInfoFromChrome(created, 'chrome.windows.create');
    },
    getWindow: async (windowId) => {
      const win = await chrome.windows.get(windowId, { populate: true });
      return chromeWindowInfoFromChrome(win, `chrome.windows.get(${windowId})`, -1);
    },
    updateWindow: async (windowId, props) => {
      const updated = await chrome.windows.update(
        windowId,
        pickDefinedWindowFields({
          left: props.left,
          top: props.top,
          width: props.width,
          height: props.height,
          state: props.state,
          focused: props.focused,
        })
      );
      return chromeWindowInfoFromChrome(updated, `chrome.windows.update(${windowId})`, -1);
    },
    removeTab: (tabId) => chrome.tabs.remove(tabId),
    showTab: async (tabId) => {
      await chrome.tabs.update(tabId, { active: true });
    },
    activateTab: async (tabId) => {
      try {
        const tab = await chrome.tabs.update(tabId, { active: true });
        if (typeof tab?.windowId === 'number') {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } catch {}
    },
  };
  return { ...base, ...(overrides ?? {}) };
}

export async function handleBridgePortConnect(
  port: ChromeRuntimePort,
  deps: BridgeSwDeps
): Promise<void> {
  if (port.name !== EXTENSION_BRIDGE_PORT_NAME) return;

  const state: PortState = {
    channelId: null,
    sessionToTab: new Map(),
    attachRefCounts: new Map(),
    ownedTabs: new Set(),
    runtimeTabs: new Set(),
    pageSessions: new Set(),
    lifecycleSessions: new Set(),
    unsubscribeEvents: null,
    emit: () => {},
    announce: () => {},
    cut: new Set(),
    leaderTabId: port.sender?.tab?.id,
  };

  let pinned = false;
  let rejected = false;
  const earlyQueue: unknown[] = [];

  const runMessage = (raw: unknown): void => {
    handleBridgeMessage(port, state, raw, deps).catch((err) => {
      console.error('[slicc-bridge-sw] handleBridgeMessage threw', err);
    });
  };

  port.onMessage.addListener((raw: unknown) => {
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
    if (state.unsubscribeEvents) {
      state.unsubscribeEvents();
      state.unsubscribeEvents = null;
    }
    const usedTabs = new Set(state.sessionToTab.values());
    for (const tabId of state.ownedTabs) {
      tabShields.delete(tabId);
      deps.detachDebugger(tabId).catch(() => {});
    }
    state.ownedTabs.clear();
    state.sessionToTab.clear();
    state.runtimeTabs.clear();
    state.pageSessions.clear();
    state.lifecycleSessions.clear();
    state.attachRefCounts.clear();
    for (const tabId of usedTabs) releaseTabShield(tabId, deps).catch(() => {});
  });

  const pin = await validateBridgePin(port.sender, deps);
  if (!pin.ok) {
    rejected = true;
    try {
      port.postMessage({
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId: 'rejected',
        kind: 'handshake.rejected',
        reason: pin.reason ?? 'pin-failed',
      } satisfies ExtensionBridgeEnvelope);
    } catch {}
    try {
      port.disconnect();
    } catch {}
    return;
  }

  pinned = true;
  await seedFronts(deps).catch(() => {});
  for (const raw of earlyQueue) runMessage(raw);
  earlyQueue.length = 0;
}

async function handleBridgeMessage(
  port: ChromeRuntimePort,
  state: PortState,
  raw: unknown,
  deps: BridgeSwDeps
): Promise<void> {
  if (isBridgeVersionMismatch(raw)) {
    console.warn('[slicc-bridge-sw] bridge protocol version mismatch — update the older side', {
      peerVersion: raw.bridge,
      ourVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
    });
    try {
      port.postMessage({
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId: raw.channelId,
        kind: 'handshake.rejected',
        reason: 'version-mismatch',
      } satisfies ExtensionBridgeEnvelope);
      port.disconnect();
    } catch {}
    return;
  }
  if (!isExtensionBridgeEnvelope(raw)) return;
  const env = raw as ExtensionBridgeEnvelope;

  if (state.channelId === null) {
    if (env.kind !== 'handshake.hello') {
      port.postMessage({
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId: env.channelId,
        kind: 'handshake.rejected',
        reason: 'expected-hello-first',
      } satisfies ExtensionBridgeEnvelope);
      try {
        port.disconnect();
      } catch {}
      return;
    }
    state.channelId = env.channelId;
    liveBridgePortStates.set(port, state);
    state.emit = (tabId, method, params) => {
      let sessionId: string | undefined;
      for (const [sid, tid] of state.sessionToTab) {
        if (
          tid === tabId &&
          (!method.startsWith('Page.') || state.pageSessions.has(sid)) &&
          (method !== 'Page.lifecycleEvent' || state.lifecycleSessions.has(sid))
        ) {
          sessionId = sid;
          break;
        }
      }
      if (sessionId === undefined) return;
      const channelId = state.channelId;
      if (channelId === null) return;
      try {
        port.postMessage({
          bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
          channelId,
          kind: 'cdp.event',
          method,
          params: redactProtected(params, method),
          sessionId,
        } satisfies ExtensionBridgeEnvelope);
      } catch {}
    };
    state.announce = (method, params) => {
      const channelId = state.channelId;
      if (channelId === null) return;
      try {
        port.postMessage({
          bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
          channelId,
          kind: 'cdp.event',
          method,
          params: redactProtected(params, method),
        } satisfies ExtensionBridgeEnvelope);
      } catch {}
    };
    state.unsubscribeEvents = subscribeShieldedEvents(deps, (tabId, method, params) => {
      if (method.startsWith('Runtime.') && !state.runtimeTabs.has(tabId)) return;
      state.emit(tabId, method, params);
    });
    port.postMessage({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: state.channelId,
      kind: 'handshake.welcome',
    } satisfies ExtensionBridgeEnvelope);
    welcomedLeaderPorts.set(port, state.channelId);
    return;
  }

  if (env.kind === 'leader.join-url') {
    if (env.channelId !== state.channelId) return;
    deps.onLeaderJoinUrl?.(env.joinUrl);
    return;
  }

  if (env.kind !== 'cdp.request') return;
  if (env.channelId !== state.channelId) return;

  const id = env.id;
  try {
    const result = await dispatchCdpCommand(env, state, deps);
    port.postMessage({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: state.channelId,
      kind: 'cdp.response',
      id,
      result: redactProtected(result, env.method),
    } satisfies ExtensionBridgeEnvelope);
  } catch (err) {
    port.postMessage({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: state.channelId,
      kind: 'cdp.response',
      id,
      error: redactText(err instanceof Error ? err.message : String(err)),
    } satisfies ExtensionBridgeEnvelope);
  }
}

function attachedTab(method: string, sessionId: string | undefined, state: PortState): number {
  if (sessionId === undefined && method === 'Target.setDiscoverTargets') {
    throw new Error(DISCOVERY_REFUSAL);
  }
  const tabId = sessionId !== undefined ? state.sessionToTab.get(sessionId) : undefined;
  if (tabId !== undefined) return tabId;
  if (sessionId !== undefined && state.cut.has(sessionId)) throw new Error(PROTECTED_REFUSAL);
  throw new Error(
    `No tab attached for sessionId: ${sessionId ?? '(none)'}. Attach to a target first.`
  );
}

async function dispatchCdpCommand(
  req: Pick<ExtensionBridgeCdpRequest, 'method' | 'params' | 'sessionId'>,
  state: PortState,
  deps: BridgeSwDeps
): Promise<CDPPayload> {
  const { method, params, sessionId } = req;

  if (method === 'Target.getTargets') return cdpGetTargets(state, deps);
  if (method === 'Target.attachToTarget') return cdpAttachToTarget(params ?? {}, state, deps);
  if (method === 'Target.detachFromTarget') return cdpDetachFromTarget(params ?? {}, state, deps);
  if (method === 'Target.createTarget') return cdpCreateTarget(params ?? {}, deps);
  if (method === 'Target.closeTarget') return cdpCloseTarget(params ?? {}, state, deps);
  if (
    method === 'Target.getTargetInfo' &&
    sessionId === undefined &&
    params?.['targetId'] !== undefined
  ) {
    return cdpGetTargetInfo(params ?? {}, deps);
  }
  if (method === 'Browser.getWindowForTarget') {
    return cdpGetWindowForTarget(params ?? {}, deps);
  }
  if (method === 'Browser.getWindowBounds') return cdpGetWindowBounds(params ?? {}, deps);
  if (method === 'Browser.setWindowBounds') {
    return cdpSetWindowBounds(params ?? {}, state, deps);
  }

  const tabId = attachedTab(method, sessionId, state);

  if (method === 'Page.bringToFront') {
    await deps.activateTab(tabId);
  }
  const shield = tabShields.get(tabId);
  if (!shield) throw new Error(`${PROTECTED_REFUSAL} (the tab is not guarded)`);
  const result = await shield.command(method, params, async (m, p) =>
    deps.sendDebuggerCommand(tabId, m, await deps.maybeUnmaskCdpFrame(tabId, m, p))
  );
  switchRuntime(method, tabId, state, shield);
  switchPage(method, params, sessionId, state);
  return result;
}

function switchPage(
  method: string,
  params: CDPPayload | undefined,
  sessionId: string | undefined,
  state: PortState
): void {
  if (sessionId === undefined) return;
  if (method === 'Page.enable') state.pageSessions.add(sessionId);
  if (method === 'Page.disable') state.pageSessions.delete(sessionId);
  if (method === 'Page.setLifecycleEventsEnabled') {
    if (params?.['enabled'] === true) state.lifecycleSessions.add(sessionId);
    else state.lifecycleSessions.delete(sessionId);
  }
}

function switchRuntime(method: string, tabId: number, state: PortState, shield: TabShield): void {
  if (method === 'Runtime.disable') state.runtimeTabs.delete(tabId);
  if (method !== 'Runtime.enable' || state.runtimeTabs.has(tabId)) return;
  state.runtimeTabs.add(tabId);
  for (const context of shield.visibleContexts()) {
    state.emit(tabId, 'Runtime.executionContextCreated', { context });
  }
}

async function cdpGetTargets(
  _state: PortState,
  deps: BridgeSwDeps
): Promise<BridgeTargetGetTargetsResult> {
  const [tabs, activeId] = await Promise.all([deps.queryTabs(), deps.queryActiveTabId()]);
  const targetInfos = tabs
    .filter((t): t is ChromeTab & { id: number } => typeof t.id === 'number')
    .map((t) => {
      const info = {
        targetId: String(t.id),
        type: 'page',
        title: t.title ?? '',
        url: t.url ?? '',
        attached: false,
        active: t.id === activeId,
      };
      return isProtectedTarget(info.url, false, 'unknown') ? { ...info, ...redacted(info) } : info;
    });
  return { targetInfos } as BridgeTargetGetTargetsResult;
}

async function cdpAttachToTarget(
  params: CDPPayload,
  state: PortState,
  deps: BridgeSwDeps
): Promise<BridgeTargetAttachResult> {
  const targetId = readTargetIdParam(params);
  const tabId = await guardedTab(params, deps);
  if (!state.ownedTabs.has(tabId)) {
    const attachedByThisPort = await deps.attachDebugger(tabId).catch((err: unknown) => {
      if (foreignFrameError(err)) throw new Error(EXTENSION_FRAME);
      throw err;
    });
    if (attachedByThisPort) state.ownedTabs.add(tabId);
  }
  await confirmFailure(tabId, deps);
  if (await protectedNow(tabId, deps)) {
    if (state.ownedTabs.has(tabId)) {
      state.ownedTabs.delete(tabId);
      await deps.detachDebugger(tabId);
    }
    throw new Error(PROTECTED_REFUSAL);
  }
  try {
    await ensureTabShield(tabId, deps);
    if (await deps.tabHasProtectedFrame?.(tabId)) throw new Error(PROTECTED_REFUSAL);
  } catch (err) {
    if (state.ownedTabs.has(tabId)) {
      state.ownedTabs.delete(tabId);
      tabShields.delete(tabId);
      await deps.detachDebugger(tabId);
    } else {
      await releaseTabShield(tabId, deps);
    }
    throw err;
  }
  const sessionId = targetId;
  state.cut.delete(sessionId);
  state.sessionToTab.set(sessionId, tabId);
  state.attachRefCounts.set(tabId, (state.attachRefCounts.get(tabId) ?? 0) + 1);
  const tab = await deps.getTab(tabId);
  const url = tab?.url || tab?.pendingUrl || '';
  const info = {
    targetId,
    type: 'page',
    title: tab?.title ?? '',
    url,
    attached: true,
    canAccessOpener: false,
  };
  state.announce('Target.attachedToTarget', {
    sessionId,
    targetInfo: url && isProtectedUrl(url) ? redacted(info) : info,
    waitingForDebugger: false,
  });
  return { sessionId };
}

async function cdpDetachFromTarget(
  params: CDPPayload,
  state: PortState,
  deps: BridgeSwDeps
): Promise<BridgeTargetDetachResult> {
  const sessionId = params['sessionId'];
  if (typeof sessionId !== 'string') return {};
  const tabId = state.sessionToTab.get(sessionId);
  if (tabId === undefined) return {};

  const nextRefCount = (state.attachRefCounts.get(tabId) ?? 1) - 1;
  if (nextRefCount > 0) {
    state.attachRefCounts.set(tabId, nextRefCount);
    return {};
  }

  state.attachRefCounts.delete(tabId);
  for (const [sid, attachedTabId] of state.sessionToTab) {
    if (attachedTabId === tabId) {
      state.sessionToTab.delete(sid);
      state.pageSessions.delete(sid);
      state.lifecycleSessions.delete(sid);
    }
  }
  state.runtimeTabs.delete(tabId);
  if (state.ownedTabs.has(tabId)) {
    state.ownedTabs.delete(tabId);
    tabShields.delete(tabId);
    await deps.detachDebugger(tabId);
  }
  await releaseTabShield(tabId, deps);
  return {};
}

async function cdpCreateTarget(
  params: CDPPayload,
  deps: BridgeSwDeps
): Promise<BridgeTargetCreateResult> {
  const url = readCreateTargetUrl(params);
  refuseUnparseableDestination(url);
  if (!URL.canParse(url)) throw new Error(RELATIVE_REFUSAL);
  if (wrapsAbout(url, PROTECTED_RULES.innerSchemes)) throw new Error(ABOUT_WRAPPED);
  if (isProtectedTarget(url)) {
    throw new Error(PROTECTED_REFUSAL);
  }
  if (params['newWindow'] !== true) {
    return openedTarget(await deps.createTab(url), deps);
  }
  const state = readOptionalWindowState(params['windowState']);
  const opts: BridgeCreateWindowOptions = {
    url,
    type: params['decorated'] === false ? 'popup' : 'normal',
    focused:
      typeof params['focus'] === 'boolean' ? params['focus'] : params['background'] === false,
  };
  if (state && state !== 'normal') {
    opts.state = state;
  } else {
    copyNumericFields(params as CdpBoundsBag, opts, GEOMETRY_KEYS);
    if (state) opts.state = state;
  }
  const created = await deps.createWindow(opts);
  return openedTarget(created.tabId, deps);
}

async function openedTarget(tabId: number, deps: BridgeSwDeps): Promise<BridgeTargetCreateResult> {
  const tab = await deps.getTab(tabId);
  if (isProtectedUrl(tab?.pendingUrl) || isProtectedUrl(tab?.url)) {
    await deps.removeTab(tabId).catch(() => {});
    throw new Error(PROTECTED_REFUSAL);
  }
  return { targetId: String(tabId) };
}

async function cdpGetTargetInfo(params: CDPPayload, deps: BridgeSwDeps): Promise<CDPPayload> {
  const targetId = readTargetIdParam(params);
  const tabId = exactTabId(targetId);
  const tab = await deps.getTab(tabId);
  if (!tab) throw new Error(`No target with given id found: ${targetId}`);
  const info = {
    targetId,
    type: 'page',
    title: tab.title ?? '',
    url: tab.url || tab.pendingUrl || '',
    attached: false,
    canAccessOpener: false,
  };
  const hidden = await isProtectedTab(tab, deps.getTab);
  return { targetInfo: hidden ? redacted(info) : info };
}

async function cdpGetWindowForTarget(
  params: CDPPayload,
  deps: BridgeSwDeps
): Promise<BridgeGetWindowForTargetResult> {
  const targetId = readTargetIdParam(params);
  const tabId = await guardedTab(params, deps);
  const tab = await deps.getTab(tabId);
  if (!tab || typeof tab.windowId !== 'number') {
    throw new Error(`No window for targetId: ${targetId}`);
  }
  const win = await deps.getWindow(tab.windowId);
  return {
    windowId: win.windowId,
    bounds: chromeWindowToCdpBounds(win),
  };
}

async function cdpGetWindowBounds(
  params: CDPPayload,
  deps: BridgeSwDeps
): Promise<BridgeGetWindowBoundsResult> {
  const windowId = params['windowId'];
  if (typeof windowId !== 'number') {
    throw new Error(`Invalid windowId: ${String(windowId)}`);
  }
  const win = await deps.getWindow(windowId);
  return { bounds: chromeWindowToCdpBounds(win) };
}

export const MINIMIZE_REFUSAL =
  "slicc: refused: minimizing the window that holds SLICC's tab would hide it";

async function cdpSetWindowBounds(
  params: CDPPayload,
  portState: PortState,
  deps: BridgeSwDeps
): Promise<CDPPayload> {
  const windowId = params['windowId'];
  if (typeof windowId !== 'number') {
    throw new Error(`Invalid windowId: ${String(windowId)}`);
  }
  const rawBounds = readCdpBoundsFields(params['bounds']);
  const state = readOptionalWindowState(rawBounds['windowState'] ?? rawBounds['state']);
  const props: BridgeWindowUpdateProps = {};
  if (state === 'minimized' && portState.leaderTabId !== undefined) {
    const leader = await deps.getTab(portState.leaderTabId);
    if (leader?.windowId === windowId) throw new Error(MINIMIZE_REFUSAL);
  }
  if (state && state !== 'normal') {
    props.state = state;
  } else {
    copyNumericFields(rawBounds, props, GEOMETRY_KEYS);
    if (state) props.state = state;
  }
  await deps.updateWindow(windowId, props);
  return {};
}

const GEOMETRY_KEYS = ['left', 'top', 'width', 'height'] as const;
const WINDOW_STATES = new Set(['normal', 'minimized', 'maximized', 'fullscreen']);

interface BridgeWindowUpdateProps {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  state?: string;
}

interface CdpBoundsBag {
  left?: unknown;
  top?: unknown;
  width?: unknown;
  height?: unknown;
  windowState?: unknown;
  state?: unknown;
}

function copyNumericFields(
  source: CdpBoundsBag,
  target: { [K in (typeof GEOMETRY_KEYS)[number]]?: number },
  keys: readonly (typeof GEOMETRY_KEYS)[number][]
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number') target[key] = value;
  }
}

function readCdpBoundsFields(value: unknown): CdpBoundsBag {
  return value !== null && typeof value === 'object' ? (value as CdpBoundsBag) : {};
}

function chromeWindowToCdpBounds(win: BridgeChromeWindowInfo): BridgeWindowBounds {
  return {
    left: win.left,
    top: win.top,
    width: win.width,
    height: win.height,
    windowState: win.state || 'normal',
  };
}

function readOptionalWindowState(
  value: unknown
): 'normal' | 'minimized' | 'maximized' | 'fullscreen' | undefined {
  if (typeof value === 'string' && WINDOW_STATES.has(value)) {
    return value as 'normal' | 'minimized' | 'maximized' | 'fullscreen';
  }
  return undefined;
}

async function cdpCloseTarget(
  params: CDPPayload,
  state: PortState,
  deps: BridgeSwDeps
): Promise<BridgeTargetCloseResult> {
  const tabId = await guardedTab(params, deps);
  for (const [sid, tid] of state.sessionToTab) {
    if (tid === tabId) {
      state.sessionToTab.delete(sid);
      state.pageSessions.delete(sid);
      state.lifecycleSessions.delete(sid);
    }
  }
  state.runtimeTabs.delete(tabId);
  state.attachRefCounts.delete(tabId);
  if (state.ownedTabs.has(tabId)) {
    state.ownedTabs.delete(tabId);
    tabShields.delete(tabId);
    await deps.detachDebugger(tabId);
  }
  await releaseTabShield(tabId, deps);
  await deps.removeTab(tabId);
  return { success: true };
}
