import type { CDPPayload } from '@slicc/shared-ts';

type Ids = { has(id: unknown): boolean };

export interface Seal {
  visible: Ids;
  sealed: Ids;
  nodes: Ids;
}

const SEALED_DOMAINS = [
  'DOM.',
  'DOMSnapshot.',
  'Accessibility.',
  'CSS.',
  'Overlay.',
  'DOMDebugger.',
  'LayerTree.',
  'Animation.',
];
const NODE_KEY = /^(?:[a-z]+N|n)odeIds?$/;
const NODE_EVENT_KEYS = ['nodeId', 'parentId', 'parentNodeId', 'insertionPointId', 'hostId'];
export const DEEP = 'slicc: refused: that reply nests too deeply to check for protected frames';
const WHOLE_PAGE = new Set(['DOM.performSearch', 'DOMSnapshot.getSnapshot']);
const RARE_STRINGS = [
  'shadowRootType',
  'textValue',
  'inputValue',
  'pseudoType',
  'pseudoIdentifier',
  'currentSourceURL',
  'originURL',
];
const DOCUMENT_STRINGS = [
  'documentURL',
  'title',
  'baseURL',
  'contentLanguage',
  'encodingName',
  'publicId',
  'systemId',
  'frameId',
];

function isObj(value: unknown): value is CDPPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const REALM_READS = new Set([
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.getProperties',
  'Runtime.getExceptionDetails',
  'Runtime.compileScript',
  'Runtime.globalLexicalScopeNames',
  'Runtime.queryObjects',
  'Runtime.runScript',
  'Runtime.awaitPromise',
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Runtime.bindingCalled',
]);

export function unknownFrame(frame: CDPPayload): boolean {
  if (typeof frame['securityOrigin'] !== 'string' || typeof frame['url'] !== 'string') return true;
  try {
    const origin = new URL(String(frame['securityOrigin']));
    new URL(String(frame['url']));
    return origin.origin === 'null';
  } catch {
    return true;
  }
}

export function sealedRead(method: string): boolean {
  return REALM_READS.has(method) || SEALED_DOMAINS.some((domain) => method.startsWith(domain));
}

export function wholePage(method: string): boolean {
  return WHOLE_PAGE.has(method) || REALM_READS.has(method) || method.startsWith('CSS.');
}

export function frameSets(
  tree: unknown,
  hidden: (frame: CDPPayload) => boolean
): { visible: Set<string>; sealed: Set<string> } {
  const visible = new Set<string>();
  const sealed = new Set<string>();
  const pending: [unknown, boolean, boolean][] = [[tree, false, true]];
  while (pending.length > 0) {
    const [node, above, top] = pending.pop() as [unknown, boolean, boolean];
    const frame = isObj(node) ? node['frame'] : undefined;
    if (!isObj(node) || !isObj(frame) || typeof frame['id'] !== 'string') continue;
    const shut = above || (!top && hidden(frame));
    (shut ? sealed : visible).add(frame['id']);
    for (const child of list(node['childFrames'])) pending.push([child, shut, false]);
  }
  return { visible, sealed };
}

export function sealedNodes(snapshot: unknown, visible: Ids): Set<unknown> {
  const strings = isObj(snapshot) ? list(snapshot['strings']) : [];
  const nodes = new Set<unknown>();
  for (const doc of isObj(snapshot) ? list(snapshot['documents']) : []) {
    const frame = isObj(doc) && typeof doc['frameId'] === 'number' ? strings[doc['frameId']] : '';
    if (visible.has(frame)) continue;
    const tree = isObj(doc) && isObj(doc['nodes']) ? doc['nodes'] : {};
    for (const id of list(tree['backendNodeId'])) nodes.add(id);
  }
  return nodes;
}

export function nodeSelectors(params: CDPPayload): {
  backend: number[];
  dom: number[];
  objects: string[];
} {
  const out = { backend: [] as number[], dom: [] as number[], objects: [] as string[] };
  for (const [key, value] of Object.entries(params)) {
    if (key === 'objectId' && typeof value === 'string') out.objects.push(value);
    if (!NODE_KEY.test(key)) continue;
    const ids = (Array.isArray(value) ? value : [value]).filter(
      (id): id is number => typeof id === 'number'
    );
    out[key.startsWith('backend') ? 'backend' : 'dom'].push(...ids);
  }
  return out;
}

export function boundIds(node: unknown, out: number[] = [], depth = 0): number[] {
  if (depth > 1000) throw new Error(DEEP);
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) boundIds(item, out, depth + 1);
    return out;
  }
  const value = node as CDPPayload;
  if (typeof value['nodeId'] === 'number' && value['nodeId'] > 0) out.push(value['nodeId']);
  for (const item of Object.values(value)) boundIds(item, out, depth + 1);
  return out;
}

