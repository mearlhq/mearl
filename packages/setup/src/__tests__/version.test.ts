import { describe, expect, it } from 'vitest';
import {
  compareMearlReleaseLines,
  compareMearlReleaseVersions,
  isMearlReleaseLine,
  isMearlReleaseVersion,
  isMearlReleaseVersionInLine,
  mearlReleaseLineForVersion,
  parseMearlReleaseLine,
  parseMearlReleaseVersion,
} from '../version.js';

describe('Mearl release versions', () => {
  it.each(['0.0.0', '2.3.0', '2.4.0-beta.12'])('accepts the supported release form %s', version => {
    expect(isMearlReleaseVersion(version)).toBe(true);
  });

  it.each(['latest', '2.3', '02.3.0', '2.3.0-rc.1', '2.3.0;echo unsafe'])(
    'rejects an unsupported release form %s',
    version => {
      expect(parseMearlReleaseVersion(version)).toBeNull();
    },
  );

  it('derives and validates an npm-compatible release line', () => {
    expect(mearlReleaseLineForVersion('2.3.12')).toBe('2.3.x');
    expect(parseMearlReleaseLine('2.3.x')).toEqual({ raw: '2.3.x', major: 2, minor: 3 });
    expect(isMearlReleaseLine('2.3.12')).toBe(false);
    expect(isMearlReleaseVersionInLine('2.3.12', '2.3.x')).toBe(true);
    expect(isMearlReleaseVersionInLine('2.4.0', '2.3.x')).toBe(false);
  });

  it('compares compatibility by major and minor without requiring matching patches', () => {
    expect(compareMearlReleaseLines('2.3.1', '2.3.12')).toBe(0);
    expect(compareMearlReleaseLines('2.3.12', '2.4.0')).toBe(-1);
    expect(compareMearlReleaseLines('3.0.0', '2.9.99')).toBe(1);
  });

  it('orders complete release versions including beta releases', () => {
    expect(compareMearlReleaseVersions('2.8.0', '2.8.0')).toBe(0);
    expect(compareMearlReleaseVersions('2.8.0-beta.2', '2.8.0-beta.3')).toBe(-1);
    expect(compareMearlReleaseVersions('2.8.0-beta.3', '2.8.0')).toBe(-1);
    expect(compareMearlReleaseVersions('2.9.0', '2.8.99')).toBe(1);
  });
});

it('keeps beta setup on an exact release and preserves explicit release-line selection', async () => {
  const { mearlPackageSelector } = await import('../version.js');
  expect(mearlPackageSelector('3.0.0-beta.0')).toBe('3.0.0-beta.0');
  expect(mearlPackageSelector('3.0.0')).toBe('latest');
  expect(mearlPackageSelector('3.0.0-beta.0', '2.22.x')).toBe('2.22.x');
});
