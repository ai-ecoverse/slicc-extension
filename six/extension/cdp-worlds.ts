import type { CDPPayload } from '@slicc/shared-ts';

export const WORLD = 'slicc: refused: that execution context belongs to a browser extension';
export const UNSEEN_CONTEXT =
  'slicc: refused: that execution context or object is not exposed to browser automation';
export const PROFILED =
  'slicc: refused: a browser extension runs scripts in this page, and profiling it would expose them';
export const RESERVED_WORLD = 'slicc: refused: that world name is reserved for the guard';
export const EXTENSION_FRAME =
  "slicc: refused: another browser extension has a frame in this tab, and Chrome doesn't let one extension debug another's frames";
export const ABOUT_WORLD = 'slicc-navigate';

const EXTENSION_SCHEMES = [
  'chrome-extension:',
  'moz-extension:',
  'safari-web-extension:',
  'ms-browser-extension:',
];
const PROFILED_DOMAINS = ['Debugger.', 'DOMDebugger.', 'Profiler.', 'HeapProfiler.'];
const OBJECT_KEY = /^(objectId|\w+ObjectId)$/;
const OPAQUE_KEYS = new Set(['value', 'unserializableValue', 'expression', 'functionDeclaration']);
const FOREIGN_FRAME = /chrome-extension:\/\/ URL of different extension/i;

export type WorldKind = 'ours' | 'foreign' | undefined;

interface Selector {
  kind: 'id' | 'unique' | 'object' | 'name' | 'deep';
  value?: unknown;
}

interface Entry {
  hidden: boolean;
  context: CDPPayload | undefined;
}

