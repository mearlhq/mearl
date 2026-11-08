import { describe, expect, it, vi } from 'vitest';
import { qoderAuthenticationHint, resolveQoderPersonalAccessToken } from '../auth.js';

describe('Qoder authentication recovery', () => {
  it('offers local interactive Keychain configuration only on macOS', () => {
    expect(qoderAuthenticationHint('darwin')).toContain('security add-generic-password');
    for (const platform of ['linux', 'win32'] as const) {
      const hint = qoderAuthenticationHint(platform);
      expect(hint).toContain('MEARL_ENV_FILE > ~/.mearl/.env');
      expect(hint).not.toContain('Keychain');
      expect(hint).not.toContain('security add-generic-password');
    }
  });
});

describe('resolveQoderPersonalAccessToken', () => {
  it('prefers an explicit token and then the inherited environment', () => {
    const readFile = vi.fn(() => 'QODER_PERSONAL_ACCESS_TOKEN=file-token');

    expect(
      resolveQoderPersonalAccessToken({
        token: ' explicit-token ',
        env: { QODER_PERSONAL_ACCESS_TOKEN: 'env-token' },
        readFile,
        platform: 'linux',
      }),
    ).toBe('explicit-token');
    expect(readFile).not.toHaveBeenCalled();

    expect(
      resolveQoderPersonalAccessToken({
        env: { QODER_PERSONAL_ACCESS_TOKEN: ' env-token ' },
        readFile,
        platform: 'linux',
      }),
    ).toBe('env-token');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('reads the shared Mearl env file used by browser-launched processes', () => {
    const readFile = vi.fn((file: string) => {
      expect(file).toBe('/users/test/.mearl/.env');
      return 'EXAMPLE_CLOUD_KEY=other\nQODER_PERSONAL_ACCESS_TOKEN="file-token"\n';
    });

    expect(
      resolveQoderPersonalAccessToken({
        env: {},
        homeDirectory: '/users/test',
        readFile,
        platform: 'linux',
      }),
    ).toBe('file-token');
  });

  it('uses the configured macOS Keychain item as the final local fallback', () => {
    const readKeychainToken = vi.fn(() => ' keychain-token ');

    expect(
      resolveQoderPersonalAccessToken({
        env: {},
        homeDirectory: '/users/test',
        readFile: () => {
          throw new Error('missing');
        },
        platform: 'darwin',
        readKeychainToken,
      }),
    ).toBe('keychain-token');
    expect(readKeychainToken).toHaveBeenCalledOnce();
  });

  it('does not consult the macOS Keychain on other platforms', () => {
    const readKeychainToken = vi.fn(() => 'keychain-token');

    expect(
      resolveQoderPersonalAccessToken({
        env: {},
        homeDirectory: '/users/test',
        readFile: () => '',
        platform: 'win32',
        readKeychainToken,
      }),
    ).toBeUndefined();
    expect(readKeychainToken).not.toHaveBeenCalled();
  });
});
