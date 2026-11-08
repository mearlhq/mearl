import { afterEach, describe, expect, it, vi } from 'vitest';
import { getExtensionInstallationInfo } from '../extensionInstallation';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getExtensionInstallationInfo', () => {
  it('returns the setup-managed path from the marker bundled with an unpacked install', async () => {
    Object.assign(chrome.runtime, {
      getURL: vi.fn((file: string) => `chrome-extension://test-extension-id/${file}`),
      id: 'test-extension-id',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              extensionId: 'test-extension-id',
              path: '/home/test/.mearl/chrome-extension',
              schemaVersion: 1,
            }),
          ),
      ),
    );

    await expect(getExtensionInstallationInfo()).resolves.toEqual({
      extensionId: 'test-extension-id',
      extensionVersion: '2.0.0',
      setupManagedPath: '/home/test/.mearl/chrome-extension',
    });
  });

  it('does not identify a store install without the setup marker', async () => {
    Object.assign(chrome.runtime, {
      getURL: vi.fn((file: string) => `chrome-extension://test-extension-id/${file}`),
      id: 'test-extension-id',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    );

    await expect(getExtensionInstallationInfo()).resolves.toMatchObject({
      setupManagedPath: null,
    });
  });
});
