import { expect, it } from 'vitest';
import { extensionManifestVersion, readExtensionReleaseVersion } from '../extensionVersion.js';

it('keeps Chrome version ordering consistent with beta and stable releases', () => {
  const releases = ['3.0.0-beta.0', '3.0.0-beta.1', '3.0.0', '3.0.1-beta.0'];
  const versions = releases.map(release => extensionManifestVersion(release));
  expect(versions.map(value => value.version)).toEqual(['3.0.0.0', '3.0.0.1', '3.0.0.65535', '3.0.1.0']);
  expect(versions.map(readExtensionReleaseVersion)).toEqual(releases);
});

it('accepts old stable manifests and rejects forged names or unsupported numeric versions', () => {
  expect(readExtensionReleaseVersion({ version: '2.22.0' })).toBe('2.22.0');
  for (const value of [
    { version: '3.0.0.0', version_name: '3.0.0-beta.1' },
    { version: '2.22.0', version_name: '3.0.0-beta.0' },
    { version: '3.0.0-beta.0' }, { version: '3.0.0.0' }, { version: '65536.0.0' },
    { version: '3.0.0', version_name: 3 },
  ]) expect(readExtensionReleaseVersion(value)).toBeNull();
  for (const version of ['3.0.0-beta.65535', '65536.0.0', '3.0.0-beta.01', '3.0.0-rc.1']) {
    expect(() => extensionManifestVersion(version)).toThrow();
  }
});
