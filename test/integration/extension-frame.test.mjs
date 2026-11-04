import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import catalog from '@ai-ecoverse/slicc-browsers' with { type: 'json' };
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId, fixtureId } from './extension-page.mjs';

const { shownRefusal, presentRefusal } = catalog.protectedOrigins.extensionFrames;
const PROTECTED = catalog.protectedOrigins.refusal;
const transports = ['seven', 'six-bridge'];
const entry = {
  seven: 'https://seven.sliccy.ai/',
  'six-bridge': 'https://www.sliccy.ai/?slicc=leader',
};
const fixture = `chrome-extension://${fixtureId}`;
const frameUrl = `${fixture}/frame.html`;

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

async function opened(page, url) {
  return page.evaluate(async (url) => {
    const created = await h.attempt('Target.createTarget', { url });
    const targetId = created.result?.targetId;
    await h.until(async () => {
      const listed = await h.attempt('Target.getTargetInfo', { targetId });
      return listed.result?.targetInfo?.url === url;
    });
    return targetId;
  }, url);
}

async function attached(page, targetId) {
  return page.evaluate(async (targetId) => {
    const attach = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
    return attach.result?.sessionId ?? attach;
  }, targetId);
}

async function rawTarget(match) {
  for (let i = 0; i < 50; i++) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const found = targetInfos.find((info) => info.type === 'page' && match(info.url));
    if (found) return found.targetId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('raw target not found');
}

async function rawEvaluate(targetId, expression) {
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const answer = await chrome.cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (answer.exceptionDetails) {
      throw new Error(
        answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text
      );
    }
    return answer.result.value;
  } finally {
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }
}

async function embed(
  targetId,
  { hidden = true, focus = false, count = 1, shadowFocus = false } = {}
) {
  return rawEvaluate(
    targetId,
    `(() => {
      const src = ${JSON.stringify(frameUrl)};
      const make = (id, hide, into) => {
        const f = document.createElement('iframe');
        f.id = id;
        f.src = src;
        if (hide) f.hidden = true;
        else f.style.cssText = 'position:fixed;right:0;bottom:0;width:300px;height:200px;border:0';
        into.append(f);
        return f;
      };
      document.body.replaceChildren();
      const typed = document.createElement('input');
      typed.id = 'typed';
      document.body.append(typed);
      const host = document.createElement('div');
      host.id = 'shadow-host';
      const root = host.attachShadow({ mode: 'closed' });
      document.body.append(host);
      const frames = [];
      for (let i = 0; i < ${count}; i++) {
        const into = i === 0 && ${shadowFocus} ? root : document.body;
        frames.push(make('ext-frame-' + i, ${hidden}, into));
      }
      return new Promise((resolve) => {
        let left = frames.length;
        const done = () => {
          left -= 1;
          if (left > 0) return;
          if (${focus} || ${shadowFocus}) {
            const target = frames[${count} - 1];
            target.focus();
            try { target.contentWindow?.focus(); } catch {}
          } else {
            typed.focus();
          }
          resolve(frames.map((f) => f.src));
        };
        for (const f of frames) {
          if (f.contentDocument?.readyState === 'complete') done();
          else f.addEventListener('load', done, { once: true });
        }
        setTimeout(() => resolve(frames.map((f) => f.src)), 5000);
      });
    })()`
  );
}

async function styleSecond(targetId, { visible = false, focus = false } = {}) {
  return rawEvaluate(
    targetId,
    `(() => {
      const f = document.getElementById('ext-frame-1');
      if (!f) return false;
      if (${visible}) {
        f.hidden = false;
        f.style.cssText = 'position:fixed;right:0;bottom:0;width:300px;height:200px;border:0';
      } else {
        f.hidden = true;
        f.style.cssText = '';
      }
      if (${focus}) {
        f.focus();
        try { f.contentWindow?.focus(); } catch {}
      }
      return true;
    })()`
  );
}

function carries(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.includes(fixture) || text.includes(frameUrl) || text.includes(fixtureId);
}

