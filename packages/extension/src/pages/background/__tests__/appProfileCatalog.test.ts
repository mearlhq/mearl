import { APP_PROFILES } from '../../../../../app-profiles/src/__tests__/fixtures';
import { MAP_PROFILE_FIXTURE } from '../../../test/fixtures/appProfileSettings';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { appProfileRevision } from '@mearl/browser-core';
const native = vi.hoisted(() => ({ requestNativeHostOnce: vi.fn() }));
const browser = vi.hoisted(() => ({
  getBrowserAppProfile: vi.fn(),
  getBrowserAppProfileCatalog: vi.fn(),
  onChange: () => {},
  onBrowserPresetChange: vi.fn(),
}));
vi.mock('../nativeHostRequest', () => native);
vi.mock('../browserCapabilityRegistry', () => browser);
import { getAppProfileCatalog, resolveAvailableAppProfile } from '../appProfileCatalog';

beforeEach(() => {
  vi.clearAllMocks();
  browser.onChange();
  browser.onBrowserPresetChange.mockImplementation(listener => { browser.onChange = listener; return () => {}; });
  (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
  browser.getBrowserAppProfile.mockResolvedValue(undefined);
  browser.getBrowserAppProfileCatalog.mockResolvedValue({
    profiles: [],
    errors: [],
    bundleIds: [],
  });
});
describe('extension profile catalog', () => {
  it('does not share an in-flight Native lookup across preset selections', async () => {
    const firstEntry = { id: 'first/app', label: 'First', definition: { ...MAP_PROFILE_FIXTURE, name: 'first/app' }, plugin: 'first', available: true };
    const nextEntry = { id: 'next/app', label: 'Next', definition: { ...MAP_PROFILE_FIXTURE, name: 'next/app' }, plugin: 'next', available: true };
    browser.getBrowserAppProfileCatalog.mockResolvedValueOnce({ profiles: [firstEntry], bundleIds: ['first'], errors: [] }).mockResolvedValueOnce({ profiles: [nextEntry], bundleIds: ['next'], errors: [] });
    let finishFirst!: (value: unknown) => void, finishNext!: (value: unknown) => void;
    native.requestNativeHostOnce.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; })).mockImplementationOnce(() => new Promise(resolve => { finishNext = resolve; }));
    const first = getAppProfileCatalog();
    const rejected = expect(first).rejects.toThrow('selection changed');
    await vi.waitFor(() => expect(native.requestNativeHostOnce).toHaveBeenCalledOnce());
    browser.onChange();
    const next = getAppProfileCatalog();
    await vi.waitFor(() => expect(native.requestNativeHostOnce).toHaveBeenCalledTimes(2));
    finishFirst({ profiles: [], errors: [] });
    await rejected;
    const joined = getAppProfileCatalog();
    finishNext({ profiles: [], errors: [] });
    expect((await next).profiles).toEqual([nextEntry]);
    expect((await joined).profiles).toEqual([nextEntry]);
    expect(native.requestNativeHostOnce).toHaveBeenCalledTimes(2);
  });
  it('keeps cached offline definitions visible but prevents new activation', async () => {
    const definition = { ...MAP_PROFILE_FIXTURE, name: 'maps/sample' };
    const entry = {
      id: definition.name,
      label: definition.label,
      source: 'plugin',
      plugin: 'maps',
      revision: appProfileRevision(definition),
      definition,
    };
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({ appProfileCatalog: [entry] });
    native.requestNativeHostOnce.mockRejectedValue(new Error('offline'));
    const result = await getAppProfileCatalog();
    expect(result.offline).toBe(true);
    expect(result.profiles.find(profile => profile.id === entry.id)?.available).toBe(false);
    await expect(resolveAvailableAppProfile(entry.id)).rejects.toThrow('online registration');
  });
  it('does not offer or activate an App without an installed capability', async () => {
    native.requestNativeHostOnce.mockResolvedValue({ profiles: [], errors: [] });
    expect((await getAppProfileCatalog()).profiles).toEqual([]);
    await expect(resolveAvailableAppProfile('shop')).rejects.toThrow('unavailable');
  });
  it('activates a verified browser profile without an online registration or native call', async () => {
    const definition = { ...APP_PROFILES.reader, name: 'simulation/reader' };
    browser.getBrowserAppProfile.mockResolvedValue({ id: definition.name, definition });
    native.requestNativeHostOnce.mockRejectedValue(new Error('offline'));
    const resolved = await resolveAvailableAppProfile(definition.name, { appVersion: '10.0.9' });
    expect(resolved.profile).toBe(definition.name);
    expect(resolved.injected.binding?.definition).toEqual(definition);
    expect(native.requestNativeHostOnce).not.toHaveBeenCalled();
  });
  it('keeps browser profiles available when the native directory is offline', async () => {
    const definition = { ...MAP_PROFILE_FIXTURE, name: 'maps/sample' };
    const entry = { id: definition.name, definition, plugin: 'maps', available: true };
    browser.getBrowserAppProfileCatalog.mockResolvedValue({
      profiles: [entry],
      bundleIds: ['maps'],
      errors: [],
    });
    native.requestNativeHostOnce.mockRejectedValue(new Error('offline'));
    const result = await getAppProfileCatalog();
    expect(result.offline).toBe(true);
    expect(result.profiles.find(profile => profile.id === entry.id)?.available).toBe(true);
  });
  it('uses the explicitly installed browser namespace without mixing native definitions', async () => {
    const definition = { ...MAP_PROFILE_FIXTURE, name: 'maps/sample' };
    const browserEntry = { id: definition.name, definition, plugin: 'maps', available: true };
    browser.getBrowserAppProfileCatalog.mockResolvedValue({
      profiles: [browserEntry],
      bundleIds: ['maps'],
      errors: [],
    });
    const nativeDefinition = { ...definition, defaultAppVersion: '0.0.1' };
    native.requestNativeHostOnce.mockResolvedValue({
      profiles: [
        {
          id: definition.name,
          source: 'plugin',
          plugin: 'maps',
          definition: nativeDefinition,
          revision: appProfileRevision(nativeDefinition),
        },
      ],
    });
    const result = await getAppProfileCatalog();
    expect(result.profiles.filter(profile => profile.id === definition.name)).toEqual([
      browserEntry,
    ]);
  });
  it('does not silently fall back to a native profile when its browser installation is corrupt', async () => {
    browser.getBrowserAppProfile.mockRejectedValue(new Error('BUNDLE_INTEGRITY'));
    await expect(resolveAvailableAppProfile('maps/sample')).rejects.toThrow('BUNDLE_INTEGRITY');
    expect(native.requestNativeHostOnce).not.toHaveBeenCalled();
  });
  it('replaces the built-in implementation in its original catalog position and keeps its stable ID', async () => {
    const definition = { ...APP_PROFILES.reader, defaultAppVersion: '10.9.0' };
    const entry = { id: 'reader', definition, plugin: 'simulation', available: true };
    browser.getBrowserAppProfileCatalog.mockResolvedValue({
      profiles: [entry],
      boundAppIds: ['reader'],
      bundleIds: ['simulation'],
      errors: [],
    });
    browser.getBrowserAppProfile.mockResolvedValue(entry);
    native.requestNativeHostOnce.mockRejectedValue(new Error('offline'));
    const result = await getAppProfileCatalog();
    expect(result.profiles.filter(profile => profile.id === 'reader')).toEqual([entry]);
    expect(result.profiles[0]).toEqual(entry);
    const resolved = await resolveAvailableAppProfile('reader');
    expect(resolved.injected.binding?.definition).toEqual(definition);
    expect(resolved.profile).toBe('reader');
  });
  it('does not synthesize App entries for a broken preset', async () => {
    browser.getBrowserAppProfileCatalog.mockResolvedValue({
      profiles: [],
      bundleIds: [],
      errors: [{ plugin: '', error: 'corrupt' }],
      presetUnavailable: true,
    });
    native.requestNativeHostOnce.mockRejectedValue(new Error('offline'));
    expect((await getAppProfileCatalog()).profiles).toEqual([]);
    browser.getBrowserAppProfile.mockRejectedValue(new Error('BUNDLE_INTEGRITY'));
    await expect(resolveAvailableAppProfile('wallet')).rejects.toThrow('BUNDLE_INTEGRITY');
  });
  it('does not fall back to uninstalled Apps when a binding is corrupt', async () => {
    browser.getBrowserAppProfileCatalog.mockResolvedValue({
      profiles: [],
      bundleIds: ['simulation'],
      boundAppIds: ['reader'],
      errors: [{ plugin: 'simulation', error: 'corrupt' }],
      presetUnavailable: false,
    });
    native.requestNativeHostOnce.mockRejectedValue(new Error('offline'));
    const catalog = await getAppProfileCatalog();
    expect(catalog.profiles).toEqual([]);
    await expect(resolveAvailableAppProfile('shop')).rejects.toThrow('online registration');
  });
});

it('ignores Native aliases owned by the installed browser bundle before validating extra registrations', async () => {
  const definition = { ...APP_PROFILES.reader, name: 'reader' };
  const browserEntry = { id: 'reader', definition, plugin: 'simulation', available: true };
  browser.getBrowserAppProfileCatalog.mockResolvedValue({ profiles: [browserEntry], bundleIds: ['simulation'], boundAppIds: ['reader'], errors: [] });
  native.requestNativeHostOnce.mockResolvedValue({ profiles: [{ ...browserEntry, source: 'plugin', revision: appProfileRevision(definition) }], errors: [] });
  const result = await getAppProfileCatalog();
  expect(result.profiles.filter(profile => profile.id === 'reader')).toEqual([browserEntry]);
  expect(result.errors).toEqual([]);
  expect(result.offline).not.toBe(true);
});
