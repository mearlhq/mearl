import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAppProfile } from '../../../../../app-profiles/src/__tests__/fixtures';

const quickSimulationMocks = vi.hoisted(() => ({
  clearQuickDeviceEmulation: vi.fn(),
  restoreQuickDeviceEmulationForTab: vi.fn(),
  setQuickAppSimulation: vi.fn(),
  setQuickDeviceEmulation: vi.fn(),
}));
const profileRuleMocks = vi.hoisted(() => ({ getAppProfileForTab: vi.fn() }));
const deviceStateMocks = vi.hoisted(() => ({
  getQuickDeviceSimulationState: vi.fn(),
  hydrateQuickDeviceSimulationState: vi.fn(),
}));

vi.mock('../quickDeviceEmulation', () => quickSimulationMocks);
vi.mock('../utils/appProfileRules', () => profileRuleMocks);
vi.mock('../quickDeviceSimulationState', () => deviceStateMocks);

import {
  applyQuickSimulationAutoRuleForTab,
  getQuickSimulationAutoRuleForTab,
  getQuickSimulationRootDomain,
  runQuickSimulationUpdateWithAutoRuleSync,
  setQuickAppSimulationWithAutoRuleSync,
  setQuickDeviceSimulationWithAutoRuleSync,
  setQuickSimulationAutoRuleForTab,
} from '../quickSimulationAutoRules';

const selection = {
  profile: 'reader',
  appVersion: '10.0.0',
  deviceSelection: {
    preset: 'iphone-17-pro',
    orientation: 'portrait',
    fitToWindow: true,
    deviceShell: true,
    splitScreen: true,
  },
} as const;

