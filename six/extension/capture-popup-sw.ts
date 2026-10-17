import type { SwMessageOutcome } from './sw-message-router.js';

interface CaptureOpenWindowMsg {
  type: 'capture-open-window';
  url: string;
  requestId?: string;
}

interface CaptureClaimMsg {
  type: 'capture-claim';
  claim: string;
}

interface CaptureClaimEntry {
  req: string;
  at: number;
}

const CLAIM_PREFIX = 'capture-claim:';
const CLAIM_TTL_MS = 60_000;

function isCaptureOpenWindowMsg(msg: unknown): msg is CaptureOpenWindowMsg {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as { type?: unknown }).type === 'capture-open-window' &&
    typeof (msg as { url?: unknown }).url === 'string'
  );
}

function isCaptureClaimMsg(msg: unknown): msg is CaptureClaimMsg {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'capture-claim' &&
    typeof (msg as { claim?: unknown }).claim === 'string'
  );
}

function popupUrl(): string {
  return chrome.runtime.getURL('capture-popup.html');
}

function requestOf(url: string): string | undefined {
  try {
    const parsed = new URL(url, popupUrl());
    if (`${parsed.origin}${parsed.pathname}` !== popupUrl()) return undefined;
    return parsed.searchParams.get('req') ?? undefined;
  } catch {
    return undefined;
  }
}

async function prune(): Promise<void> {
  const all = (await chrome.storage.session.get(null)) as Record<string, unknown>;
  const stale = Object.entries(all)
    .filter(([key, value]) => {
      if (!key.startsWith(CLAIM_PREFIX)) return false;
      const at = (value as Partial<CaptureClaimEntry> | null)?.at;
      return typeof at !== 'number' || Date.now() - at > CLAIM_TTL_MS;
    })
    .map(([key]) => key);
  if (stale.length > 0) await chrome.storage.session.remove(stale);
}

async function register(req: string): Promise<string> {
  await prune().catch(() => {});
  const claim = crypto.randomUUID();
  const entry: CaptureClaimEntry = { req, at: Date.now() };
  await chrome.storage.session.set({ [CLAIM_PREFIX + claim]: entry });
  return `${popupUrl()}?claim=${claim}`;
}

async function claimRequest(claim: string): Promise<{ req?: string }> {
  const key = CLAIM_PREFIX + claim;
  const found = (await chrome.storage.session.get(key)) as Record<string, unknown>;
  await chrome.storage.session.remove(key);
  const entry = found[key] as Partial<CaptureClaimEntry> | undefined;
  if (!entry || typeof entry.req !== 'string' || typeof entry.at !== 'number') return {};
  if (Date.now() - entry.at > CLAIM_TTL_MS) return {};
  return { req: entry.req };
}

function reportFailure(requestId: string | undefined, error: string): void {
  if (!requestId) return;
  chrome.runtime
    .sendMessage({ source: 'capture-popup', requestId, ok: false, error })
    .catch(() => {});
}

async function openCaptureWindow(message: CaptureOpenWindowMsg): Promise<void> {
  const req = requestOf(message.url);
  if (!req) {
    reportFailure(message.requestId, 'invalid capture request');
    return;
  }
  try {
    const url = await register(req);
    await chrome.windows.create({ url, type: 'popup', width: 360, height: 220, focused: true });
  } catch (err) {
    console.error('[slicc-sw] Failed to open capture popup window:', err);
    const reason = err instanceof Error ? err.message : String(err);
    reportFailure(message.requestId, `failed to open capture window: ${reason}`);
  }
}

export function handleCapturePopupMessage(
  message: unknown,
  _sender?: ChromeMessageSender,
  sendResponse?: (response?: unknown) => void
): SwMessageOutcome {
  if (isCaptureClaimMsg(message)) {
    claimRequest(message.claim).then(
      (answer) => sendResponse?.(answer),
      () => sendResponse?.({})
    );
    return 'handled-async';
  }
  if (!isCaptureOpenWindowMsg(message)) return 'not-handled';
  void openCaptureWindow(message);
  return 'handled';
}
