import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { send } from './guard.mjs';

const gateSource = String.raw`
const sliccInbound = (globalThis.__sliccInbound ??= {
  held: new Map(),
  seen: [],
});
function sliccRemember(args) {
  try {
    const bits = [];
    const push = (value) => {
      if (typeof value === 'string' && value.indexOf('://') !== -1) bits.push(value);
    };
    const pull = (value) => {
      if (!value || typeof value !== 'object') return;
      push(value.url);
      push(value.pendingUrl);
      push(value.unreachableUrl);
      push(value.documentURL);
      pull(value.frame);
      pull(value.request);
      pull(value.targetInfo);
    };
    pull(args[1]);
    pull(args[2]);
    if (!bits.length) return;
    sliccInbound.seen.push(bits.join(' '));
    if (sliccInbound.seen.length > 500) sliccInbound.seen.shift();
  } catch {
    return;
  }
}
function sliccRestore(args) {
  return args[1] === 'Page.frameNavigated' && args[2]?.type === 'BackForwardCacheRestore';
}
function sliccBucket(args) {
  const source = args[0];
  const keys = [];
  if (source && typeof source === 'object') {
    if (typeof source.tabId === 'number') keys.push('tab:' + source.tabId);
    if (typeof source.targetId === 'string') keys.push('target:' + source.targetId);
  } else if (typeof source === 'number') {
    keys.push('tab:' + source);
  }
  for (const key of keys) {
    const bucket = sliccInbound.held.get(key);
    if (bucket) return bucket;
  }
  return undefined;
}
function sliccWrap(target) {
  const add = target.addListener.bind(target);
  target.addListener = (fn, ...rest) =>
    add((...args) => {
      sliccRemember(args);
      const bucket = sliccBucket(args);
      if (!bucket) return fn(...args);
      if (sliccRestore(args)) {
        bucket.count += 1;
        if (!bucket.first) bucket.first = Date.now();
      }
      bucket.queue.push(() => fn(...args));
    }, ...rest);
}
sliccWrap(chrome.debugger.onEvent);
sliccWrap(chrome.tabs.onUpdated);
globalThis.__sliccInboundHold = async (sessionId, targetId) => {
  let tabId;
  if (/^\d+$/.test(sessionId)) tabId = Number(sessionId);
  if (typeof tabId !== 'number' && targetId) {
    const list = await chrome.debugger.getTargets();
    const found = list.find((target) => target.id === targetId);
    if (found && typeof found.tabId === 'number') tabId = found.tabId;
  }
  const bucket = { queue: [], count: 0, first: 0, keys: [] };
  const add = (key) => {
    bucket.keys.push(key);
    sliccInbound.held.set(key, bucket);
  };
  if (typeof tabId === 'number') add('tab:' + tabId);
  if (targetId) add('target:' + targetId);
  return bucket.keys[0] || false;
};
globalThis.__sliccInboundPending = (key) => {
  const bucket = sliccInbound.held.get(key);
  return {
    delayedEvents: bucket ? bucket.count : 0,
    firstDelayedAt: bucket ? bucket.first : 0,
  };
};
globalThis.__sliccInboundRelease = (key) => {
  const bucket = sliccInbound.held.get(key);
  if (!bucket) return { delayedEvents: 0, firstDelayedAt: 0 };
  for (const owned of bucket.keys) sliccInbound.held.delete(owned);
  const delayedEvents = bucket.count;
  const firstDelayedAt = bucket.first;
  const queued = bucket.queue.splice(0);
  for (const run of queued) run();
  return { delayedEvents, firstDelayedAt };
};
`;

export async function armInbound(paths) {
  const file = join(paths[0], 'cdp.js');
  const source = await readFile(file, 'utf8');
  if (source.includes('globalThis.__sliccInbound')) return;
  await writeFile(file, `${source}\n${gateSource}`);
}

function sawSeed(texts) {
  let protectedAt = -1;
  let ordinaryAt = -1;
  texts.forEach((text, index) => {
    const raw = String(text);
    if (/https:\/\/(?!www\.)(?:[a-z0-9-]+\.)?sliccy\.ai\/bfcache/.test(raw)) protectedAt = index;
    if (/https:\/\/ordinary\.test\/bfcache/.test(raw)) ordinaryAt = index;
  });
  return {
    protectedObserved: protectedAt >= 0,
    ordinaryObserved: protectedAt >= 0 && ordinaryAt > protectedAt,
  };
}

function holdSession(events, sessionId, ms) {
  const held = [];
  let count = 0;
  let first = 0;
  const push = events.push.bind(events);
  events.push = (...items) => {
    const pass = [];
    for (const item of items) {
      if (item?.sessionId !== sessionId) {
        pass.push(item);
        continue;
      }
      held.push(item);
      if (
        item.method === 'Page.frameNavigated' &&
        item.params?.type === 'BackForwardCacheRestore'
      ) {
        count += 1;
        if (!first) first = Date.now();
      }
    }
    return pass.length ? push(...pass) : events.length;
  };
  let released = false;
  return async () => {
    if (released) {
      return { delayedEvents: count, firstDelayedAt: first, releasedAt: Date.now() };
    }
    released = true;
    if (first) {
      const wait = first + ms - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    events.push = push;
    if (held.length) push(...held);
    return { delayedEvents: count, firstDelayedAt: first, releasedAt: Date.now() };
  };
}

export function inboundDelay({ evaluate }) {
  return async ({ targetId, sessionId, ms, side, client, gate }) => {
    const texts =
      side === 'guarded'
        ? String(
            (await evaluate('(globalThis.__sliccInbound.seen || []).join("\\n")')) ?? ''
          ).split('\n')
        : (client.events ?? []).map((event) => JSON.stringify(event));
    const seen = sawSeed(texts);
    let release;
    if (side === 'guarded') {
      const key = await evaluate(
        `globalThis.__sliccInboundHold(${JSON.stringify(String(sessionId))}, ${JSON.stringify(String(targetId ?? ''))})`
      );
      let released = false;
      release = async () => {
        if (released) {
          return { delayedEvents: 0, firstDelayedAt: 0, releasedAt: Date.now() };
        }
        released = true;
        const pending = await evaluate(`globalThis.__sliccInboundPending(${JSON.stringify(key)})`);
        const first = pending?.firstDelayedAt || 0;
        if (first) {
          const wait = first + ms - Date.now();
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        }
        const flushed = await evaluate(`globalThis.__sliccInboundRelease(${JSON.stringify(key)})`);
        return {
          delayedEvents: flushed?.delayedEvents ?? 0,
          firstDelayedAt: flushed?.firstDelayedAt ?? 0,
          releasedAt: Date.now(),
        };
      };
    } else {
      release = holdSession(client.events, sessionId, ms);
    }
    return {
      targetId,
      sessionId,
      ms,
      gate: gate === true,
      protectedObserved: seen.protectedObserved,
      ordinaryObserved: seen.ordinaryObserved,
      release,
    };
  };
}

export async function workerEval(cdp, sessionId, expression) {
  await send(cdp, 'Runtime.enable', {}, sessionId).catch(() => undefined);
  const answer = await send(
    cdp,
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (answer.exceptionDetails) {
    throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
  }
  return answer.result?.value;
}
