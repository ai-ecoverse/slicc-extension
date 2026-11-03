import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLivePermissions } from '../../scripts/check-live-permissions.mjs';
import { checkSixFloor } from '../../scripts/check-six-floor.mjs';

const release = { version: '7.13.0', permissions: ['storage'] };
const live = { version: '7.12.0', permissions: ['storage'] };
const xml = '<updatecheck version="7.12.0" codebase="https://store.invalid/item.crx"/>';

function crx(manifest) {
  const name = Buffer.from('manifest.json');
  const data = Buffer.from(JSON.stringify(manifest));
  const local = Buffer.alloc(30);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  const header = Buffer.alloc(12);
  header.write('Cr24');
  return Buffer.concat([header, local, name, data, central, name, end]);
}

const checks = {
  floor: (opts) => checkSixFloor(release, { tag: 'v6.256.4' }, opts),
  permissions: (opts) => checkLivePermissions(release, opts),
};

for (const [name, check] of Object.entries(checks)) {
  for (const stage of ['feed', 'crx']) {
    for (const scenario of ['network', 'exhausted', '404', 'malformed', '503', '429']) {
      test(`${name}: ${stage} ${scenario}`, async () => {
        let attempts = 0;
        let fallbackCalls = 0;
        const delays = [];
        const result = await check({
          sleepImpl: async (ms) => delays.push(ms),
          readUpstream: async () => {
            fallbackCalls++;
            return live;
          },
          fetchImpl: async (url) => {
            const target = stage === 'crx' ? url.endsWith('.crx') : !url.endsWith('.crx');
            if (target) {
              attempts++;
              if (scenario === 'exhausted' || (scenario === 'network' && attempts === 1)) {
                throw new TypeError('fetch failed');
              }
              if (scenario === '404' || (['503', '429'].includes(scenario) && attempts === 1)) {
                return new Response('', { status: Number(scenario) });
              }
              if (scenario === 'malformed') return new Response('broken');
            }
            return new Response(url.endsWith('.crx') ? crx(live) : xml);
          },
        });
        const failed = ['exhausted', '404', 'malformed'].includes(scenario);
        assert.equal(attempts, scenario === 'exhausted' ? 3 : failed ? 1 : 2);
        assert.deepEqual(delays, scenario === 'exhausted' ? [1000, 3000] : failed ? [] : [1000]);
        if (name === 'permissions') {
          assert.equal(result.ok, true);
          assert.equal(result.source, failed ? 'upstream' : 'live');
          assert.equal(fallbackCalls, failed ? 1 : 0);
        } else {
          assert.equal(result.ok, !failed);
          if (failed) assert.match(result.error, /Failing closed/);
        }
        if (scenario === 'exhausted') {
          assert.match(result.error ?? result.liveError, /fetch failed \(3 attempts\)/);
        }
        if (scenario === '404') {
          assert.match(result.error ?? result.liveError, /404 .*\(1 attempt\)/);
        }
      });
    }
  }
}

test('permissions: exhausted retries still fail when the pinned baseline is unreadable', async () => {
  let attempts = 0;
  const result = await checkLivePermissions(release, {
    sleepImpl: async () => {},
    fetchImpl: async () => {
      attempts++;
      throw new TypeError('fetch failed');
    },
    readUpstream: async () => {
      throw new Error('hash mismatch');
    },
  });
  assert.equal(attempts, 3);
  assert.equal(result.ok, false);
  assert.match(result.error, /fetch failed \(3 attempts\).*hash mismatch/);
});
