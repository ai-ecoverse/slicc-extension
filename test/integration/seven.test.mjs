import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { protectedRules } from '../../extension/protected-rules.js';
import { seven } from '../../extension/seven.js';
import { excludesOf, sevenOf, sixHostsOf } from '../../scripts/build-seven.mjs';
import { launch } from './chrome.mjs';

const extId = 'akjjllgokmbgpbdbmafpiefnhidlmbgf';
const refused = "slicc: refused: target is on seven's origin";
const root = new URL('../../node_modules/@ai-ecoverse/slicc-browsers/', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('catalog.json', root)));
const manifest = JSON.parse(
  await readFile(new URL('../../extension/manifest.json', import.meta.url))
);

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

test('the excluded labels and prefixes come from the pinned slicc-browsers catalog', () => {
  assert.deepEqual(seven, sevenOf(catalog));
  assert.deepEqual(seven.excludedLabels, catalog.seven.excludedLabels);
  assert.deepEqual(seven.excludedLabelPrefixes, catalog.seven.excludedLabelPrefixes);
  assert.deepEqual(protectedRules, catalog.protectedOrigins);
  assert.ok(seven.excludedLabels.includes('echo'), 'the pinned catalog excludes echo');
});

test('every content script carries the catalog excludes and loads a generated gate first', () => {
  const expected = excludesOf(sevenOf(catalog), sixHostsOf(manifest));
  assert.ok(expected.exclude_matches.includes('https://echo.sliccy.ai/*'));
  assert.ok(!expected.exclude_matches.includes('https://www.sliccy.ai/*'), 'six keeps www');
  assert.equal(manifest.content_scripts.length, 2);
  for (const entry of manifest.content_scripts) {
    assert.deepEqual(entry.exclude_matches, expected.exclude_matches);
    assert.deepEqual(entry.exclude_globs, expected.exclude_globs);
    assert.match(entry.js[0], /^seven-gate(-main)?\.js$/);
  }
});

test('no extension source hand-codes an excluded label list', async () => {
  const dir = new URL('../../extension/', import.meta.url);
  const generated = new Set([
    'seven.js',
    'seven-gate.js',
    'seven-gate-main.js',
    'protected-rules.js',
    'six-sw.js',
  ]);
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.js') || generated.has(name)) continue;
    const source = await readFile(new URL(name, dir), 'utf8');
    for (const label of ['mcpcat', 'vault-preview', 'echo']) {
      assert.ok(!source.includes(`'${label}'`), `${name} hand-codes ${label}`);
    }
  }
});

async function worlds(href) {
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const target = targetInfos.find((info) => info.type === 'page' && info.url === href);
  assert.ok(target, `tab for ${href}`);
  const { sessionId } = await chrome.cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const contexts = [];
  const off = chrome.cdp.on(({ method, params, sessionId: from }) => {
    if (from === sessionId && method === 'Runtime.executionContextCreated') {
      contexts.push(params.context);
    }
  });
  try {
    await chrome.cdp.send('Runtime.enable', {}, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    off();
    await chrome.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }
  return contexts.filter((c) => c.origin === `chrome-extension://${extId}`);
}

async function scripts(t, host) {
  const href = `https://${host}/?seven=${Math.random().toString(36).slice(2)}`;
  const page = await chrome.visit(t, href);
  const main = await page.evaluate(() => 'sliccExtension' in globalThis);
  return { main, isolated: (await worlds(href)).length, page };
}

test('echo.sliccy.ai gets no extension content script while an allowed label gets relay.js', async (t) => {
  const control = await scripts(t, 'seven.sliccy.ai');
  assert.equal(control.main, true, 'control: page.js runs on seven.sliccy.ai');
  assert.equal(control.isolated, 1, 'control: relay.js runs on seven.sliccy.ai');
  const echo = await scripts(t, 'echo.sliccy.ai');
  assert.equal(echo.main, false, 'page.js must not run on echo.sliccy.ai');
  assert.equal(echo.isolated, 0, 'relay.js must not run on echo.sliccy.ai');
});

test('a seven page cannot open, attach to, or navigate to echo.sliccy.ai', async (t) => {
  const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
  const answer = await page.evaluate(async () => {
    const cdp = globalThis.sliccExtension.cdp;
    const fail = async (method, params, sessionId) => {
      try {
        await cdp.send(method, params, sessionId);
        return 'ran';
      } catch (error) {
        return error.message;
      }
    };
    const opened = await fail('Target.createTarget', { url: 'https://echo.sliccy.ai/' });
    const created = await cdp.send('Target.createTarget', { url: 'https://other.test/' });
    const session = await cdp.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    });
    const navigated = await fail(
      'Page.navigate',
      { url: 'https://echo.sliccy.ai/' },
      session.sessionId
    );
    await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => undefined);
    return { opened, navigated, control: typeof session.sessionId };
  });
  assert.equal(answer.opened, refused);
  assert.equal(answer.navigated, refused);
  assert.equal(answer.control, 'string', 'control: other.test opens and attaches');
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const echo = targetInfos.find((info) => info.type === 'page' && info.url.includes('echo'));
  assert.equal(echo, undefined, 'no echo tab was opened');
});
