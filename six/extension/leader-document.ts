const DOCUMENTS_KEY = 'slicc_leader_documents';
const KIND_KEY = 'slicc_leader_kind';
const UPGRADED_KEY = 'slicc_seven_upgraded';

export type LeaderKind = 'six' | 'seven';

interface TopDocument {
  documentId: string;
  leader: boolean;
}

const documents = new Map<number, TopDocument>();

export function isSevenPath(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const { pathname } = new URL(rawUrl);
    return pathname === '/7' || pathname.startsWith('/7/') || pathname.startsWith('/os/');
  } catch {
    return false;
  }
}

export function isSixLeaderDocumentUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl || isSevenPath(rawUrl)) return false;
  try {
    return new URL(rawUrl).searchParams.get('slicc') === 'leader';
  } catch {
    return false;
  }
}

async function storedDocuments(): Promise<Record<string, TopDocument>> {
  try {
    const raw = (await chrome.storage.session.get(DOCUMENTS_KEY))[DOCUMENTS_KEY];
    return raw && typeof raw === 'object' ? (raw as Record<string, TopDocument>) : {};
  } catch {
    return {};
  }
}

async function saveDocument(tabId: number, top: TopDocument | undefined): Promise<void> {
  const all = await storedDocuments();
  if (top === undefined) delete all[tabId];
  else all[tabId] = top;
  try {
    await chrome.storage.session.set({ [DOCUMENTS_KEY]: all });
  } catch {}
}

let saving: Promise<void> = Promise.resolve();

export function noteTopDocument(tabId: number, url: string, documentId: string | undefined): void {
  const top = documentId ? { documentId, leader: isSixLeaderDocumentUrl(url) } : undefined;
  if (top) documents.set(tabId, top);
  else documents.delete(tabId);
  saving = saving.then(() => saveDocument(tabId, top));
}

export function forgetTopDocument(tabId: number): void {
  documents.delete(tabId);
  saving = saving.then(() => saveDocument(tabId, undefined));
}

export async function isLeaderDocument(
  tabId: number,
  documentId: string | undefined
): Promise<boolean> {
  if (typeof documentId !== 'string' || documentId === '') return false;
  await saving;
  const seen = documents.get(tabId) ?? (await storedDocuments())[tabId];
  if (seen?.documentId === documentId) return seen.leader;
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null);
  return frame?.documentId === documentId && isSixLeaderDocumentUrl(frame.url);
}

export async function readLeaderKind(): Promise<LeaderKind> {
  try {
    return (await chrome.storage.session.get(KIND_KEY))[KIND_KEY] === 'seven' ? 'seven' : 'six';
  } catch {
    return 'seven';
  }
}

export async function writeLeaderKind(kind: LeaderKind): Promise<void> {
  await chrome.storage.session.set({ [KIND_KEY]: kind });
}

export async function readSevenUpgraded(): Promise<boolean> {
  try {
    return (await chrome.storage.local.get(UPGRADED_KEY))[UPGRADED_KEY] === true;
  } catch {
    return false;
  }
}

export async function markSevenUpgraded(): Promise<void> {
  await chrome.storage.local.set({ [UPGRADED_KEY]: true });
}
