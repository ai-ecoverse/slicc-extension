import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { openExtensionPage, portCall } from './extension-page.mjs';

let chrome;
before(async () => {
  chrome = await launch();
});
after(() => chrome?.close());

const seven = 'https://seven.sliccy.ai/';
const leader = 'https://www.sliccy.ai/?slicc=leader';

async function secretsPage(t) {
  const page = await chrome.visit(t, seven);
  return openExtensionPage(page, 'secrets.html');
}

function rows(secrets) {
  return secrets.evaluate(
    '[...document.querySelectorAll("#list .secret-row")].map((row) => ({ name: row.dataset.name, domains: row.querySelector(".secret-domains")?.textContent }))'
  );
}

function toast(secrets) {
  return secrets.evaluate(
    '({ text: document.getElementById("toast").textContent, error: document.getElementById("toast").classList.contains("error") })'
  );
}

function fill(fields) {
  return `(() => { for (const [id, value] of Object.entries(${JSON.stringify(fields)})) document.getElementById(id).value = value; return true; })()`;
}

test('six secrets page: a custom secret needs a domain, then saves, lists and deletes only after confirmation', async (t) => {
  const secrets = await secretsPage(t);
  const name = `SIX_CUSTOM_${Date.now()}`;
  await secrets.evaluate('document.querySelector(\'[data-pane="custom"]\').click()');
  assert.equal(await secrets.evaluate('document.querySelector(".pane.active").id'), 'pane-custom');
  await secrets.evaluate(fill({ 'c-name': name, 'c-value': 'v-1', 'c-domains': '' }));
  await secrets.evaluate('document.getElementById("c-save").click()');
  await secrets.until('document.getElementById("toast").classList.contains("show")');
  assert.equal((await toast(secrets)).error, true, 'a secret without domains is refused');
  assert.equal(
    (await rows(secrets)).some((r) => r.name === name),
    false,
    'the refused secret is not listed'
  );
  await secrets.evaluate(
    fill({ 'c-name': name, 'c-value': 'v-1', 'c-domains': 'upstream.test, *.upstream.test' })
  );
  await secrets.evaluate('document.getElementById("c-save").click()');
  await secrets.until(
    `[...document.querySelectorAll("#list .secret-row")].some((row) => row.dataset.name === ${JSON.stringify(name)})`
  );
  assert.deepEqual(
    (await rows(secrets)).find((r) => r.name === name),
    { name, domains: 'upstream.test, *.upstream.test' }
  );
  assert.deepEqual(await toast(secrets), { text: `Saved "${name}"`, error: false });
  assert.equal(
    await secrets.evaluate('document.getElementById("c-name").value'),
    '',
    'the form clears after a save'
  );
  const remove = `[...document.querySelector('.secret-row[data-name=${JSON.stringify(name)}]').querySelectorAll('button')].find((b) => b.textContent === 'Delete').click()`;
  await secrets.evaluate(
    `(() => { window.asked = 0; window.confirm = () => { window.asked += 1; return false; }; ${remove}; return true; })()`
  );
  assert.equal(await secrets.until('window.asked === 1'), true, 'the delete asks first');
  await secrets.evaluate(
    'document.getElementById("list").replaceChildren(); document.getElementById("refreshBtn").click()'
  );
  await secrets.until('document.getElementById("list").children.length > 0');
  assert.equal(
    (await rows(secrets)).some((r) => r.name === name),
    true,
    'declining the confirmation keeps the secret in storage'
  );
  await secrets.evaluate(`(() => { window.confirm = () => true; ${remove}; return true; })()`);
  await secrets.until(
    `![...document.querySelectorAll("#list .secret-row")].some((row) => row.dataset.name === ${JSON.stringify(name)})`
  );
  assert.deepEqual(await toast(secrets), { text: `Deleted ${name}`, error: false });
  await secrets.close();
});

