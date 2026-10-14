import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const saJson = process.env.CHROME_WEB_STORE_SERVICE_ACCOUNT_JSON;
if (!saJson) {
  process.stdout.write('No service account configured — skipping Chrome Web Store publish\n');
  process.exit(0);
}

const sa = JSON.parse(saJson);
const itemId = process.env.CHROME_WEB_STORE_ITEM_ID;
const deployPercentage = process.env.CHROME_WEB_STORE_DEPLOY_PERCENTAGE;

const now = Math.floor(Date.now() / 1000);
const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(
  JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/chromewebstore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })
).toString('base64url');
const signer = createSign('RSA-SHA256');
signer.update(`${header}.${payload}`);
const signature = signer.sign(sa.private_key, 'base64url');
const jwt = `${header}.${payload}.${signature}`;

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
});
const tokenData = await tokenRes.json();
if (!tokenData.access_token) {
  process.stderr.write(`Failed to obtain access token: ${JSON.stringify(tokenData)}\n`);
  process.exit(1);
}
const token = tokenData.access_token;

const zip = readFileSync('artifacts/slicc-extension.zip');
process.stdout.write(`Uploading ${zip.length} bytes to item ${itemId}\n`);

const uploadRes = await fetch(`https://chromewebstore.googleapis.com/v2/items/${itemId}`, {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/zip',
  },
  body: zip,
});
const uploadData = await uploadRes.json();
process.stdout.write(`Upload: ${JSON.stringify(uploadData)}\n`);
if (uploadData.uploadState === 'FAILURE') {
  process.exit(1);
}

let publishUrl = `https://chromewebstore.googleapis.com/v2/items/${itemId}:publish`;
if (deployPercentage) {
  publishUrl += `?deployPercentage=${encodeURIComponent(deployPercentage)}`;
}
const publishRes = await fetch(publishUrl, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const publishData = await publishRes.json();
process.stdout.write(`Publish: ${JSON.stringify(publishData)}\n`);
if (publishData.status?.includes('OK') || publishData.status?.includes('ITEM_PENDING_REVIEW')) {
  process.stdout.write('Published successfully\n');
} else {
  process.stderr.write('Publish failed or needs review\n');
  process.exit(1);
}
