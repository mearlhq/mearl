import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveEmulationConfig } from '@mearl/browser-core';
import { getQuickDeviceChromeConfig } from '../../../shared/quickAppProfile';
import english from '../../../locales/en/messages.json';
import chinese from '../../../locales/zh_CN/messages.json';

describe('deviceShellRules', () => {
  beforeEach(() => {
    vi.resetModules();
    chrome.declarativeNetRequest = {
      getSessionRules: vi.fn().mockResolvedValue([]),
      updateSessionRules: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof chrome.declarativeNetRequest;
  });

  it('allows inherited viewport devices to enable split screen without a landscape override', async () => {
    const { applyDeviceShellForTab, getDeviceShellForTab } = await import('../deviceShellRules');
    const fixed = resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' });
    const environment = {
      viewport: 'inherit' as const,
      mobile: fixed.mobile,
      userAgent: fixed.userAgent,
      platform: fixed.platform,
      platformVersion: fixed.platformVersion,
      architecture: fixed.architecture,
      model: fixed.model,
      touch: fixed.touch,
      orientation: fixed.orientation,
      safeAreaInsets: fixed.safeAreaInsets,
      appearance: fixed.appearance,
    };

    await applyDeviceShellForTab(31, getQuickDeviceChromeConfig('ios-adaptive'), environment, {
      splitScreen: true,
    });

    await expect(getDeviceShellForTab(31)).resolves.toMatchObject({
      splitScreen: true,
      emulation: { viewport: 'inherit', orientation: 'portrait' },
    });
  });

  it('sends preview preferences with the shell document without storing them in the device rule', async () => {
    const { applyDeviceShellForTab, getDeviceShellBootstrapHeaderForTab } =
      await import('../deviceShellRules');
    const tabId = 31;
    const fixed = resolveEmulationConfig({ enabled: true, preset: 'iphone-duo-folded' });
    const storage: { get(keys: string[]): Promise<Record<string, unknown>> } = chrome.storage.local;
    const readPreferences = vi.spyOn(storage, 'get').mockResolvedValue({
      'device-preview-panel-width': 410,
      'device-preview-panel-open': false,
      'device-preview-toolbar-collapsed': true,
    });
    const previousTabs = chrome.tabs;
    const previousSync = chrome.storage.sync;
    const readLanguage = vi.fn().mockResolvedValue({ language: 'en' });
    chrome.storage.sync = { get: readLanguage } as unknown as typeof chrome.storage.sync;
    const loadMessages = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async url =>
        ({
          json: async () => (String(url).includes('/en/') ? english : chinese),
        }) as Response,
    );
    chrome.tabs = {
      get: vi.fn().mockResolvedValue({ width: 1200, height: 848 }),
    } as unknown as typeof chrome.tabs;
    try {
      await applyDeviceShellForTab(
        tabId,
        {
          ...getQuickDeviceChromeConfig('iphone-duo-folded'),
          phoneFrame: { width: fixed.width, height: fixed.height },
        },
        fixed,
      );
      const decode = (header: { value: string } | undefined) =>
        JSON.parse(Buffer.from(header!.value.split('"')[1]!, 'base64').toString('utf8'));
      expect(decode(await getDeviceShellBootstrapHeaderForTab(tabId))).not.toHaveProperty(
        'previewLayout',
      );
      expect(readPreferences).not.toHaveBeenCalled();
      expect(
        decode(await getDeviceShellBootstrapHeaderForTab(tabId, true)).previewLayout,
      ).toMatchObject({
        width: 410,
        toolbarCollapsed: true,
        panelOpen: false,
        viewport: { width: 1200, height: 848 },
        toolbar: {
          profile: null,
          preset: {
            id: 'iphone-duo-folded',
            label: english.deviceSimulationIphoneDuoFolded.message,
          },
          orientation: 'portrait',
          labels: { deviceSimulationDisable: english.deviceSimulationDisable.message },
        },
      });
      readLanguage.mockResolvedValue({ language: 'zh_CN' });
      expect(
        decode(await getDeviceShellBootstrapHeaderForTab(tabId, true)).previewLayout.toolbar,
      ).toMatchObject({
        preset: { label: chinese.deviceSimulationIphoneDuoFolded.message },
        labels: { deviceSimulationDisable: chinese.deviceSimulationDisable.message },
      });
    } finally {
      readPreferences.mockRestore();
      loadMessages.mockRestore();
      chrome.tabs = previousTabs;
      chrome.storage.sync = previousSync;
    }
  });
});
