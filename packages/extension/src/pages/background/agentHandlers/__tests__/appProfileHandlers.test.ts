vi.mock('../../appProfileCatalog', () => ({ resolveAvailableAppProfile: async (...args: Parameters<typeof import('../../../../../../app-profiles/src/__tests__/fixtures').resolveAppProfile>) => (await import('../../../../../../app-profiles/src/__tests__/fixtures')).resolveAppProfile(...args) }));
import { MAP_PROFILE_FIXTURE } from '../../../../test/fixtures/appProfileSettings';
import { resolveAppProfile } from '../../../../../../app-profiles/src/__tests__/fixtures';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const debuggerMocks = vi.hoisted(() => ({
  clearDeviceShellWebViewEnvironmentForTab: vi.fn(),
  disableAppProfileDocumentBootstrapForTab: vi.fn(),
  enableAppProfileDocumentBootstrapForTab: vi.fn(),
  prepareDeviceShellWebViewEnvironmentForTab: vi.fn(),
  reloadTabInSession: vi.fn().mockResolvedValue(undefined),
}));
const profileRuleMocks = vi.hoisted(() => ({
  applyAppProfileForTab: vi.fn(),
  clearAppProfileForTab: vi.fn(),
  getAppProfileForTab: vi.fn(),
  getAppProfileDeviceEmulationForTab: vi.fn(),
  appProfileOwnsDeviceEmulation: vi.fn(),
}));
const deviceStateMocks = vi.hoisted(() => ({ getEmulationConfigForTab: vi.fn() }));
const deviceShellMocks = vi.hoisted(() => ({ getDeviceShellForTab: vi.fn() }));
const tabMocks = vi.hoisted(() => ({ navigateAndWait: vi.fn() }));
const envSwitchMocks = vi.hoisted(() => ({ setInstalledNetworkControl: vi.fn() }));

vi.mock('../../debuggerManager', () => debuggerMocks);
vi.mock('../../utils/appProfileRules', () => profileRuleMocks);
vi.mock('../../deviceEmulationState', () => deviceStateMocks);
vi.mock('../../deviceShellRules', () => deviceShellMocks);
vi.mock('../tabHandlers', () => tabMocks);
vi.mock('../../envSwitchRules', () => envSwitchMocks);

import { handleSetAppProfile } from '../appProfileHandlers';

