import { test } from 'node:test';
import { launch } from './chrome.mjs';
import { extId } from './extension-page.mjs';

async function worker(chrome) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const found = targetInfos.find(
      (info) =>
        info.type === 'service_worker' && info.url === `chrome-extension://${extId}/background.js`
    );
    if (found) {
      const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
        targetId: found.targetId,
        flatten: true,
      });
      return sessionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('extension worker missing');
}

async function inWorker(chrome, sessionId, expression) {
  const answer = await chrome.cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  if (answer.exceptionDetails) return { exception: JSON.stringify(answer.exceptionDetails) };
  return answer.result?.value;
}

async function iframeTarget(chrome, marker) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const found = targetInfos.find((info) => info.type === 'iframe' && info.url.includes(marker));
    if (found) return found.targetId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function tools() {
  const NAMES = new Set(['IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'FENCEDFRAME']);
  const state = { tabId: 0, events: [] };
  const listener = (source, method, params) => {
    if (source.tabId !== state.tabId) return;
    state.events.push({
      method,
      private: typeof source.sessionId === 'string',
      type: params?.targetInfo?.type ?? null,
    });
  };
  const send = (method, params = {}, sessionId) =>
    chrome.debugger.sendCommand(
      sessionId ? { tabId: state.tabId, sessionId } : { tabId: state.tabId },
      method,
      params
    );
  const timed = async (fn) => {
    const start = performance.now();
    try {
      const result = await fn();
      return { ms: performance.now() - start, result };
    } catch (error) {
      return { ms: performance.now() - start, error: String(error?.message ?? error) };
    }
  };
  const summary = (list) =>
    list.reduce((acc, entry) => {
      const key = `${entry.method}@${entry.private ? 'private' : 'root'}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  const stats = (list) => {
    const sorted = [...list].sort((a, b) => a - b);
    return {
      n: sorted.length,
      median: sorted[Math.floor(sorted.length / 2)],
      p90: sorted[Math.floor(sorted.length * 0.9)],
      min: sorted[0],
      max: sorted.at(-1),
    };
  };
  const candidates = (snapshot) => {
    const found = [];
    const strings = snapshot?.strings ?? [];
    for (const doc of snapshot?.documents ?? []) {
      const nodes = doc.nodes ?? {};
      const content = new Set(nodes.contentDocumentIndex?.index ?? []);
      (nodes.nodeName ?? []).forEach((name, at) => {
        if (NAMES.has(String(strings[name]).toUpperCase()))
          found.push({ backend: nodes.backendNodeId[at], local: content.has(at) });
      });
    }
    return found;
  };
  const deepOwners = (node, out = {}) => {
    if (!node || typeof node !== 'object') return out;
    if (node.nodeType === 1 && typeof node.frameId === 'string')
      out[node.frameId] = { backend: node.backendNodeId, nodeId: node.nodeId };
    for (const child of [
      ...(node.children ?? []),
      ...(node.shadowRoots ?? []),
      ...(node.pseudoElements ?? []),
      ...(node.contentDocument ? [node.contentDocument] : []),
      ...(node.templateContent ? [node.templateContent] : []),
    ])
      deepOwners(child, out);
    return out;
  };
  const snapshotRead = async () => {
    const started = performance.now();
    const snapshot = await send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
    const snapshotMs = performance.now() - started;
    const bytes = JSON.stringify(snapshot).length;
    const owners = candidates(snapshot);
    const root = snapshot?.documents?.[0]?.nodes?.backendNodeId?.[0];
    const map = {};
    const nodeIds = [];
    const described = performance.now();
    for (const owner of owners.filter((entry) => !entry.local)) {
      const answer = await send('DOM.describeNode', { backendNodeId: owner.backend });
      nodeIds.push(answer?.node?.nodeId);
      if (typeof answer?.node?.frameId === 'string')
        map[answer.node.frameId] = { backend: owner.backend, nodeId: answer.node.nodeId };
    }
    return {
      snapshotMs,
      describeMs: performance.now() - described,
      bytes,
      owners,
      root,
      map,
      nodeIds,
    };
  };
  const deepRead = async (root) => {
    const started = performance.now();
    const answer = await send('DOM.describeNode', { backendNodeId: root, depth: -1, pierce: true });
    const ms = performance.now() - started;
    return { ms, bytes: JSON.stringify(answer).length, map: deepOwners(answer?.node) };
  };
  globalThis.__frameDiag = {
    start(tabId) {
      state.tabId = tabId;
      state.events = [];
      chrome.debugger.onEvent.removeListener(listener);
      chrome.debugger.onEvent.addListener(listener);
      return true;
    },
    stop() {
      chrome.debugger.onEvent.removeListener(listener);
      return true;
    },
    async attach(remoteId) {
      const out = { ua: navigator.userAgent };
      const info = await timed(() => send('Target.getTargetInfo'));
      const pageId = info.result?.targetInfo?.targetId;
      out.info = { error: info.error, type: info.result?.targetInfo?.type };
      out.debuggerTargets = (await chrome.debugger.getTargets())
        .filter((entry) => entry.tabId === state.tabId)
        .map((entry) => ({ type: entry.type, attached: entry.attached }));
      let mark = state.events.length;
      const self = await timed(() =>
        send('Target.attachToTarget', { targetId: pageId, flatten: true })
      );
      out.attachSelf = {
        ms: self.ms,
        error: self.error,
        sessionId: typeof self.result?.sessionId,
        events: summary(state.events.slice(mark)),
      };
      mark = state.events.length;
      const plain = await timed(() => send('Target.attachToTarget', { targetId: pageId }));
      out.attachSelfUnflattened = {
        error: plain.error,
        sessionId: typeof plain.result?.sessionId,
        events: summary(state.events.slice(mark)),
      };
      const child = await timed(() =>
        send('Target.attachToTarget', { targetId: remoteId, flatten: true })
      );
      out.attachChild = { error: child.error, sessionId: typeof child.result?.sessionId };
      out.getTargets = { error: (await timed(() => send('Target.getTargets'))).error };
      out.attachBrowser = {
        error: (await timed(() => send('Target.attachToBrowserTarget'))).error,
      };
      const privateId = self.result?.sessionId;
      if (privateId) {
        const owner = await timed(() =>
          send('DOM.getFrameOwner', { frameId: remoteId }, privateId)
        );
        out.privateOwner = { error: owner.error, nodeId: owner.result?.nodeId ?? null };
        await send('Target.detachFromTarget', { sessionId: privateId }).catch(() => undefined);
      }
      return out;
    },
    async reads(remoteIds) {
      const mark = state.events.length;
      const snap = await timed(snapshotRead);
      const deep = snap.result?.root
        ? await timed(() => deepRead(snap.result.root))
        : { error: 'no root' };
      return {
        error: snap.error ?? deep.error,
        snapshotMs: snap.result?.snapshotMs,
        describeMs: snap.result?.describeMs,
        snapshotBytes: snap.result?.bytes,
        candidates: snap.result?.owners.map((entry) => entry.local),
        describeNodeIds: snap.result?.nodeIds,
        deepMs: deep.result?.ms,
        deepBytes: deep.result?.bytes,
        deepNodeIds: Object.values(deep.result?.map ?? {}).map((entry) => entry.nodeId),
        owners: remoteIds.map((id) => ({
          snapshot: snap.result?.map?.[id]?.backend ?? null,
          deep: deep.result?.map?.[id]?.backend ?? null,
        })),
        rootEvents: summary(state.events.slice(mark)),
      };
    },
    async shared(remoteId) {
      const mark = state.events.length;
      const owner = await timed(() => send('DOM.getFrameOwner', { frameId: remoteId }));
      return {
        error: owner.error,
        backend: owner.result?.backendNodeId ?? null,
        nodeId: typeof owner.result?.nodeId,
        rootEvents: summary(state.events.slice(mark)),
      };
    },
    async cost(remoteId, rounds) {
      const snapshot = [];
      const describe = [];
      const deep = [];
      const shared = [];
      let bytes = 0;
      let deepBytes = 0;
      for (let i = 0; i < rounds; i++) {
        const read = await snapshotRead();
        snapshot.push(read.snapshotMs + read.describeMs);
        describe.push(read.describeMs);
        bytes = read.bytes;
        const start = performance.now();
        const wide = await deepRead(read.root);
        deep.push(performance.now() - start);
        deepBytes = wide.bytes;
        const at = performance.now();
        await send('DOM.getFrameOwner', { frameId: remoteId });
        shared.push(performance.now() - at);
      }
      return {
        snapshotPlusDescribe: stats(snapshot),
        describeOnly: stats(describe),
        deepDescribe: stats(deep),
        sharedGetFrameOwner: stats(shared),
        snapshotBytes: bytes,
        deepBytes,
      };
    },
  };
  return true;
}

function canonical(list) {
  const ids = new Map();
  const id = (value) => {
    if (typeof value !== 'number' || value === 0) return value;
    if (!ids.has(value)) ids.set(value, ids.size + 1);
    return `n${ids.get(value)}`;
  };
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (['nodeId', 'parentId', 'previousNodeId', 'hostId', 'insertionPointId'].includes(key))
        out[key] = id(item);
      else if (key === 'nodeIds' && Array.isArray(item)) out[key] = item.map(id);
      else out[key] = walk(item);
    }
    return out;
  };
  return JSON.stringify(walk(list));
}

test('diagnostic: frame owner read without the shared DOM agent', async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const result = {};
  const heap = async (sw) => {
    await chrome.cdp.send('HeapProfiler.collectGarbage', {}, sw).catch(() => undefined);
    return (await chrome.cdp.send('Runtime.getHeapUsage', {}, sw).catch(() => ({}))).usedSize;
  };
  try {
    const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
    const url = 'https://ordinary.test/doc?frames-owner-diag';
    const target = await chrome.visit(t, url);
    await target.evaluate(async () => {
      const wrap = document.createElement('div');
      const inner = document.createElement('section');
      inner.id = 'diag-section';
      wrap.append(inner);
      document.body.append(wrap);
      const add = (src, parent) =>
        new Promise((resolve) => {
          const iframe = document.createElement('iframe');
          iframe.onload = resolve;
          setTimeout(resolve, 5000);
          iframe.src = src;
          parent.append(iframe);
        });
      await add('https://other.test/doc?OWNER_DIAG_REMOTE', inner);
      await add('https://ordinary.test/doc?OWNER_DIAG_LOCAL', inner);
      const host = document.createElement('div');
      host.attachShadow({ mode: 'open' }).innerHTML = '<slot name="named"></slot>';
      document.body.append(host);
      await add('https://other.test/doc?OWNER_DIAG_UNSLOTTED', host);
    });
    const remoteId = await iframeTarget(chrome, 'OWNER_DIAG_REMOTE');
    const unslottedId = await iframeTarget(chrome, 'OWNER_DIAG_UNSLOTTED');
    result.targets = { remote: Boolean(remoteId), unslotted: Boolean(unslottedId) };
    const remoteIds = [remoteId, unslottedId];
    const tabId = await page.evaluate(async (url) => {
      const listed = await sliccExtension.cdp.send('Target.getTargets');
      const info = listed.targetInfos.find((entry) => entry.url === url);
      const attached = await sliccExtension.cdp.send('Target.attachToTarget', {
        targetId: info.targetId,
        flatten: true,
      });
      globalThis.__diag = { sessionId: attached.sessionId, events: [] };
      sliccExtension.cdp.on((message) => {
        if (typeof message.method === 'string')
          globalThis.__diag.events.push({ method: message.method, params: message.params });
      });
      return Number(info.targetId);
    }, url);
    const client = (body, arg) =>
      page.evaluate(body, { tabId, ...arg }).catch((error) => ({
        error: String(error?.message ?? error),
      }));
    const sw = await worker(chrome);
    result.install = await inWorker(chrome, sw, `(${tools.toString()})()`);
    await inWorker(chrome, sw, `globalThis.__frameDiag.start(${tabId})`);
    const located = await client(async () => {
      const { sessionId } = globalThis.__diag;
      await sliccExtension.cdp.send('DOM.enable', {}, sessionId);
      const doc = await sliccExtension.cdp.send(
        'DOM.getDocument',
        { depth: -1, pierce: false },
        sessionId
      );
      const found = {};
      const walk = (node) => {
        if (node.nodeName === 'IFRAME') {
          const src = node.attributes?.[node.attributes.indexOf('src') + 1] ?? '';
          if (src.includes('OWNER_DIAG_REMOTE')) found.remote = node.backendNodeId;
          if (src.includes('OWNER_DIAG_UNSLOTTED')) found.unslotted = node.backendNodeId;
        }
        for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
      };
      walk(doc.root);
      return found;
    });
    result.located = { remote: typeof located.remote, unslotted: typeof located.unslotted };
    const segment = async (withRead) => {
      const fresh = await client(async () => {
        const { sessionId } = globalThis.__diag;
        const doc = await sliccExtension.cdp.send('DOM.getDocument', { depth: 2 }, sessionId);
        const body = doc.root.children[0].children.find((node) => node.nodeName === 'BODY');
        globalThis.__diag.mark = globalThis.__diag.events.length;
        globalThis.__diag.body = { nodeId: body.nodeId, backendNodeId: body.backendNodeId };
        return { doc };
      });
      const read = withRead
        ? await inWorker(chrome, sw, `globalThis.__frameDiag.reads(${JSON.stringify(remoteIds)})`)
        : null;
      const after = await client(
        async ({ backends }) => {
          const { sessionId, mark, body } = globalThis.__diag;
          await new Promise((resolve) => setTimeout(resolve, 300));
          const between = globalThis.__diag.events.slice(mark).map((entry) => entry.method);
          const again = await sliccExtension.cdp.send(
            'DOM.describeNode',
            { nodeId: body.nodeId },
            sessionId
          );
          const start = globalThis.__diag.events.length;
          const pushed = await sliccExtension.cdp.send(
            'DOM.pushNodesByBackendIdsToFrontend',
            { backendNodeIds: backends },
            sessionId
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          const pushEvents = globalThis.__diag.events.slice(start);
          const described = await sliccExtension.cdp.send(
            'DOM.describeNode',
            { backendNodeId: backends[0] },
            sessionId
          );
          return {
            between,
            bodyStable:
              again.node?.backendNodeId === body.backendNodeId && again.node?.nodeName === 'BODY',
            pushed,
            pushEvents,
            described,
          };
        },
        { backends: [located.remote, located.unslotted].filter(Number.isInteger) }
      );
      return { fresh, read, after };
    };
    const control = await segment(false);
    const probed = await segment(true);
    const shape = (run) =>
      canonical([
        run.fresh.doc,
        run.after.pushed,
        run.after.pushEvents,
        run.after.described?.node?.nodeId,
      ]);
    result.proof = {
      controlBetween: control.after.between,
      probedBetween: probed.after.between,
      bodyStable: [control.after.bodyStable, probed.after.bodyStable],
      pushEventsControl: control.after.pushEvents.map((entry) => entry.method),
      pushEventsProbed: probed.after.pushEvents.map((entry) => entry.method),
      sameClientShape: shape(control) === shape(probed),
      controlError: control.fresh.error ?? control.after.error,
      probedError: probed.fresh.error ?? probed.after.error,
      read: probed.read,
      ownersMatchLocated: probed.read?.owners?.map((entry, at) => ({
        snapshot: entry.snapshot === [located.remote, located.unslotted][at],
        deep: entry.deep === [located.remote, located.unslotted][at],
      })),
    };
    const framesCall = (rounds) =>
      client(
        async ({ tabId, rounds }) => {
          const mark = globalThis.__diag.events.length;
          let reply;
          let error;
          for (let attempt = 0; attempt < 30; attempt += 1) {
            try {
              reply = await sliccExtension.frames(tabId);
              error = undefined;
              break;
            } catch (e) {
              error = e.message;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
          const seen = globalThis.__diag.events.slice(mark).map((entry) => entry.method);
          const times = [];
          for (let i = 0; reply && i < rounds; i += 1) {
            const start = performance.now();
            await sliccExtension.frames(tabId).catch(() => undefined);
            times.push(performance.now() - start);
          }
          times.sort((a, b) => a - b);
          return {
            error,
            owners: reply?.remoteOwners ?? null,
            localFrames: reply?.localFrames?.length,
            clientEvents: seen,
            median: times[Math.floor(times.length / 2)],
            max: times.at(-1),
          };
        },
        { rounds }
      );
    await client(async () => {
      const { sessionId } = globalThis.__diag;
      await sliccExtension.cdp.send('DOM.getDocument', { depth: 2 }, sessionId);
      return true;
    });
    const base = await framesCall(10);
    result.baseFrames = {
      error: base.error,
      localFrames: base.localFrames,
      remoteOwners: base.owners?.length,
      clientEvents: base.clientEvents,
      median: base.median,
      max: base.max,
      ownersMatchRead: (base.owners ?? []).map((owner) =>
        [located.remote, located.unslotted].includes(owner.backendNodeId)
      ),
    };
    result.shared = await inWorker(
      chrome,
      sw,
      `globalThis.__frameDiag.shared(${JSON.stringify(remoteId)})`
    );
    result.attach = await inWorker(
      chrome,
      sw,
      `globalThis.__frameDiag.attach(${JSON.stringify(remoteId)})`
    );
    result.cost = {};
    for (const [label, count, rounds] of [
      ['small', 0, 10],
      ['5k', 2500, 10],
      ['50k', 22500, 5],
    ]) {
      if (count)
        await target.evaluate((count) => {
          const box = document.createElement('div');
          for (let i = 0; i < count; i += 1) {
            const item = document.createElement('div');
            item.textContent = `row ${i}`;
            box.append(item);
          }
          document.body.append(box);
        }, count);
      const nodes = await target.evaluate(() => {
        const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
        let total = 1;
        while (walker.nextNode()) total += 1;
        return total;
      });
      const before = await heap(sw);
      const read = await inWorker(
        chrome,
        sw,
        `globalThis.__frameDiag.cost(${JSON.stringify(remoteId)}, ${rounds})`
      );
      const peak = (await chrome.cdp.send('Runtime.getHeapUsage', {}, sw).catch(() => ({})))
        .usedSize;
      const after = await heap(sw);
      const frames = await framesCall(rounds);
      result.cost[label] = {
        nodes,
        read,
        heap: { before, peakNoGc: peak, afterGc: after },
        frames: { error: frames.error, median: frames.median, max: frames.max },
      };
    }
    await inWorker(chrome, sw, 'globalThis.__frameDiag.stop()');
  } catch (error) {
    result.failure = String(error?.stack ?? error);
  }
  const line = `FRAMES_OWNER_DIAG ${JSON.stringify(result)}`;
  t.diagnostic(line);
  console.log(line);
});
