import { LEADER_EXT_ID_QUERY_NAME, SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import { broadcastLeaderGone, setCherryPanelSeven } from './cherry-panel-sw.js';
import {
  forgetTopDocument,
  isSixLeaderDocumentUrl,
  type LeaderKind,
  markSevenUpgraded,
  noteTopDocument,
  readLeaderKind,
  readSevenUpgraded,
  writeLeaderKind,
} from './leader-document.js';

const LEADER_TAB_ID_KEY = 'slicc_leader_tab_id';

const PROD_LEADER_TAB_URL = `${SLICC_HOSTED_ORIGIN}/?slicc=leader`;
const PROD_LEADER_TAB_URL_GLOB = `${SLICC_HOSTED_ORIGIN}/*`;
const PROD_LEADER_TAB_ORIGIN = SLICC_HOSTED_ORIGIN;
const DEV_LEADER_TAB_URL = 'http://localhost:8787/?slicc=leader';
const DEV_LEADER_TAB_URL_GLOB = 'http://localhost:8787/*';
const DEV_LEADER_TAB_ORIGIN = 'http://localhost:8787';

export function getLeaderTabUrl(isExtDev: boolean): string {
  return isExtDev ? DEV_LEADER_TAB_URL : PROD_LEADER_TAB_URL;
}

export function getLeaderTabUrlGlob(isExtDev: boolean): string {
  return isExtDev ? DEV_LEADER_TAB_URL_GLOB : PROD_LEADER_TAB_URL_GLOB;
}

export function getLeaderTabOrigin(isExtDev: boolean): string {
  return isExtDev ? DEV_LEADER_TAB_ORIGIN : PROD_LEADER_TAB_ORIGIN;
}

export function appendLeaderExtIdParam(leaderUrl: string, extensionId: string | undefined): string {
  if (!extensionId) return leaderUrl;
  try {
    const u = new URL(leaderUrl);
    u.searchParams.set(LEADER_EXT_ID_QUERY_NAME, extensionId);
    return u.toString();
  } catch {
    return leaderUrl;
  }
}

export function leaderUrlHasExtId(
  rawUrl: string | undefined,
  extensionId: string | undefined
): boolean {
  if (!rawUrl || !extensionId) return false;
  try {
    return new URL(rawUrl).searchParams.get(LEADER_EXT_ID_QUERY_NAME) === extensionId;
  } catch {
    return false;
  }
}

const LEADER_TAB_URL = getLeaderTabUrl(__SLICC_EXT_DEV__);
const LEADER_TAB_URL_GLOB = getLeaderTabUrlGlob(__SLICC_EXT_DEV__);
const LEADER_TAB_ORIGIN = getLeaderTabOrigin(__SLICC_EXT_DEV__);

export async function readStoredLeaderTabId(): Promise<number | undefined> {
  try {
    const result = await chrome.storage.session.get(LEADER_TAB_ID_KEY);
    const raw = result[LEADER_TAB_ID_KEY];
    return typeof raw === 'number' ? raw : undefined;
  } catch (err) {
    console.error('[slicc-sw] storage.session.get leader tab id failed', err);
    return undefined;
  }
}

export async function writeStoredLeaderTabId(
  tabId: number,
  kind: LeaderKind = 'six'
): Promise<void> {
  await chrome.storage.session.set({ [LEADER_TAB_ID_KEY]: tabId });
  await writeLeaderKind(sevenCommits.has(tabId) ? 'seven' : kind);
  await markLeaderTabNotDiscardable(tabId);
}

async function markLeaderTabNotDiscardable(tabId: number): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch (err) {
    console.warn('[slicc-sw] failed to exempt leader tab from discard/freeze', err);
  }
}

async function clearStoredLeaderTabId(): Promise<void> {
  await chrome.storage.session.remove(LEADER_TAB_ID_KEY);
  await writeLeaderKind('six');
}

function isLeaderTabUrl(rawUrl: string | undefined): boolean {
  return isSixLeaderDocumentUrl(rawUrl, [LEADER_TAB_ORIGIN]);
}

export function isSevenTabUrl(rawUrl: string | undefined, origin = LEADER_TAB_ORIGIN): boolean {
  if (!rawUrl) return false;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.origin !== origin) return false;
  return u.pathname === '/7' || u.pathname.startsWith('/7/') || u.pathname.startsWith('/os/');
}

export function sevenPanelUrl(origin = LEADER_TAB_ORIGIN): string {
  return `${origin}/os/`;
}

export async function readLeaderIsSeven(): Promise<boolean> {
  const id = await readStoredLeaderTabId();
  if (id === undefined || (await readLeaderKind()) !== 'seven') return false;
  const tab = await chrome.tabs.get(id).catch(() => undefined);
  return tab !== undefined && isSevenTabUrl(tab.url);
}