async function drive(page, sessionId, method, params = {}) {
  return page.evaluate(
    async ({ sessionId, method, params }) => h.attempt(method, params, sessionId),
    { sessionId, method, params }
  );
}

for (const transport of transports) {
  test(`${transport} page reads and hidden Input or screenshot work with one or two hidden extension frames`, async (t) => {
    const page = await client(t, transport);
    const url = `https://ordinary.test/doc?n=extension-frame-ok-${transport}`;
    const targetId = await opened(page, url);
    const raw = await rawTarget((href) => href === url);
    await embed(raw, { hidden: true, count: 1 });
    let sessionId = await attached(page, targetId);
    assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
    const one = await page.evaluate(async (sessionId) => {
      const origin = await h.evaluate(sessionId, 'self.origin');
      const shot = await h.attempt('Page.captureScreenshot', { format: 'png' }, sessionId);
      const typed = await h.attempt('Input.insertText', { text: 'k' }, sessionId);
      const mouse = await h.attempt(
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x: 20, y: 20, button: 'left', clickCount: 1 },
        sessionId
      );
      return {
        origin,
        shot: typeof shot.result?.data === 'string' && shot.result.data.length > 0,
        shotError: shot.error,
        typed: typed.error,
        mouse: mouse.error,
      };
    }, sessionId);
    assert.equal(one.origin, 'https://ordinary.test');
    assert.equal(one.shot, true, JSON.stringify(one));
    assert.equal(one.shotError, undefined, JSON.stringify(one));
    assert.equal(one.typed, undefined, JSON.stringify(one));
    assert.equal(one.mouse, undefined, JSON.stringify(one));
    await page.evaluate((targetId) => h.close(targetId), targetId);

    const twoUrl = `https://ordinary.test/doc?n=extension-frame-two-${transport}`;
    const twoId = await opened(page, twoUrl);
    const twoRaw = await rawTarget((href) => href === twoUrl);
    await embed(twoRaw, { hidden: true, count: 2 });
    sessionId = await attached(page, twoId);
    assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
    const two = await page.evaluate(async (sessionId) => {
      const origin = await h.evaluate(sessionId, 'self.origin');
      const shot = await h.attempt('Page.captureScreenshot', { format: 'png' }, sessionId);
      const typed = await h.attempt('Input.insertText', { text: 'k' }, sessionId);
      return {
        origin,
        shot: typeof shot.result?.data === 'string' && shot.result.data.length > 0,
        shotError: shot.error,
        typed: typed.error,
      };
    }, sessionId);
    assert.equal(two.origin, 'https://ordinary.test');
    assert.equal(two.shot, true, JSON.stringify(two));
    assert.equal(two.shotError, undefined, JSON.stringify(two));
    assert.equal(two.typed, undefined, JSON.stringify(two));
    await page.evaluate((targetId) => h.close(targetId), twoId);
  });

  test(`${transport} a visible extension frame refuses screenshot and Input with shownRefusal`, async (t) => {
    const page = await client(t, transport);
    const url = `https://ordinary.test/doc?n=extension-frame-shown-${transport}`;
    const targetId = await opened(page, url);
    const raw = await rawTarget((href) => href === url);
    await embed(raw, { hidden: false, count: 1 });
    const sessionId = await attached(page, targetId);
    assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
    const run = await page.evaluate(async (sessionId) => {
      const read = await h.evaluate(sessionId, 'self.origin');
      const shot = await h.attempt('Page.captureScreenshot', { format: 'png' }, sessionId);
      const typed = await h.attempt('Input.insertText', { text: 'k' }, sessionId);
      return { read, shot: shot.error, typed: typed.error };
    }, sessionId);
    assert.equal(run.read, 'https://ordinary.test');
    assert.equal(run.shot, shownRefusal, JSON.stringify(run));
    assert.equal(run.typed, shownRefusal, JSON.stringify(run));
    await page.evaluate((targetId) => h.close(targetId), targetId);
  });

  test(`${transport} a hidden focused extension frame, including inside a shadow root, refuses with shownRefusal`, async (t) => {
    const page = await client(t, transport);
    for (const shadowFocus of [false, true]) {
      const url = `https://ordinary.test/doc?n=extension-frame-focus-${shadowFocus}-${transport}`;
      const targetId = await opened(page, url);
      const raw = await rawTarget((href) => href === url);
      await embed(raw, { hidden: true, focus: !shadowFocus, shadowFocus, count: 1 });
      const sessionId = await attached(page, targetId);
      assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
      const run = await page.evaluate(async (sessionId) => {
        const shot = await h.attempt('Page.captureScreenshot', { format: 'png' }, sessionId);
        const typed = await h.attempt('Input.insertText', { text: 'k' }, sessionId);
        return { shot: shot.error, typed: typed.error };
      }, sessionId);
      assert.equal(run.shot, shownRefusal, JSON.stringify({ shadowFocus, run }));
      assert.equal(run.typed, shownRefusal, JSON.stringify({ shadowFocus, run }));
      await page.evaluate((targetId) => h.close(targetId), targetId);
    }
  });

  test(`${transport} the second of two frames being visible or focused refuses with shownRefusal`, async (t) => {
    const page = await client(t, transport);
    for (const mode of ['visible', 'focused']) {
      const url = `https://ordinary.test/doc?n=extension-frame-second-${mode}-${transport}`;
      const targetId = await opened(page, url);
      const raw = await rawTarget((href) => href === url);
      await embed(raw, { hidden: true, count: 2 });
      await styleSecond(raw, { visible: mode === 'visible', focus: mode === 'focused' });
      const sessionId = await attached(page, targetId);
      assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
      const run = await page.evaluate(async (sessionId) => {
        const shot = await h.attempt('Page.captureScreenshot', { format: 'png' }, sessionId);
        const typed = await h.attempt('Input.insertText', { text: 'k' }, sessionId);
        return { shot: shot.error, typed: typed.error };
      }, sessionId);
      assert.equal(run.shot, shownRefusal, JSON.stringify({ mode, run }));
      assert.equal(run.typed, shownRefusal, JSON.stringify({ mode, run }));
      await page.evaluate((targetId) => h.close(targetId), targetId);
    }
  });

  test(`${transport} whole-tab capture and screencast start refuse with presentRefusal while an extension frame is present`, async (t) => {
    const page = await client(t, transport);
    const url = `https://ordinary.test/doc?n=extension-frame-present-${transport}`;
    const targetId = await opened(page, url);
    const raw = await rawTarget((href) => href === url);
    await embed(raw, { hidden: true, count: 1 });
    const sessionId = await attached(page, targetId);
    assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
    const run = await page.evaluate(async (sessionId) => {
      const archive = await h.attempt('Page.captureSnapshot', { format: 'mhtml' }, sessionId);
      const pdf = await h.attempt('Page.printToPDF', {}, sessionId);
      const cast = await h.attempt(
        'Page.startScreencast',
        { format: 'png', everyNthFrame: 1 },
        sessionId
      );
      return { archive: archive.error, pdf: pdf.error, cast: cast.error };
    }, sessionId);
    assert.equal(run.archive, presentRefusal, JSON.stringify(run));
    assert.equal(run.pdf, presentRefusal, JSON.stringify(run));
    assert.equal(run.cast, presentRefusal, JSON.stringify(run));
    await page.evaluate((targetId) => h.close(targetId), targetId);
  });

  test(`${transport} a running screencast stops or drops frames when an extension frame appears`, async (t) => {
    const page = await client(t, transport);
    const url = `https://ordinary.test/doc?n=extension-frame-cast-${transport}`;
    const targetId = await opened(page, url);
    const sessionId = await attached(page, targetId);
    assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
    const raw = await rawTarget((href) => href === url);
    const run = await page.evaluate(async (sessionId) => {
      const start = await h.attempt(
        'Page.startScreencast',
        { format: 'png', everyNthFrame: 1 },
        sessionId
      );
      const cursor = h.events.length;
      return { start, cursor };
    }, sessionId);
    if (!run.start.error) {
      await embed(raw, { hidden: true, count: 1 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = await page.evaluate(
        async ({ sessionId, cursor }) => {
          const frames = h.events
            .slice(cursor)
            .filter(
              (event) => event.method === 'Page.screencastFrame' && event.sessionId === sessionId
            );
          await h.attempt('Page.stopScreencast', {}, sessionId);
          return { frames: frames.length };
        },
        { sessionId, cursor: run.cursor }
      );
      assert.equal(after.frames, 0, JSON.stringify(after));
    } else {
      assert.equal(run.start.error, presentRefusal, JSON.stringify(run.start));
    }
    await page.evaluate((targetId) => h.close(targetId), targetId);
  });

  test(`${transport} the extension frame itself is unreachable and its URL never appears`, async (t) => {
    const page = await client(t, transport);
    const url = `https://ordinary.test/doc?n=extension-frame-redact-${transport}`;
    const targetId = await opened(page, url);
    const raw = await rawTarget((href) => href === url);
    await embed(raw, { hidden: true, count: 1 });
    const sessionId = await attached(page, targetId);
    assert.equal(typeof sessionId, 'string', JSON.stringify(sessionId));
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const frame = targetInfos.find(
      (info) => info.type === 'iframe' && info.url.startsWith(`${fixture}/`)
    );
    assert.ok(frame, 'the observer sees the extension frame target');
    const run = await page.evaluate(
      async ({ sessionId, frameId }) => {
        const attach = await h.attempt('Target.attachToTarget', {
          targetId: frameId,
          flatten: true,
        });
        const targets = await h.attempt('Target.getTargets', {});
        const tree = await h.attempt('Page.getFrameTree', {}, sessionId);
        const doc = await h.attempt('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
        const snap = await h.attempt(
          'DOMSnapshot.captureSnapshot',
          { computedStyles: [] },
          sessionId
        );
        const ax = await h.attempt('Accessibility.getFullAXTree', {}, sessionId);
        const evaluated = await h.attempt(
          'Runtime.evaluate',
          {
            expression:
              '(() => { const f = document.getElementById("ext-frame-0"); return f ? f.src : ""; })()',
            returnByValue: true,
          },
          sessionId
        );
        return { attach, targets, tree, doc, snap, ax, evaluated };
      },
      { sessionId, frameId: frame.targetId }
    );
    assert.ok(run.attach.error, JSON.stringify(run.attach));
    assert.ok(!carries(run.targets), JSON.stringify(run.targets));
    assert.ok(!carries(run.tree), JSON.stringify(run.tree));
    assert.ok(!carries(run.doc), JSON.stringify(run.doc));
    assert.ok(!carries(run.snap), JSON.stringify(run.snap));
    assert.ok(!carries(run.ax), JSON.stringify(run.ax));
    assert.ok(!carries(run.evaluated), JSON.stringify(run.evaluated));
    await page.evaluate((targetId) => h.close(targetId), targetId);
  });

  test(`${transport} a protected-origin tab with an extension frame is still refused`, async (t) => {
    const page = await client(t, transport);
    const url = `https://seven.sliccy.ai/doc?n=extension-frame-protected-${transport}`;
    const created = await page.evaluate((url) => h.attempt('Target.createTarget', { url }), url);
    if (created.error) {
      assert.equal(created.error, PROTECTED, JSON.stringify(created));
      return;
    }
    const targetId = created.result?.targetId;
    assert.ok(targetId);
    const raw = await rawTarget((href) => href.startsWith('https://seven.sliccy.ai/'));
    await embed(raw, { hidden: true, count: 1 }).catch(() => undefined);
    const sessionId = await attached(page, targetId);
    assert.ok(
      sessionId?.error === PROTECTED ||
        (typeof sessionId === 'string' &&
          (
            await drive(page, sessionId, 'Runtime.evaluate', {
              expression: '1',
              returnByValue: true,
            })
          ).error === PROTECTED),
      JSON.stringify(sessionId)
    );
    await page.evaluate((targetId) => h.close(targetId), targetId).catch(() => undefined);
  });
}