describe('app profile handler', () => {
  it('preserves the active plugin language and method overrides across a device update', async () => {
    const definition = {
      ...MAP_PROFILE_FIXTURE,
      name: 'maps/sample',
      policies: {
        navigatorLanguage: true,
        languages: ['en', 'zh'],
        defaultLanguage: 'zh',
      },
    };
    const config = resolveAppProfile(
      'maps/sample',
      { language: 'en', bridgeConfig: { methods: { probe: { response: false } } } },
      definition,
    ).injected;
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(config);
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      appProfileOptions: { 'maps/sample': { language: 'zh' } },
    });
    await handleSetAppProfile(
      { tabId: 1, enabled: true, profile: 'maps/sample', os: 'android', reload: false },
      () => null,
    );
    expect(profileRuleMocks.applyAppProfileForTab).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        language: 'en',
        actions: expect.objectContaining({ responses: expect.objectContaining({ probe: false }) }),
        binding: expect.objectContaining({ revision: config.binding!.revision }),
      }),
    );
  });
  it('restores the previous definition when installing new document injection fails', async () => {
    const config = resolveAppProfile('shop').injected;
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(config);
    debuggerMocks.enableAppProfileDocumentBootstrapForTab.mockRejectedValueOnce(
      new Error('install failed'),
    );
    await expect(
      handleSetAppProfile({ tabId: 1, enabled: true, profile: 'reader' }, () => null),
    ).rejects.toThrow('install failed');
    expect(profileRuleMocks.applyAppProfileForTab).toHaveBeenLastCalledWith(1, config, {
      ownsDeviceEmulation: undefined,
      deviceEmulation: undefined,
    });
    expect(debuggerMocks.enableAppProfileDocumentBootstrapForTab).toHaveBeenLastCalledWith(
      1,
      config,
    );
  });
  it('attempts every recovery step when restoring the previous rules fails', async () => {
    const config = resolveAppProfile('shop').injected;
    const emulation = { presetName: 'iphone-17-pro', orientation: 'portrait' };
    const installError = new Error('install failed');
    const rollbackError = new Error('rule restore failed');
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(config);
    profileRuleMocks.applyAppProfileForTab
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(rollbackError);
    deviceShellMocks.getDeviceShellForTab.mockResolvedValue({ emulation, splitScreen: true });
    debuggerMocks.enableAppProfileDocumentBootstrapForTab.mockRejectedValueOnce(installError);

    const failure = await handleSetAppProfile(
      { tabId: 1, enabled: true, profile: 'reader' },
      () => null,
    ).catch(error => error);

    expect(debuggerMocks.enableAppProfileDocumentBootstrapForTab).toHaveBeenLastCalledWith(
      1,
      config,
    );
    expect(debuggerMocks.prepareDeviceShellWebViewEnvironmentForTab).toHaveBeenLastCalledWith(
      1,
      emulation,
      config,
      { splitScreen: true },
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([installError, rollbackError]);
    expect(debuggerMocks.reloadTabInSession).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({});
    profileRuleMocks.applyAppProfileForTab.mockResolvedValue(undefined);
    profileRuleMocks.clearAppProfileForTab.mockResolvedValue(undefined);
    profileRuleMocks.getAppProfileForTab.mockResolvedValue(undefined);
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(undefined);
    deviceShellMocks.getDeviceShellForTab.mockResolvedValue(null);
    debuggerMocks.clearDeviceShellWebViewEnvironmentForTab.mockResolvedValue(undefined);
    debuggerMocks.disableAppProfileDocumentBootstrapForTab.mockResolvedValue(undefined);
    debuggerMocks.enableAppProfileDocumentBootstrapForTab.mockResolvedValue(undefined);
    debuggerMocks.prepareDeviceShellWebViewEnvironmentForTab.mockResolvedValue(undefined);
    envSwitchMocks.setInstalledNetworkControl.mockResolvedValue(undefined);
    tabMocks.navigateAndWait.mockImplementation(
      async (_tabId: number, _url: string, navigate: () => Promise<unknown>) => navigate(),
    );
    chrome.tabs = {
      get: vi.fn().mockResolvedValue({ id: 1, url: 'https://example.test/' }),
      reload: vi.fn().mockResolvedValue(undefined),
    } as any;
  });

  it('只注入 App 环境和桥，不创建根 WebView 或接管设备模拟', async () => {
    const result = await handleSetAppProfile(
      { tabId: 1, enabled: true, profile: 'reader' },
      () => null,
    );

    expect(profileRuleMocks.applyAppProfileForTab).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        profile: 'reader',
        rootContainer: expect.objectContaining({ enabled: false }),
        simulateSystemBars: false,
        externalDeviceChrome: false,
      }),
    );
    expect(debuggerMocks.enableAppProfileDocumentBootstrapForTab).toHaveBeenCalled();
    expect(debuggerMocks.clearDeviceShellWebViewEnvironmentForTab).toHaveBeenCalledWith(1);
    expect(result).toMatchObject({ enabled: true, profile: 'reader', reloaded: true });
  });

  it('已有 deviceShell 时只把 App 桥环境同步给业务 WebView', async () => {
    const emulation = {
      presetName: 'pixel-11',
      orientation: 'portrait',
      userAgent: 'device ua',
    };
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(emulation);
    deviceShellMocks.getDeviceShellForTab.mockResolvedValue({
      emulation,
      config: {},
    });

    await handleSetAppProfile(
      { tabId: 1, enabled: true, profile: 'reader', os: 'android' },
      () => null,
    );

    expect(debuggerMocks.prepareDeviceShellWebViewEnvironmentForTab).toHaveBeenCalledWith(
      1,
      emulation,
      expect.objectContaining({ profile: 'reader', platform: 'Android' }),
      {},
    );
    expect(deviceShellMocks.getDeviceShellForTab).toHaveBeenCalledWith(1);
  });

  it('钱包语言从已保存配置恢复，并在重建当前档案时保留选择', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      appProfileOptions: { wallet: { language: 'zh-TW' } },
    });
    await handleSetAppProfile({ tabId: 1, enabled: true, profile: 'wallet' }, () => null);
    expect(profileRuleMocks.applyAppProfileForTab).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        language: 'zh-TW',
        userAgent: expect.stringContaining('iOS zh-TW'),
      }),
    );

    profileRuleMocks.getAppProfileForTab.mockResolvedValue({
      ...resolveAppProfile('wallet', { language: 'zh-HK' }).injected,
    });
    await handleSetAppProfile({ tabId: 1, enabled: true, profile: 'wallet' }, () => null);
    expect(profileRuleMocks.applyAppProfileForTab).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({
        language: 'zh-HK',
        userAgent: expect.stringContaining('iOS zh-HK'),
      }),
    );
  });

  it('切换钱包语言时保留当前桥方法配置', async () => {
    const current = resolveAppProfile('wallet', {
      bridgeConfig: {
        methods: { customMethod: { response: { enabled: true } } },
      },
    }).injected;
    await handleSetAppProfile(
      { tabId: 1, enabled: true, profile: 'wallet', language: 'en-US', reload: false },
      () => null,
      { current },
    );
    expect(profileRuleMocks.applyAppProfileForTab).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ language: 'en-US', actions: current.actions }),
    );
    expect(debuggerMocks.reloadTabInSession).not.toHaveBeenCalled();
  });

  it('清除 App 档案时保留 deviceShell，并恢复纯设备 WebView 环境', async () => {
    const emulation = { presetName: 'iphone-17-pro', orientation: 'portrait' };
    profileRuleMocks.getAppProfileForTab.mockResolvedValue({ profile: 'reader' });
    deviceStateMocks.getEmulationConfigForTab.mockReturnValue(emulation);
    deviceShellMocks.getDeviceShellForTab.mockResolvedValue({
      emulation,
      config: {},
    });

    await expect(handleSetAppProfile({ tabId: 1, enabled: false }, () => null)).resolves.toEqual({
      enabled: false,
      reloaded: true,
    });

    expect(profileRuleMocks.clearAppProfileForTab).toHaveBeenCalledWith(1);
    expect(debuggerMocks.prepareDeviceShellWebViewEnvironmentForTab).toHaveBeenCalledWith(
      1,
      emulation,
      undefined,
      {},
    );
    expect(debuggerMocks.reloadTabInSession).toHaveBeenCalledWith(1);
  });

  it('没有设备外壳时清除子 WebView 自动附加环境', async () => {
    profileRuleMocks.getAppProfileForTab.mockResolvedValue({ profile: 'reader' });

    await handleSetAppProfile({ tabId: 1, enabled: false, reload: false }, () => null);

    expect(debuggerMocks.clearDeviceShellWebViewEnvironmentForTab).toHaveBeenCalledWith(1);
    expect(debuggerMocks.reloadTabInSession).not.toHaveBeenCalled();
  });

  it('合并插件本地桥配置，并让单次 Agent 配置拥有更高优先级', async () => {
    (chrome.storage.local.get as unknown as Mock).mockResolvedValue({
      appBridgeConfigs: {
        reader: {
          methods: {
            getFeatureFlags: { response: { enhancedRendering: false } },
            plugin_only: { noop: true },
          },
        },
      },
    });

    await handleSetAppProfile(
      {
        tabId: 1,
        enabled: true,
        profile: 'reader',
        bridgeConfig: {
          methods: { getFeatureFlags: { response: { enhancedRendering: true } } },
        },
      },
      () => null,
    );

    const injected = profileRuleMocks.applyAppProfileForTab.mock.calls[0]?.[1];
    expect(injected.actions.responses.getFeatureFlags).toEqual({ enhancedRendering: true });
    expect(injected.actions.noop).toContain('plugin_only');
  });

  it('启用 App 档案时同步 Protocol 预发环境并共用一次重载', async () => {
    const result = await handleSetAppProfile(
      { tabId: 1, enabled: true, profile: 'shop', networkControl: { id: 'environment', value: 'pre' } },
      () => null,
    );

    expect(envSwitchMocks.setInstalledNetworkControl).toHaveBeenCalledWith(1, { id: 'environment', value: 'pre' });
    expect(debuggerMocks.reloadTabInSession).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ enabled: true, networkControl: { id: 'environment', value: 'pre' }, reloaded: true });
  });

  it('不启用 App 档案时也可单独设置 Protocol 生产环境', async () => {
    const result = await handleSetAppProfile(
      { tabId: 1, enabled: false, networkControl: { id: 'environment', value: 'prod' } },
      () => null,
    );

    expect(envSwitchMocks.setInstalledNetworkControl).toHaveBeenCalledWith(1, { id: 'environment', value: 'prod' });
    expect(profileRuleMocks.clearAppProfileForTab).not.toHaveBeenCalled();
    expect(debuggerMocks.reloadTabInSession).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ enabled: false, networkControl: { id: 'environment', value: 'prod' }, reloaded: true });
  });

  it('拒绝未知的 Protocol 环境', async () => {
    await expect(
      handleSetAppProfile({ tabId: 1, enabled: false, networkControl: 'online' as never }, () => null),
    ).rejects.toThrow('networkControl requires {id,value} or null');

    expect(envSwitchMocks.setInstalledNetworkControl).not.toHaveBeenCalled();
  });

  it('重载失败时只回滚 App 档案，不清理设备层', async () => {
    tabMocks.navigateAndWait.mockRejectedValue(new Error('reload failed'));

    await expect(
      handleSetAppProfile({ tabId: 1, enabled: true, profile: 'reader' }, () => null),
    ).rejects.toThrow('reload failed');

    expect(profileRuleMocks.clearAppProfileForTab).toHaveBeenCalledWith(1);
    expect(debuggerMocks.disableAppProfileDocumentBootstrapForTab).toHaveBeenCalledWith(1);
  });
});