export async function announceSevenLeader(): Promise<void> {
  if (await readLeaderIsSeven()) setCherryPanelSeven(sevenPanelUrl());
}

const sevenCommits = new Set<number>();
const starts = new Map<number, string>();

function ownLeaderUrl(rawUrl: string | undefined): boolean {
  return isLeaderTabUrl(rawUrl) && leaderUrlHasExtId(rawUrl, chrome.runtime.id);
}

export async function noteTopCommit(details: ChromeNavigationDetails): Promise<void> {
  if (details.frameId !== 0) return;
  const from = starts.get(details.tabId);
  starts.delete(details.tabId);
  noteTopDocument(details.tabId, details.url, details.documentId);
  const seven = isSevenTabUrl(details.url);
  const redirected =
    seven &&
    ownLeaderUrl(from) &&
    details.transitionQualifiers?.includes('server_redirect') === true;
  if (redirected) await markSevenUpgraded();
  if (seven && redirected) sevenCommits.add(details.tabId);
  else if (!seven) sevenCommits.delete(details.tabId);
  if ((await readStoredLeaderTabId()) !== details.tabId) return;
  if (isLeaderTabUrl(details.url)) {
    await writeLeaderKind('six');
    return;
  }
  if (seven && (redirected || (await readLeaderKind()) === 'seven')) {
    await writeLeaderKind('seven');
    setCherryPanelSeven(sevenPanelUrl());
    return;
  }
  await clearStoredLeaderTabId();
  broadcastLeaderGone();
}

export function noteTopNavigation(details: ChromeNavigationDetails): void {
  if (details.frameId === 0) starts.set(details.tabId, details.url);
}

async function reconcileLeaderTabOnBoot(): Promise<void> {
  const storedId = await readStoredLeaderTabId();
  if (storedId === undefined) return;
  let tab: ChromeTab | undefined;
  try {
    tab = await chrome.tabs.get(storedId);
  } catch {}
  if (tab !== undefined && isLeaderTabUrl(tab.url)) return;
  if (tab !== undefined && isSevenTabUrl(tab.url) && (await readLeaderKind()) === 'seven') return;
  await clearStoredLeaderTabId();
}

let leaderTabLock: Promise<void> | null = null;

async function queryLeaderTabs(): Promise<ChromeTab[]> {
  try {
    const matches = await chrome.tabs.query({ url: LEADER_TAB_URL_GLOB });
    return matches.filter(
      (t) => t.id !== undefined && (isLeaderTabUrl(t.url) || isSevenTabUrl(t.url))
    );
  } catch (err) {
    console.error('[slicc-sw] tabs.query for leader tab failed', err);
    return [];
  }
}

export function pickSevenLeader(
  tabs: ChromeTab[],
  storedId: number | undefined
): ChromeTab | undefined {
  const seven = tabs.filter((t) => isSevenTabUrl(t.url));
  const loaded = (t: ChromeTab) => !isUnloadedTab(t);
  return (
    seven.find((t) => t.id === storedId) ??
    seven.find((t) => t.pinned === true && loaded(t)) ??
    seven.find((t) => t.pinned === true) ??
    seven.find(loaded) ??
    seven[0]
  );
}

async function adoptSevenLeaderTab(keep: ChromeTab): Promise<void> {
  if (keep.id === undefined) return;
  if (isUnloadedTab(keep)) {
    try {
      await chrome.tabs.reload(keep.id);
    } catch (err) {
      console.error('[slicc-sw] failed to reload unloaded seven tab', err);
    }
  }
  await writeStoredLeaderTabId(keep.id, 'seven');
}

async function createLeaderTab(): Promise<void> {
  const created = await chrome.tabs.create({
    url: appendLeaderExtIdParam(LEADER_TAB_URL, chrome.runtime.id),
    active: false,
    pinned: true,
  });
  if (created.id === undefined) return;
  await writeStoredLeaderTabId(created.id);
  if (sevenCommits.has(created.id)) setCherryPanelSeven(sevenPanelUrl());
}

function isUnloadedTab(tab: ChromeTab): boolean {
  return tab.discarded === true || tab.status === 'unloaded';
}

async function adoptSingleLeaderTab(matches: ChromeTab[]): Promise<void> {
  const keep = matches.find((t) => !isUnloadedTab(t)) ?? matches[0];
  const extras = matches.filter((t) => t !== keep);
  if (keep.id === undefined) return;

  for (const extra of extras) {
    if (extra.id === undefined || extra.id === keep.id) continue;
    try {
      await chrome.tabs.remove(extra.id);
    } catch (err) {
      console.error('[slicc-sw] failed to close duplicate leader tab', err);
    }
  }

  const extIdUrl =
    keep.url !== undefined &&
    chrome.runtime.id !== undefined &&
    !leaderUrlHasExtId(keep.url, chrome.runtime.id)
      ? appendLeaderExtIdParam(keep.url, chrome.runtime.id)
      : undefined;
  if (extIdUrl !== undefined || keep.pinned !== true) {
    const props: { pinned: true; url?: string } = { pinned: true };
    if (extIdUrl !== undefined) props.url = extIdUrl;
    await chrome.tabs.update(keep.id, props);
  }
  if (extIdUrl === undefined && isUnloadedTab(keep)) {
    try {
      await chrome.tabs.reload(keep.id);
    } catch (err) {
      console.error('[slicc-sw] failed to reload unloaded leader tab', err);
    }
  }
  await writeStoredLeaderTabId(keep.id);
}

