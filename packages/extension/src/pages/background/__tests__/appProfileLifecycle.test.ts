import { MAP_PROFILE_FIXTURE } from '../../../test/fixtures/appProfileSettings';
import { resolveAppProfile } from '../../../../../app-profiles/src/__tests__/fixtures';
import type { InjectedAppProfileConfig } from '@mearl/browser-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const rules = vi.hoisted(() => ({
  applyAppProfileForTab: vi.fn(),
  getAppProfileForTab: vi.fn(),
  clearAppProfileForTab: vi.fn(),
  appProfileOwnsDeviceEmulation: vi.fn(),
  getAppProfileDeviceEmulationForTab: vi.fn(),
  listAppProfileTabIds: vi.fn(),
}));
const debuggerMocks = vi.hoisted(() => ({
  enableAppProfileDocumentBootstrapForTab: vi.fn(),
  disableAppProfileDocumentBootstrapForTab: vi.fn(),
  prepareDeviceShellWebViewEnvironmentForTab: vi.fn(),
  clearDeviceShellWebViewEnvironmentForTab: vi.fn(),
}));
const catalog = vi.hoisted(() => ({ resolveAvailableAppProfile: vi.fn(), getAppProfileCatalog: vi.fn() }));
const runtime = vi.hoisted(() => ({ pinPageRuntimes: vi.fn() }));
vi.mock('../browserCapabilityRegistry', () => ({ browserCapabilityRegistry: () => runtime }));
vi.mock('../utils/appProfileRules', () => rules);
vi.mock('../debuggerManager', () => debuggerMocks);
vi.mock('../appProfileCatalog', () => catalog);
vi.mock('../deviceShellRules', () => ({ getDeviceShellForTab: vi.fn(async () => null) }));
import { refreshAppProfileForNavigation, removeUnavailableBasicAppProfiles } from '../appProfileLifecycle';
import { getDeviceShellForTab } from '../deviceShellRules';
import { runSerializedQuickSimulationUpdate } from '../quickSimulationUpdateQueue';

describe('unavailable UA-only bindings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    rules.listAppProfileTabIds.mockResolvedValue([7]);
    rules.getAppProfileForTab.mockResolvedValue(resolveAppProfile('reader').injected);
    catalog.getAppProfileCatalog.mockResolvedValue({ profiles: [], errors: [] });
    vi.mocked(getDeviceShellForTab).mockResolvedValue(null);
  });

  it('clears an orphaned App without disabling or reloading the device shell', async () => {
    const shell = { emulation: { userAgent: 'device UA' }, splitScreen: true };
    vi.mocked(getDeviceShellForTab).mockResolvedValue(shell as never);
    await removeUnavailableBasicAppProfiles();
    expect(rules.clearAppProfileForTab).toHaveBeenCalledWith(7);
    expect(debuggerMocks.disableAppProfileDocumentBootstrapForTab).toHaveBeenCalledWith(7);
    expect(debuggerMocks.prepareDeviceShellWebViewEnvironmentForTab).toHaveBeenCalledWith(7, shell.emulation, undefined, { splitScreen: true });
    expect(debuggerMocks.clearDeviceShellWebViewEnvironmentForTab).not.toHaveBeenCalled();
  });

  it('retains installed UA definitions and pinned complete runtimes', async () => {
    catalog.getAppProfileCatalog.mockResolvedValue({ profiles: [{ id: 'reader', available: false }], errors: [] });
    await removeUnavailableBasicAppProfiles();
    expect(rules.clearAppProfileForTab).not.toHaveBeenCalled();
    const full = resolveAppProfile('reader').injected;
    full.pageRuntime = { id: 'simulation/main', sha256: 'a'.repeat(64) };
    rules.getAppProfileForTab.mockResolvedValue(full);
    catalog.getAppProfileCatalog.mockClear();
    await removeUnavailableBasicAppProfiles();
    expect(catalog.getAppProfileCatalog).not.toHaveBeenCalled();
    expect(rules.clearAppProfileForTab).not.toHaveBeenCalled();
  });

  it('does not clear a profile changed during catalog discovery', async () => {
    rules.getAppProfileForTab.mockResolvedValueOnce(resolveAppProfile('reader').injected);
    rules.getAppProfileForTab.mockResolvedValue(resolveAppProfile('shop').injected);
    await removeUnavailableBasicAppProfiles();
    expect(rules.clearAppProfileForTab).not.toHaveBeenCalled();
  });

  it.each([
    { profiles: [], errors: [], offline: true },
    { profiles: [], errors: [{ plugin: 'simulation', error: 'unavailable' }] },
  ])('preserves bindings when catalog discovery cannot confirm absence: %j', async result => {
    catalog.getAppProfileCatalog.mockResolvedValue(result);
    await removeUnavailableBasicAppProfiles();
    expect(rules.clearAppProfileForTab).not.toHaveBeenCalled();
    expect(debuggerMocks.disableAppProfileDocumentBootstrapForTab).not.toHaveBeenCalled();
  });
});

