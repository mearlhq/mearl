import { execFileSync } from 'node:child_process';
import { sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readExtensionReleaseVersion } from '../packages/browser-core/src/extensionVersion.ts';
import { verifyRelease } from './ci-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tokenUrl = 'https://oauth2.googleapis.com/token';
const storeUrl = 'https://chromewebstore.googleapis.com';
const scope = 'https://www.googleapis.com/auth/chromewebstore';

export async function serviceAccessToken(credentialsJson, { readonly = false } = {}) {
  let credentials;
  try {
    credentials = JSON.parse(credentialsJson);
  } catch {
    throw new Error('Configure a valid CHROME_WEBSTORE_SERVICE_ACCOUNT_JSON secret.');
  }
  if (credentials?.type !== 'service_account' || !credentials.client_email || !credentials.private_key || credentials.token_uri !== tokenUrl) {
    throw new Error('Invalid Chrome Web Store service account credentials.');
  }

  const iat = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claim = [
    encode({ alg: 'RS256', typ: 'JWT' }),
    encode({ iss: credentials.client_email, scope: readonly ? scope + '.readonly' : scope, aud: tokenUrl, iat, exp: iat + 3600 }),
  ].join('.');
  const signature = sign('RSA-SHA256', Buffer.from(claim), credentials.private_key).toString('base64url');
  const response = await fetch(tokenUrl, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: claim + '.' + signature }),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Google service account authentication failed (HTTP ${response.status}).`);
  const { access_token: token } = await response.json();
  if (!token) throw new Error('Google did not return an access token.');
  return token;
}

export function storeRequest(publisherId, extensionId, token) {
  if (!/^[a-zA-Z0-9-]+$/.test(publisherId ?? '') || !/^[a-p]{32}$/.test(extensionId ?? '')) {
    throw new Error('Configure CHROME_WEBSTORE_PUBLISHER_ID and a valid extension ID.');
  }
  return async (action, body) => {
    const upload = action === 'upload';
    const url = `${storeUrl}/${upload ? 'upload/' : ''}v2/publishers/${publisherId}/items/${extensionId}:${action}`;
    const options = {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(upload ? 120_000 : 30_000),
      redirect: 'error',
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = upload ? 'application/zip' : 'application/json';
      options.body = upload ? body : JSON.stringify(body);
    }
    const response = await fetch(url, options).catch(() => {
      throw new Error(`Chrome Web Store ${action} did not return a response. Check the Developer Dashboard before retrying.`);
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(`Chrome Web Store ${action} failed (HTTP ${response.status}): ${result.error?.message ?? response.statusText}`);
    }
    return response.json();
  };
}

function compareVersions(left, right) {
  const parts = version => {
    if (!/^\d+(?:\.\d+){0,3}$/.test(version)) throw new Error('Invalid Chrome Web Store version.');
    return version.split('.').map(Number);
  };
  const a = parts(left), b = parts(right);
  for (let index = 0; index < 4; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export async function submitReview(request, bytes, version, wait = delay) {
  const current = await request('fetchStatus');
  const published = current.publishedItemRevisionStatus?.distributionChannels ?? [];
  if (published.some(channel => compareVersions(version, channel.crxVersion) < 0)) {
    throw new Error('A newer extension version is already published.');
  }
  if (published.some(channel => compareVersions(version, channel.crxVersion) === 0)) return 'PUBLISHED';

  const submitted = current.submittedItemRevisionStatus;
  if (['PENDING_REVIEW', 'STAGED'].includes(submitted?.state)) {
    if (submitted.state === 'PENDING_REVIEW' && submitted.distributionChannels?.some(channel => channel.crxVersion === version)) {
      return submitted.state;
    }
    throw new Error(`An extension submission is ${submitted.state}. Check the Developer Dashboard before uploading.`);
  }
  if (current.lastAsyncUploadState === 'IN_PROGRESS') {
    throw new Error('A Chrome Web Store upload is already in progress.');
  }

  const upload = await request('upload', bytes);
  let uploadState = upload.uploadState;
  const deadline = Date.now() + 120_000;
  while (uploadState === 'IN_PROGRESS' && Date.now() < deadline) {
    await wait(2000);
    uploadState = (await request('fetchStatus')).lastAsyncUploadState;
  }
  if (uploadState !== 'SUCCEEDED') {
    throw new Error(`Chrome Web Store upload is ${uploadState ?? 'unknown'}. Check the Developer Dashboard before retrying.`);
  }
  if (upload.crxVersion && upload.crxVersion !== version) {
    throw new Error(`Chrome Web Store received version ${upload.crxVersion} instead of ${version}.`);
  }
  const { state } = await request('publish', { publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true });
  if (!['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(state)) {
    throw new Error(`Chrome Web Store returned submission state ${state ?? 'unknown'}.`);
  }
  return state;
}

export function storeZipVersion(manifest, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || readExtensionReleaseVersion(manifest) !== version) {
    throw new Error('The extension ZIP must match the stable release version.');
  }
  if (manifest.host_permissions?.includes('<all_urls>')) {
    throw new Error('The Chrome Web Store ZIP must retain the build’s host permission allowlist.');
  }
  return manifest.version;
}

async function main(artifacts, env) {
  const { release } = await verifyRelease(root, artifacts, 'stable', env);
  const filename = `mearl-chrome-v${release.version}.zip`;
  if (!release.assets.some(item => item.file === filename)) throw new Error('The verified extension ZIP is missing.');
  const archive = resolve(artifacts, filename);
  const manifest = JSON.parse(execFileSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' }));
  const version = storeZipVersion(manifest, release.version);
  const { extensionId } = JSON.parse(await readFile(resolve(root, 'packages/preset/installation-site.json'), 'utf8'));
  const token = await serviceAccessToken(env.CHROME_WEBSTORE_SERVICE_ACCOUNT_JSON);
  const request = storeRequest(env.CHROME_WEBSTORE_PUBLISHER_ID, extensionId, token);
  const state = await submitReview(request, await readFile(archive), version);
  console.log(`Chrome Web Store version ${version}: ${state}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2], process.env).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
