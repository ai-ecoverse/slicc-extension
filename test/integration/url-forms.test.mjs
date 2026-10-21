import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const transports = ['seven', 'six-bridge'];
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const callbacks = {
  seven: 'https://seven.sliccy.ai/auth/callback',
  vault: 'https://vault.sliccy.ai/oauth/mcp-callback',
  ordinary: 'https://ordinary.test/landing',
};
const errorPage = 'chrome-error://chromewebdata/';
let serial = 0;

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

function unique(prefix) {
  return `${prefix}${++serial}${Date.now()}`.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mark(n) {
  return `S3CR3T${[...n].reverse().join('')}`;
}

function parts(url) {
  const u = new URL(url);
  return { scheme: u.protocol.slice(0, -1), host: u.host, rest: url.slice(u.origin.length) };
}

const forms = {
  'json-escaped slashes': (s) => `${s.scheme}:\\/\\/${s.host}${s.rest.replaceAll('/', '\\/')}`,
  'three slashes': (s) => `${s.scheme}:///${s.host}${s.rest}`,
  'a run of mixed slashes': (s) => `${s.scheme}:/\\//\\${s.host}${s.rest}`,
  'one slash': (s) => `${s.scheme}:/${s.host}${s.rest}`,
  'no slash': (s) => `${s.scheme}:${s.host}${s.rest}`,
  'one backslash': (s) => `${s.scheme}:\\${s.host}${s.rest}`,
  'a tab in the path': (s) => `${s.scheme}://${s.host}/\t${s.rest.slice(1)}`,
  'a newline in the path': (s) => `${s.scheme}://${s.host}/\n${s.rest.slice(1)}`,
  'a line break in the host': (s) =>
    `${s.scheme}://${s.host.slice(0, 3)}\r\n${s.host.slice(3)}${s.rest}`,
  'a tab in the scheme': (s) =>
    `${s.scheme.slice(0, 2)}\t${s.scheme.slice(2)}://${s.host}${s.rest}`,
};
const snapshotForms = ['json-escaped slashes', 'one slash', 'no slash'];

function written(to, form, n) {
  return `start ${forms[form](parts(`${callbacks[to]}?code=${mark(n)}`))} end`;
}

function decoded(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) decoded(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      decoded(item, out);
      if (value.base64Encoded === true && typeof item === 'string' && key !== 'stream') {
        try {
          out.push(atob(item));
        } catch {}
      }
    }
  }
  return out;
}

function leaks(value, n) {
  const secret = mark(n);
  return decoded(value).filter((text) => text.includes(secret));
}

function refused(answer) {
  return typeof answer?.error === 'string' && answer.error.startsWith('slicc: refused');
}

async function values(page, n, texts) {
  return page.evaluate(
    async ({ n, texts }) => {
      const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=forms-${n}`);
      const out = [];
      for (const text of texts) {
        out.push(
          await h.attempt(
            'Runtime.evaluate',
            { expression: JSON.stringify(text), returnByValue: true },
            sessionId
          )
        );
      }
      await h.close(targetId);
      return out;
    },
    { n, texts }
  );
}

async function snapshot(page, n, text) {
  return page.evaluate(
    async ({ n, text }) => {
      const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=snap-${n}`);
      await h.attempt(
        'Runtime.evaluate',
        { expression: `document.body.textContent = ${JSON.stringify(text)}; 1` },
        sessionId
      );
      const answer = await h.attempt('Page.captureSnapshot', {}, sessionId);
      await h.close(targetId);
      return answer;
    },
    { n, text }
  );
}

async function networkBody(page, n, to) {
  return page.evaluate(
    async ({ n, to }) => {
      const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=body-${n}`);
      await h.attempt('Network.enable', {}, sessionId);
      const from = h.events.length;
      const url = `https://ordinary.test/payload?to=${to}&n=${n}`;
      await h.evaluate(
        sessionId,
        `fetch(${JSON.stringify(url)}).then((r) => r.arrayBuffer()).then((b) => b.byteLength)`
      );
      const done = await h.until(() => {
        const seen = h.events.slice(from);
        const sent = seen.find(
          (e) => e.method === 'Network.requestWillBeSent' && e.params.request.url === url
        );
        return (
          sent &&
          seen.find(
            (e) =>
              e.method === 'Network.loadingFinished' && e.params.requestId === sent.params.requestId
          )
        );
      });
      const answer = await h.attempt(
        'Network.getResponseBody',
        { requestId: done?.params.requestId },
        sessionId
      );
      const events = h.events.slice(from);
      await h.close(targetId);
      return { answer, events };
    },
    { n, to }
  );
}

