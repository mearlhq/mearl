import { describe, expect, it } from 'vitest';
import {
  compareReleaseVersions,
  getExtensionChangelogUrl,
  getRemoteExtensionRelease,
} from '../remoteConfig';

describe('remote extension release', () => {
  it('validates the version-bound archive URL and builds the changelog anchor', () => {
    expect(
      getRemoteExtensionRelease({
        latestVersion: '2.8.1',
        downloadUrl: 'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
        downloadSha256: 'A'.repeat(64),
      }),
    ).toEqual({
      archiveUrl: 'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
      changelogUrl: 'https://github.com/mearlhq/mearl/releases/tag/v2.8.1',
      sha256: 'a'.repeat(64),
      version: '2.8.1',
    });
  });

  it('rejects mismatched download URLs and malformed checksums', () => {
    expect(
      getRemoteExtensionRelease({
        latestVersion: '2.8.1',
        downloadUrl: 'https://example.com/mearl-chrome-v2.8.1.zip',
      }),
    ).toBeNull();
    expect(
      getRemoteExtensionRelease({
        latestVersion: '2.8.1',
        downloadUrl: 'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
        downloadSha256: 'invalid',
      }),
    ).toBeNull();
  });

  it('orders stable and beta releases', () => {
    expect(compareReleaseVersions('2.8.0', '2.8.0-beta.3')).toBeGreaterThan(0);
    expect(compareReleaseVersions('2.8.0-beta.2', '2.8.0-beta.3')).toBeLessThan(0);
    expect(compareReleaseVersions('2.8.1', '2.8.0')).toBeGreaterThan(0);
    expect(compareReleaseVersions('invalid', '2.8.0')).toBeNull();
  });

  it('builds changelog URLs only for supported release versions', () => {
    expect(getExtensionChangelogUrl('2.8.1')).toBe(
      'https://github.com/mearlhq/mearl/releases/tag/v2.8.1',
    );
    expect(getExtensionChangelogUrl('invalid')).toBeNull();
  });
});
