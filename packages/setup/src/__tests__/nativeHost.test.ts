import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveNativeHostDirectory, uninstallNativeHostArtifacts } from '../nativeHost.js';

describe('resolveNativeHostDirectory', () => {
  it('resolves supported per-platform locations', () => {
    expect(
      resolveNativeHostDirectory({
        homedir: () => '/Users/test',
        platform: 'darwin',
      }),
    ).toBe('/Users/test/Library/Application Support/Google/Chrome/NativeMessagingHosts');
    expect(
      resolveNativeHostDirectory({
        homedir: () => '/home/test',
        platform: 'linux',
      }),
    ).toBe('/home/test/.config/google-chrome/NativeMessagingHosts');
  });
});

describe('uninstallNativeHostArtifacts', () => {
  it('removes both Unix manifest and launcher pairs', () => {
    const hostDir = '/host';
    const artifacts = new Set([
      path.join(hostDir, 'ai.mearl.skills.json'),
      path.join(hostDir, 'ai.mearl.skills-launcher.sh'),
      path.join(hostDir, 'ai.mearl.mcp.json'),
      path.join(hostDir, 'ai.mearl.mcp-launcher.sh'),
    ]);
    const unlinkSync = vi.fn((artifact: string) => artifacts.delete(artifact));

    expect(
      uninstallNativeHostArtifacts(
        { mode: 'both', silent: true },
        {
          existsSync: artifact => artifacts.has(artifact),
          hostDir,
          platform: 'linux',
          unlinkSync,
        },
      ),
    ).toBe(true);

    expect(unlinkSync).toHaveBeenCalledTimes(4);
    expect(artifacts.size).toBe(0);
  });

  it('removes the Windows registry key even when files are already absent', () => {
    const unregisterWindowsNativeHost = vi.fn();

    expect(
      uninstallNativeHostArtifacts(
        { mode: 'mcp', silent: true },
        {
          existsSync: () => false,
          hostDir: 'C:\\hosts',
          platform: 'win32',
          unregisterWindowsNativeHost,
        },
      ),
    ).toBe(true);

    expect(unregisterWindowsNativeHost).toHaveBeenCalledWith('ai.mearl.mcp');
  });
});
