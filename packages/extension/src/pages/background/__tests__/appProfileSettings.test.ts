import { resolveSettingsProfile as resolveAppProfile } from '../../../test/fixtures/appProfileSettings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rules = vi.hoisted(() => ({
  applyAppProfileForTab: vi.fn(),
  getAppProfileForTab: vi.fn(),
  appProfileOwnsDeviceEmulation: vi.fn(),
  getAppProfileDeviceEmulationForTab: vi.fn(),
}));
const debuggerMocks = vi.hoisted(() => ({
  enableAppProfileDocumentBootstrapForTab: vi.fn(),
  prepareDeviceShellWebViewEnvironmentForTab: vi.fn(),
  reloadTabInSession: vi.fn(),
}));
const shellMocks = vi.hoisted(() => ({ getDeviceShellForTab: vi.fn() }));
const variants = vi.hoisted(() => ({ catalog: vi.fn(), set: vi.fn() }));
vi.mock('../utils/appProfileRules', () => rules);
vi.mock('../debuggerManager', () => debuggerMocks);
vi.mock('../deviceShellRules', () => shellMocks);
vi.mock('../appProfileCatalog', () => ({ getAppProfileCatalog: variants.catalog }));
vi.mock('../agentHandlers/appProfileHandlers', () => ({ handleSetAppProfile: variants.set }));
vi.mock('../quickSimulationAutoRules', () => ({
  runQuickSimulationUpdateWithAutoRuleSync: (
    _tabId: number,
    _rule: unknown,
    update: () => unknown,
  ) => update(),
}));
import {
  getAppProfileVariants,
  selectAppProfileVariant,
  setAppProfileSetting,
  setAppProfileRuntimeResponses,
} from '../appProfileSettings';

