import { beforeEach, describe, expect, it, vi } from 'vitest';

const debuggerMocks = vi.hoisted(() => ({
  clearDeviceShellWebViewEnvironmentForTab: vi.fn(),
  disableEmulationForTab: vi.fn(),
  enableEmulationForTab: vi.fn(),
  prepareDeviceShellWebViewEnvironmentForTab: vi.fn(),
  refreshChildDeviceScripts: vi.fn(),
  allowLocalRootWebViewReload: vi.fn(),
}));
const containerMocks = vi.hoisted(() => ({ reloadContainerTopFrame: vi.fn() }));
const profileRuleMocks = vi.hoisted(() => ({
  releaseAppProfileDeviceEmulationForTab: vi.fn(),
}));
const tabMocks = vi.hoisted(() => ({
  waitForTabLoad: vi.fn(),
  applyEmulationWithReload: vi.fn(),
}));
const deviceStateMocks = vi.hoisted(() => ({
  setEmulationFitToWindowForTab: vi.fn(),
}));
const quickDeviceMocks = vi.hoisted(() => ({
  releaseQuickDeviceSimulationOwnership: vi.fn(),
}));
const deviceShellRuleMocks = vi.hoisted(() => ({
  applyDeviceShellForTab: vi.fn(),
  clearDeviceShellForTab: vi.fn(),
  getDeviceShellForTab: vi.fn(),
}));

vi.mock('../../debuggerManager', () => debuggerMocks);
vi.mock('../../utils/appProfileRules', () => profileRuleMocks);
vi.mock('../tabHandlers', () => tabMocks);
vi.mock('../../deviceEmulationState', () => deviceStateMocks);
vi.mock('../../quickDeviceSimulationState', () => quickDeviceMocks);
vi.mock('../../deviceShellRules', () => deviceShellRuleMocks);
vi.mock('../../utils/containerFrameTarget', () => containerMocks);

import { handleSetDeviceEmulation } from '../emulationHandlers';

/**
 * 下发 + reload + 实测校验的行为由 tabHandlers 的 applyEmulationWithReload 承担
 * （tab_open 与 set_device_emulation 共用同一实现，其用例见 tabHandlers.test.ts）。
 * 这里只覆盖本 handler 的职责：入参校验、委托与结果映射。
 */