describe('definition updates at a navigation boundary', () => {
  let current: InjectedAppProfileConfig;
  const definition = { ...MAP_PROFILE_FIXTURE, name: 'maps/sample' };
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.pinPageRuntimes.mockResolvedValue(undefined);
    current = resolveAppProfile(
      'maps/sample',
      { language: 'en', bridgeConfig: { methods: { probe: { response: false } } } },
      definition,
    ).injected;
    rules.getAppProfileForTab.mockImplementation(async () => current);
    rules.applyAppProfileForTab.mockImplementation(async (_tabId, config) => {
      current = config;
    });
    catalog.resolveAvailableAppProfile.mockResolvedValue(
      resolveAppProfile('maps/sample', {}, { ...definition, defaultAppVersion: '15.0' }),
    );
  });
  it('updates defaults and all injection environments while retaining explicit choices', async () => {
    const previous = current;
    const updated = await refreshAppProfileForNavigation(7);
    expect(updated?.globals.__APP_VERSION__).toBe('15.0');
    expect(updated?.language).toBe('en');
    expect(updated?.actions.responses?.probe).toBe(false);
    expect(previous.globals.__APP_VERSION__).toBe(definition.defaultAppVersion);
    expect(debuggerMocks.enableAppProfileDocumentBootstrapForTab).toHaveBeenCalledWith(7, updated);
    expect(current).toBe(updated);
  });
  it('keeps an unavailable or uninstalled definition and honors explicit locks', async () => {
    const previous = current;
    catalog.resolveAvailableAppProfile.mockRejectedValueOnce(new Error('offline'));
    await expect(refreshAppProfileForNavigation(7)).resolves.toBeUndefined();
    expect(current).toBe(previous);
    current = resolveAppProfile('maps/sample', { lockDefinition: true }, definition).injected;
    catalog.resolveAvailableAppProfile.mockClear();
    await expect(refreshAppProfileForNavigation(7)).resolves.toBeUndefined();
    expect(catalog.resolveAvailableAppProfile).not.toHaveBeenCalled();
  });
  it('does not queue behind the command whose reload is currently paused', async () => {
    await runSerializedQuickSimulationUpdate(7, async () => {
      await expect(refreshAppProfileForNavigation(7)).resolves.toBeUndefined();
    });
    expect(catalog.resolveAvailableAppProfile).not.toHaveBeenCalled();
  });
  it('restores the existing definition when installing an update fails', async () => {
    const previous = current;
    debuggerMocks.enableAppProfileDocumentBootstrapForTab.mockRejectedValueOnce(
      new Error('install failed'),
    );
    await expect(refreshAppProfileForNavigation(7)).rejects.toThrow('install failed');
    expect(current).toBe(previous);
    expect(debuggerMocks.enableAppProfileDocumentBootstrapForTab).toHaveBeenLastCalledWith(
      7,
      previous,
    );
  });
  it('keeps previous code referenced throughout a failed update and releases it after recovery', async () => {
    current = resolveAppProfile(
      'maps/sample',
      {},
      { ...definition, pageRuntime: { id: 'maps/main', sha256: 'a'.repeat(64) } },
    ).injected;
    current.hostCapabilities = { modules: { protocol: { sha256: 'c'.repeat(64), revision: 'accepted', handlers: ['scope'] } }, bindings: { 'app.userInfo.scope': { module: 'protocol', handler: 'scope' } } };
    const previous = current;
    catalog.resolveAvailableAppProfile.mockResolvedValueOnce(resolveAppProfile('maps/sample', {}, {
      ...definition, defaultAppVersion: '15.0', pageRuntime: { id: 'maps/main', sha256: 'b'.repeat(64) },
    }));
    debuggerMocks.enableAppProfileDocumentBootstrapForTab.mockImplementationOnce(async () => {
      const retained = runtime.pinPageRuntimes.mock.calls[0]?.[0];
      expect(Object.values(retained)).toEqual([previous.pageRuntime!.sha256, 'c'.repeat(64)]);
      expect(runtime.pinPageRuntimes).toHaveBeenCalledOnce();
      throw new Error('runtime setup failed');
    });
    await expect(refreshAppProfileForNavigation(7)).rejects.toThrow('runtime setup failed');
    expect(current).toBe(previous);
    const owner = Object.keys(runtime.pinPageRuntimes.mock.calls[0][0])[0];
    expect(runtime.pinPageRuntimes).toHaveBeenLastCalledWith({ [owner]: null, [`${owner}:host:protocol`]: null });
  });
});
