import catalog from '@ai-ecoverse/slicc-browsers';
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

type Guard = {
  url: (text: string, options?: { readOnly?: boolean }) => boolean;
  target: (opts: { url: string; previous?: boolean; opener?: string; type?: string }) => boolean;
  cookieDomain: (domain: string) => boolean;
  storageKey: (key: string) => boolean;
  unparseable: (text: string) => boolean;
};

const base = protectedOrigins(catalog.protectedOrigins) as Guard;
const FORBIDDEN_HOST = /[\u0000-\u0020%\u007f#/:<>?@[\\\]^|]/;
const failClosed = catalog.protectedOrigins.unparseable === 'protected';

function parsed(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function noncanonical(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const inner: readonly string[] = catalog.protectedOrigins.innerSchemes;
  let u = parsed(text);
  for (let i = 0; u && inner.includes(u.protocol.slice(0, -1)) && i < 8; i += 1) {
    u = parsed(u.href.slice(u.protocol.length));
  }
  if (!u?.hostname || u.hostname.startsWith('[')) return false;
  return FORBIDDEN_HOST.test(u.hostname);
}

const guard: Guard = {
  ...base,
  url: (text, options = {}) =>
    base.url(text, options) || (failClosed && !options.readOnly && noncanonical(text)),
  target: (info) => base.target(info) || (failClosed && noncanonical(info.url)),
  unparseable: (text) => base.unparseable(text) || noncanonical(text),
};

export const PROTECTED_RULES: {
  domains: readonly string[];
  hosts: readonly string[];
  schemes: readonly string[];
  innerSchemes: readonly string[];
  protectedSchemes: readonly string[];
  schemeExceptions: readonly string[];
  refusal: string;
  unparseableRefusal: string;
} = catalog.protectedOrigins;

export const PROTECTED_REFUSAL: string = catalog.protectedOrigins.refusal;

export function isProtectedUrl(rawUrl: string | undefined, readOnly = false): boolean {
  if (!rawUrl) return false;
  return guard.url(rawUrl, { readOnly });
}

export function isUnparseableUrl(rawUrl: string): boolean {
  return guard.unparseable(rawUrl);
}

export function refuseUnparseableDestination(url: unknown): void {
  if (typeof url === 'string' && /^\s*[a-z][a-z0-9+.-]*:/i.test(url) && guard.unparseable(url)) {
    throw new Error(catalog.protectedOrigins.unparseableRefusal);
  }
}

export function isProtectedTarget(
  url: string,
  previous = false,
  opener?: 'protected' | 'unprotected' | 'unknown',
  type?: string
): boolean {
  return guard.target({ url, previous, opener, type });
}

export function isProtectedTargetType(type: unknown): boolean {
  return (
    typeof type === 'string' && guard.target({ url: 'about:blank', opener: 'unprotected', type })
  );
}

export function isProtectedCookieDomain(domain: string): boolean {
  return guard.cookieDomain(domain);
}

export function isProtectedStorageKey(key: string): boolean {
  return guard.storageKey(key);
}

type OpenerState = 'protected' | 'unprotected' | 'unknown' | undefined;

async function openerStateOf(
  tab: ChromeTab,
  getTab: (tabId: number) => Promise<ChromeTab | undefined>
): Promise<OpenerState> {
  if (typeof tab.openerTabId !== 'number') return undefined;
  try {
    const opener = await getTab(tab.openerTabId);
    if (!opener) return 'unknown';
    const openerProtected =
      isProtectedTarget(opener.url ?? '', false, 'unknown') || isProtectedUrl(opener.pendingUrl);
    return openerProtected ? 'protected' : 'unprotected';
  } catch {
    return 'unknown';
  }
}

export async function isProtectedTab(
  tab: ChromeTab | undefined,
  getTab: (tabId: number) => Promise<ChromeTab | undefined>
): Promise<boolean> {
  if (!tab) return false;
  if (isProtectedUrl(tab.pendingUrl)) return true;
  const url = tab.url ?? '';
  if (isProtectedUrl(url)) return true;
  return isProtectedTarget(url, false, await openerStateOf(tab, getTab));
}
