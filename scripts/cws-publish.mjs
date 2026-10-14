import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DEFAULT_POLL_MS = 2000;
const DEFAULT_MAX_ATTEMPTS = 30;
const SUCCESS_STATES = new Set(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']);

function getEnv(envObj, name) {
  const v = envObj[name]?.trim();
  return v || undefined;
}

function parseBool(value, name) {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be one of true, false, 1, or 0.`);
}

function parsePercentage(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value))
    throw new Error('CHROME_WEB_STORE_DEPLOY_PERCENTAGE must be an integer between 0 and 100.');
  const n = Number.parseInt(value, 10);
  if (n < 0 || n > 100)
    throw new Error('CHROME_WEB_STORE_DEPLOY_PERCENTAGE must be an integer between 0 and 100.');
  return n;
}

function parsePublishType(value) {
  if (value === undefined) return undefined;
  if (value === 'DEFAULT_PUBLISH' || value === 'STAGED_PUBLISH') return value;
  throw new Error('CHROME_WEB_STORE_PUBLISH_TYPE must be DEFAULT_PUBLISH or STAGED_PUBLISH.');
}

export function readConfig(envObj) {
  const publisherId = getEnv(envObj, 'CHROME_WEB_STORE_PUBLISHER_ID');
  const itemId = getEnv(envObj, 'CHROME_WEB_STORE_ITEM_ID');
  const saJson = getEnv(envObj, 'CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON');
  if (!publisherId && !itemId && !saJson) return null;
  const missing = [];
  if (!publisherId) missing.push('CHROME_WEB_STORE_PUBLISHER_ID');
  if (!itemId) missing.push('CHROME_WEB_STORE_ITEM_ID');
  if (!saJson) missing.push('CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON');
  if (missing.length)
    throw new Error(
      `Chrome Web Store publishing is partially configured. Missing: ${missing.join(', ')}.`
    );
  const version = getEnv(envObj, 'EXTENSION_VERSION');
  if (!version || !/^\d+(\.\d+){0,3}$/.test(version))
    throw new Error(`EXTENSION_VERSION must be a Chrome extension version, got ${version || 'nothing'}.`);
  const sa = JSON.parse(saJson);
  if (!sa.client_email || !sa.private_key)
    throw new Error('Service account must include client_email and private_key.');
  return {
    publisherId,
    itemId,
    version,
    publishType: parsePublishType(getEnv(envObj, 'CHROME_WEB_STORE_PUBLISH_TYPE')),
    deployPercentage: parsePercentage(getEnv(envObj, 'CHROME_WEB_STORE_DEPLOY_PERCENTAGE')),
    forceCancelPending: parseBool(
      getEnv(envObj, 'CHROME_WEB_STORE_FORCE_CANCEL_PENDING'),
      'CHROME_WEB_STORE_FORCE_CANCEL_PENDING'
    ),
    skipReview: parseBool(
      getEnv(envObj, 'CHROME_WEB_STORE_SKIP_REVIEW'),
      'CHROME_WEB_STORE_SKIP_REVIEW'
    ),
    sa,
  };
}

function itemName(config) {
  return `publishers/${config.publisherId}/items/${config.itemId}`;
}

export function createJwt(sa, nowSeconds) {
  const tokenUri = sa.token_uri || TOKEN_URI;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    })
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  const sig = signer.sign(sa.private_key).toString('base64url');
  return `${header}.${claims}.${sig}`;
}

async function expectJson(response, context) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = text ? ` ${text}` : '';
    throw new Error(`${context} failed with ${response.status} ${response.statusText}.${detail}`);
  }
  return data;
}

export function compareVersions(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function liveVersions(status) {
  const versions = [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]
    .flatMap((revision) => revision?.distributionChannels ?? [])
    .map((channel) => channel?.crxVersion)
    .filter((version) => typeof version === 'string' && version.length > 0);
  return versions.length > 0 ? versions : null;
}

export async function publishRelease(opts = {}) {
  const f = opts.fetchImpl ?? fetch;
  const envObj = opts.env ?? process.env;
  const log = opts.log ?? {
    log: (m) => process.stdout.write(`${m}\n`),
    warn: (m) => process.stderr.write(`WARN: ${m}\n`),
  };
  const readZip = opts.readZip ?? (() => readFileSync('artifacts/slicc-extension.zip'));
  const waitMs = opts.waitMs ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const maxAttempts = opts.maxPollAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  const config = readConfig(envObj);
  if (!config) return null;

  const name = itemName(config);

  const jwt = createJwt(config.sa, nowSeconds());
  const tokenUri = config.sa.token_uri || TOKEN_URI;
  const tokenRes = await f(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await expectJson(tokenRes, 'token exchange');
  if (!tokenData.access_token) throw new Error('Token exchange did not return an access_token.');
  const token = tokenData.access_token;

  async function status() {
    const r = await f(`https://chromewebstore.googleapis.com/v2/${name}:fetchStatus`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    return expectJson(r, 'status');
  }

  const preflight = await status();
  const live = liveVersions(preflight);
  if (live === null) {
    throw new Error(
      `Chrome Web Store status for ${config.itemId} has no crxVersion, so the live version is unknown. Refusing to publish. Status keys: ${Object.keys(preflight).join(', ')}`
    );
  }
  const highest = live.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b), '0');
  if (compareVersions(config.version, highest) <= 0) {
    throw new Error(
      `Version ${config.version} is not greater than the live Chrome Web Store version ${highest}. Refusing to publish.`
    );
  }
  log.log(`Live version ${highest}, publishing ${config.version}`);
  if (preflight.warned) log.warn(`Item ${config.itemId} is currently warned.`);
  if (preflight.takenDown) log.warn(`Item ${config.itemId} is currently taken down.`);

  if (preflight.submittedItemRevisionStatus?.state === 'PENDING_REVIEW') {
    if (!config.forceCancelPending) {
      log.warn(
        `Skipping publish for item ${config.itemId} because a revision is already pending review. Set CHROME_WEB_STORE_FORCE_CANCEL_PENDING=true to cancel and resubmit.`
      );
      return null;
    }
    log.warn(
      `Cancelling the pending Chrome Web Store review for item ${config.itemId} before uploading.`
    );
    const cancelRes = await f(`https://chromewebstore.googleapis.com/v2/${name}:cancelSubmission`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!cancelRes.ok) {
      const t = await cancelRes.text();
      throw new Error(`Cancel submission failed with ${cancelRes.status}.${t ? ` ${t}` : ''}`);
    }
    for (let i = 1; i <= maxAttempts; i++) {
      const s = await status();
      if (s.submittedItemRevisionStatus?.state !== 'PENDING_REVIEW') break;
      if (i === maxAttempts)
        throw new Error(`Cancellation did not complete after ${maxAttempts} checks.`);
      await waitMs(pollMs);
    }
  }

  const zipBytes = readZip();
  log.log(`Uploading ${zipBytes.length} bytes to ${name}`);
  const uploadRes = await expectJson(
    await f(`https://chromewebstore.googleapis.com/upload/v2/${name}:upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/zip',
      },
      body: zipBytes,
    }),
    'upload'
  );

  if (uploadRes.crxVersion && uploadRes.crxVersion !== config.version)
    throw new Error(
      `Chrome Web Store accepted version ${uploadRes.crxVersion}, but the release is ${config.version}.`
    );
  if (uploadRes.uploadState === 'FAILED' || uploadRes.uploadState === 'NOT_FOUND')
    throw new Error(`Upload finished immediately in state ${uploadRes.uploadState}.`);
  if (uploadRes.uploadState !== 'SUCCEEDED' && uploadRes.uploadState !== 'IN_PROGRESS')
    throw new Error(`Upload returned unknown state ${uploadRes.uploadState}.`);

  if (uploadRes.uploadState === 'IN_PROGRESS') {
    log.log('Upload in progress, polling for completion...');
    for (let i = 1; i <= maxAttempts; i++) {
      const s = await status();
      const state = s.lastAsyncUploadState;
      if (state === 'SUCCEEDED') break;
      if (state === 'FAILED' || state === 'NOT_FOUND')
        throw new Error(`Async upload finished in state ${state}.`);
      if (state !== undefined && state !== 'IN_PROGRESS')
        throw new Error(`Async upload returned unknown state ${state}.`);
      if (i === maxAttempts)
        throw new Error(`Async upload did not complete after ${maxAttempts} checks.`);
      await waitMs(pollMs);
    }
  }

  const body = {};
  if (config.publishType) body.publishType = config.publishType;
  if (config.deployPercentage !== undefined)
    body.deployInfos = [{ deployPercentage: config.deployPercentage }];
  if (config.skipReview !== undefined) body.skipReview = config.skipReview;

  const publishRes = await expectJson(
    await f(`https://chromewebstore.googleapis.com/v2/${name}:publish`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    'publish'
  );

  if (!SUCCESS_STATES.has(publishRes.state))
    throw new Error(`Publish returned unexpected state ${publishRes.state}.`);

  log.log(`Published to Chrome Web Store item ${config.itemId} (${publishRes.state}).`);
  return {
    itemId: config.itemId,
    uploadState: uploadRes.uploadState === 'IN_PROGRESS' ? 'SUCCEEDED' : uploadRes.uploadState,
    publishState: publishRes.state,
  };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  publishRelease().then(
    (result) => {
      if (!result) process.stdout.write('Chrome Web Store publish skipped.\n');
    },
    (err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
  );
}
