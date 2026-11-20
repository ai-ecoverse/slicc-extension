import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const ERROR = 'chrome-error://chromewebdata/';
const CANARY = 'https://127.0.0.1:1/ERROR_FRAME_CANARY?q=CANARY';
const SIBLING = 'https://other.test/doc?FRAME_LIST_DIAG_SIBLING=seven';

function parseDiag(error) {
  const text = String(error ?? '');
  const marker = 'FRAME_DIAG_JSON:';
  const at = text.indexOf(marker);
  if (at < 0) return { reason: text, diag: null };
  const reason = text.slice(0, at).trim();
  try {
    return { reason, diag: JSON.parse(text.slice(at + marker.length)) };
  } catch {
    return { reason: text, diag: null };
  }
}

function walk(tree, out = []) {
  const frame = tree?.frame;
  if (frame) out.push(frame);
  for (const child of tree?.childFrames ?? []) walk(child, out);
  return out;
}

function classify(url = '', unreachable = '') {
  const text = `${url} ${unreachable}`;
  if (url.startsWith('chrome-error:') || unreachable.includes('127.0.0.1:1')) return 'canary';
  if (text.includes('other.test') || text.includes('FRAME_LIST_DIAG_SIBLING')) return 'sibling';
  if (text.includes('127.0.0.1:1') || text.includes('ERROR_FRAME_CANARY')) return 'canary';
  return 'other';
}

async function childTree(cdp, targetId) {
  const attached = await cdp
    .send('Target.attachToTarget', { targetId, flatten: true })
    .catch(() => null);
  if (!attached?.sessionId) return { error: 'attach-failed' };
  try {
    const tree = await cdp.send('Page.getFrameTree', {}, attached.sessionId);
    const frame = tree?.frameTree?.frame ?? {};
    return {
      url: frame.url,
      unreachableUrl: frame.unreachableUrl,
      chromeError: String(frame.url ?? '').startsWith('chrome-error:'),
    };
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 80) };
  } finally {
    await cdp
      .send('Target.detachFromTarget', { sessionId: attached.sessionId })
      .catch(() => undefined);
  }
}

