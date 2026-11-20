import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

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

async function framed(t) {
  const host = 'seven.sliccy.ai';
  const page = await chrome.visit(t, `https://${host}/`);
  const url = `https://ordinary.test/doc?frame-list-diag-${Date.now()}-${Math.random()}`;
  const target = await chrome.visit(t, url);
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
  await target.evaluate(
    async (sources) => {
      await Promise.all(
        sources.map(
          (src) =>
            new Promise((resolve) => {
              const iframe = document.createElement('iframe');
              iframe.onload = resolve;
              iframe.src = src;
              document.body.append(iframe);
            })
        )
      );
    },
    [
      'https://127.0.0.1:1/ERROR_FRAME_CANARY?q=CANARY',
      'https://other.test/doc?FRAME_LIST_DIAG_SIBLING=seven',
    ]
  );
  return { page, targetId };
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
    const { page, targetId } = await framed(t);
    const result = await poll(page, targetId);
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
      attempts,
      firstFail: attempts.find((a) => !a.ok) || null,
      lastFail: [...attempts].reverse().find((a) => !a.ok) || null,
    });
  }
  const reasonCounts = {};
  const phaseFails = {};
  let boundedCount = 0;
  let waitingChildOnFail = 0;
  for (const row of rows) {
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
