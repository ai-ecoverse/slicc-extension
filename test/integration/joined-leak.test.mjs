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
};
const joins = {
  comma: (a, b) => `${a},${b}`,
  semicolon: (a, b) => `${a};${b}`,
  paren: (a, b) => `(${a})(${b})`,
};
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

function encodings(secret) {
  return [secret, encodeURIComponent(secret), btoa(secret), btoa(secret).replace(/=+$/, '')];
}

function leaks(run, n) {
  const needles = encodings(mark(n));
  const seen = (value) => JSON.stringify(value ?? null);
  const out = [];
  for (const event of run.events) {
    if (needles.some((needle) => seen(event).includes(needle))) out.push(event.method);
  }
  for (const reply of run.replies) {
    if (needles.some((needle) => seen(reply.answer).includes(needle)))
      out.push(`${reply.method} reply`);
  }
  return [...new Set(out)];
}

function refused(answer) {
  return typeof answer?.error === 'string' && answer.error.startsWith('slicc: refused');
}

async function probe(page, n, steps) {
  return page.evaluate(
    async ({ n, steps }) => {
      const replies = [];
      const record = async (method, params, sessionId) => {
        const answer = await h.attempt(method, params, sessionId);
        replies.push({ method, answer });
        return answer;
      };
      const start = h.events.length;
      const { targetId, sessionId } = await h.open(`https://ordinary.test/doc?n=joined-${n}`);
      const out = {};
      for (const [name, method, params] of steps) {
        out[name] = await record(method, params, sessionId);
      }
      await h.sleep(300);
      await h.close(targetId);
      return { out, events: h.events.slice(start), replies };
    },
    { n, steps }
  );
}

function pairOf(join, order, ordinary, guarded) {
  return order === 'ordinary-first'
    ? joins[join](ordinary, guarded)
    : joins[join](guarded, ordinary);
}

for (const transport of transports) {
  for (const join of Object.keys(joins)) {
    for (const order of ['ordinary-first', 'protected-first']) {
      for (const to of ['seven', 'vault']) {
        test(`${transport}: a ${join}-joined pair, ${order}, naming ${to}'s callback reaches the client with only its origin and the ordinary url intact`, async (t) => {
          const page = await client(t, transport);
          const n = unique(`${transport}${join}${order}${to}`);
          const ordinary = `https://ordinary.test/a?n=${n}`;
          const pair = pairOf(join, order, ordinary, `${callbacks[to]}?code=${mark(n)}`);
          const run = await probe(page, n, [
            [
              'value',
              'Runtime.evaluate',
              { expression: JSON.stringify(pair), returnByValue: true },
            ],
          ]);
          const found = leaks(run, n);
          t.diagnostic(`LEAK ${transport} ${join} ${order} ${to}: ${found.join(' ') || 'none'}`);
          assert.deepEqual(found, [], `the token leaks through ${found.join(' ')}`);
          const value = run.out.value.result?.result?.value ?? '';
          assert.ok(value.includes(ordinary), `the ordinary url survives: ${value}`);
          assert.ok(value.includes(new URL(callbacks[to]).origin), `the origin stays: ${value}`);
        });
      }

      test(`${transport}: a page holding a ${join}-joined pair, ${order}, naming vault's callback snapshots to nothing beyond the origin`, async (t) => {
        const page = await client(t, transport);
        const n = unique(`${transport}snap${join}${order}`);
        const ordinary = `https://ordinary.test/a?n=${n}`;
        const pair = pairOf(join, order, ordinary, `${callbacks.vault}?code=${mark(n)}`);
        const run = await probe(page, n, [
          [
            'write',
            'Runtime.evaluate',
            {
              expression: `document.body.textContent = ${JSON.stringify(pair)}; 1`,
              returnByValue: true,
            },
          ],
          [
            'text',
            'Runtime.evaluate',
            { expression: 'document.body.textContent', returnByValue: true },
          ],
          ['snapshot', 'Page.captureSnapshot', {}],
        ]);
        const found = leaks(run, n);
        t.diagnostic(`LEAK ${transport} snapshot ${join} ${order}: ${found.join(' ') || 'none'}`);
        assert.deepEqual(found, [], `the token leaks through ${found.join(' ')}`);
        const text = run.out.text.result?.result?.value ?? '';
        assert.ok(text.includes(ordinary), `the ordinary url survives: ${text}`);
        assert.ok(refused(run.out.snapshot), JSON.stringify(run.out.snapshot).slice(0, 300));
      });
    }

    test(`${transport} control: a ${join}-joined pair of ordinary urls reaches the client intact and snapshots`, async (t) => {
      const page = await client(t, transport);
      const n = unique(`${transport}plain${join}`);
      const pair = joins[join](
        `https://ordinary.test/a?code=${mark(n)}`,
        `https://ordinary.test/b?code=${mark(n)}`
      );
      const run = await probe(page, n, [
        ['value', 'Runtime.evaluate', { expression: JSON.stringify(pair), returnByValue: true }],
        [
          'write',
          'Runtime.evaluate',
          {
            expression: `document.body.textContent = ${JSON.stringify(pair)}; 1`,
            returnByValue: true,
          },
        ],
        ['snapshot', 'Page.captureSnapshot', {}],
      ]);
      assert.equal(run.out.value.result?.result?.value, pair);
      assert.ok(!run.out.snapshot.error, JSON.stringify(run.out.snapshot).slice(0, 300));
      assert.ok(leaks(run, n).length > 0, 'the ordinary marker is visible');
    });
  }

  test(`${transport}: a Runtime.evaluate value keyed by vault's callback reaches the client keyed by its origin only`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}key`);
    const key = `${callbacks.vault}?code=${mark(n)}`;
    const run = await probe(page, n, [
      [
        'value',
        'Runtime.evaluate',
        {
          expression: `({ [${JSON.stringify(key)}]: 1, plain: 2 })`,
          returnByValue: true,
        },
      ],
    ]);
    const found = leaks(run, n);
    t.diagnostic(`LEAK ${transport} key: ${found.join(' ') || 'none'}`);
    assert.deepEqual(found, [], `the token leaks through ${found.join(' ')}`);
    assert.deepEqual(run.out.value.result?.result?.value, {
      'https://vault.sliccy.ai': 1,
      plain: 2,
    });
  });

  test(`${transport}: a Runtime.evaluate value with two keys that reduce to the same protected origin is refused`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}collide`);
    const run = await probe(page, n, [
      [
        'value',
        'Runtime.evaluate',
        {
          expression: `({ [${JSON.stringify(`${callbacks.vault}?code=${mark(n)}`)}]: 1, [${JSON.stringify(`${callbacks.vault}/other?code=${mark(n)}`)}]: 2 })`,
          returnByValue: true,
        },
      ],
    ]);
    const found = leaks(run, n);
    assert.deepEqual(found, [], `the token leaks through ${found.join(' ')}`);
    assert.ok(refused(run.out.value), JSON.stringify(run.out.value));
  });

  test(`${transport} control: a Runtime.evaluate value keyed by an ordinary url keeps its key`, async (t) => {
    const page = await client(t, transport);
    const n = unique(`${transport}plainkey`);
    const key = `https://ordinary.test/landing?code=${mark(n)}`;
    const run = await probe(page, n, [
      [
        'value',
        'Runtime.evaluate',
        { expression: `({ [${JSON.stringify(key)}]: 1 })`, returnByValue: true },
      ],
    ]);
    assert.deepEqual(run.out.value.result?.result?.value, { [key]: 1 });
  });
}
