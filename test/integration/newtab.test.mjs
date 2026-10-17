import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { install } from './client.mjs';
import { extId } from './extension-page.mjs';

const vectors = JSON.parse(
  await readFile(
    new URL('../../node_modules/@ai-ecoverse/slicc-browsers/guard-vectors.json', import.meta.url)
  )
);
const row = (id) => vectors.vectors.find((vector) => vector.id === id);
const urls = Object.fromEntries(
  Object.entries(vectors.targets)
    .filter(([, target]) => typeof target.url === 'string')
    .map(([name, target]) => [name, target.url])
);

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
let counter = 0;

async function client(t, transport) {
  const page = await chrome.visit(t, entry[transport]);
  await page.evaluate(install, transport, extId);
  return page;
}

function tagged(label) {
  counter += 1;
  return `https://ordinary.test/doc?n=${label}-${Date.now()}-${counter}`;
}

async function rawShows(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const { targetInfos } = await chrome.cdp.send('Target.getTargets');
    const found = targetInfos.find(predicate);
    if (found || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const newTab = /^chrome:\/\/(newtab|new-tab-page)\//;

for (const transport of transports) {
  for (const name of [...row('C8.newtab').targets, 'ordinary']) {
    test(`${transport} C8.newtab ${name}: in the default context the guard opens, lists and reaches the settled page, and the same tab navigates to an ordinary document`, async (t) => {
      const page = await client(t, transport);
      const ordinary = name === 'ordinary';
      const url = ordinary ? tagged('c8-newtab-control') : urls[name];
      const doc = tagged('c8-newtab-doc');
      const reach = transport === 'seven' ? 'Target.activateTarget' : 'Browser.getWindowForTarget';
      const run = await page.evaluate(
        async ({ url, doc, reach, ordinary }) => {
          const created = await h.attempt('Target.createTarget', { url });
          const targetId = created.result?.targetId;
          if (!targetId) return { created };
          const listed = await h.until(async () => {
            const { targetInfos } = await h.cdp.send('Target.getTargets', {});
            const info = targetInfos.find((item) => item.targetId === targetId);
            const settled = ordinary
              ? info?.url === url
              : /^chrome:\/\/(newtab|new-tab-page)\//.test(info?.url ?? '');
            return settled ? info : undefined;
          }, 10000);
          await h.sleep(1000);
          const reached = await h.attempt(reach, { targetId });
          const attach = await h.attempt('Target.attachToTarget', { targetId, flatten: true });
          const sessionId = attach.result?.sessionId;
          const navigate = sessionId
            ? await h.attempt('Page.navigate', { url: doc }, sessionId)
            : undefined;
          return { created, listed, reached, attach, navigate };
        },
        { url, doc, reach, ordinary }
      );
      assert.equal(typeof run.created.result?.targetId, 'string', `the guard opens ${url}`);
      assert.ok(run.listed, 'the guard lists the settled page');
      if (!ordinary) assert.match(run.listed.url, newTab, 'listed unredacted');
      assert.ok(run.reached.result, `${reach} reaches it: ${run.reached.error}`);
      const raw = await rawShows(
        (info) =>
          info.type === 'page' &&
          (ordinary ? info.url === url || info.url === doc : newTab.test(info.url)),
        5000
      );
      assert.ok(raw, 'live: the page is open in the default context');
      if (ordinary) {
        assert.equal(typeof run.attach.result?.sessionId, 'string', 'control: the guard attaches');
        assert.ok(run.navigate?.result, `control: Page.navigate runs: ${run.navigate?.error}`);
      } else {
        assert.doesNotMatch(String(run.attach.error), /slicc/, 'the guard does not refuse it');
        assert.match(
          String(run.attach.error),
          /^Cannot access a chrome:\/\/ URL$/,
          'chrome.debugger itself refuses every chrome:// page to an extension'
        );
        const live = await chrome.cdp.send('Target.attachToTarget', {
          targetId: raw.targetId,
          flatten: true,
        });
        await chrome.cdp.send('Page.navigate', { url: doc }, live.sessionId);
      }
      assert.ok(
        await rawShows((info) => info.targetId === raw.targetId && info.url === doc, 10000),
        'live: the same tab reached the ordinary document'
      );
      await chrome.cdp
        .send('Target.closeTarget', { targetId: raw.targetId })
        .catch(() => undefined);
    });
  }

  for (const name of ['chrome-settings', 'chrome-passwords']) {
    test(`${transport} C8.newtab neighbours ${name}: in the same browser the guard refuses to attach, the unguarded runner can`, async (t) => {
      const page = await client(t, transport);
      const raw = await chrome.cdp.send('Target.createTarget', { url: urls[name] });
      assert.ok(
        await rawShows((info) => info.targetId === raw.targetId && info.url.startsWith('chrome:')),
        `live: ${urls[name]} is open in the default context`
      );
      const run = await page.evaluate(
        async (prefix) => {
          const found =
            (await h.until(async () => {
              const { targetInfos } = await h.cdp.send('Target.getTargets', {});
              const hits = targetInfos.filter((info) => info.url.startsWith(prefix));
              return hits.length > 0 ? hits : undefined;
            }, 5000)) ?? [];
          const answers = [];
          for (const info of found) {
            answers.push(
              await h.attempt('Target.attachToTarget', { targetId: info.targetId, flatten: true })
            );
          }
          return { found: found.length, answers };
        },
        urls[name].replace(/\/$/, '')
      );
      assert.ok(run.found > 0, 'the guard lists the privileged tab');
      for (const answer of run.answers) {
        assert.match(String(answer.error), /^slicc: refused/, 'the guard itself refuses');
        assert.equal(answer.result, undefined, 'no session comes back');
      }
      const live = await chrome.cdp.send('Target.attachToTarget', {
        targetId: raw.targetId,
        flatten: true,
      });
      assert.equal(typeof live.sessionId, 'string', 'live: the runner attaches without the guard');
      await chrome.cdp.send('Target.detachFromTarget', { sessionId: live.sessionId });
      await chrome.cdp
        .send('Target.closeTarget', { targetId: raw.targetId })
        .catch(() => undefined);
    });
  }
}