function sealedItem(item: unknown, seal: Seal): boolean {
  if (!isObj(item)) return false;
  if (seal.nodes.has(item['backendNodeId']) || seal.nodes.has(item['backendDOMNodeId'])) {
    return true;
  }
  return typeof item['nodeId'] === 'string' && seal.sealed.has(item['frameId']);
}

function pruneList(items: unknown[], seal: Seal, cut: number[]): unknown[] {
  const gone = new Set<unknown>();
  const drop = (item: unknown): false => {
    if (isObj(item) && item['nodeId'] !== undefined) gone.add(item['nodeId']);
    boundIds(item, cut);
    return false;
  };
  let kept = items.filter((item) => !sealedItem(item, seal) || drop(item));
  for (let grew = true; grew; ) {
    grew = false;
    kept = kept.filter((item) => {
      if (!isObj(item) || !gone.has(item['parentId'])) return true;
      grew = true;
      return drop(item);
    });
  }
  return kept;
}

export function pruneSealed(value: unknown, seal: Seal, cut: number[] = [], depth = 0): number[] {
  if (depth > 1000) throw new Error(DEEP);
  if (value === null || typeof value !== 'object') return cut;
  if (Array.isArray(value)) {
    for (const item of value) pruneSealed(item, seal, cut, depth + 1);
    return cut;
  }
  const node = value as CDPPayload;
  const inner = node['contentDocument'];
  if (
    isObj(inner) &&
    (seal.nodes.has(inner['backendNodeId']) ||
      typeof node['frameId'] !== 'string' ||
      !seal.visible.has(node['frameId']))
  ) {
    boundIds(inner, cut);
    delete node['contentDocument'];
  }
  for (const [key, item] of Object.entries(node)) {
    if (sealedItem(item, seal)) {
      boundIds(item, cut);
      delete node[key];
      continue;
    }
    if (Array.isArray(item)) node[key] = pruneList(item, seal, cut);
    pruneSealed(node[key], seal, cut, depth + 1);
  }
  return cut;
}

export function sealedEvent(params: CDPPayload, cut: Ids): boolean {
  return NODE_EVENT_KEYS.some((key) => cut.has(params[key]));
}

export function pruneSnapshot(snapshot: CDPPayload, visible: Ids): CDPPayload {
  const strings = list(snapshot['strings']);
  const documents = list(snapshot['documents']);
  const index = new Map<number, number>();
  documents.forEach((doc, at) => {
    const frame = isObj(doc) && typeof doc['frameId'] === 'number' ? strings[doc['frameId']] : '';
    if (visible.has(frame)) index.set(at, index.size);
  });
  const fresh: string[] = [];
  const seen = new Map<number, number>();
  const str = (at: unknown): unknown => {
    if (typeof at !== 'number' || at < 0) return at;
    if (!seen.has(at)) {
      seen.set(at, fresh.length);
      const text = strings[at];
      fresh.push(typeof text === 'string' ? text : '');
    }
    return seen.get(at);
  };
  const all = (items: unknown): unknown => (Array.isArray(items) ? items.map(str) : items);
  const nested = (items: unknown): unknown => (Array.isArray(items) ? items.map(all) : items);
  const kept = documents
    .filter((_, at) => index.has(at))
    .map((raw) => {
      const doc = raw as CDPPayload;
      const out: CDPPayload = { ...doc };
      for (const key of DOCUMENT_STRINGS) out[key] = str(doc[key]);
      const nodes: CDPPayload = { ...(isObj(doc['nodes']) ? doc['nodes'] : {}) };
      nodes['nodeName'] = all(nodes['nodeName']);
      nodes['nodeValue'] = all(nodes['nodeValue']);
      nodes['attributes'] = nested(nodes['attributes']);
      for (const key of RARE_STRINGS) {
        const rare = nodes[key];
        if (isObj(rare)) nodes[key] = { ...rare, value: all(rare['value']) };
      }
      const content = nodes['contentDocumentIndex'];
      if (isObj(content)) {
        const values = list(content['value']);
        const pairs = list(content['index'])
          .map((node, at): [unknown, number | undefined] => [node, index.get(values[at] as number)])
          .filter(([, target]) => target !== undefined);
        nodes['contentDocumentIndex'] = {
          index: pairs.map(([node]) => node),
          value: pairs.map(([, target]) => target),
        };
      }
      out['nodes'] = nodes;
      const layout = doc['layout'];
      if (isObj(layout)) {
        out['layout'] = {
          ...layout,
          styles: nested(layout['styles']),
          text: all(layout['text']),
          blendedBackgroundColors: all(layout['blendedBackgroundColors']),
        };
      }
      return out;
    });
  return { ...snapshot, documents: kept, strings: fresh };
}
