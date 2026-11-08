import { getExtensionVersion } from './extensionVersion';
const SETUP_MARKER_FILE = '.mearl-setup.json';

interface SetupMarker {
  extensionId?: unknown;
  path?: unknown;
  schemaVersion?: unknown;
}

export interface ExtensionInstallationInfo {
  extensionId: string;
  extensionVersion: string;
  setupManagedPath: string | null;
}

export async function getExtensionInstallationInfo(): Promise<ExtensionInstallationInfo> {
  let setupManagedPath: string | null = null;
  try {
    const response = await fetch(chrome.runtime.getURL(SETUP_MARKER_FILE), { cache: 'no-store' });
    if (response.ok) {
      const marker = (await response.json()) as SetupMarker;
      if (
        marker.schemaVersion === 1 &&
        marker.extensionId === chrome.runtime.id &&
        typeof marker.path === 'string' &&
        marker.path.length > 0
      ) {
        setupManagedPath = marker.path;
      }
    }
  } catch {
    // Packaged and store installations do not contain the setup marker.
  }

  return {
    extensionId: chrome.runtime.id,
    extensionVersion: getExtensionVersion(),
    setupManagedPath,
  };
}
