import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';
import { waitErrorFrame } from './frame-observer.mjs';

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
  'a long userinfo': (s) => `${s.scheme}://${'a'.repeat(4081)}@${s.host}${s.rest}`,
};
const USER = 4081;
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

async function networkBody(page, n, to, user = '') {
  return page.evaluate(
    async ({ n, to, user }) => {
      const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=body-${n}`);
      await h.attempt('Network.enable', {}, sessionId);
      const from = h.events.length;
      const url = `https://ordinary.test/payload?to=${to}&n=${n}&user=${user}`;
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
    { n, to, user }
  );
}

async function heldBody(page, n, to, how, size, bin = '', user = '') {
  return page.evaluate(
    async ({ n, to, how, size, bin, user }) => {
      const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=held-${n}`);
      await h.attempt(
        'Fetch.enable',
        {
          patterns: [{ urlPattern: 'https://ordinary.test/payload*', requestStage: 'Response' }],
        },
        sessionId
      );
      const from = h.events.length;
      const url = `https://ordinary.test/payload?to=${to}&n=${n}&bin=${bin}&user=${user}`;
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
    { n, to, how, size, bin, user }
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

  const LONG = 10000;
  const insideUser = 'start https://'.length + LONG - 900;

  test(`${transport}: a binary Network.getResponseBody naming vault's callback behind a long userinfo is refused`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}netuser`);
    const run = await networkBody(page, n, 'vault', USER);
    assert.deepEqual(leaks(run, n), [], 'the token reaches the client');
    assert.ok(refused(run.answer), JSON.stringify(run.answer).slice(0, 300));
  });

  for (const bin of ['', '1']) {
    test(`${transport}: a ${bin ? 'binary' : 'textual'} streamed body naming vault's callback behind a long userinfo, split inside it, never shows the token`, async (t) => {
      const page = await client(t, transport);
      const n = unique(`${transport}streamuser${bin}`);
      const run = await heldBody(page, n, 'vault', 'stream', insideUser, bin, LONG);
      assert.ok(run.paused, 'the response is held');
      assert.equal(run.answers[0].error, undefined, 'the stream opens');
      assert.ok(!run.text.includes(mark(n)), `the client reassembles ${run.text.slice(-200)}`);
      assert.deepEqual(leaks(run, n), [], 'the token reaches the client');
    });
  }

  test(`${transport}: a Runtime.evaluate value keyed by vault's callback behind a long userinfo is keyed by its origin only`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}keyuser`);
    const key = forms['a long userinfo'](parts(`${callbacks.vault}?code=${mark(n)}`));
    const answer = await page.evaluate(
      async ({ n, key }) => {
        const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=key-${n}`);
        const answer = await h.attempt(
          'Runtime.evaluate',
          { expression: `({ [${JSON.stringify(key)}]: 1 })`, returnByValue: true },
          sessionId
        );
        await h.close(targetId);
        return answer;
      },
      { n, key }
    );
    assert.deepEqual(leaks(answer, n), [], 'the token reaches the client');
    assert.deepEqual(Object.keys(answer.result?.result?.value ?? {}), ['https://vault.sliccy.ai']);
  });

  test(`${transport}: once the scan budget is spent, a protected url behind a short userinfo still reaches the client as its origin only`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}budget`);
    const unit = `${[...'abcdefghijklmnopqrstuvwxyz'].join('\t')}\thttps:x`;
    const tail = ` https://${'a'.repeat(285)}@vault.sliccy.ai/oauth/mcp-callback?code=${mark(n)} end`;
    const answer = await page.evaluate(
      async ({ n, unit, tail }) => {
        const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=budget-${n}`);
        const expression = `(${JSON.stringify(unit)}.repeat(300) + " ").repeat(100) + ${JSON.stringify(tail)}`;
        const answer = await h.attempt(
          'Runtime.evaluate',
          { expression, returnByValue: true },
          sessionId
        );
        await h.close(targetId);
        return answer;
      },
      { n, unit, tail }
    );
    assert.equal(answer.error, undefined);
    assert.deepEqual(leaks(answer, n), [], 'the token reaches the client');
    assert.ok(String(answer.result?.result?.value).endsWith(' https://vault.sliccy.ai end'));
  });

  test(`${transport} control: an ordinary url behind a long userinfo reaches the client intact, whole and streamed`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}plainuser`);
    const network = await networkBody(page, n, 'ordinary', USER);
    assert.equal(
      network.answer.result?.base64Encoded,
      true,
      JSON.stringify(network.answer).slice(0, 300)
    );
    const body = atob(network.answer.result.body);
    assert.ok(
      body.includes(`${'a'.repeat(USER)}@ordinary.test/landing?code=${mark(n)}`),
      body.slice(-200)
    );
    const split = await heldBody(page, n, 'ordinary', 'stream', insideUser, '', LONG);
    assert.ok(!split.answers.some(refused), JSON.stringify(split.answers).slice(0, 400));
    assert.ok(
      split.text.endsWith(`${'a'.repeat(LONG)}@ordinary.test/landing?code=${mark(n)} end`),
      split.text.slice(-200)
    );
  });

  async function failedSignIn(page, n) {
    const run = await page.evaluate(
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
          return href === errorPage || /^slicc: refused:/.test(href?.error ?? '')
            ? errorPage
            : undefined;
        });
        const detach = await h.attempt('Target.detachFromTarget', { sessionId });
        await h.sleep(300);
        return { targetId, raw: tree.result?.frameTree?.frame?.id, settled, detach };
      },
      { n, errorPage }
    );
    await waitErrorFrame(chrome, run.raw, callbacks.vault);
    return run;
  }

  async function reattach(page, targetId) {
    return page.evaluate(async (targetId) => {
      const start = h.events.length;
      const attach = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = attach.result?.sessionId;
      const href = sessionId ? await h.evaluate(sessionId, 'location.href') : undefined;
      const info = await h.attempt('Target.getTargetInfo', { targetId });
      const events = h.events.slice(start);
      const close = await h.attempt('Target.closeTarget', { targetId });
      return { attach, href, info, events, close };
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
    assert.match(again.href?.error ?? '', /^slicc: refused:/, 'reply');
  });

  async function loadAgain(raw, how, n) {
    const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
      targetId: raw,
      flatten: true,
    });
    try {
      const tree = await chrome.cdp.send('Page.getFrameTree', {}, sessionId);
      const failed = tree.frameTree.frame.unreachableUrl;
      assert.ok(failed?.startsWith(callbacks.vault), `the error page is for ${failed}`);
      if (how === 'reload') await chrome.cdp.send('Page.reload', {}, sessionId);
      else {
        const url = {
          'a different url': `${callbacks.vault}?code=${mark(n)}`,
          'the identical url': failed,
          'a #fragment variant': `${failed}#again`,
        }[how];
        await chrome.cdp.send('Page.navigate', { url }, sessionId);
      }
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
  }

  for (const how of ['a different url', 'reload', 'the identical url', 'a #fragment variant']) {
    test(`${transport} control: a failed tab that then really loads the protected page by ${how} is refused after a detach`, async (t) => {
      const page = await client(t, transport);
      const n = unique(`${transport}reloaded${how.replace(/\W/g, '')}`);
      const failed = await failedSignIn(page, n);
      assert.equal(failed.settled, errorPage, 'the sign-in fails at the request');
      await loadAgain(failed.raw, how, n);
      const again = await reattach(page, failed.targetId);
      await chrome.cdp.send('Target.closeTarget', { targetId: failed.raw }).catch(() => undefined);
      assert.deepEqual(leaks(again, n), [], 'the token reaches the client');
      assert.ok(refused(again.attach), JSON.stringify(again.attach));
      assert.ok(
        refused(again.close),
        `the stale failure still vouches: ${JSON.stringify(again.close)}`
      );
    });
  }

  async function untouched(page, targetId) {
    return page.evaluate(async (targetId) => {
      const out = {};
      for (const method of [
        'Target.activateTarget',
        'Browser.getWindowForTarget',
        'Target.closeTarget',
      ]) {
        out[method] = await h.attempt(method, { targetId });
      }
      return out;
    }, targetId);
  }

  async function alive(raw) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    return targetInfos.some((info) => info.targetId === raw);
  }

  for (const how of ['reload', 'the identical url']) {
    test(`${transport}: a failed tab that then really loads the protected page by ${how} cannot be activated, located or closed without attaching again`, async (t) => {
      const page = await client(t, transport);
      const n = unique(`${transport}stale${how.replace(/\W/g, '')}`);
      const failed = await failedSignIn(page, n);
      assert.equal(failed.settled, errorPage, 'the sign-in fails at the request');
      await loadAgain(failed.raw, how, n);
      const ops = await untouched(page, failed.targetId);
      const live = await alive(failed.raw);
      await chrome.cdp.send('Target.closeTarget', { targetId: failed.raw }).catch(() => undefined);
      assert.deepEqual(leaks(ops, n), [], 'the token reaches the client');
      assert.ok(live, 'the protected tab is still open');
      assert.ok(refused(ops['Target.closeTarget']), JSON.stringify(ops['Target.closeTarget']));
      assert.notEqual(ops['Target.activateTarget'].error, undefined, 'activate succeeds');
      assert.notEqual(ops['Browser.getWindowForTarget'].error, undefined, 'the window is reported');
    });
  }

  test(`${transport} control: a tab whose protected sign-in failed and stays failed can be closed without attaching again`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}stillfailed`);
    const failed = await failedSignIn(page, n);
    assert.equal(failed.settled, errorPage, 'the sign-in fails at the request');
    const close = await page.evaluate(
      (targetId) => h.attempt('Target.closeTarget', { targetId }),
      failed.targetId
    );
    const live = await alive(failed.raw);
    if (live)
      await chrome.cdp.send('Target.closeTarget', { targetId: failed.raw }).catch(() => undefined);
    assert.equal(close.error, undefined, JSON.stringify(close));
    assert.equal(live, false, 'the failed tab closes');
  });
}
