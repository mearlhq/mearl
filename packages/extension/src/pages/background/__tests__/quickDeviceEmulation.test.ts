vi.mock('../appProfileCatalog', () => ({ resolveAvailableAppProfile: async (...args: Parameters<typeof import('../../../../../app-profiles/src/__tests__/fixtures').resolveAppProfile>) => (await import('../../../../../app-profiles/src/__tests__/fixtures')).resolveAppProfile(...args) }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveEmulationConfig } from '@mearl/browser-core';
import { resolveAppProfile } from '../../../../../app-profiles/src/__tests__/fixtures';

const appProfileHandlerMocks = vi.hoisted(() => ({ handleSetAppProfile: vi.fn() }));
const deviceHandlerMocks = vi.hoisted(() => ({ handleSetDeviceEmulation: vi.fn() }));
const debuggerManagerMocks = vi.hoisted(() => ({
  clearDeviceShellWebViewEnvironmentForTab: vi.fn(),
  disableEmulationForTab: vi.fn(),
  disableSafeAreaInsetsForTab: vi.fn(),
  enableEmulationForTab: vi.fn(),
  getSafeAreaInsetsForTab: vi.fn(),
  prepareDeviceShellWebViewEnvironmentForTab: vi.fn(),
  reapplySafeAreaInsetsForTab: vi.fn(),
  reloadTabInSession: vi.fn().mockResolvedValue(undefined),
  releaseSafeAreaInsetsOwnershipForTab: vi.fn(),
  updateDeviceFrameViewportForTab: vi.fn().mockResolvedValue(undefined),
}));
const deviceStateMocks = vi.hoisted(() => ({
  getEmulationConfigForTab: vi.fn(),
  getEmulationFitToWindowForTab: vi.fn(),
  setEmulationFitToWindowForTab: vi.fn(),
}));
const profileRuleMocks = vi.hoisted(() => ({ getAppProfileForTab: vi.fn() }));
const deviceShellRuleMocks = vi.hoisted(() => ({
  applyDeviceShellForTab: vi.fn(),
  clearDeviceShellForTab: vi.fn(),
  getDeviceShellForTab: vi.fn(),
  inheritsDeviceViewport: vi.fn(
    (config: unknown) =>
      typeof config === 'object' &&
      config !== null &&
      'viewport' in config &&
      config.viewport === 'inherit',
  ),
}));

vi.mock('../agentHandlers/appProfileHandlers', () => appProfileHandlerMocks);
vi.mock('../agentHandlers/emulationHandlers', () => deviceHandlerMocks);
vi.mock('../debuggerManager', () => debuggerManagerMocks);
vi.mock('../deviceEmulationState', () => deviceStateMocks);
vi.mock('../utils/appProfileRules', () => profileRuleMocks);
vi.mock('../deviceShellRules', () => deviceShellRuleMocks);

import {
  calculateFitToWindowScale,
  clearQuickDeviceEmulation,
  getQuickDeviceEmulationState,
  getQuickDeviceEmulationStateWithGlobalDefault,
  handleSetAppSimulation,
  refreshQuickDeviceFitToWindowForWindow,
  restoreQuickDeviceEmulationForTab,
  setQuickAppSimulation,
  setQuickDeviceEmulation,
  setQuickDevicePhoneFrame,
} from '../quickDeviceEmulation';
import {
  getQuickDeviceChromeConfig,
  getQuickDevicePresetModel,
  getQuickDevicePresetOs,
} from '../../../shared/quickAppProfile';
import {
  deleteQuickDeviceSimulationState,
  getQuickDeviceSimulationState,
  setQuickDeviceSimulationState,
} from '../quickDeviceSimulationState';

const appProfile = (
  platform: 'iOS' | 'Android',
  deviceModel?: string,
  preset: 'iphone-17-pro' | 'pixel-11' | 'pura-x-max' = platform === 'Android'
    ? 'pixel-11'
    : 'iphone-17-pro',
  orientation: 'portrait' | 'landscape' = 'portrait',
) => {
  const deviceChrome = getQuickDeviceChromeConfig(preset, orientation);
  return {
    profile: 'reader',
    platform,
    globals: {
      __APP_VERSION__: '10.0.0',
      __DEVICE_MODEL__: deviceModel ?? (platform === 'Android' ? 'Pixel 11' : 'iPhone 17 Pro'),
    },
    deviceAppearance: {
      preset,
      orientation,
      cutout: preset === 'iphone-17-pro' && orientation === 'portrait' ? 'dynamic-island' : 'none',
    },
    statusBarHeight: deviceChrome.statusBarHeight,
    safeAreaInsets: deviceChrome.safeAreaInsets,
    externalDeviceChrome: false,
    simulateSystemBars: false,
  } as never;
};

const emulation = (
  presetName: 'iphone-17-pro' | 'pixel-11' | 'galaxy-s26' | 'pura-x-max',
  orientation: 'portrait' | 'landscape',
) => ({ presetName, orientation });

const seedQuickDevice = (
  preset: 'iphone-17-pro' | 'pixel-11' | 'pura-x-max',
  orientation: 'portrait' | 'landscape',
  fitToWindow = false,
) => {
  setQuickDeviceSimulationState(7, { preset, orientation, fitToWindow });
};

describe('quick device emulation', () => {
  beforeEach(async () => {
    await deleteQuickDeviceSimulationState(7);
    vi.clearAllMocks();
    appProfileHandlerMocks.handleSetAppProfile.mockResolvedValue({
      enabled: true,
      reloaded: false,
    });
    deviceHandlerMocks.handleSetDeviceEmulation.mockResolvedValue({
      enabled: true,
      reloaded: true,
    });
    debuggerManagerMocks.enableEmulationForTab.mockResolvedValue(undefined);
    debuggerManagerMocks.clearDeviceShellWebViewEnvironmentForTab.mockResolvedValue(undefined);
    debuggerManagerMocks.disableEmulationForTab.mockResolvedValue(undefined);
    debuggerManagerMocks.disableSafeAreaInsetsForTab.mockResolvedValue(undefined);
    debuggerManagerMocks.prepareDeviceShellWebViewEnvironmentForTab.mockResolvedValue(undefined);
    debuggerManagerMocks.reapplySafeAreaInsetsForTab.mockResolvedValue(undefined);
    debuggerManagerMocks.getSafeAreaInsetsForTab.mockReturnValue(undefined);
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(undefined);
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(undefined);
    deviceStateMocks.getEmulationFitToWindowForTab.mockReturnValue(false);
    deviceShellRuleMocks.applyDeviceShellForTab.mockResolvedValue(undefined);
    deviceShellRuleMocks.clearDeviceShellForTab.mockResolvedValue(false);
    deviceShellRuleMocks.getDeviceShellForTab.mockResolvedValue(null);
    chrome.tabs = {
      get: vi.fn().mockResolvedValue({ id: 7, width: 1200, height: 1000 }),
      query: vi.fn().mockResolvedValue([]),
      reload: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof chrome.tabs;
    chrome.storage.local.get = vi.fn().mockResolvedValue({});
    chrome.storage.local.set = vi.fn().mockResolvedValue(undefined);
  });

  it('disables the phone frame without removing system bars or reloading the WebView', async () => {
    const emulation = resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' });
    const systemBars = getQuickDeviceChromeConfig('iphone-17-pro', 'portrait');
    let config = { ...systemBars, phoneFrame: { width: emulation.width, height: emulation.height } };
    deviceShellRuleMocks.getDeviceShellForTab.mockImplementation(async () => ({
      config, emulation, splitScreen: false,
    }));
    deviceShellRuleMocks.applyDeviceShellForTab.mockImplementation(async (_tabId, next) => {
      config = next;
    });
    expect(await setQuickDevicePhoneFrame(7, false)).toMatchObject({
      active: true, deviceShell: true, phoneFrame: false,
    });
    expect(deviceShellRuleMocks.applyDeviceShellForTab).toHaveBeenCalledWith(7, systemBars, emulation);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ quickDevicePhoneFrame: false });
    expect(debuggerManagerMocks.reloadTabInSession).not.toHaveBeenCalled();
    expect(deviceShellRuleMocks.clearDeviceShellForTab).not.toHaveBeenCalled();
  });

  it('calculates a bounded, non-upscaling fit-to-window scale', () => {
    expect(calculateFitToWindowScale(400, 800, 300, 500)).toBe(0.62);
    expect(calculateFitToWindowScale(400, 800, 1200, 1000)).toBe(1);
    expect(calculateFitToWindowScale(400, 800, 10, 10)).toBe(0.1);
    expect(calculateFitToWindowScale(400, 800, undefined, 500)).toBe(1);
  });

  it('maps Apple presets to iOS and Android presets to Android', () => {
    expect(getQuickDeviceChromeConfig('ios-adaptive')).toEqual({
      platform: 'ios',
      statusBarHeight: 62,
      bottomBarHeight: 34,
      safeAreaInsets: { top: 62, right: 0, bottom: 34, left: 0 },
      cutout: 'dynamic-island',
    });
    expect(getQuickDeviceChromeConfig('android-adaptive')).toEqual({
      platform: 'android',
      statusBarHeight: 30,
      bottomBarHeight: 24,
      safeAreaInsets: { top: 30, right: 0, bottom: 24, left: 0 },
      cutout: 'none',
    });
    expect(getQuickDevicePresetOs('iphone-17-pro')).toBe('ios');
    expect(getQuickDevicePresetOs('iphone-17e')).toBe('ios');
    expect(getQuickDevicePresetOs('ipad-mini-a17-pro')).toBe('ios');
    expect(getQuickDevicePresetOs('pixel-11')).toBe('android');
    expect(getQuickDevicePresetOs('galaxy-s26')).toBe('android');
    expect(getQuickDevicePresetOs('pura-x-max')).toBe('android');
    expect(getQuickDevicePresetModel('iphone-17-pro')).toBe('iPhone 17 Pro');
    expect(getQuickDevicePresetModel('iphone-17e')).toBe('iPhone 17e');
    expect(getQuickDevicePresetModel('ipad-mini-a17-pro')).toBe('iPad mini (A17 Pro)');
    expect(getQuickDevicePresetModel('pixel-11')).toBe('Pixel 11');
    expect(getQuickDevicePresetModel('galaxy-s26')).toBe('SM-S942B');
    expect(getQuickDevicePresetModel('pura-x-max')).toBe('HUAWEI Pura X Max');
    expect(getQuickDevicePresetModel('ios-adaptive')).toBe('iPhone 17 Pro');
    expect(getQuickDevicePresetModel('android-adaptive')).toBe('Pixel 11');
  });

  it('enables iOS adaptive device chrome when the client switch has no device history', async () => {
    await setQuickAppSimulation({ tabId: 7, profile: 'reader' });

    expect(appProfileHandlerMocks.handleSetAppProfile).toHaveBeenCalledWith(
      {
        tabId: 7,
        enabled: true,
        profile: 'reader',
        os: 'ios',
        deviceModel: 'iPhone 17 Pro',
        reload: false,
      },
      expect.any(Function),
    );
    expect(getQuickDeviceEmulationState(7)).toMatchObject({
      active: true,
      preset: 'ios-adaptive',
      deviceShell: true,
    });
  });

  it('uses the device selection displayed by the client switch on a new tab', async () => {
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(
      emulation('iphone-17-pro', 'portrait'),
    );

    await setQuickAppSimulation({
      tabId: 7,
      profile: 'reader',
      deviceSelection: {
        preset: 'iphone-17-pro',
        orientation: 'portrait',
        fitToWindow: true,
        deviceShell: true,
      },
    });

    expect(deviceHandlerMocks.handleSetDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 7,
        enabled: true,
        preset: 'iphone-17-pro',
        orientation: 'portrait',
        deviceShell: true,
      }),
      expect.any(Function),
      expect.objectContaining({ preserveQuickDeviceOwnership: true }),
    );
    expect(getQuickDeviceEmulationState(7)).toMatchObject({
      active: true,
      preset: 'iphone-17-pro',
      orientation: 'portrait',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
  });

  it('applies a fixed device viewport before enabling the App profile', async () => {
    const order: string[] = [];
    debuggerManagerMocks.enableEmulationForTab.mockImplementation(async () => {
      order.push('device');
    });
    appProfileHandlerMocks.handleSetAppProfile.mockImplementation(async () => {
      order.push('app');
      return { enabled: true, reloaded: false };
    });
    deviceHandlerMocks.handleSetDeviceEmulation.mockImplementation(async () => {
      order.push('reload');
      return { enabled: true, reloaded: true };
    });

    await setQuickAppSimulation({
      tabId: 7,
      profile: 'shop',
      deviceSelection: {
        preset: 'iphone-17-pro',
        orientation: 'portrait',
        fitToWindow: true,
        deviceShell: true,
      },
    });

    expect(order).toEqual(['device', 'app', 'reload']);
    expect(debuggerManagerMocks.enableEmulationForTab).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        presetName: 'iphone-17-pro',
        width: 402,
        height: 874,
      }),
    );
  });

  it('switches the App with one reload and keeps an unchanged phone frame', async () => {
    const device = resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' });
    const selection = { preset: 'iphone-17-pro', orientation: 'portrait', fitToWindow: true, deviceShell: true } as const;
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(device);
    deviceStateMocks.getEmulationFitToWindowForTab.mockReturnValue(true);
    deviceShellRuleMocks.getDeviceShellForTab.mockResolvedValue({
      config: { ...getQuickDeviceChromeConfig(selection.preset), phoneFrame: { width: device.width, height: device.height } },
      emulation: device,
      splitScreen: false,
    });
    appProfileHandlerMocks.handleSetAppProfile.mockResolvedValue({ enabled: true, reloaded: true });

    const result = await setQuickAppSimulation({ tabId: 7, profile: 'shop', deviceSelection: selection });

    expect(appProfileHandlerMocks.handleSetAppProfile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tabId: 7, profile: 'shop', reload: true }), expect.any(Function),
    );
    expect(debuggerManagerMocks.enableEmulationForTab).not.toHaveBeenCalled();
    expect(deviceHandlerMocks.handleSetDeviceEmulation).not.toHaveBeenCalled();
    expect(result).toMatchObject({ profile: 'shop', reloaded: true, device: { ...selection, active: true, phoneFrame: true } });
  });

  it('remembers the selected App profile after the client switch is disabled', async () => {
    const stored: Record<string, unknown> = {};
    chrome.storage.local.get = vi.fn(async key => ({
      [key as string]: stored[key as string],
    }));
    chrome.storage.local.set = vi.fn(async values => {
      Object.assign(stored, values);
    });
    await setQuickAppSimulation({ tabId: 7, profile: 'chat' });

    expect(getQuickDeviceSimulationState(7)?.lastAppProfile).toBe('chat');
    vi.mocked(chrome.storage.local.set).mockClear();

    await setQuickAppSimulation({ tabId: 7, profile: null });

    expect(getQuickDeviceSimulationState(7)).toMatchObject({
      enabled: false,
      lastAppProfile: 'chat',
    });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('keeps set_app_profile bridge-only when emulation is omitted', async () => {
    await handleSetAppSimulation({ tabId: 7, enabled: true, profile: 'reader' }, () => null);

    expect(appProfileHandlerMocks.handleSetAppProfile).toHaveBeenCalledOnce();
    expect(deviceHandlerMocks.handleSetDeviceEmulation).not.toHaveBeenCalled();
  });

  it('applies App and device state in one set_app_profile call when emulation is present', async () => {
    await handleSetAppSimulation(
      {
        tabId: 7,
        enabled: true,
        profile: 'reader',
        emulation: {
          preset: 'pixel-11',
          orientation: 'landscape',
          deviceShell: true,
          splitScreen: true,
        },
      },
      () => null,
    );

    expect(appProfileHandlerMocks.handleSetAppProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 7,
        enabled: true,
        profile: 'reader',
        os: 'android',
        deviceModel: 'Pixel 11',
        reload: false,
      }),
      expect.any(Function),
    );
    expect(deviceHandlerMocks.handleSetDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 7,
        enabled: true,
        preset: 'pixel-11',
        orientation: 'landscape',
        deviceShell: true,
        splitScreen: true,
      }),
      expect.any(Function),
    );
  });

  it('keeps landscape safe areas separate from the visible status bar height', () => {
    expect(getQuickDeviceChromeConfig('iphone-17-pro', 'landscape')).toEqual({
      platform: 'ios',
      statusBarHeight: 24,
      bottomBarHeight: 21,
      safeAreaInsets: { top: 0, right: 62, bottom: 21, left: 62 },
      cutout: 'none',
    });
  });

  it('uses a side rail except when the unfolded Duo is in portrait', () => {
    expect(getQuickDeviceChromeConfig('iphone-duo-folded')).toMatchObject({
      statusBarHeight: 0,
      sideBarWidth: 84,
      safeAreaInsets: { top: 0, right: 84, bottom: 34, left: 0 },
      cutout: 'side-camera',
    });
    expect(getQuickDeviceChromeConfig('iphone-duo-folded', 'landscape')).toMatchObject({
      statusBarHeight: 0,
      sideBarWidth: 84,
      safeAreaInsets: { top: 0, right: 84, bottom: 21, left: 0 },
      cutout: 'none',
    });
    expect(getQuickDeviceChromeConfig('iphone-duo-unfolded', 'landscape')).toMatchObject({
      statusBarHeight: 0,
      sideBarWidth: 84,
      safeAreaInsets: { top: 0, right: 84, bottom: 34, left: 0 },
      cutout: 'none',
    });
    expect(getQuickDeviceChromeConfig('iphone-duo-unfolded', 'portrait')).toMatchObject({
      statusBarHeight: 80,
      safeAreaInsets: { top: 80, right: 0, bottom: 34, left: 0 },
      cutout: 'none',
    });
    expect(
      getQuickDeviceChromeConfig('iphone-duo-unfolded', 'portrait').sideBarWidth,
    ).toBeUndefined();
  });

  it('returns the active preset and orientation', () => {
    seedQuickDevice('pixel-11', 'landscape', true);
    deviceStateMocks.getEmulationFitToWindowForTab.mockReturnValue(true);
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(emulation('pixel-11', 'landscape'));

    expect(getQuickDeviceEmulationState(7)).toEqual({
      success: true,
      active: true,
      preset: 'pixel-11',
      orientation: 'landscape',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
  });

  it('does not claim a generic fixed emulation as a Quick Settings device', () => {
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(emulation('pixel-11', 'portrait'));

    expect(getQuickDeviceEmulationState(7)).toEqual({
      success: true,
      active: false,
      preset: null,
    });
  });

  it('shows the global device default on an inactive tab without enabling it', async () => {
    const stored: Record<string, unknown> = {};
    chrome.storage.local.get = vi.fn(async key => ({
      [key as string]: stored[key as string],
    }));
    chrome.storage.local.set = vi.fn(async values => {
      Object.assign(stored, values);
    });
    await setQuickDeviceSimulationState(7, {
      preset: 'iphone-duo-unfolded',
      orientation: 'landscape',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: true,
    });
    const inactiveTabId = 8;

    const response = await getQuickDeviceEmulationStateWithGlobalDefault(inactiveTabId);

    expect(response).toEqual({
      success: true,
      active: false,
      preset: 'iphone-duo-unfolded',
      orientation: 'landscape',
      fitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
    expect(getQuickDeviceSimulationState(inactiveTabId)).toBeUndefined();
    await deleteQuickDeviceSimulationState(inactiveTabId);
  });

  it('applies a preset directly when no App profile is active', async () => {
    deviceStateMocks.getEmulationConfigForTab
      .mockReturnValueOnce(undefined)
      .mockReturnValue(emulation('iphone-17-pro', 'portrait'));

    await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'iphone-17-pro',
      orientation: 'portrait',
    });

    expect(appProfileHandlerMocks.handleSetAppProfile).not.toHaveBeenCalled();
    expect(deviceHandlerMocks.handleSetDeviceEmulation).toHaveBeenCalledWith(
      {
        tabId: 7,
        enabled: true,
        preset: 'iphone-17-pro',
        orientation: 'portrait',
        scale: 1,
        deviceShell: true,
      },
      expect.any(Function),
      expect.objectContaining({ preserveQuickDeviceOwnership: true }),
    );
    expect(deviceStateMocks.setEmulationFitToWindowForTab).toHaveBeenCalledWith(7, true);
  });

  it('passes the fitted visual scale without changing the selected device', async () => {
    chrome.tabs.get = vi.fn().mockResolvedValue({ id: 7, width: 300, height: 500 });
    deviceStateMocks.getEmulationConfigForTab
      .mockReturnValueOnce(undefined)
      .mockReturnValue(emulation('pixel-11', 'portrait'));

    await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'pixel-11',
      orientation: 'portrait',
      fitToWindow: true,
    });

    expect(deviceHandlerMocks.handleSetDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 7,
        enabled: true,
        preset: 'pixel-11',
        orientation: 'portrait',
        scale: 0.54,
        deviceShell: true,
      }),
      expect.any(Function),
      expect.objectContaining({ preserveQuickDeviceOwnership: true }),
    );
    expect(deviceStateMocks.setEmulationFitToWindowForTab).toHaveBeenCalledWith(7, true);
  });

  it('keeps scale at one and records the disabled fit preference', async () => {
    deviceStateMocks.getEmulationConfigForTab
      .mockReturnValueOnce(undefined)
      .mockReturnValue(emulation('pixel-11', 'portrait'));

    await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'pixel-11',
      orientation: 'portrait',
      fitToWindow: false,
    });

    expect(deviceHandlerMocks.handleSetDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({ scale: 1 }),
      expect.any(Function),
      expect.objectContaining({ preserveQuickDeviceOwnership: true }),
    );
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(deviceStateMocks.setEmulationFitToWindowForTab).toHaveBeenCalledWith(7, false);
  });

  it('keeps App bridge injection unchanged when only the device orientation changes', async () => {
    seedQuickDevice('pixel-11', 'portrait');
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(appProfile('Android', 'Pixel 11'));
    deviceStateMocks.getEmulationConfigForTab
      .mockReturnValueOnce(emulation('pixel-11', 'portrait'))
      .mockReturnValueOnce(emulation('pixel-11', 'portrait'))
      .mockReturnValue(emulation('pixel-11', 'landscape'));

    await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'pixel-11',
      orientation: 'landscape',
    });

    expect(appProfileHandlerMocks.handleSetAppProfile).not.toHaveBeenCalled();
    expect(deviceHandlerMocks.handleSetDeviceEmulation).toHaveBeenCalledWith(
      {
        tabId: 7,
        enabled: true,
        preset: 'pixel-11',
        orientation: 'landscape',
        scale: 1,
        deviceShell: true,
        splitScreen: false,
        reload: false,
      },
      expect.any(Function),
      expect.objectContaining({ preserveQuickDeviceOwnership: true }),
    );
  });

  it('switches between devices in the same document environment without reloading', async () => {
    seedQuickDevice('pixel-11', 'portrait');
    deviceStateMocks.getEmulationConfigForTab
      .mockReturnValueOnce(emulation('pixel-11', 'portrait'))
      .mockReturnValueOnce(emulation('pixel-11', 'portrait'))
      .mockReturnValue(emulation('galaxy-s26', 'portrait'));

    await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'galaxy-s26',
      orientation: 'portrait',
    });

    expect(deviceHandlerMocks.handleSetDeviceEmulation).toHaveBeenCalledWith(
      {
        tabId: 7,
        enabled: true,
        preset: 'galaxy-s26',
        orientation: 'portrait',
        scale: 1,
        deviceShell: true,
        reload: false,
      },
      expect.any(Function),
      expect.objectContaining({ preserveQuickDeviceOwnership: true }),
    );
  });

  it('keeps a matching App appearance when only the fit scale changes', async () => {
    seedQuickDevice('pixel-11', 'portrait', true);
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(appProfile('Android', 'Pixel 11'));
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(emulation('pixel-11', 'portrait'));

    await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'pixel-11',
      orientation: 'portrait',
      fitToWindow: false,
    });

    expect(appProfileHandlerMocks.handleSetAppProfile).not.toHaveBeenCalled();
    expect(deviceHandlerMocks.handleSetDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({ reload: false, scale: 1 }),
      expect.any(Function),
      expect.objectContaining({ preserveQuickDeviceOwnership: true }),
    );
  });

  it('updates an iOS App profile before switching to an Android device', async () => {
    seedQuickDevice('iphone-17-pro', 'portrait');
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(appProfile('iOS'));
    deviceStateMocks.getEmulationConfigForTab
      .mockReturnValueOnce(emulation('iphone-17-pro', 'portrait'))
      .mockReturnValue(emulation('pixel-11', 'landscape'));

    const response = await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'pixel-11',
      orientation: 'landscape',
    });

    expect(appProfileHandlerMocks.handleSetAppProfile).toHaveBeenCalledWith(
      {
        tabId: 7,
        enabled: true,
        profile: 'reader',
        reload: false,
      },
      expect.any(Function),
      expect.objectContaining({ deviceOptions: { os: 'android', deviceModel: 'Pixel 11' } }),
    );
    expect(deviceHandlerMocks.handleSetDeviceEmulation).toHaveBeenCalledWith(
      {
        tabId: 7,
        enabled: true,
        preset: 'pixel-11',
        orientation: 'landscape',
        scale: 1,
        deviceShell: true,
        splitScreen: false,
      },
      expect.any(Function),
      expect.objectContaining({ preserveQuickDeviceOwnership: true }),
    );
    expect(response).toMatchObject({
      success: true,
      active: true,
      preset: 'pixel-11',
      orientation: 'landscape',
    });
  });

  it('updates the active Android App model when switching devices on the same platform', async () => {
    seedQuickDevice('pixel-11', 'portrait');
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(appProfile('Android', 'Pixel 11'));
    deviceStateMocks.getEmulationConfigForTab
      .mockReturnValueOnce(emulation('pixel-11', 'portrait'))
      .mockReturnValue(emulation('pura-x-max', 'portrait'));

    await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'pura-x-max',
      orientation: 'portrait',
    });

    expect(appProfileHandlerMocks.handleSetAppProfile).toHaveBeenCalledWith(
      {
        tabId: 7,
        enabled: true,
        profile: 'reader',
        reload: false,
      },
      expect.any(Function),
      expect.objectContaining({
        deviceOptions: { os: 'android', deviceModel: 'HUAWEI Pura X Max' },
      }),
    );
    expect(deviceHandlerMocks.handleSetDeviceEmulation).toHaveBeenCalledWith(
      {
        tabId: 7,
        enabled: true,
        preset: 'pura-x-max',
        orientation: 'portrait',
        scale: 1,
        deviceShell: true,
      },
      expect.any(Function),
      expect.objectContaining({ preserveQuickDeviceOwnership: true }),
    );
  });

  it('restores the previous App profile when a cross-platform device update fails', async () => {
    seedQuickDevice('iphone-17-pro', 'portrait');
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(appProfile('iOS'));
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(
      emulation('iphone-17-pro', 'portrait'),
    );
    deviceHandlerMocks.handleSetDeviceEmulation.mockRejectedValue(new Error('failed'));

    await expect(
      setQuickDeviceEmulation({
        tabId: 7,
        preset: 'pixel-11',
        orientation: 'portrait',
      }),
    ).rejects.toThrow('failed');

    expect(appProfileHandlerMocks.handleSetAppProfile).toHaveBeenLastCalledWith(
      {
        tabId: 7,
        enabled: true,
        profile: 'reader',
        reload: true,
      },
      expect.any(Function),
      expect.objectContaining({ deviceOptions: { os: 'ios', deviceModel: 'iPhone 17 Pro' } }),
    );
  });

  it('restores the previous Android App model when a same-platform device update fails', async () => {
    seedQuickDevice('pixel-11', 'portrait');
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(appProfile('Android', 'Pixel 11'));
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(emulation('pixel-11', 'portrait'));
    deviceHandlerMocks.handleSetDeviceEmulation.mockRejectedValue(new Error('failed'));

    await expect(
      setQuickDeviceEmulation({
        tabId: 7,
        preset: 'pura-x-max',
        orientation: 'portrait',
      }),
    ).rejects.toThrow('failed');

    expect(appProfileHandlerMocks.handleSetAppProfile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({}),
      expect.any(Function),
      expect.objectContaining({
        deviceOptions: { os: 'android', deviceModel: 'HUAWEI Pura X Max' },
      }),
    );
    expect(appProfileHandlerMocks.handleSetAppProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({}),
      expect.any(Function),
      expect.objectContaining({ deviceOptions: { os: 'android', deviceModel: 'Pixel 11' } }),
    );
  });

  it('enables adaptive iOS chrome without applying fixed viewport emulation', async () => {
    const response = await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: true,
    });

    expect(response).toEqual({
      success: true,
      active: true,
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
      fixedFitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
    expect(deviceHandlerMocks.handleSetDeviceEmulation).not.toHaveBeenCalled();
    expect(debuggerManagerMocks.reapplySafeAreaInsetsForTab).toHaveBeenCalledWith(7, {
      top: 62,
      right: 0,
      bottom: 34,
      left: 0,
    });
    expect(deviceStateMocks.setEmulationFitToWindowForTab).not.toHaveBeenCalled();
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(deviceShellRuleMocks.applyDeviceShellForTab).toHaveBeenCalledWith(
      7,
      getQuickDeviceChromeConfig('ios-adaptive', 'portrait'),
      expect.objectContaining({
        viewport: 'inherit',
        platform: 'iPhone',
        safeAreaInsets: { top: 62, right: 0, bottom: 34, left: 0 },
        appearance: { cutout: 'dynamic-island' },
      }),
      {},
    );
    expect(debuggerManagerMocks.prepareDeviceShellWebViewEnvironmentForTab).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ viewport: 'inherit', platform: 'iPhone' }),
      undefined,
    );
    const adaptiveEnvironment = deviceShellRuleMocks.applyDeviceShellForTab.mock.calls[0]?.[2];
    expect(adaptiveEnvironment).not.toHaveProperty('width');
    expect(adaptiveEnvironment).not.toHaveProperty('height');
    expect(adaptiveEnvironment).not.toHaveProperty('deviceScaleFactor');
    expect(debuggerManagerMocks.reloadTabInSession).toHaveBeenCalledWith(7);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      action: 'quickDeviceChromeUpdate',
      config: getQuickDeviceChromeConfig('ios-adaptive', 'portrait'),
    });
  });

  it('switches from adaptive iOS to an iPhone viewport without reloading', async () => {
    setQuickDeviceSimulationState(7, {
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
    });
    deviceStateMocks.getEmulationConfigForTab
      .mockReturnValueOnce(undefined)
      .mockReturnValue(emulation('iphone-17-pro', 'portrait'));

    await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'iphone-17-pro',
      orientation: 'portrait',
      fitToWindow: false,
    });

    expect(deviceHandlerMocks.handleSetDeviceEmulation).toHaveBeenCalledWith(
      {
        tabId: 7,
        enabled: true,
        preset: 'iphone-17-pro',
        orientation: 'portrait',
        scale: 1,
        deviceShell: true,
        reload: false,
      },
      expect.any(Function),
      expect.objectContaining({ preserveQuickDeviceOwnership: true }),
    );
    expect(debuggerManagerMocks.releaseSafeAreaInsetsOwnershipForTab).toHaveBeenCalledWith(7);
  });

  it('enables adaptive split screen independently of the stored orientation', async () => {
    const response = await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'ios-adaptive',
      orientation: 'portrait',
      splitScreen: true,
    });

    expect(response).toMatchObject({
      active: true,
      preset: 'ios-adaptive',
      orientation: 'portrait',
      splitScreen: true,
    });
    expect(deviceShellRuleMocks.applyDeviceShellForTab).toHaveBeenCalledWith(
      7,
      getQuickDeviceChromeConfig('ios-adaptive', 'portrait'),
      expect.objectContaining({ viewport: 'inherit' }),
      { splitScreen: true },
    );
  });

  it('keeps an iPhone 17 client unchanged when switching to adaptive iOS', async () => {
    seedQuickDevice('iphone-17-pro', 'portrait');
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(appProfile('iOS'));
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(
      emulation('iphone-17-pro', 'portrait'),
    );

    await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'ios-adaptive',
      orientation: 'portrait',
    });

    expect(appProfileHandlerMocks.handleSetAppProfile).not.toHaveBeenCalled();
    expect(debuggerManagerMocks.disableEmulationForTab).toHaveBeenCalledWith(7);
    expect(debuggerManagerMocks.reapplySafeAreaInsetsForTab).toHaveBeenCalledWith(7, {
      top: 62,
      right: 0,
      bottom: 34,
      left: 0,
    });
  });

  it('clears fixed metrics when switching from a device preset to adaptive Android', async () => {
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(emulation('pixel-11', 'portrait'));

    await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'android-adaptive',
      orientation: 'portrait',
    });

    expect(debuggerManagerMocks.disableEmulationForTab).toHaveBeenCalledWith(7);
    expect(getQuickDeviceEmulationState(7)).toMatchObject({
      active: true,
      preset: 'android-adaptive',
      fitToWindow: false,
    });
    expect(debuggerManagerMocks.reapplySafeAreaInsetsForTab).toHaveBeenCalledWith(7, {
      top: 30,
      right: 0,
      bottom: 24,
      left: 0,
    });
    expect(deviceShellRuleMocks.applyDeviceShellForTab).toHaveBeenCalledWith(
      7,
      getQuickDeviceChromeConfig('android-adaptive', 'portrait'),
      expect.objectContaining({
        viewport: 'inherit',
        platform: 'Android',
        safeAreaInsets: { top: 30, right: 0, bottom: 24, left: 0 },
        appearance: { cutout: 'none' },
      }),
      {},
    );
  });

  it('updates an active client for adaptive device chrome without enabling device metrics', async () => {
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(appProfile('iOS'));

    await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'android-adaptive',
      orientation: 'portrait',
    });

    expect(appProfileHandlerMocks.handleSetAppProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        profile: 'reader',
        reload: true,
      }),
      expect.any(Function),
      expect.objectContaining({ deviceOptions: { os: 'android', deviceModel: 'Pixel 11' } }),
    );
    expect(appProfileHandlerMocks.handleSetAppProfile.mock.calls[0]?.[0]).not.toHaveProperty(
      'emulation',
    );
    expect(deviceHandlerMocks.handleSetDeviceEmulation).not.toHaveBeenCalled();
  });

  it('disables adaptive chrome while remembering it and leaving device metrics untouched', async () => {
    await setQuickDeviceEmulation({
      tabId: 7,
      preset: 'ios-adaptive',
      orientation: 'portrait',
    });

    const response = await clearQuickDeviceEmulation(7);

    expect(response).toEqual({
      success: true,
      active: false,
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
      fixedFitToWindow: true,
      deviceShell: true,
      splitScreen: false,
    });
    expect(deviceHandlerMocks.handleSetDeviceEmulation).not.toHaveBeenCalled();
    expect(debuggerManagerMocks.disableSafeAreaInsetsForTab).toHaveBeenCalledWith(7);
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(7, {
      action: 'quickDeviceChromeUpdate',
      config: null,
    });
  });

  it('restores fixed device metrics from the remembered Quick selection', async () => {
    seedQuickDevice('pixel-11', 'landscape', true);
    deviceStateMocks.getEmulationConfigForTab
      .mockReturnValueOnce(undefined)
      .mockReturnValue(emulation('pixel-11', 'landscape'));

    await restoreQuickDeviceEmulationForTab(7);

    expect(deviceHandlerMocks.handleSetDeviceEmulation).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 7,
        enabled: true,
        preset: 'pixel-11',
        orientation: 'landscape',
        reload: false,
      }),
      expect.any(Function),
      expect.objectContaining({ preserveQuickDeviceOwnership: true }),
    );
    expect(getQuickDeviceEmulationState(7)).toMatchObject({
      active: true,
      preset: 'pixel-11',
    });
  });

  it('restores adaptive safe-area state only when its CDP lease is absent', async () => {
    setQuickDeviceSimulationState(7, {
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
    });

    await restoreQuickDeviceEmulationForTab(7);
    debuggerManagerMocks.getSafeAreaInsetsForTab.mockReturnValue({
      top: 62,
      right: 0,
      bottom: 34,
      left: 0,
    });
    await restoreQuickDeviceEmulationForTab(7);

    expect(debuggerManagerMocks.reapplySafeAreaInsetsForTab).toHaveBeenCalledTimes(1);
    expect(debuggerManagerMocks.reapplySafeAreaInsetsForTab).toHaveBeenCalledWith(7, {
      top: 62,
      right: 0,
      bottom: 34,
      left: 0,
    });
  });

  it('migrates an active adaptive shell that still overrides the viewport', async () => {
    setQuickDeviceSimulationState(7, {
      preset: 'ios-adaptive',
      orientation: 'portrait',
      fitToWindow: false,
    });
    deviceShellRuleMocks.getDeviceShellForTab.mockResolvedValue({
      config: getQuickDeviceChromeConfig('ios-adaptive', 'portrait'),
      emulation: { width: 1200, height: 1000 },
    });

    await restoreQuickDeviceEmulationForTab(7);

    expect(deviceShellRuleMocks.applyDeviceShellForTab).toHaveBeenCalledWith(
      7,
      getQuickDeviceChromeConfig('ios-adaptive', 'portrait'),
      expect.objectContaining({ viewport: 'inherit', platform: 'iPhone' }),
      {},
    );
    expect(debuggerManagerMocks.prepareDeviceShellWebViewEnvironmentForTab).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ viewport: 'inherit', platform: 'iPhone' }),
      undefined,
    );
    const adaptiveEnvironment = deviceShellRuleMocks.applyDeviceShellForTab.mock.calls[0]?.[2];
    expect(adaptiveEnvironment).not.toHaveProperty('width');
    expect(adaptiveEnvironment).not.toHaveProperty('height');
    expect(adaptiveEnvironment).not.toHaveProperty('deviceScaleFactor');
  });

  it('refits active opted-in presets after their window changes size', async () => {
    chrome.tabs.query = vi.fn().mockResolvedValue([{ id: 7 }, { id: 8 }]);
    chrome.tabs.get = vi.fn().mockResolvedValue({ id: 7, width: 300, height: 500 });
    deviceStateMocks.getEmulationFitToWindowForTab.mockImplementation(
      (tabId: number) => tabId === 7,
    );
    deviceStateMocks.getEmulationConfigForTab.mockImplementation((tabId: number) =>
      tabId === 7
        ? ({
            ...emulation('pixel-11', 'portrait'),
            width: 412,
            height: 923,
            scale: 1,
          } as never)
        : undefined,
    );

    await refreshQuickDeviceFitToWindowForWindow(3);

    expect(chrome.tabs.query).toHaveBeenCalledWith({ windowId: 3 });
    expect(debuggerManagerMocks.enableEmulationForTab).toHaveBeenCalledWith(7, {
      width: 412,
      height: 923,
      presetName: 'pixel-11',
      orientation: 'portrait',
      scale: 0.54,
    });
    expect(deviceHandlerMocks.handleSetDeviceEmulation).not.toHaveBeenCalled();
    expect(appProfileHandlerMocks.handleSetAppProfile).not.toHaveBeenCalled();
    expect(deviceStateMocks.setEmulationFitToWindowForTab).toHaveBeenCalledWith(7, true);
  });
  it('uses binding identity for a basic UA profile without reapplying it on device changes', async () => {
    const { injected } = resolveAppProfile('reader', { devicePreset: 'iphone-17-pro', appVersion: '10.0.9' });
    expect(injected.globals).toEqual({});
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(injected);
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(emulation('iphone-17-pro', 'portrait'));
    await seedQuickDevice('iphone-17-pro', 'portrait');
    await setQuickDeviceEmulation({ tabId: 7, preset: 'iphone-17-pro', orientation: 'portrait', fitToWindow: false, deviceShell: true });
    expect(appProfileHandlerMocks.handleSetAppProfile).not.toHaveBeenCalled();
  });
  it('returns the basic profile version from its binding when enabling the client', async () => {
    const { injected } = resolveAppProfile('reader', { devicePreset: 'iphone-17-pro', appVersion: '10.0.9' });
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(injected);
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(emulation('iphone-17-pro', 'portrait'));
    const result = await setQuickAppSimulation({ tabId: 7, profile: 'reader', deviceSelection: { preset: 'iphone-17-pro', orientation: 'portrait', fitToWindow: false, deviceShell: true } });
    expect(result).toMatchObject({ enabled: true, profile: 'reader', appVersion: '10.0.9' });
    expect(appProfileHandlerMocks.handleSetAppProfile).toHaveBeenCalledTimes(1);
  });

});
