import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { publishRelease } from '../../scripts/cws-publish.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = JSON.stringify({
  client_email: 'test@example.invalid',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

function run(mode, { live = '1.0', pending = false, async = false, failed = false } = {}) {
  const calls = [];
  const logs = [];
  let statuses = 0;
  const result = publishRelease({
    env: {
      CHROME_WEB_STORE_MODE: mode,
      CHROME_WEB_STORE_PUBLISHER_ID: 'publisher',
      CHROME_WEB_STORE_ITEM_ID: 'item',
      CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON: credentials,
      EXTENSION_VERSION: '2.0',
      CHROME_WEB_STORE_PUBLISH_TYPE: 'STAGED_PUBLISH',
      CHROME_WEB_STORE_DEPLOY_PERCENTAGE: '25',
      CHROME_WEB_STORE_SKIP_REVIEW: 'false',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      let data;
      if (url.endsWith('/token')) data = { access_token: 'fake-token' };
      else if (url.endsWith(':fetchStatus')) {
        statuses++;
        data = {
          publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: live }] },
          submittedItemRevisionStatus: pending ? { state: 'PENDING_REVIEW' } : undefined,
          lastAsyncUploadState: failed ? 'FAILED' : statuses < 3 ? 'IN_PROGRESS' : 'SUCCEEDED',
        };
      } else if (url.endsWith(':upload'))
        data = { crxVersion: '2.0', uploadState: async ? 'IN_PROGRESS' : 'SUCCEEDED' };
      else if (url.endsWith(':publish')) data = { state: 'PENDING_REVIEW' };
      else throw new Error(`Unexpected request: ${url}`);
      return new Response(JSON.stringify(data));
    },
    readZip: () => Buffer.from('fake zip'),
    waitMs: async () => {},
    log: { log: (message) => logs.push(message), warn: (message) => logs.push(message) },
  });
  return { result, calls, logs };
}

for (const mode of [undefined, '', 'publish']) {
  test(`mode ${String(mode)} uploads and publishes with the existing body`, async () => {
    const { result, calls } = run(mode);
    assert.deepEqual(await result, {
      itemId: 'item',
      uploadState: 'SUCCEEDED',
      publishState: 'PENDING_REVIEW',
    });
    assert.deepEqual(
      calls.map(({ url }) => url.split(':').at(-1)),
      ['//oauth2.googleapis.com/token', 'fetchStatus', 'upload', 'publish']
    );
    assert.deepEqual(JSON.parse(calls.at(-1).body), {
      publishType: 'STAGED_PUBLISH',
      deployInfos: [{ deployPercentage: 25 }],
      skipReview: false,
    });
  });
}

for (const async of [false, true]) {
  test(`upload mode leaves a draft after ${async ? 'async' : 'immediate'} success`, async () => {
    const { result, calls, logs } = run('upload', { async });
    assert.deepEqual(await result, { itemId: 'item', uploadState: 'SUCCEEDED' });
    assert.equal(calls.filter(({ url }) => url.endsWith(':upload')).length, 1);
    assert.equal(
      calls.some(({ url }) => url.endsWith(':publish')),
      false
    );
    assert.equal(calls.filter(({ url }) => url.endsWith(':fetchStatus')).length, async ? 3 : 1);
    assert.equal(logs.at(-1), 'uploaded 2.0 as a draft, not submitted');
  });
}

for (const mode of ['submit', 'invalid']) {
  test(`unknown mode ${mode} refuses before fetching`, async () => {
    const { result, calls } = run(mode);
    await assert.rejects(result, /CHROME_WEB_STORE_MODE must be publish or upload/);
    assert.equal(calls.length, 0);
    await assert.rejects(
      publishRelease({ env: { CHROME_WEB_STORE_MODE: mode }, fetchImpl: assert.fail }),
      /CHROME_WEB_STORE_MODE/
    );
  });
}

for (const options of [{ live: '2.0' }, { live: '3.0' }, { pending: true }]) {
  test(`upload retains preflight refusal for ${JSON.stringify(options)}`, async () => {
    const { result, calls } = run('upload', options);
    await assert.rejects(result, /not greater than|already pending review/);
    assert.equal(calls.length, 2);
  });
}

test('upload refuses async failure without claiming draft success', async () => {
  const { result, calls, logs } = run('upload', { async: true, failed: true });
  await assert.rejects(result, /Async upload finished in state FAILED/);
  assert.equal(
    calls.some(({ url }) => url.endsWith(':publish')),
    false
  );
  assert.equal(
    logs.some((line) => line.includes('as a draft')),
    false
  );
});
