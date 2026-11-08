import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveEmulationConfig } from '@mearl/browser-core';
import { getQuickDeviceChromeConfig } from '../../../shared/quickAppProfile';

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
    const { applyDeviceShellForTab, getDeviceShellBootstrapHeaderForTab } = await import('../deviceShellRules');
    const { getDevicePreviewPanelToken } = await import('../devicePreviewPanel');
    const tabId = 31;
    const fixed = resolveEmulationConfig({ enabled: true, preset: 'iphone-17-pro' });
    const storage: { get(keys: string[]): Promise<Record<string, unknown>> } = chrome.storage.local;
    const readPreferences = vi.spyOn(storage, 'get').mockResolvedValue({
      'device-preview-panel-width': 410,
      'device-preview-toolbar-collapsed': true,
    });
    const previousTabs = chrome.tabs;
    const previousI18n = chrome.i18n;
    chrome.tabs = { get: vi.fn().mockResolvedValue({ width: 1200, height: 848 }) } as unknown as typeof chrome.tabs;
    chrome.i18n = { getMessage: (key: string) => key === 'deviceSimulationIphone17Pro' ? 'iPhone 17 Pro' : '' } as typeof chrome.i18n;
    try {
      await applyDeviceShellForTab(tabId, {
        ...getQuickDeviceChromeConfig('iphone-17-pro'),
        phoneFrame: { width: fixed.width, height: fixed.height },
      }, fixed);
      getDevicePreviewPanelToken(tabId, false, true);
      const decode = (header: { value: string } | undefined) =>
        JSON.parse(atob(header!.value.split('"')[1]!));
      expect(decode(await getDeviceShellBootstrapHeaderForTab(tabId))).not.toHaveProperty('previewLayout');
      expect(readPreferences).not.toHaveBeenCalled();
      expect(decode(await getDeviceShellBootstrapHeaderForTab(tabId, true)).previewLayout).toEqual({
        width: 410,
        toolbarCollapsed: true,
        panel: { wide: true, open: false },
        viewport: { width: 1200, height: 848 },
        toolbar: { profile: null, preset: { id: 'iphone-17-pro', label: 'iPhone 17 Pro' }, orientation: 'portrait' },
      });
    } finally {
      readPreferences.mockRestore();
      chrome.tabs = previousTabs;
      chrome.i18n = previousI18n;
    }
  });
});
