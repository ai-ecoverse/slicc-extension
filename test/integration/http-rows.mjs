import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { documentCell, unique } from './document-rows.mjs';
import { read, readable, receiver } from './http-fixture.mjs';

export async function first(lens, t, { to, from, warm }, trials = 20) {
  const panel = await lens.extension(t);
  let count = 0;
  for (let i = 0; i < trials; i++) {
    const page = await panel.tab();
    await page.goto(
      from ? `${from}?n=${unique('from')}` : `https://other.test/?n=${unique('blank')}`
    );
    if (warm) await lens.running(panel);
    else await lens.stop(panel);
    await page.goto(
      `${to}early?${new URLSearchParams({ n: unique('early'), url: `${receiver}?n=${unique('receiver')}` })}`
    );
    if (readable(await page.evaluate(() => globalThis.__early))) count += 1;
    await page.close().catch(() => undefined);
  }
  return count;
}

export async function ruleTable() {
  return JSON.parse(await readFile(new URL('../../extension/rules.json', import.meta.url)));
}

export function httpRows(context) {
  return [
    {
      id: 'h1',
      name: 'http Seven requests commit no http document, worker stopped or running',
      async run(t, report) {
        for (const warm of [false, true]) {
          const counts = await documentCell(context, t, { warm, path: '/early' }, 20);
          report(`row-h1: state=${warm ? 'warm' : 'cold'} ${JSON.stringify(counts)}`);
        }
      },
    },
    {
      id: 'h2',
      name: 'the first script of an https Seven or www document reads a CORS-less receiver, worker stopped or running',
      async run(t, report) {
        const counts = {};
        for (const host of ['seven.sliccy.ai', 'www.sliccy.ai']) {
          for (const warm of [false, true]) {
            counts[`${host}-${warm ? 'warm' : 'cold'}`] = await first(context.lens, t, {
              to: `https://${host}/`,
              warm,
            });
          }
        }
        report(`row-h2: ${JSON.stringify(counts)}`);
        assert.deepEqual(Object.values(counts), [20, 20, 20, 20]);
      },
    },
    {
      id: 'h3',
      name: 'a tab moving from https Seven to http Seven commits no http document',
      async run(t, report) {
        const counts = await documentCell(
          context,
          t,
          { from: `https://seven.sliccy.ai/?from=${unique('seven')}`, path: '/early' },
          20
        );
        report(`row-h3: ${JSON.stringify(counts)}`);
      },
    },
    {
      id: 'h6',
      name: 'the vault host reads a CORS-less receiver over https',
      async run(t, report) {
        await context.lens.extension(t);
        let lifted = 0;
        for (let trial = 0; trial < 20; trial++) {
          const page = await context.chrome.visit(
            t,
            `https://vault.sliccy.ai/?n=${unique('vault')}`,
            { expectExtension: false }
          );
          if (readable(await read(page, `${receiver}?n=${unique('vault-receiver')}`))) lifted++;
        }
        report(`row-h6: documents=20 lifted=${lifted}/20`);
        assert.equal(lifted, 20);
      },
    },
    {
      id: 'h7',
      name: 'loading Seven, www, vault and ordinary pages writes no session rules',
      async run(t, report) {
        const panel = await context.lens.extension(t);
        const before = await panel.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
        for (const url of [
          'https://seven.sliccy.ai/',
          'https://www.sliccy.ai/',
          'https://vault.sliccy.ai/',
          'https://other.test/',
        ]) {
          await context.chrome.visit(t, `${url}?n=${unique('quiet')}`, {
            expectExtension: false,
          });
        }
        await documentCell(context, t, {}, 1);
        const after = await panel.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
        report(`row-h7: before=${before.length} after=${after.length}`);
        assert.deepEqual([before, after], [[], []]);
      },
    },
  ];
}