test('six S3 mount: a profile saved on the secrets page signs the leader request with SigV4; an unknown profile is not configured', async (t) => {
  const secrets = await secretsPage(t);
  const profile = `itest${Date.now()}`;
  await secrets.evaluate(
    fill({
      's3-profile': profile,
      's3-key': 'AKIDEXAMPLE',
      's3-secret': 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      's3-region': 'eu-central-1',
      's3-endpoint': 'https://upstream.test',
      's3-pathstyle': 'true',
      's3-domains': 'upstream.test',
    })
  );
  await secrets.evaluate('document.getElementById("s3-save").click()');
  await secrets.until(
    `document.getElementById("toast").textContent === ${JSON.stringify(`Saved profile "${profile}"`)}`
  );
  const listed = (await rows(secrets)).filter((r) => r.name.startsWith(`s3.${profile}.`));
  assert.deepEqual(
    listed.map((r) => r.name).sort(),
    [
      `s3.${profile}.access_key_id`,
      `s3.${profile}.endpoint`,
      `s3.${profile}.path_style`,
      `s3.${profile}.region`,
      `s3.${profile}.secret_access_key`,
    ],
    'the profile is listed as its five paired secrets'
  );
  assert.equal(await secrets.evaluate('document.getElementById("s3-profile").value'), '');

  const www = await chrome.visit(t, leader);
  const reply = await portCall(www, 'mount.sign-and-forward', {
    id: 1,
    type: 'mount.s3-sign-and-forward',
    envelope: { profile, method: 'GET', bucket: 'bucket', key: 'dir/file name.txt' },
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.status, 200);
  const seen = chrome.upstream.seen.filter((s) => s.path === '/bucket/dir/file%20name.txt');
  assert.equal(seen.length, 1, 'the signed request reaches the profile endpoint, path-style');
  assert.match(
    seen[0].headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/
  );
  assert.equal(
    JSON.stringify(reply).includes('wJalrXUtnFEMI'),
    false,
    'the secret key never reaches the page'
  );

  const missing = await portCall(www, 'mount.sign-and-forward', {
    id: 2,
    type: 'mount.s3-sign-and-forward',
    envelope: { profile: `${profile}-missing`, method: 'GET', bucket: 'bucket', key: 'k' },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.errorCode, 'profile_not_configured');
  const invalid = await portCall(www, 'mount.sign-and-forward', { id: 3, type: 'mount.nope' });
  assert.deepEqual(invalid, {
    ok: false,
    error: 'invalid mount.sign-and-forward request',
    errorCode: 'internal',
  });
  await secrets.close();
});

test('six secrets page: OAuth extra domains add, refuse a duplicate, list and clear', async (t) => {
  const secrets = await secretsPage(t);
  const provider = `prov${Date.now()}`;
  await secrets.evaluate('document.querySelector(\'[data-pane="oauth-domains"]\').click()');
  await secrets.evaluate(fill({ 'od-provider': provider, 'od-domain': '' }));
  await secrets.evaluate('document.getElementById("od-add").click()');
  assert.deepEqual(await toast(secrets), { text: 'Domain is required', error: true });
  for (const domain of ['api.upstream.test', '*.cdn.upstream.test']) {
    await secrets.evaluate(fill({ 'od-provider': provider, 'od-domain': domain }));
    await secrets.evaluate('document.getElementById("od-add").click()');
    assert.deepEqual(await toast(secrets), {
      text: `Added ${domain} to ${provider}`,
      error: false,
    });
  }
  await secrets.evaluate(fill({ 'od-provider': provider, 'od-domain': 'api.upstream.test' }));
  await secrets.evaluate('document.getElementById("od-add").click()');
  assert.deepEqual(await toast(secrets), { text: `Already in ${provider} extras`, error: true });
  const section = `document.querySelector('#od-list .secret-row[data-provider=${JSON.stringify(provider)}]')`;
  assert.equal(
    await secrets.evaluate(`${section}.querySelector('.secret-domains').textContent`),
    'api.upstream.test, *.cdn.upstream.test'
  );
  await secrets.evaluate(
    `(() => { window.confirm = () => true; [...${section}.querySelectorAll('button')].find((b) => b.textContent === 'Clear').click(); return true; })()`
  );
  assert.equal(await secrets.until(`!${section}`), true, 'clearing removes the provider');
  await secrets.close();
});

test('six handoff: a Link handoff header raises one notification and the badge per fingerprint; an ordinary page raises none', async (t) => {
  const n = `n${Date.now()}`;
  const panel = await secretsPage(t);
  const handoffs = () =>
    panel.evaluate(
      'chrome.notifications.getAll().then((all) => Object.keys(all).filter((id) => id.startsWith("slicc-handoff-")))'
    );
  await panel.evaluate(
    'chrome.notifications.getAll().then((all) => Promise.all(Object.keys(all).map((id) => chrome.notifications.clear(id))))'
  );
  await panel.evaluate('chrome.action.setBadgeText({ text: "" })');
  const fingerprints =
    'chrome.storage.session.get("slicc_handoff_notified_fingerprints").then((r) => (r.slicc_handoff_notified_fingerprints ?? []).length)';
  const before = await panel.evaluate(fingerprints);
  await chrome.visit(t, 'https://ordinary.test/');
  await chrome.visit(t, `https://ordinary.test/linked?n=${n}`);
  await chrome.visit(t, `https://ordinary.test/linked?n=${n}`);
  await chrome.visit(t, `https://ordinary.test/linked?n=${n}-later`);
  assert.equal(
    await panel.until(`${fingerprints}.then((count) => count >= ${before + 2})`),
    true,
    'both distinct handoffs are recorded, so every earlier navigation was handled'
  );
  const shown =
    'chrome.notifications.getAll().then((all) => Object.keys(all).filter((id) => id.startsWith("slicc-handoff-")).length >= 2)';
  assert.equal(await panel.until(shown), true, 'both distinct handoffs show their notification');
  assert.equal(
    (await handoffs()).length,
    2,
    'one notification per distinct handoff: none for the ordinary page, none for the repeat'
  );
  assert.equal(await panel.evaluate('chrome.action.getBadgeText({})'), '!');
  await panel.close();
});

test('six pinned ports: the leader lists, sets and deletes over secrets.crud; a www.sliccy.ai tab that is not the leader is refused', async (t) => {
  const name = `SIX_CRUD_${Date.now()}`;
  const www = await chrome.visit(t, leader);
  const set = await portCall(www, 'secrets.crud', {
    id: 1,
    type: 'secrets.set',
    name,
    value: 'crud-value',
    domains: ['upstream.test'],
  });
  assert.equal(set.ok, true, JSON.stringify(set));
  const listed = await portCall(www, 'secrets.crud', { id: 2, type: 'secrets.list' });
  assert.deepEqual(
    listed.entries.find((e) => e.name === name),
    { name, domains: ['upstream.test'] }
  );
  assert.equal(
    JSON.stringify(listed).includes('crud-value'),
    false,
    'secrets.list carries no values'
  );
  const unknown = await portCall(www, 'secrets.crud', { id: 3, type: 'secrets.nope' });
  assert.deepEqual(unknown, { error: 'unknown secrets type: secrets.nope' });

  const other = await chrome.visit(t, 'https://www.sliccy.ai/elsewhere');
  const refused = await portCall(other, 'secrets.crud', { id: 4, type: 'secrets.list' });
  assert.match(refused.error, /^secrets\.crud pin failed: /);
  const mount = await portCall(other, 'mount.sign-and-forward', {
    id: 5,
    type: 'mount.s3-sign-and-forward',
    envelope: { profile: 'x', method: 'GET', bucket: 'b', key: 'k' },
  });
  assert.match(mount.error, /^mount\.sign-and-forward pin failed: /);

  const removed = await portCall(www, 'secrets.crud', { id: 6, type: 'secrets.delete', name });
  assert.equal(removed.removed, true, JSON.stringify(removed));
  const after = await portCall(www, 'secrets.crud', { id: 7, type: 'secrets.list' });
  assert.equal(
    after.entries.some((e) => e.name === name),
    false
  );
});
