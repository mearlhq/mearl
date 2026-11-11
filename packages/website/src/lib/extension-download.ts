import site from '@mearl/preset/installation-site.json';
import { repositoryUrl } from './reference-docs.mjs';

let download: Promise<{ version: string; url: string } | undefined> | undefined;

export function latestExtensionDownload() {
  return (download ??= resolveDownload().catch(error => {
    console.warn(
      'Could not resolve the offline Chrome extension ZIP:',
      error instanceof Error ? error.message.split('\n')[0] : error,
    );
    return undefined;
  }));
}

function extensionZip(version: unknown) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) {
    throw new Error('Invalid extension version');
  }
  return {
    version,
    url: `${repositoryUrl}/releases/download/v${version}/mearl-chrome-v${version}.zip`,
  };
}

async function resolveDownload() {
  // Release builds supply the published version before Pages has been refreshed.
  if (process.env.MEARL_EXTENSION_RELEASE_VERSION)
    return extensionZip(process.env.MEARL_EXTENSION_RELEASE_VERSION);

  const response = await fetch(new URL('config.json', site.url), {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok)
    throw new Error(`Could not read GitHub Pages configuration (HTTP ${response.status})`);
  const config = await response.json();
  const release = extensionZip(config?.latestVersion);
  if (config.downloadUrl !== release.url) throw new Error('Invalid extension download URL');
  return release;
}