describe('device emulation handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    debuggerMocks.disableEmulationForTab.mockResolvedValue(undefined);
    debuggerMocks.enableEmulationForTab.mockResolvedValue(undefined);
    debuggerMocks.clearDeviceShellWebViewEnvironmentForTab.mockResolvedValue(undefined);
    debuggerMocks.prepareDeviceShellWebViewEnvironmentForTab.mockResolvedValue(undefined);
    profileRuleMocks.releaseAppProfileDeviceEmulationForTab.mockResolvedValue(undefined);
    tabMocks.waitForTabLoad.mockResolvedValue(undefined);
    tabMocks.applyEmulationWithReload.mockResolvedValue(true);
    quickDeviceMocks.releaseQuickDeviceSimulationOwnership.mockResolvedValue(undefined);
    deviceShellRuleMocks.applyDeviceShellForTab.mockResolvedValue(undefined);
    deviceShellRuleMocks.clearDeviceShellForTab.mockResolvedValue(false);
    deviceShellRuleMocks.getDeviceShellForTab.mockResolvedValue(null);
    chrome.tabs = {
      get: vi.fn().mockResolvedValue({ url: 'https://example.test/' }),
      reload: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
  });

  it('委托给共享的下发 + reload + 校验流程，并回传生效配置', async () => {
    const result = await handleSetDeviceEmulation(
      { tabId: 1, enabled: true, preset: 'iphone-15-pro' },
      () => null,
    );

    expect(tabMocks.applyEmulationWithReload).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ width: 393, presetName: 'iphone-15-pro' }),
      'https://example.test/',
      { devicePrepared: false },
    );
    expect(profileRuleMocks.releaseAppProfileDeviceEmulationForTab).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ width: 393, presetName: 'iphone-15-pro' }),
    );
    expect(result).toMatchObject({
      enabled: true,
      preset: 'iphone-15-pro',
      viewport: { width: 393, height: 852, deviceScaleFactor: 3 },
      mobile: true,
      touch: true,
      deviceShell: false,
      reloaded: true,
    });
    expect(deviceStateMocks.setEmulationFitToWindowForTab).toHaveBeenCalledWith(1, false);
    expect(quickDeviceMocks.releaseQuickDeviceSimulationOwnership).toHaveBeenCalledWith(1, {
      preserveAppliedDeviceEnvironment: true,
    });
  });

  it('rejects Device Shell before changing the tab environment on Chrome 124', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome/124.0.0.0' });
    try {
      await expect(
        handleSetDeviceEmulation(
          { tabId: 1, enabled: true, preset: 'iphone-15-pro', deviceShell: true },
          () => null,
        ),
      ).rejects.toThrow('Device Shell requires Chrome 125 or newer');
      expect(profileRuleMocks.releaseAppProfileDeviceEmulationForTab).not.toHaveBeenCalled();
      expect(deviceShellRuleMocks.applyDeviceShellForTab).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('校验未通过时报错，不把失败当成功返回', async () => {
    tabMocks.applyEmulationWithReload.mockResolvedValue(false);

    await expect(
      handleSetDeviceEmulation({ tabId: 1, enabled: true, preset: 'iphone-15-pro' }, () => null),
    ).rejects.toThrow('Device emulation did not remain active after reload');
  });

  it('reload:false 时只下发 override，不走 reload 与校验', async () => {
    const result = await handleSetDeviceEmulation(
      { tabId: 1, enabled: true, preset: 'iphone-15-pro', reload: false },
      () => null,
    );

    expect(debuggerMocks.enableEmulationForTab).toHaveBeenCalledTimes(1);
    expect(tabMocks.applyEmulationWithReload).not.toHaveBeenCalled();
    expect(result.reloaded).toBe(false);
  });

  it('deviceShell 开启 iframe 外壳，并在移除时强制 reload', async () => {
    const enabled = await handleSetDeviceEmulation(
      {
        tabId: 1,
        enabled: true,
        preset: 'iphone-17-pro',
        deviceShell: true,
        reload: false,
      },
      () => null,
    );

    expect(deviceShellRuleMocks.applyDeviceShellForTab).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ platform: 'ios', statusBarHeight: 62 }),
      expect.objectContaining({ presetName: 'iphone-17-pro' }),
    );
    expect(debuggerMocks.prepareDeviceShellWebViewEnvironmentForTab).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ presetName: 'iphone-17-pro' }),
      undefined,
    );
    expect(tabMocks.applyEmulationWithReload).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ presetName: 'iphone-17-pro' }),
      'https://example.test/',
      { devicePrepared: true },
    );
    expect(enabled).toMatchObject({ deviceShell: true, reloaded: true });

    vi.clearAllMocks();
    deviceShellRuleMocks.getDeviceShellForTab.mockResolvedValue({
      config: {},
      emulation: {},
    });
    deviceShellRuleMocks.clearDeviceShellForTab.mockResolvedValue(true);
    profileRuleMocks.releaseAppProfileDeviceEmulationForTab.mockResolvedValue(undefined);
    debuggerMocks.disableEmulationForTab.mockResolvedValue(undefined);
    debuggerMocks.clearDeviceShellWebViewEnvironmentForTab.mockResolvedValue(undefined);
    chrome.tabs.reload = vi.fn().mockResolvedValue(undefined);
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue(undefined);

    await expect(
      handleSetDeviceEmulation({ tabId: 1, enabled: false, reload: false }, () => null),
    ).resolves.toEqual({
      enabled: false,
      deviceShell: false,
      splitScreen: false,
      reloaded: true,
    });
    expect(chrome.tabs.reload).toHaveBeenCalledWith(1);
  });

  it('仅在横屏设备外壳中下发分屏配置', async () => {
    profileRuleMocks.releaseAppProfileDeviceEmulationForTab.mockResolvedValue({
      profile: 'reader',
      userAgent: 'Mozilla/5.0 Sample/10.0.0)',
    });
    const result = await handleSetDeviceEmulation(
      {
        tabId: 1,
        enabled: true,
        preset: 'iphone-17-pro',
        orientation: 'landscape',
        deviceShell: true,
        splitScreen: true,
      },
      () => null,
    );

    expect(deviceShellRuleMocks.applyDeviceShellForTab).toHaveBeenCalledWith(
      1,
      expect.any(Object),
      expect.objectContaining({ orientation: 'landscape' }),
      { splitScreen: true },
    );
    expect(result).toMatchObject({ deviceShell: true, splitScreen: true });
  });

  it('切换预设时保留 App profile，并使用 App UA 校验组合态', async () => {
    const profile = {
      profile: 'reader',
      userAgent: 'Mozilla/5.0 Sample/10.0.0)',
    };
    profileRuleMocks.releaseAppProfileDeviceEmulationForTab.mockResolvedValue(profile);

    await handleSetDeviceEmulation({ tabId: 1, enabled: true, preset: 'pixel-8' }, () => null);

    expect(tabMocks.applyEmulationWithReload).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ presetName: 'pixel-8' }),
      'https://example.test/',
      { expectedUserAgent: profile.userAgent, devicePrepared: false },
    );
    expect(debuggerMocks.prepareDeviceShellWebViewEnvironmentForTab).not.toHaveBeenCalled();
  });

  it('enabled:false 时清除模拟', async () => {
    const result = await handleSetDeviceEmulation({ tabId: 1, enabled: false }, () => null);

    expect(profileRuleMocks.releaseAppProfileDeviceEmulationForTab).toHaveBeenCalledWith(1);
    expect(debuggerMocks.disableEmulationForTab).toHaveBeenCalledWith(1);
    expect(debuggerMocks.prepareDeviceShellWebViewEnvironmentForTab).not.toHaveBeenCalled();
    expect(result).toEqual({
      enabled: false,
      deviceShell: false,
      splitScreen: false,
      reloaded: false,
    });
    expect(quickDeviceMocks.releaseQuickDeviceSimulationOwnership).toHaveBeenCalledWith(1);
  });

  it('Quick 内部切换设备时保留快捷设备所有权', async () => {
    await handleSetDeviceEmulation(
      { tabId: 1, enabled: true, preset: 'pixel-8', reload: false },
      () => null,
      { preserveQuickDeviceOwnership: true },
    );

    expect(quickDeviceMocks.releaseQuickDeviceSimulationOwnership).not.toHaveBeenCalled();
  });

  it('uses the saved frame preference for Agent and Quick Settings without exposing it to Agent', async () => {
    const data = { tabId: 1, enabled: true, preset: 'iphone-17-pro', deviceShell: true } as const;
    chrome.storage.local.get = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ quickDevicePhoneFrame: false });
    const response = await handleSetDeviceEmulation({ ...data, scale: 0.5 }, () => null);
    expect(deviceShellRuleMocks.applyDeviceShellForTab.mock.lastCall?.[1].phoneFrame).toEqual({
      width: 402,
      height: 874,
      maxScale: 0.5,
    });
    expect(response.deviceShell).toBe(true);
    expect(response.viewport?.scale).toBe(0.5);
    expect(response).not.toHaveProperty('phoneFrame');

    await handleSetDeviceEmulation(data, () => null, { preserveQuickDeviceOwnership: true });
    expect(
      deviceShellRuleMocks.applyDeviceShellForTab.mock.lastCall?.[1].phoneFrame,
    ).toBeUndefined();
  });

  it('reloads only the business frame when a fixed preview rotates', async () => {
    deviceShellRuleMocks.getDeviceShellForTab.mockResolvedValue({
      config: { platform: 'ios', phoneFrame: { width: 402, height: 874 } },
      emulation: { orientation: 'portrait' },
      splitScreen: false,
    });
    containerMocks.reloadContainerTopFrame.mockImplementationOnce(
      async (_tabId, { beforeNavigate }) => {
        const target = { frameId: 'root', url: 'https://example.test/' };
        await beforeNavigate(target);
        return target;
      },
    );
    await handleSetDeviceEmulation(
      {
        tabId: 1,
        enabled: true,
        preset: 'iphone-17-pro',
        orientation: 'landscape',
        deviceShell: true,
      },
      () => null,
      { preserveQuickDeviceOwnership: true, preservePreviewPanel: true },
    );

    expect(debuggerMocks.refreshChildDeviceScripts).toHaveBeenCalledWith(1);
    expect(debuggerMocks.allowLocalRootWebViewReload).toHaveBeenCalledWith(
      1,
      'root',
      'https://example.test/',
    );
    expect(tabMocks.applyEmulationWithReload).not.toHaveBeenCalled();
  });

  it('清除设备模拟时保留 App profile 注入', async () => {
    const profile = {
      profile: 'reader',
      safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
    };
    profileRuleMocks.releaseAppProfileDeviceEmulationForTab.mockResolvedValue(profile);

    await handleSetDeviceEmulation({ tabId: 1, enabled: false }, () => null);

    expect(debuggerMocks.disableEmulationForTab).toHaveBeenCalledWith(1);
    expect(debuggerMocks.clearDeviceShellWebViewEnvironmentForTab).toHaveBeenCalledWith(1);
    expect(debuggerMocks.prepareDeviceShellWebViewEnvironmentForTab).not.toHaveBeenCalled();
  });

  it('缺少 enabled 时报错', async () => {
    await expect(handleSetDeviceEmulation({ tabId: 1 } as never, () => null)).rejects.toThrow(
      '"enabled" is required',
    );
  });
});