async function heldBody(page, n, to, how, size, bin = '') {
  return page.evaluate(
    async ({ n, to, how, size, bin }) => {
      const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=held-${n}`);
      await h.attempt(
        'Fetch.enable',
        {
          patterns: [{ urlPattern: 'https://ordinary.test/payload*', requestStage: 'Response' }],
        },
        sessionId
      );
      const from = h.events.length;
      const url = `https://ordinary.test/payload?to=${to}&n=${n}&bin=${bin}`;
      await h.attempt(
        'Runtime.evaluate',
        {
          expression: `globalThis.body = fetch(${JSON.stringify(url)}).then((r) => r.text(), () => "error"); 1`,
        },
        sessionId
      );
      const paused = await h.until(() =>
        h.events
          .slice(from)
          .find((e) => e.method === 'Fetch.requestPaused' && e.params.responseStatusCode)
      );
      const requestId = paused?.params.requestId;
      const answers = [];
      let text = '';
      if (how === 'whole') {
        answers.push(await h.attempt('Fetch.getResponseBody', { requestId }, sessionId));
      } else {
        const opened = await h.attempt('Fetch.takeResponseBodyAsStream', { requestId }, sessionId);
        answers.push(opened);
        const handle = opened.result?.stream;
        for (let i = 0; handle && i < 20; i++) {
          const read = await h.attempt(
            'IO.read',
            i === 0 && size ? { handle, size } : { handle },
            sessionId
          );
          answers.push(read);
          if (read.error) break;
          text += read.result.base64Encoded ? atob(read.result.data) : read.result.data;
          if (read.result.eof) break;
        }
        if (handle) await h.attempt('IO.close', { handle }, sessionId);
      }
      await h.attempt('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, sessionId);
      const events = h.events.slice(from);
      await h.close(targetId);
      return { paused: Boolean(requestId), answers, text, events };
    },
    { n, to, how, size, bin }
  );
}

function payload(to, n) {
  return `start ${callbacks[to]}?code=${mark(n)} end`;
}

for (const transport of transports) {
  for (const form of Object.keys(forms)) {
    test(`${transport}: a protected url written with ${form} reaches the client as its origin only`, async (t) => {
      const page = await client(t, transport);
      const n = unique(`${transport}${form}`);
      const answers = await values(page, n, [written('seven', form, n), written('vault', form, n)]);
      const found = leaks(answers, n);
      t.diagnostic(`LEAK ${transport} ${form}: ${found.length}`);
      assert.deepEqual(found, [], 'the token reaches the client');
      assert.deepEqual(
        answers.map((a) => a.result?.result?.value),
        ['start https://seven.sliccy.ai end', 'start https://vault.sliccy.ai end']
      );
    });
  }

  test(`${transport} control: an ordinary url written in every form reaches the client unchanged`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}plainforms`);
    const texts = Object.keys(forms).map((form) => written('ordinary', form, n));
    const answers = await values(page, n, texts);
    assert.deepEqual(
      answers.map((a) => a.result?.result?.value),
      texts
    );
  });

  test(`${transport} control: ordinary urls on the lines around a protected one stay intact`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}lines`);
    const a = `https://ordinary.test/a?n=${n}`;
    const b = `https://ordinary.test/b?n=${n}`;
    const text = `${a}\n${callbacks.vault}?code=${mark(n)}\n${b}`;
    const [answer] = await values(page, n, [text]);
    assert.deepEqual(leaks(answer, n), []);
    assert.equal(answer.result?.result?.value, `${a}\nhttps://vault.sliccy.ai\n${b}`);
  });

  for (const form of snapshotForms) {
    test(`${transport}: a page holding a protected url written with ${form} does not snapshot`, async (t) => {
      const page = await client(t, transport);
      const n = unique(`${transport}snap${form}`);
      const answer = await snapshot(page, n, written('vault', form, n));
      assert.deepEqual(leaks(answer, n), [], 'the token reaches the client');
      assert.ok(refused(answer), JSON.stringify(answer).slice(0, 300));
    });
  }

  test(`${transport} control: a page holding ordinary urls in those forms snapshots`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}snapplain`);
    const text = snapshotForms.map((form) => written('ordinary', form, n)).join(' ');
    const answer = await snapshot(page, n, text);
    assert.ok(!answer.error, JSON.stringify(answer).slice(0, 300));
  });

  for (const to of ['seven', 'vault']) {
    test(`${transport}: a binary Network.getResponseBody naming ${to}'s callback is refused`, async (t) => {
      const page = await client(t, transport);
      const n = unique(`${transport}netbody${to}`);
      const run = await networkBody(page, n, to);
      assert.deepEqual(leaks(run, n), [], 'the token reaches the client');
      assert.ok(refused(run.answer), JSON.stringify(run.answer).slice(0, 300));
    });

    test(`${transport}: a binary Fetch.getResponseBody naming ${to}'s callback is refused`, async (t) => {
      const page = await client(t, transport);
      const n = unique(`${transport}fetchbody${to}`);
      const run = await heldBody(page, n, to, 'whole');
      assert.ok(run.paused, 'the response is held');
      assert.deepEqual(leaks(run, n), [], 'the token reaches the client');
      assert.ok(refused(run.answers[0]), JSON.stringify(run.answers[0]).slice(0, 300));
    });

    for (const bin of ['', '1']) {
      const kind = bin ? 'binary' : 'textual';
      for (const [how, size] of [
        ['in one read', 0],
        ['split inside the host', 'start https://vault.slicc'.length + bin.length * 3],
      ]) {
        test(`${transport}: a ${kind} streamed body naming ${to}'s callback, read ${how}, never shows the token`, async (t) => {
          const page = await client(t, transport);
          const n = unique(`${transport}stream${to}${size}${bin}`);
          const run = await heldBody(page, n, to, 'stream', size, bin);
          assert.ok(run.paused, 'the response is held');
          assert.equal(run.answers[0].error, undefined, 'the stream opens');
          assert.ok(!run.text.includes(mark(n)), `the client reassembles ${run.text}`);
          assert.deepEqual(leaks(run, n), [], 'the token reaches the client');
          if (bin && !size) assert.ok(refused(run.answers[1]), JSON.stringify(run.answers));
        });
      }
    }
  }

  test(`${transport} control: ordinary binary bodies, whole and streamed in split reads, reach the client intact`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}plainbody`);
    const body = payload('ordinary', n);
    const network = await networkBody(page, n, 'ordinary');
    assert.equal(network.answer.result?.base64Encoded, true);
    assert.equal(atob(network.answer.result.body), body);
    const whole = await heldBody(page, n, 'ordinary', 'whole');
    assert.equal(atob(whole.answers[0].result?.body ?? ''), body);
    const split = await heldBody(page, n, 'ordinary', 'stream', 'start https://ordin'.length);
    assert.ok(!split.answers.some(refused), JSON.stringify(split.answers).slice(0, 400));
    assert.equal(split.text, body);
    const binary = await heldBody(
      page,
      n,
      'ordinary',
      'stream',
      'start https://ordin'.length + 3,
      '1'
    );
    assert.ok(!binary.answers.some(refused), JSON.stringify(binary.answers).slice(0, 400));
    assert.equal(binary.text, `\xff\xfe\0${body}`);
  });

  async function failedSignIn(page, n) {
    return page.evaluate(
      async ({ n, errorPage }) => {
        const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=start-${n}`);
        const tree = await h.attempt('Page.getFrameTree', {}, sessionId);
        await h.attempt(
          'Page.navigate',
          { url: `https://ordinary.test/signin?n=${n}&to=vault&form=query` },
          sessionId
        );
        const settled = await h.until(async () => {
          const href = await h.evaluate(sessionId, 'location.href');
          return href === errorPage ? href : undefined;
        });
        const detach = await h.attempt('Target.detachFromTarget', { sessionId });
        await h.sleep(300);
        return { targetId, raw: tree.result?.frameTree?.frame?.id, settled, detach };
      },
      { n, errorPage }
    );
  }

  async function reattach(page, targetId) {
    return page.evaluate(async (targetId) => {
      const start = h.events.length;
      const attach = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = attach.result?.sessionId;
      const href = sessionId ? await h.evaluate(sessionId, 'location.href') : undefined;
      const info = await h.attempt('Target.getTargetInfo', { targetId });
      const events = h.events.slice(start);
      await h.close(targetId);
      return { attach, href, info, events };
    }, targetId);
  }

  test(`${transport}: a tab whose protected sign-in failed attaches again after a detach and shows only the error page`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}reattach`);
    const failed = await failedSignIn(page, n);
    assert.equal(failed.settled, errorPage, 'the sign-in fails at the request');
    assert.equal(failed.detach.error, undefined, JSON.stringify(failed.detach));
    const again = await reattach(page, failed.targetId);
    assert.deepEqual(leaks(again, n), [], 'the token reaches the client');
    assert.equal(typeof again.attach.result?.sessionId, 'string', JSON.stringify(again.attach));
    assert.equal(again.href, errorPage);
  });

  test(`${transport} control: a failed tab that then really loads the protected page is refused after a detach`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}reloaded`);
    const failed = await failedSignIn(page, n);
    assert.equal(failed.settled, errorPage, 'the sign-in fails at the request');
    const callback = `${callbacks.vault}?code=${mark(n)}`;
    const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
      targetId: failed.raw,
      flatten: true,
    });
    try {
      await chrome.cdp.send('Page.navigate', { url: callback }, sessionId);
      let href = '';
      for (let i = 0; i < 50 && !href.startsWith(callbacks.vault); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const answer = await chrome.cdp
          .send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)
          .catch(() => undefined);
        href = String(answer?.result?.value ?? '');
      }
      assert.ok(href.startsWith(callbacks.vault), `the protected page loads: ${href}`);
    } finally {
      await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    }
    const again = await reattach(page, failed.targetId);
    await chrome.cdp.send('Target.closeTarget', { targetId: failed.raw }).catch(() => undefined);
    assert.deepEqual(leaks(again, n), [], 'the token reaches the client');
    assert.ok(refused(again.attach), JSON.stringify(again.attach));
  });
}