export async function ensureLeaderTab(): Promise<void> {
  if (leaderTabLock !== null) return leaderTabLock;
  leaderTabLock = (async () => {
    try {
      const matches = await queryLeaderTabs();
      const six = matches.filter((t) => isLeaderTabUrl(t.url));
      const upgraded = six.length === 0 && (await readSevenUpgraded());
      const seven = upgraded ? pickSevenLeader(matches, await readStoredLeaderTabId()) : undefined;
      if (seven !== undefined) await adoptSevenLeaderTab(seven);
      else if (six.length === 0) await createLeaderTab();
      else await adoptSingleLeaderTab(six);
      await announceSevenLeader();
    } finally {
      leaderTabLock = null;
    }
  })();
  return leaderTabLock;
}

export async function reloadLeaderTabIfExists(): Promise<boolean> {
  const id = await readStoredLeaderTabId();
  if (typeof id !== 'number') return false;
  try {
    await chrome.tabs.reload(id);
    return true;
  } catch {
    return false;
  }
}

export async function focusLeaderTab(): Promise<void> {
  const storedId = await readStoredLeaderTabId();
  if (storedId !== undefined) {
    let leaderTab: ChromeTab | undefined;
    try {
      leaderTab = await chrome.tabs.get(storedId);
    } catch {
      leaderTab = undefined;
    }
    if (
      leaderTab !== undefined &&
      (isLeaderTabUrl(leaderTab.url) || isSevenTabUrl(leaderTab.url))
    ) {
      await chrome.tabs.update(storedId, { active: true });
      if (leaderTab.windowId !== undefined) {
        await chrome.windows.update(leaderTab.windowId, { focused: true });
      }
      return;
    }
    await clearStoredLeaderTabId();
  }
  await ensureLeaderTab();
  const newId = await readStoredLeaderTabId();
  if (newId === undefined) return;
  const tab = await chrome.tabs.get(newId).catch(() => undefined);
  if (tab === undefined) return;
  await chrome.tabs.update(newId, { active: true });
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

const UPDATE_RELOAD_GUARD_KEY = 'slicc_update_reload_at';
const UPDATE_RELOAD_GUARD_MS = 60_000;

async function isWithinUpdateReloadGuard(): Promise<boolean> {
  const result = await chrome.storage.session.get(UPDATE_RELOAD_GUARD_KEY);
  const stamp = result[UPDATE_RELOAD_GUARD_KEY];
  if (typeof stamp !== 'number') return false;
  return Date.now() - stamp < UPDATE_RELOAD_GUARD_MS;
}

async function stampUpdateReloadGuard(): Promise<void> {
  await chrome.storage.session.set({ [UPDATE_RELOAD_GUARD_KEY]: Date.now() });
}

async function reloadLeaderTabForUpdate(): Promise<void> {
  if (await isWithinUpdateReloadGuard()) return;
  if (await reloadLeaderTabIfExists()) await stampUpdateReloadGuard();
}

async function handleLeaderTabRemoved(tabId: number): Promise<void> {
  sevenCommits.delete(tabId);
  starts.delete(tabId);
  forgetTopDocument(tabId);
  const storedId = await readStoredLeaderTabId();
  if (storedId !== tabId) return;
  await clearStoredLeaderTabId();
  broadcastLeaderGone();
}

export function installLeaderTabListeners(): void {
  reconcileLeaderTabOnBoot().catch((err) => {
    console.error('[slicc-sw] reconcile leader tab failed', err);
  });

  chrome.runtime.onUpdateAvailable.addListener((details) => {
    console.log('[slicc-sw] Extension update available', details.version);
    reloadLeaderTabForUpdate()
      .catch((err) => {
        console.error('[slicc-sw] onUpdateAvailable handler failed', err);
      })
      .finally(() => {
        chrome.runtime.reload();
      });
  });

  chrome.webNavigation.onBeforeNavigate.addListener(noteTopNavigation);
  chrome.webNavigation.onCommitted.addListener((details) => {
    noteTopCommit(details).catch((err) => {
      console.error('[slicc-sw] noteTopCommit failed', err);
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    handleLeaderTabRemoved(tabId).catch((err) => {
      console.error('[slicc-sw] handleLeaderTabRemoved failed', err);
    });
  });
}