function isObj(value: unknown): value is CDPPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extensionOrigin(origin: unknown): boolean {
  if (typeof origin !== 'string') return false;
  const lower = origin.toLowerCase();
  return EXTENSION_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

export function foreignFrameError(error: unknown): boolean {
  return FOREIGN_FRAME.test(String((error as { message?: unknown })?.message ?? error));
}

export function profiled(method: string): boolean {
  return PROFILED_DOMAINS.some((domain) => method.startsWith(domain));
}

export function objectContext(objectId: string): number | undefined {
  const found = /^-?\d+\.(-?\d+)\.-?\d+$/.exec(objectId);
  return found ? Number(found[1]) : undefined;
}

export function selectors(value: unknown, out: Selector[] = [], depth = 0): Selector[] {
  if (depth > 16) {
    out.push({ kind: 'deep' });
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) selectors(item, out, depth + 1);
    return out;
  }
  if (!isObj(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    if (OPAQUE_KEYS.has(key)) continue;
    if ((key === 'contextId' || key === 'executionContextId') && typeof item === 'number') {
      out.push({ kind: 'id', value: item });
    } else if (key === 'uniqueContextId' || key === 'executionContextUniqueId') {
      out.push({ kind: 'unique', value: item });
    } else if (OBJECT_KEY.test(key)) {
      out.push({ kind: 'object', value: item });
    } else if (key === 'executionContextName') {
      out.push({ kind: 'name', value: item });
    } else if (typeof item === 'object' && item !== null) {
      selectors(item, out, depth + 1);
    }
  }
  return out;
}

export class Worlds {
  private readonly ids = new Map<number, Entry>();
  private readonly uniques = new Map<string, boolean>();
  private readonly names = new Set<string>();
  private readonly handles = new Map<string, true>();
  foreign = false;

  learn(value: unknown, depth = 0): void {
    if (depth > 16 || typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) this.learn(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (OBJECT_KEY.test(key) && typeof item === 'string') {
        this.handles.delete(item);
        this.handles.set(item, true);
        if (this.handles.size > 50000) {
          const oldest = this.handles.keys().next().value;
          if (oldest !== undefined) this.handles.delete(oldest);
        }
      } else {
        this.learn(item, depth + 1);
      }
    }
  }

  kindOf(context: CDPPayload, protectedOrigin: (origin: string) => boolean): WorldKind {
    const aux = isObj(context['auxData']) ? context['auxData'] : {};
    const origin = typeof context['origin'] === 'string' ? context['origin'] : '';
    if (aux['isDefault'] !== true && context['name'] === ABOUT_WORLD) return 'ours';
    if (aux['isDefault'] !== true && (extensionOrigin(origin) || protectedOrigin(origin))) {
      return 'foreign';
    }
    return undefined;
  }

  add(context: CDPPayload, kind: WorldKind): boolean {
    const hidden = kind !== undefined;
    const id = context['id'];
    if (typeof id === 'number') {
      const before = this.ids.get(id);
      this.ids.set(id, { hidden: hidden || before?.hidden === true, context });
    }
    const unique = context['uniqueId'];
    if (typeof unique === 'string') {
      this.uniques.set(unique, hidden || this.uniques.get(unique) === true);
    }
    const name = context['name'];
    if (hidden && typeof name === 'string') this.names.add(name);
    const latched = kind === 'foreign' && !this.foreign;
    if (kind === 'foreign') this.foreign = true;
    return latched;
  }

  seen(id: unknown): void {
    if (typeof id !== 'number' || this.ids.has(id)) return;
    this.ids.set(id, { hidden: false, context: undefined });
  }

  remove(id: unknown): boolean {
    if (typeof id !== 'number') return false;
    if (this.ids.get(id)?.hidden) return true;
    this.ids.delete(id);
    return false;
  }

  clear(): void {
    for (const [id, entry] of this.ids) if (!entry.hidden) this.ids.delete(id);
  }

  named(name: unknown): boolean {
    return typeof name === 'string' && this.names.has(name);
  }

  visible(): CDPPayload[] {
    return [...this.ids.entries()]
      .filter(([, entry]) => !entry.hidden && entry.context !== undefined)
      .sort(([a], [b]) => a - b)
      .map(([, entry]) => entry.context as CDPPayload);
  }

  bindingContexts(): CDPPayload[] {
    return [...this.ids.values()]
      .map((entry) => entry.context)
      .filter(
        (context): context is CDPPayload =>
          typeof context?.['uniqueId'] === 'string' &&
          this.uniques.get(context['uniqueId']) === false
      );
  }

  private verdict(selector: Selector): string | undefined {
    if (selector.kind === 'deep') return UNSEEN_CONTEXT;
    if (selector.kind === 'name') {
      return typeof selector.value === 'string' && this.names.has(selector.value)
        ? WORLD
        : undefined;
    }
    if (selector.kind === 'unique') {
      const unique = selector.value;
      if (typeof unique !== 'string' || !this.uniques.has(unique)) return UNSEEN_CONTEXT;
      return this.uniques.get(unique) ? WORLD : undefined;
    }
    const id = selector.value;
    if (selector.kind === 'object') {
      const context = typeof id === 'string' ? objectContext(id) : undefined;
      if (context !== undefined && this.ids.get(context)?.hidden) return WORLD;
      return typeof id === 'string' && this.handles.has(id) ? undefined : UNSEEN_CONTEXT;
    }
    const entry = typeof id === 'number' ? this.ids.get(id) : undefined;
    if (!entry) return UNSEEN_CONTEXT;
    return entry.hidden ? WORLD : undefined;
  }

  refusal(params: unknown): string | undefined {
    for (const selector of selectors(params)) {
      const reason = this.verdict(selector);
      if (reason) return reason;
    }
    return undefined;
  }

  hides(params: unknown): boolean {
    return selectors(params).some((selector) => {
      if (selector.kind === 'deep') return true;
      if (selector.kind === 'name') return false;
      return this.verdict(selector) === WORLD;
    });
  }
}

export function scopedBinding(params: CDPPayload): CDPPayload {
  if (params['executionContextId'] !== undefined || params['executionContextName'] !== undefined) {
    return params;
  }
  return { ...params, executionContextName: '' };
}
