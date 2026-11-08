import { describe, expect, it } from 'vitest';
import { APP_PROFILE_NAMES, appProfileRevision } from '@mearl/browser-core';
import { findAppProfileDefinitionUpdate, resolveAppProfileDefinition, resolveAppProfileUpdate, rebuildAppProfileConfig, updateAppProfileSetting } from '../index.js';
import { APP_PROFILES, resolveAppProfile } from './fixtures.js';
import { APP_PROFILES as defaults, listBuiltinAppProfiles, resolveAppProfile as resolveUnregisteredAppProfile } from '../index.js';

describe('installed profile compilation', () => {
  it('has no built-in App identities and requires an installed definition', () => {
    expect(defaults).toEqual({});
    expect(listBuiltinAppProfiles()).toEqual([]);
    for (const name of APP_PROFILE_NAMES)
      expect(() => resolveUnregisteredAppProfile(name)).toThrow('Install an App simulation capability');
  });

});

const definition = () => ({
  ...APP_PROFILES.reader, name: 'sample/app', label: 'Sample',
  uaTemplate: { ios: 'Sample/{v} iOS {language}', android: 'Sample/{v} {deviceModel}' },
  pageRuntime: { id: 'sample/main', sha256: 'a'.repeat(64) },
  settings: [{ id: 'count', label: 'Count', type: 'number' as const, target: { method: 'getCount', field: 'count' }, minimum: 0, maximum: 99 }],
  actions: { ...APP_PROFILES.reader.actions, responses: { getCount: { count: 3, retained: true } } },
});

describe('capability profile compilation', () => {
  it('copies the selected definition and binds its exact code revision', () => {
    const input = definition();
    const result = resolveAppProfileDefinition(input, { appVersion: '4', os: 'android', deviceModel: 'Device' });
    expect(result.ua).toBe('Sample/4 Device');
    expect(result.injected.pageRuntime).toEqual(input.pageRuntime);
    expect(result.injected.binding?.revision).toBe(appProfileRevision(input));
    input.actions.responses.getCount.count = 8;
    expect(result.injected.actions.responses?.getCount).toEqual({ count: 3, retained: true });
    expect(appProfileRevision({ ...input, pageRuntime: { ...input.pageRuntime, sha256: 'b'.repeat(64) } })).not.toBe(result.injected.binding?.revision);
  });
  it('passes runtime-owned options and behavior IDs through isolated profile copies', () => {
    const input = { ...definition(), runtimeOptions: { location: { api: 'example.location' } } };
    input.actions.behaviors = { locate: 'example:location.v2' };
    const compiled = resolveAppProfileDefinition(input).injected;
    expect(compiled.actions.behaviors).toEqual(input.actions.behaviors);
    expect(compiled.runtimeOptions).toEqual(input.runtimeOptions);
    input.runtimeOptions.location.api = 'changed';
    expect(compiled.runtimeOptions).toEqual({ location: { api: 'example.location' } });
  });
  it('retains explicit options, device layout and method settings across definition updates', () => {
    const first = resolveAppProfile('sample/app', { appVersion: '5', os: 'android' }, definition()).injected;
    const changed = updateAppProfileSetting(first, 'count', 7);
    expect(changed.config.actions.responses?.getCount).toEqual({ count: 7, retained: true });
    const updated = { ...definition(), defaultAppVersion: '8', pageRuntime: { id: 'sample/main', sha256: 'b'.repeat(64) } };
    const result = resolveAppProfileUpdate('sample/app', { current: changed.config, definition: updated, defaults: { appVersion: '6' } }).injected;
    expect(result.binding?.options.appVersion).toBe('5');
    expect(result.actions.responses?.getCount).toEqual({ count: 7, retained: true });
    const rebuilt = rebuildAppProfileConfig({ ...result, statusBarHeight: 62, simulateSystemBars: true }, { appVersion: '9' });
    expect(rebuilt.statusBarHeight).toBe(62);
    expect(rebuilt.simulateSystemBars).toBe(true);
    expect(rebuilt.pageRuntime?.sha256).toBe('b'.repeat(64));
    expect(rebuilt.userAgent).toContain('Sample/9');
  });
  it('retains host protocols for setting changes and captures new ones for a replacement definition', () => {
    const current = resolveAppProfileDefinition(definition()).injected;
    current.hostCapabilities = { modules: { protocol: { sha256: 'c'.repeat(64), revision: 'accepted', handlers: ['scope'] } }, bindings: { 'app.userInfo.scope': { module: 'protocol', handler: 'scope' } } };
    const changed = updateAppProfileSetting(current, 'count', 7).config;
    expect(changed.hostCapabilities).toEqual(current.hostCapabilities);
    expect(changed.hostCapabilities).not.toBe(current.hostCapabilities);
    expect(resolveAppProfileUpdate(current.profile, { current, options: { appVersion: '9' } }).injected.hostCapabilities).toEqual(current.hostCapabilities);
    expect(rebuildAppProfileConfig(current, {}, { ...definition(), defaultAppVersion: '9' }).hostCapabilities).toBeUndefined();
  });
  it('rejects invalid definitions, options and settings', () => {
    const input = definition();
    expect(() => resolveAppProfileDefinition({ ...input, pageRuntime: { ...input.pageRuntime, sha256: 'latest' } })).toThrow('pageRuntime');
    expect(() => resolveAppProfileDefinition(input, { appVersion: 'x\r\nInjected: yes' })).toThrow('appVersion');
    const current = resolveAppProfileDefinition(input).injected;
    expect(() => updateAppProfileSetting(current, 'count', 100)).toThrow('Invalid');
    expect(() => updateAppProfileSetting(current, 'unknown', 1)).toThrow('unavailable');
    expect(() => resolveAppProfile('unknown')).toThrow('Unknown app profile');
  });
});


it('does not compile business globals into basic UA profiles', () => {
  for (const profile of Object.keys(APP_PROFILES)) expect(resolveAppProfile(profile).injected.globals).toEqual({});
});

it('retains pinned full code when automatic discovery only finds a basic fallback', async () => {
  const full = { ...definition(), name: 'reader' };
  const current = resolveAppProfile('reader', {}, full).injected;
  await expect(findAppProfileDefinitionUpdate(current, async () => APP_PROFILES.reader)).resolves.toBeUndefined();
  const updated = { ...full, pageRuntime: { ...full.pageRuntime, sha256: 'b'.repeat(64) } };
  await expect(findAppProfileDefinitionUpdate(current, async () => updated)).resolves.toEqual(updated);
  expect(resolveAppProfileUpdate('reader', { current, definition: APP_PROFILES.reader }).injected.pageRuntime).toBeUndefined();
});
