import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { documentBrowser } from './document-rows.mjs';
import { httpRows, ruleTable } from './http-rows.mjs';

test('the static frame rules have ordered priorities and response headers are unchanged', async () => {
  const [headers, frames, upgrade, ...rest] = await ruleTable();
  assert.deepEqual(rest, []);
  assert.deepEqual(frames, {
    id: 2,
    priority: 2,
    condition: { urlFilter: '|http://', resourceTypes: ['main_frame', 'sub_frame'] },
    action: { type: 'allowAllRequests' },
  });
  assert.deepEqual(upgrade, {
    id: 3,
    priority: 3,
    condition: {
      urlFilter: '|http://',
      requestDomains: ['sliccy.ai'],
      resourceTypes: ['main_frame', 'sub_frame', 'object'],
    },
    action: { type: 'upgradeScheme' },
  });
  assert.equal(headers.id, 1);
  assert.equal(headers.priority, 1);
  assert.deepEqual(Object.keys(headers.action), ['type', 'responseHeaders']);
  assert.equal(headers.action.type, 'modifyHeaders');
  assert.ok(headers.priority < frames.priority && frames.priority < upgrade.priority);
});

const context = {};
before(async () => Object.assign(context, await documentBrowser()));
after(() => context.chrome?.close());

for (const row of httpRows(context)) {
  test(row.name, { timeout: 600000 }, (t) =>
    row.run(t, (line) => {
      t.diagnostic(line);
      console.log(line);
    })
  );
}
