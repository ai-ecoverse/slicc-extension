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

async function remoteFrame(chrome, marker) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const found = targetInfos.find((info) => info.type === 'iframe' && info.url.includes(marker));
    if (found) return found.targetId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

const SW = `(async ({ tabId, remoteId, rounds }) => {
  const out = { ua: navigator.userAgent };
  const events = [];
  const listener = (source, method, params) => {
    if (source.tabId !== tabId) return;
    events.push({ method, session: source.sessionId ?? null, type: params?.targetInfo?.type ?? null, sessionId: params?.sessionId ?? null });
  };
  chrome.debugger.onEvent.addListener(listener);
  const send = (method, params = {}, sessionId) =>
    chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params);
  const timed = async (fn) => {
    const start = performance.now();
    try {
      const result = await fn();
      return { ms: performance.now() - start, result };
    } catch (error) {
      return { ms: performance.now() - start, error: String(error?.message ?? error) };
    }
  };
  const since = (mark) => events.slice(mark);
  const summary = (list) => list.reduce((acc, e) => { const key = e.method + (e.session ? '@private' : '@root'); acc[key] = (acc[key] ?? 0) + 1; return acc; }, {});
  const stats = (list) => { const s = [...list].sort((a, b) => a - b); return { n: s.length, median: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], min: s[0], max: s.at(-1) }; };
  try {
    const info = await timed(() => send('Target.getTargetInfo'));
    out.info = { error: info.error, type: info.result?.targetInfo?.type };
    const pageId = info.result?.targetInfo?.targetId;
    out.debuggerTargets = (await chrome.debugger.getTargets()).filter((entry) => entry.tabId === tabId).map((entry) => ({ type: entry.type, attached: entry.attached, samePage: entry.id === pageId }));
    let mark = events.length;
    const self = await timed(() => send('Target.attachToTarget', { targetId: pageId, flatten: true }));
    out.attachSelf = { ms: self.ms, error: self.error, sessionId: typeof self.result?.sessionId, events: summary(since(mark)) };
    mark = events.length;
    const selfPlain = await timed(() => send('Target.attachToTarget', { targetId: pageId }));
    out.attachSelfUnflattened = { error: selfPlain.error, sessionId: typeof selfPlain.result?.sessionId, events: summary(since(mark)) };
    const child = await timed(() => send('Target.attachToTarget', { targetId: remoteId, flatten: true }));
    out.attachChild = { error: child.error, sessionId: typeof child.result?.sessionId };
    const tabTarget = await timed(() => send('Target.getTargets'));
    out.getTargets = { error: tabTarget.error };
    const browser = await timed(() => send('Target.attachToBrowserTarget'));
    out.attachBrowser = { error: browser.error };
    const privateId = self.result?.sessionId;
    if (privateId) {
      mark = events.length;
      const owner = await timed(() => send('DOM.getFrameOwner', { frameId: remoteId }, privateId));
      out.privateOwner = { ms: owner.ms, error: owner.error, backend: owner.result?.backendNodeId, nodeId: owner.result?.nodeId ?? null, events: summary(since(mark)) };
      mark = events.length;
      const detached = await timed(() => send('Target.detachFromTarget', { sessionId: privateId }));
      out.privateDetach = { ms: detached.ms, error: detached.error, events: summary(since(mark)) };
      const perCall = [];
      for (let i = 0; i < rounds; i++) {
        const start = performance.now();
        const { sessionId } = await send('Target.attachToTarget', { targetId: pageId, flatten: true });
        await send('DOM.getFrameOwner', { frameId: remoteId }, sessionId);
        await send('Target.detachFromTarget', { sessionId });
        perCall.push(performance.now() - start);
      }
      out.perCall = stats(perCall);
      const { sessionId } = await send('Target.attachToTarget', { targetId: pageId, flatten: true });
      const cached = [];
      for (let i = 0; i < rounds; i++) {
        const start = performance.now();
        await send('DOM.getFrameOwner', { frameId: remoteId }, sessionId);
        cached.push(performance.now() - start);
      }
      await send('Target.detachFromTarget', { sessionId });
      out.cached = stats(cached);
    }
    const NAMES = new Set(['IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'FENCEDFRAME']);
    const candidates = (snapshot) => {
      const found = [];
      for (const doc of snapshot.documents ?? []) {
        const nodes = doc.nodes ?? {};
        const content = new Set(nodes.contentDocumentIndex?.index ?? []);
        (nodes.nodeName ?? []).forEach((name, at) => {
          if (NAMES.has(String(snapshot.strings[name]).toUpperCase())) found.push({ backend: nodes.backendNodeId[at], local: content.has(at) });
        });
      }
      return found;
    };
    const alternative = async () => {
      const snapshot = await send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
      const owners = candidates(snapshot);
      const map = {};
      for (const owner of owners.filter((entry) => !entry.local)) {
        const described = await send('DOM.describeNode', { backendNodeId: owner.backend });
        if (typeof described?.node?.frameId === 'string') map[described.node.frameId] = { backend: owner.backend, nodeId: described.node.nodeId };
      }
      return { owners, map };
    };
    mark = events.length;
    const alt = await timed(alternative);
    out.alternative = {
      ms: alt.ms,
      error: alt.error,
      candidates: alt.result?.owners.map((entry) => ({ local: entry.local })),
      remoteFound: Boolean(alt.result?.map?.[remoteId]),
      remoteNodeId: alt.result?.map?.[remoteId]?.nodeId ?? null,
      events: summary(since(mark)),
    };
    const legacy = await timed(() => send('DOMSnapshot.getSnapshot', { computedStyleWhitelist: [] }));
    out.legacy = {
      error: legacy.error,
      ownerFrameIds: (legacy.result?.domNodes ?? []).filter((node) => NAMES.has(String(node.nodeName).toUpperCase())).map((node) => ({ frameId: node.frameId === remoteId ? 'remote' : node.frameId ? 'other' : null, content: node.contentDocumentIndex !== undefined })),
    };
    const altTimes = [];
    for (let i = 0; i < rounds; i++) {
      const start = performance.now();
      await alternative();
      altTimes.push(performance.now() - start);
    }
    out.alternativeCost = stats(altTimes);
    const describeTimes = [];
    const remoteBackend = alt.result?.map?.[remoteId]?.backend;
    for (let i = 0; remoteBackend && i < rounds; i++) {
      const start = performance.now();
      await send('DOM.describeNode', { backendNodeId: remoteBackend });
      describeTimes.push(performance.now() - start);
    }
    out.describeCost = stats(describeTimes);
    mark = events.length;
    const shared = await timed(() => send('DOM.getFrameOwner', { frameId: remoteId }));
    out.sharedOwner = { ms: shared.ms, error: shared.error, sameBackend: shared.result?.backendNodeId === remoteBackend, nodeId: typeof shared.result?.nodeId, events: summary(since(mark)) };
    const sharedTimes = [];
    for (let i = 0; i < rounds; i++) {
      const start = performance.now();
      await send('DOM.getFrameOwner', { frameId: remoteId });
      sharedTimes.push(performance.now() - start);
    }
    out.sharedCost = stats(sharedTimes);
  } catch (error) {
    out.failure = String(error?.stack ?? error);
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
  }
  return out;
})`;