describe('app profile settings persistence and rollback', () => {
  const emulation = { presetName: 'iphone-17-pro', orientation: 'portrait' };
  let stored: Record<string, unknown>;
  const set = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    stored = {
      appProfileOptions: { wallet: { language: 'zh-CN' } },
    };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => structuredClone(stored)),
          set,
        },
      },
      tabs: { reload: vi.fn().mockResolvedValue(undefined) },
      i18n: { getUILanguage: () => 'en' },
    });
    set.mockImplementation(async value => {
      Object.assign(stored, value);
    });
    shellMocks.getDeviceShellForTab.mockResolvedValue({ emulation, splitScreen: true });
    rules.appProfileOwnsDeviceEmulation.mockResolvedValue(true);
    rules.getAppProfileDeviceEmulationForTab.mockResolvedValue(emulation);
  });

  it.each([
    { languages: ['en', 'zh-CN'], language: 'en' },
    { languages: ['zh-CN'], language: undefined },
  ])(
    'switches within the active bundle with target languages $languages',
    async ({ languages, language }) => {
      rules.getAppProfileForTab.mockResolvedValue({
        profile: 'wechat',
        settingsGroup: 'webview',
        binding: { explicitOptions: { language: 'en' } },
      });
      variants.catalog.mockResolvedValue({
        profiles: [
          {
            id: 'wechat',
            label: 'WeChat',
            plugin: 'profile-wechat',
            definition: { settingsGroup: 'webview' },
          },
          {
            id: 'wechat-mini',
            label: 'Mini-program',
            plugin: 'profile-wechat',
            definition: { settingsGroup: 'webview', policies: { languages } },
          },
          {
            id: 'other',
            label: 'Other',
            plugin: 'another-bundle',
            definition: { settingsGroup: 'webview' },
          },
        ],
      });
      expect(await getAppProfileVariants(7, 'wechat')).toEqual([
        { value: 'wechat', label: 'WeChat' },
        { value: 'wechat-mini', label: 'Mini-program' },
      ]);
      await expect(selectAppProfileVariant(7, 'wechat', 'other')).rejects.toThrow('unavailable');
      await selectAppProfileVariant(7, 'wechat', 'wechat-mini');
      expect(variants.set).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ tabId: 7, enabled: true, profile: 'wechat-mini', language }),
        expect.any(Function),
      );
    },
  );

  it('persists the language option in one write', async () => {
    rules.getAppProfileForTab.mockResolvedValue(resolveAppProfile('wallet').injected);
    await setAppProfileSetting(7, 'wallet', 'language', 'en-US');
    expect(set).toHaveBeenCalledTimes(1);
    expect(stored).toMatchObject({
      appProfileOptions: { wallet: { language: 'en-US' } },
    });
    expect(debuggerMocks.reloadTabInSession).toHaveBeenCalledWith(7);
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });

  it('routes built-in response edits through the canonical binding and retains silent flags and device ownership', async () => {
    const current = resolveAppProfile('reader', {
      bridgeConfig: {
        methods: {
          getNotifications: { response: { enabled: false }, silent: true },
          probe: { response: false },
        },
      },
    }).injected;
    rules.getAppProfileForTab.mockResolvedValue(current);
    await setAppProfileRuntimeResponses(7, 'reader', { getNotifications: { enabled: true } });
    const updated = rules.applyAppProfileForTab.mock.calls[0][1];
    expect(updated.actions.responses).toMatchObject({
      getNotifications: { enabled: true },
      probe: false,
    });
    expect(updated.binding.options.bridgeConfig.methods.getNotifications).toEqual({
      response: { enabled: true },
      silent: true,
    });
    expect(stored).toMatchObject({
      appBridgeConfigs: {
        reader: {
          methods: {
            getNotifications: { response: { enabled: true }, silent: true },
          },
        },
      },
    });
    expect(rules.applyAppProfileForTab).toHaveBeenCalledWith(7, updated, {
      ownsDeviceEmulation: true,
      deviceEmulation: emulation,
    });
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });

  it('keeps concurrent saved method edits from different tabs', async () => {
    rules.getAppProfileForTab.mockResolvedValue(resolveAppProfile('reader').injected);
    await Promise.all([
      setAppProfileRuntimeResponses(7, 'reader', { getNotifications: { enabled: true } }),
      setAppProfileRuntimeResponses(8, 'reader', { getFeatureFlags: { enhancedRendering: false } }),
    ]);
    expect(stored).toMatchObject({
      appBridgeConfigs: {
        reader: {
          methods: {
            getNotifications: { response: { enabled: true } },
            getFeatureFlags: { response: { enhancedRendering: false } },
          },
        },
      },
    });
  });

  it.each([
    ['wallet', 'language', 'en-US'],
    ['reader', 'enhancedRendering', false],
  ] as const)(
    'restores every injection environment when %s persistence fails',
    async (profile, id, value) => {
      const current = resolveAppProfile(profile).injected;
      rules.getAppProfileForTab.mockResolvedValue(current);
      set.mockRejectedValueOnce(new Error('storage failed'));
      await expect(setAppProfileSetting(7, profile, id, value)).rejects.toThrow('storage failed');
      expect(rules.applyAppProfileForTab).toHaveBeenLastCalledWith(7, current, {
        ownsDeviceEmulation: true,
        deviceEmulation: emulation,
      });
      expect(debuggerMocks.enableAppProfileDocumentBootstrapForTab).toHaveBeenLastCalledWith(
        7,
        current,
      );
      expect(debuggerMocks.prepareDeviceShellWebViewEnvironmentForTab).toHaveBeenLastCalledWith(
        7,
        emulation,
        current,
        { splitScreen: true },
      );
      expect(stored).toEqual({
        appProfileOptions: { wallet: { language: 'zh-CN' } },
      });
      expect(chrome.tabs.reload).not.toHaveBeenCalled();
    },
  );

  it('attempts all restorations and retains both errors when one restoration fails', async () => {
    const current = resolveAppProfile('wallet').injected;
    rules.getAppProfileForTab.mockResolvedValue(current);
    const storageError = new Error('storage failed');
    const rollbackError = new Error('rule restore failed');
    set.mockRejectedValueOnce(storageError);
    rules.applyAppProfileForTab
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(rollbackError);
    const failure = await setAppProfileSetting(7, 'wallet', 'language', 'en-US').catch(
      error => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([storageError, rollbackError]);
    expect(debuggerMocks.prepareDeviceShellWebViewEnvironmentForTab).toHaveBeenLastCalledWith(
      7,
      emulation,
      current,
      { splitScreen: true },
    );
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });
});
