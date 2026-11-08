import { describe, expect, it } from 'vitest';
import {
  parseInstallationConfig,
  validateInstallationOrigin,
  matchesInstallationOrigin,
  trustedInstallationPreset,
  installationOriginCovered,
} from '../installation.js';
const publicOrigin = 'https://public.example.test';
const guide = { url: 'https://guide.example.test/installed.html' };
const preset = {
  label: 'Team',
  source: 'https://assets.example.test/presets/team.json',
  origins: ['*://*.example.test/*'],
};
describe('installation catalog', () => {
  it('keeps a public-only default and validates catalog sources independently of the guide', () => {
    expect(parseInstallationConfig({ schemaVersion: 1 }, publicOrigin)).toEqual({
      schemaVersion: 1,
    });
    expect(
      parseInstallationConfig({ schemaVersion: 1, guide, presets: { team: preset } }, publicOrigin)
        .presets?.team,
    ).toEqual({ ...preset, origins: ['https://assets.example.test/*', '*://*.example.test/*'] });
  });
  it.each([
    { label: '', source: preset.source, origins: [] },
    { ...preset, source: 'javascript:alert(1)' },
    { ...preset, source: 'https://user:secret@assets.example.test/preset.json' },
    { ...preset, source: 'https://assets.example.test/preset.json#script' },
    { ...preset, command: 'exec' },
    { ...preset, origins: ['<all_urls>'] },
    { ...preset, origins: ['https://*/*'] },
    { ...preset, origins: ['https://example.test/path/*'] },
    { ...preset, origins: ['https://user:secret@example.test/*'] },
  ])('rejects executable, unbounded or ambiguous catalog input %j', entry => {
    expect(() =>
      parseInstallationConfig({ schemaVersion: 1, guide, presets: { team: entry } }, publicOrigin),
    ).toThrow();
  });
  it('does not accept a catalog without a guide or an invalid preset identity', () => {
    expect(() =>
      parseInstallationConfig({ schemaVersion: 1, presets: { team: preset } }, publicOrigin),
    ).toThrow();
    expect(() =>
      parseInstallationConfig(
        { schemaVersion: 1, guide, presets: { '../team': preset } },
        publicOrigin,
      ),
    ).toThrow();
  });
  it('bounds the number of presets and declared host scopes', () => {
    expect(() =>
      parseInstallationConfig(
        {
          schemaVersion: 1,
          guide,
          presets: Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [`team${index}`, preset]),
          ),
        },
        publicOrigin,
      ),
    ).toThrow();
    expect(() =>
      parseInstallationConfig(
        {
          schemaVersion: 1,
          guide,
          presets: {
            team: {
              ...preset,
              origins: Array.from(
                { length: 64 },
                (_, index) => `https://host${index}.example.test/*`,
              ),
            },
          },
        },
        publicOrigin,
      ),
    ).toThrow();
  });
  it('retains explicit HTTP and wildcard schemes used by existing website capabilities', () => {
    expect(validateInstallationOrigin('*://*.Example.test/*')).toBe('*://*.example.test/*');
    expect(validateInstallationOrigin('http://legacy.example.test/*')).toBe(
      'http://legacy.example.test/*',
    );
    expect(validateInstallationOrigin('https://example.test/*')).toBe('https://example.test/*');
  });
});

it('matches resource schemes, whole host boundaries and declared ports', () => {
  expect(
    matchesInstallationOrigin('http://*.example.test/*', new URL('https://a.example.test/file')),
  ).toBe(false);
  expect(
    matchesInstallationOrigin('*://*.example.test/*', new URL('https://example.test:8443/file')),
  ).toBe(true);
  expect(
    matchesInstallationOrigin(
      'https://*.example.test/*',
      new URL('https://example.test.attacker.test/file'),
    ),
  ).toBe(false);
  expect(
    matchesInstallationOrigin(
      'https://example.test:8443/*',
      new URL('https://example.test:8444/file'),
    ),
  ).toBe(false);
  expect(
    matchesInstallationOrigin(
      'https://example.test:8443/*',
      new URL('https://example.test:8443/file'),
    ),
  ).toBe(true);
});

it('trusts the catalog identity and exact source rather than names or host suffixes', () => {
  const config = parseInstallationConfig(
    { schemaVersion: 1, guide, presets: { team: preset } },
    publicOrigin,
  );
  expect(trustedInstallationPreset(config, 'team', preset.source)).toBeDefined();
  expect(
    trustedInstallationPreset(config, 'team', 'https://assets.example.test/other.json'),
  ).toBeUndefined();
  expect(trustedInstallationPreset(config, '__proto__', preset.source)).toBeUndefined();
  expect(
    installationOriginCovered('https://*.child.example.test/*', ['*://*.example.test/*']),
  ).toBe(true);
  expect(installationOriginCovered('*://*.example.test/*', ['https://*.example.test/*'])).toBe(
    false,
  );
  expect(installationOriginCovered('https://*.example.test/*', ['https://example.test/*'])).toBe(
    false,
  );
  expect(
    installationOriginCovered('https://example.test:8444/*', ['https://example.test:8443/*']),
  ).toBe(false);
  expect(
    installationOriginCovered('https://example.test.attacker.test/*', ['https://*.example.test/*']),
  ).toBe(false);
});
