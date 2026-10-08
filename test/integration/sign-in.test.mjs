import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';

const redirect = 'https://akjjllgokmbgpbdbmafpiefnhidlmbgf.chromiumapp.org/adobe';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

function signIn(page, options) {
  return page.evaluate(async (options) => {
    try {
      return { token: await globalThis.sliccExtension.signIn(options) };
    } catch (error) {
      return { error: error.message };
    }
  }, options);
}

test('signs in to Adobe IMS through the extension redirect', async (t) => {
  const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
  const answer = await signIn(page, { clientId: 'good', scopes: 'openid,AdobeID' });
  assert.deepEqual(answer, { token: 'dummy-ims-token' });
  const [query] = chrome.ims.authorized.splice(0);
  assert.equal(query.client_id, 'good');
  assert.equal(query.scope, 'openid,AdobeID');
  assert.equal(query.response_type, 'token');
  assert.equal(query.redirect_uri, redirect);
  assert.match(query.state, /^[0-9a-f-]{36}$/);
  assert.equal(
    await page.evaluate(() => document.body.textContent.includes('dummy-ims-token')),
    false
  );
});

test('rejects answers for another request, refusals and bad options', async (t) => {
  const page = await chrome.visit(t, 'https://seven.sliccy.ai/');
  assert.match(
    (await signIn(page, { clientId: 'stranger', scopes: 'openid' })).error,
    /answered another request/
  );
  assert.equal(
    (await signIn(page, { clientId: 'denied', scopes: 'openid' })).error,
    'access_denied'
  );
  assert.match((await signIn(page, { scopes: 'openid' })).error, /needs a client id/);
  assert.equal(chrome.ims.authorized.splice(0).length, 2);
});