test('diagnostic: frame owner read without the shared DOM agent', async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const result = {};
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
      const add = (src) =>
        new Promise((resolve) => {
          const iframe = document.createElement('iframe');
          iframe.onload = resolve;
          iframe.src = src;
          inner.append(iframe);
        });
      await add('https://other.test/doc?OWNER_DIAG_REMOTE');
      await add('https://ordinary.test/doc?OWNER_DIAG_LOCAL');
    });
    const remoteId = await remoteFrame(chrome, 'OWNER_DIAG_REMOTE');
    result.remoteTarget = Boolean(remoteId);
    const tabId = await page.evaluate(async (url) => {
      const listed = await sliccExtension.cdp.send('Target.getTargets');
      const info = listed.targetInfos.find((entry) => entry.url === url);
      const attached = await sliccExtension.cdp.send('Target.attachToTarget', {
        targetId: info.targetId,
        flatten: true,
      });
      globalThis.__diag = { sessionId: attached.sessionId, events: [] };
      sliccExtension.cdp.on((message) => globalThis.__diag.events.push(message.method ?? 'reply'));
      return Number(info.targetId);
    }, url);
    const client = (label, body) =>
      page
        .evaluate(body, { tabId, label })
        .catch((error) => ({ label, error: String(error?.message ?? error) }));
    result.base = await client('base', async ({ tabId }) => {
      const { sessionId } = globalThis.__diag;
      const doc = await sliccExtension.cdp.send('DOM.getDocument', { depth: 1 }, sessionId);
      const section = await sliccExtension.cdp.send(
        'DOM.querySelector',
        { nodeId: doc.root.nodeId, selector: '#diag-section' },
        sessionId
      );
      globalThis.__diag.section = section.nodeId;
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
      const seen = globalThis.__diag.events.slice(mark);
      const times = [];
      for (let i = 0; reply && i < 20; i += 1) {
        const start = performance.now();
        await sliccExtension.frames(tabId);
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      return {
        error,
        remoteOwners: reply?.remoteOwners?.length,
        localFrames: reply?.localFrames?.length,
        clientSetChildNodes: seen.filter((m) => m === 'DOM.setChildNodes').length,
        clientDocumentUpdated: seen.filter((m) => m === 'DOM.documentUpdated').length,
        framesCost: times.length
          ? { n: times.length, median: times[10], p90: times[18], min: times[0], max: times[19] }
          : null,
      };
    });
    await client('rebind', async () => {
      const { sessionId } = globalThis.__diag;
      const doc = await sliccExtension.cdp.send('DOM.getDocument', { depth: 1 }, sessionId);
      const section = await sliccExtension.cdp.send(
        'DOM.querySelector',
        { nodeId: doc.root.nodeId, selector: '#diag-section' },
        sessionId
      );
      globalThis.__diag.section = section.nodeId;
      globalThis.__diag.mark = globalThis.__diag.events.length;
      return true;
    });
    const sw = await worker(chrome);
    result.worker = await inWorker(
      chrome,
      sw,
      `${SW}(${JSON.stringify({ tabId, remoteId, rounds: 20 })})`
    );
    result.after = await client('after', async () => {
      const { sessionId, section, mark } = globalThis.__diag;
      const seen = globalThis.__diag.events.slice(mark);
      let described;
      try {
        described = (
          await sliccExtension.cdp.send('DOM.describeNode', { nodeId: section }, sessionId)
        ).node?.nodeName;
      } catch (e) {
        described = `error: ${e.message}`;
      }
      return {
        clientSetChildNodes: seen.filter((m) => m === 'DOM.setChildNodes').length,
        clientTarget: seen.filter((m) => m?.startsWith('Target.')),
        sectionStillResolves: described,
      };
    });
  } catch (error) {
    result.failure = String(error?.stack ?? error);
  }
  const line = `FRAMES_OWNER_DIAG ${JSON.stringify(result)}`;
  t.diagnostic(line);
  console.log(line);
});