async function probeReachability(cdp, pageTargetId, onloadAt, windowMs = 10000) {
  const started = Date.now();
  const sinceOnload = () => (onloadAt == null ? null : Date.now() - onloadAt);
  const navigated = [];
  const off = cdp.on(({ method, params, sessionId }) => {
    if (method !== 'Page.frameNavigated') return;
    const frame = params?.frame ?? {};
    navigated.push({
      at: Date.now() - started,
      sinceOnload: sinceOnload(),
      sessionId: sessionId ? String(sessionId).slice(0, 12) : null,
      url: frame.url,
      unreachableUrl: frame.unreachableUrl,
      role: classify(frame.url, frame.unreachableUrl),
      chromeError: String(frame.url ?? '').startsWith('chrome-error:'),
    });
  });
  const samples = [];
  let firstCanaryError = null;
  let firstSiblingSettled = null;
  try {
    const parent = await cdp
      .send('Target.attachToTarget', { targetId: pageTargetId, flatten: true })
      .catch(() => null);
    if (parent?.sessionId) {
      await cdp.send('Page.enable', {}, parent.sessionId).catch(() => undefined);
    }
    const deadline = started + windowMs;
    while (Date.now() < deadline) {
      const at = Date.now() - started;
      const listed = await cdp.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
      const targets = (listed.targetInfos ?? [])
        .filter((info) => info.type === 'iframe' || info.type === 'page')
        .map((info) => ({
          targetId: String(info.targetId ?? '').slice(0, 12),
          type: info.type,
          url: info.url,
          role: classify(info.url),
          chromeError: String(info.url ?? '').startsWith('chrome-error:'),
        }));
      const canaryTargets = (listed.targetInfos ?? []).filter(
        (info) =>
          info.type === 'iframe' &&
          (String(info.url ?? '').includes('127.0.0.1:1') ||
            String(info.url ?? '').startsWith('chrome-error:'))
      );
      const siblingTargets = (listed.targetInfos ?? []).filter(
        (info) => info.type === 'iframe' && String(info.url ?? '').includes('other.test')
      );
      const pageTree = parent?.sessionId
        ? await cdp.send('Page.getFrameTree', {}, parent.sessionId).catch(() => null)
        : null;
      const frames = walk(pageTree?.frameTree).map((frame) => ({
        url: frame.url,
        unreachableUrl: frame.unreachableUrl,
        role: classify(frame.url, frame.unreachableUrl),
        chromeError: String(frame.url ?? '').startsWith('chrome-error:'),
      }));
      const childReads = [];
      for (const info of [...canaryTargets, ...siblingTargets].slice(0, 4)) {
        const read = await childTree(cdp, info.targetId);
        childReads.push({
          targetId: String(info.targetId ?? '').slice(0, 12),
          listedUrl: info.url,
          role: classify(info.url, read.unreachableUrl),
          ...read,
        });
      }
      const canaryError =
        frames.some((f) => f.role === 'canary' && f.chromeError) ||
        targets.some((t) => t.role === 'canary' && t.chromeError) ||
        childReads.some((c) => c.role === 'canary' && c.chromeError) ||
        navigated.some((n) => n.role === 'canary' && n.chromeError);
      const siblingOk =
        frames.some((f) => f.role === 'sibling' && !f.chromeError) ||
        targets.some((t) => t.role === 'sibling' && !t.chromeError) ||
        childReads.some((c) => c.role === 'sibling' && !c.chromeError);
      if (canaryError && firstCanaryError == null) {
        firstCanaryError = { at, sinceOnload: sinceOnload() };
      }
      if (siblingOk && firstSiblingSettled == null) {
        firstSiblingSettled = { at, sinceOnload: sinceOnload() };
      }
      samples.push({
        at,
        sinceOnload: sinceOnload(),
        frames,
        targets: targets.filter((t) => t.role === 'canary' || t.role === 'sibling'),
        childReads,
        canaryError,
        siblingOk,
      });
      if (canaryError && siblingOk) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (parent?.sessionId) {
      await cdp
        .send('Target.detachFromTarget', { sessionId: parent.sessionId })
        .catch(() => undefined);
    }
  } finally {
    off();
  }
  return {
    windowMs,
    ms: Date.now() - started,
    firstCanaryError,
    firstSiblingSettled,
    canaryReachedChromeError: Boolean(firstCanaryError),
    navigated: navigated.filter((n) => n.role === 'canary' || n.role === 'sibling'),
    sampleCount: samples.length,
    lastSample: samples.at(-1) ?? null,
  };
}

async function framed(t) {
  const host = 'seven.sliccy.ai';
  const page = await chrome.visit(t, `https://${host}/`);
  const url = `https://ordinary.test/doc?frame-list-diag-${Date.now()}-${Math.random()}`;
  const target = await chrome.visit(t, url);
  const pageTargetId = await (async () => {
    for (let i = 0; i < 50; i += 1) {
      const listed = await chrome.cdp.send('Target.getTargets');
      const info = listed.targetInfos.find((entry) => entry.url === url);
      if (info?.targetId) return info.targetId;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('ordinary fixture target was not listed');
  })();
  const targetId = await page.evaluate(async (url) => {
    const listed = await sliccExtension.cdp.send('Target.getTargets');
    const info = listed.targetInfos.find((entry) => entry.url === url);
    if (!info) throw new Error('ordinary fixture target was not listed');
    const attached = await sliccExtension.cdp.send('Target.attachToTarget', {
      targetId: info.targetId,
      flatten: true,
    });
    if (!attached.sessionId) throw new Error('ordinary fixture target was not attached');
    return info.targetId;
  }, url);
  const injectStarted = Date.now();
  const onloads = await target.evaluate(
    async (sources) => {
      const marks = await Promise.all(
        sources.map(
          (src) =>
            new Promise((resolve) => {
              const iframe = document.createElement('iframe');
              const born = performance.now();
              iframe.onload = () =>
                resolve({ src, onloadMs: Math.round(performance.now() - born) });
              iframe.src = src;
              document.body.append(iframe);
            })
        )
      );
      return marks;
    },
    [CANARY, SIBLING]
  );
  const onloadAt = Date.now();
  return { page, targetId, pageTargetId, onloadAt, injectStarted, onloads };
}

async function poll(page, targetId) {
  return page.evaluate(async (targetId) => {
    const attempts = [];
    let settled;
    const started = Date.now();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const at = Date.now() - started;
      const callStarted = Date.now();
      try {
        const snapshot = await sliccExtension.frames(Number(targetId));
        attempts.push({
          attempt,
          at,
          callMs: Date.now() - callStarted,
          ok: true,
          kinds: snapshot.frames?.map((f) => f.kind),
        });
        settled = { snapshot, attempts, ms: Date.now() - started };
        break;
      } catch (error) {
        attempts.push({
          attempt,
          at,
          callMs: Date.now() - callStarted,
          ok: false,
          error: String(error?.message ?? error),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return (
      settled ?? {
        error: attempts.at(-1)?.error ?? 'slicc: frame-diag: exhausted',
        attempts,
        ms: Date.now() - started,
      }
    );
  }, targetId);
}

test('frame list diagnostic ordinary unreachable iframe', async (t) => {
  let version = 'unknown';
  try {
    const v = await chrome.cdp.send('Browser.getVersion');
    version = `${v.product ?? ''} ${v.revision ?? ''}`.trim();
  } catch {}
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    const { page, targetId, pageTargetId, onloadAt, onloads } = await framed(t);
    const [reach, result] = await Promise.all([
      probeReachability(chrome.cdp, pageTargetId, onloadAt, 10000),
      poll(page, targetId),
    ]);
    const attempts = (result.attempts || []).map((attempt) => {
      if (attempt.ok) return attempt;
      const parsed = parseDiag(attempt.error);
      return {
        attempt: attempt.attempt,
        at: attempt.at,
        callMs: attempt.callMs,
        ok: false,
        reason: parsed.reason,
        diag: parsed.diag,
      };
    });
    rows.push({
      i,
      ok: Boolean(result.snapshot),
      ms: result.ms,
      onloads,
      reach: {
        canaryReachedChromeError: reach.canaryReachedChromeError,
        firstCanaryError: reach.firstCanaryError,
        firstSiblingSettled: reach.firstSiblingSettled,
        ms: reach.ms,
        navigated: reach.navigated,
        sampleCount: reach.sampleCount,
        lastSample: reach.lastSample,
      },
      attempts,
      firstFail: attempts.find((a) => !a.ok) || null,
      lastFail: [...attempts].reverse().find((a) => !a.ok) || null,
    });
  }
  const reasonCounts = {};
  const phaseFails = {};
  let boundedCount = 0;
  let waitingChildOnFail = 0;
  let canaryErrorOnFail = 0;
  let canaryErrorOnPass = 0;
  let canaryMissingOnFail = 0;
  for (const row of rows) {
    if (row.ok && row.reach.canaryReachedChromeError) canaryErrorOnPass += 1;
    if (!row.ok && row.reach.canaryReachedChromeError) canaryErrorOnFail += 1;
    if (!row.ok && !row.reach.canaryReachedChromeError) canaryMissingOnFail += 1;
    for (const attempt of row.attempts) {
      if (attempt.ok) continue;
      const key = attempt.reason || 'unknown';
      reasonCounts[key] = (reasonCounts[key] || 0) + 1;
      if (String(key).includes('bounded:frame list')) boundedCount += 1;
      const children = attempt.diag?.children || [];
      if (children.some((c) => c.waiting === true || c.resumed === false)) waitingChildOnFail += 1;
      for (const [name, phase] of Object.entries(attempt.diag?.phases || {})) {
        if (phase && phase.ok === false) phaseFails[name] = (phaseFails[name] || 0) + 1;
      }
    }
  }
  const report = {
    chrome: version,
    host: 'seven.sliccy.ai',
    pass: rows.filter((r) => r.ok).length,
    fail: rows.filter((r) => !r.ok).length,
    ms: rows.map((r) => r.ms),
    canaryReachedChromeError: rows.filter((r) => r.reach.canaryReachedChromeError).length,
    canaryMissingOnFail,
    canaryErrorOnFail,
    canaryErrorOnPass,
    decision:
      canaryMissingOnFail > 0 && canaryErrorOnFail === 0
        ? 'fixture: chrome-error not reached in CI window'
        : canaryErrorOnFail > 0
          ? 'production: chrome-error reached but frames() unsettled'
          : rows.every((r) => r.ok)
            ? 'settled'
            : 'mixed',
    boundedCount,
    waitingChildOnFail,
    reasonCounts,
    phaseFails,
    rows,
  };
  console.log('FRAME_LIST_DIAGNOSTIC_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('FRAME_LIST_DIAGNOSTIC_END');
});
