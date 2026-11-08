import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repositoryUrl } from './reference-docs.mjs';

interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{ name: string; browser_download_url: string }>;
}

const run = promisify(execFile);
const releasesPath = `repos${new URL(repositoryUrl).pathname}/releases`;
let download: Promise<{ version: string; url: string } | undefined> | undefined;

export function latestExtensionDownload() {
  return download ??= resolveDownload().catch(error => {
    console.warn('Could not resolve the offline Chrome extension ZIP:', error instanceof Error ? error.message.split('\n')[0] : error);
    return undefined;
  });
}

async function readReleases(path: string) {
  const token = process.env.GH_TOKEN;
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  if (response.ok) return response.json();
  if (response.status !== 404) throw new Error(`Could not read GitHub releases (HTTP ${response.status})`);
}

async function readCliReleases(path: string) {
  try {
    const { stdout } = await run('gh', ['api', path], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (error && typeof error === 'object' && 'stderr' in error && String(error.stderr).includes('(HTTP 404)')) return undefined;
    throw error;
  }
}

function extensionZip(release: Release | undefined) {
  if (!release || release.draft) return;
  const version = release.tag_name.slice(1);
  if (!/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(release.tag_name)) return;
  const name = `mearl-chrome-v${version}.zip`;
  const url = `${repositoryUrl}/releases/download/${release.tag_name}/${name}`;
  if (release.assets.some(asset => asset.name === name && asset.browser_download_url === url)) return { version, url };
}

async function resolveDownload() {
  const latestPath = `${releasesPath}/latest`;
  const listPath = `${releasesPath}?per_page=100`;
  const stable = extensionZip(await readReleases(latestPath));
  if (stable) return stable;

  let releases: Release[] | undefined = await readReleases(listPath);
  // A private repository returns 404 for anonymous requests. Local previews can reuse gh authentication.
  if (!releases && !process.env.GH_TOKEN) {
    const authenticatedStable = extensionZip(await readCliReleases(latestPath));
    if (authenticatedStable) return authenticatedStable;
    releases = await readCliReleases(listPath);
  }
  for (const release of releases ?? []) {
    if (!release.prerelease) continue;
    const zip = extensionZip(release);
    if (zip) return zip;
  }
}
