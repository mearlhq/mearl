import { readExtensionReleaseVersion } from '@mearl/browser-core';

export function getExtensionVersion(): string {
  const manifest = chrome.runtime.getManifest();
  return readExtensionReleaseVersion(manifest) ?? manifest.version;
}

export function setupCommand(version = getExtensionVersion()): string {
  return `npx @mearl/setup${version.includes('-beta.') ? '@beta' : ''}`;
}