describe('quickSimulationAutoRules', () => {
  let stored: Record<string, unknown>;

  beforeEach(() => {
    stored = {};
    vi.clearAllMocks();
    chrome.storage.local.get = vi.fn(async () => ({ ...stored }));
    chrome.storage.local.set = vi.fn(async values => {
      Object.assign(stored, values);
    });
    chrome.tabs = {
      get: vi.fn().mockResolvedValue({
        id: 7,
        url: 'https://market.m.shop.com/app/trip/home',
      }),
    } as unknown as typeof chrome.tabs;
    quickSimulationMocks.restoreQuickDeviceEmulationForTab.mockResolvedValue(undefined);
    quickSimulationMocks.setQuickAppSimulation.mockResolvedValue({ success: true });
    quickSimulationMocks.setQuickDeviceEmulation.mockResolvedValue({
      success: true,
      active: true,
    });
    quickSimulationMocks.clearQuickDeviceEmulation.mockResolvedValue({
      success: true,
      active: false,
    });
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(undefined);
    deviceStateMocks.getQuickDeviceSimulationState.mockReturnValue(undefined);
    deviceStateMocks.hydrateQuickDeviceSimulationState.mockResolvedValue(undefined);
  });

  it('resolves root domains without collapsing local and IP hosts', () => {
    expect(getQuickSimulationRootDomain('https://market.m.shop.com/path')).toBe('shop.com');
    expect(getQuickSimulationRootDomain('https://a.example.co.uk/path')).toBe('example.co.uk');
    expect(getQuickSimulationRootDomain('http://localhost:3000/path')).toBe('localhost');
    expect(getQuickSimulationRootDomain('http://127.0.0.1/path')).toBe('127.0.0.1');
    expect(getQuickSimulationRootDomain('chrome://extensions')).toBeNull();
  });

  it('stores and removes one automatic selection for the current root domain', async () => {
    await expect(setQuickSimulationAutoRuleForTab(7, selection)).resolves.toMatchObject({
      domain: 'shop.com',
      ...selection,
    });
    await expect(getQuickSimulationAutoRuleForTab(7)).resolves.toMatchObject({
      domain: 'shop.com',
      rule: { domain: 'shop.com', ...selection },
    });

    await expect(setQuickSimulationAutoRuleForTab(7, null)).resolves.toBeUndefined();
    await expect(getQuickSimulationAutoRuleForTab(7)).resolves.toEqual({
      domain: 'shop.com',
      rule: undefined,
    });
  });

  it('normalizes an existing adaptive rule when reading storage', async () => {
    stored.quickSimulationAutoRules = {
      version: 1,
      rules: [
        {
          domain: 'shop.com',
          ...selection,
          deviceSelection: {
            preset: 'ios-adaptive',
            orientation: 'portrait',
            fitToWindow: true,
            deviceShell: true,
          },
        },
      ],
    };

    await expect(getQuickSimulationAutoRuleForTab(7)).resolves.toMatchObject({
      rule: { deviceSelection: { preset: 'ios-adaptive', fitToWindow: false } },
    });
  });

  it('applies the stored selection when a matching domain has no active simulation', async () => {
    await setQuickSimulationAutoRuleForTab(7, selection);

    await expect(
      applyQuickSimulationAutoRuleForTab(7, 'https://detail.m.shop.com/item.htm'),
    ).resolves.toMatchObject({ domain: 'shop.com' });

    expect(quickSimulationMocks.restoreQuickDeviceEmulationForTab).toHaveBeenCalledWith(7);
    expect(quickSimulationMocks.setQuickAppSimulation).toHaveBeenCalledWith({
      tabId: 7,
      ...selection,
      updateGlobalDefault: false,
    });
  });

  it('updates an enabled automatic rule before a manual App switch can reload the tab', async () => {
    await setQuickSimulationAutoRuleForTab(7, selection);
    quickSimulationMocks.setQuickAppSimulation.mockImplementation(async () => {
      await expect(getQuickSimulationAutoRuleForTab(7)).resolves.toMatchObject({
        rule: {
          profile: 'chat',
          deviceSelection: selection.deviceSelection,
        },
      });
      return { success: true };
    });

    await setQuickAppSimulationWithAutoRuleSync({
      tabId: 7,
      profile: 'chat',
      deviceSelection: selection.deviceSelection,
    });

    expect(quickSimulationMocks.setQuickAppSimulation).toHaveBeenCalledWith({
      tabId: 7,
      profile: 'chat',
      deviceSelection: selection.deviceSelection,
    });
    await expect(getQuickSimulationAutoRuleForTab(7)).resolves.toMatchObject({
      rule: { profile: 'chat' },
    });
  });

  it('removes an enabled automatic rule before manually disabling App simulation', async () => {
    await setQuickSimulationAutoRuleForTab(7, selection);
    quickSimulationMocks.setQuickAppSimulation.mockImplementation(async () => {
      await expect(getQuickSimulationAutoRuleForTab(7)).resolves.toMatchObject({
        rule: undefined,
      });
      return { success: true };
    });

    await setQuickAppSimulationWithAutoRuleSync({ tabId: 7, profile: null });

    expect(quickSimulationMocks.setQuickAppSimulation).toHaveBeenCalledWith({
      tabId: 7,
      profile: null,
    });
    await expect(getQuickSimulationAutoRuleForTab(7)).resolves.toMatchObject({
      rule: undefined,
    });
  });

  it('updates an enabled automatic rule before a manual device switch can reload the tab', async () => {
    await setQuickSimulationAutoRuleForTab(7, selection);
    const deviceSelection = {
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: true,
    } as const;
    const normalizedSelection = { ...deviceSelection, fitToWindow: false };
    quickSimulationMocks.setQuickDeviceEmulation.mockImplementation(async () => {
      await expect(getQuickSimulationAutoRuleForTab(7)).resolves.toMatchObject({
        rule: { deviceSelection: normalizedSelection },
      });
      return { success: true, active: true, ...normalizedSelection };
    });

    await setQuickDeviceSimulationWithAutoRuleSync({ tabId: 7, deviceSelection });

    expect(quickSimulationMocks.setQuickDeviceEmulation).toHaveBeenCalledWith({
      tabId: 7,
      ...normalizedSelection,
    });
  });

  it('normalizes an adaptive automatic rule so navigation does not reapply it forever', async () => {
    await setQuickSimulationAutoRuleForTab(7, {
      ...selection,
      deviceSelection: {
        preset: 'ios-adaptive',
        orientation: 'portrait',
        fitToWindow: true,
        deviceShell: true,
      },
    });
    profileRuleMocks.getAppProfileForTab.mockResolvedValue({
      profile: 'reader',
      platform: 'iOS',
      globals: {
        __APP_VERSION__: '10.0.0',
        __DEVICE_MODEL__: 'iPhone 17 Pro',
      },
    });
    deviceStateMocks.getQuickDeviceSimulationState.mockReturnValue({
      enabled: true,
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
      fixedFitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });

    await expect(getQuickSimulationAutoRuleForTab(7)).resolves.toMatchObject({
      rule: { deviceSelection: { preset: 'ios-adaptive', fitToWindow: false } },
    });
    await applyQuickSimulationAutoRuleForTab(7);

    expect(quickSimulationMocks.setQuickAppSimulation).not.toHaveBeenCalled();
  });

  it('removes an enabled automatic rule before manually disabling device simulation', async () => {
    await setQuickSimulationAutoRuleForTab(7, selection);
    quickSimulationMocks.clearQuickDeviceEmulation.mockImplementation(async () => {
      await expect(getQuickSimulationAutoRuleForTab(7)).resolves.toMatchObject({
        rule: undefined,
      });
      return { success: true, active: false };
    });

    await setQuickDeviceSimulationWithAutoRuleSync({ tabId: 7, deviceSelection: null });

    expect(quickSimulationMocks.clearQuickDeviceEmulation).toHaveBeenCalledWith(7, { clearUnownedDevice: true });
  });

  it('restores the previous automatic rule when a synchronized manual update fails', async () => {
    await setQuickSimulationAutoRuleForTab(7, selection);
    const failure = new Error('device switch failed');

    await expect(
      runQuickSimulationUpdateWithAutoRuleSync(
        7,
        current => ({
          profile: current.profile,
          appVersion: current.appVersion,
          deviceSelection: { ...current.deviceSelection, deviceShell: false },
        }),
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    await expect(getQuickSimulationAutoRuleForTab(7)).resolves.toMatchObject({
      rule: selection,
    });
  });

  it('does not reload a tab whose App and device already match the rule', async () => {
    await setQuickSimulationAutoRuleForTab(7, selection);
    profileRuleMocks.getAppProfileForTab.mockResolvedValue({
      profile: 'reader',
      platform: 'iOS',
      globals: {
        __APP_VERSION__: '10.0.0',
        __DEVICE_MODEL__: 'iPhone 17 Pro',
      },
    });
    deviceStateMocks.getQuickDeviceSimulationState.mockReturnValue({
      enabled: true,
      ...selection.deviceSelection,
    });

    await applyQuickSimulationAutoRuleForTab(7);

    expect(quickSimulationMocks.restoreQuickDeviceEmulationForTab).toHaveBeenCalledWith(7);
    expect(quickSimulationMocks.setQuickAppSimulation).not.toHaveBeenCalled();
  });
  it('keeps a matching basic UA profile across navigation without repeated reloads', async () => {
    await setQuickSimulationAutoRuleForTab(7, selection);
    const { injected } = resolveAppProfile('reader', { devicePreset: 'iphone-17-pro', appVersion: selection.appVersion });
    expect(injected.globals).toEqual({});
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(injected);
    deviceStateMocks.getQuickDeviceSimulationState.mockReturnValue({ enabled: true, ...selection.deviceSelection });
    await applyQuickSimulationAutoRuleForTab(7);
    await applyQuickSimulationAutoRuleForTab(7, 'https://market.m.shop.com/next');
    expect(quickSimulationMocks.setQuickAppSimulation).not.toHaveBeenCalled();
  });

});
