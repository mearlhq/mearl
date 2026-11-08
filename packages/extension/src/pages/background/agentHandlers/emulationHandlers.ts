/**
 * Agent handler: set_device_emulation
 *
 * 通过 CDP Emulation.* 指令把 tab 切换为移动端模拟态：viewport / DPR / UA / 触摸。
 * 等价于 DevTools 设备工具栏，作用域 per-tab，会话结束自动还原。
 *
 * 预设表 / 默认值推导 / 入参校验在 @mearl/browser-core 中，与 native-host CDP backend 共享。
 */

import {
  resolveEmulationConfig,
  type BrowserDevicePresetName,
  type SetDeviceEmulationParams,
} from '@mearl/browser-core';
import {
  clearDeviceShellWebViewEnvironmentForTab,
  disableEmulationForTab,
  enableEmulationForTab,
  prepareDeviceShellWebViewEnvironmentForTab,
  refreshChildDeviceScripts,
  allowLocalRootWebViewReload,
} from '../debuggerManager';
import { releaseAppProfileDeviceEmulationForTab } from '../utils/appProfileRules';
import { assertDeviceShellSupported } from '../../../shared/chromiumVersion';
import { setEmulationFitToWindowForTab } from '../deviceEmulationState';
import { releaseQuickDeviceSimulationOwnership } from '../quickDeviceSimulationState';
import { getPreferredDeviceChromeConfig } from '../quickAppProfilePreference';
import { applyEmulationWithReload } from './tabHandlers';
import { reloadContainerTopFrame } from '../utils/containerFrameTarget';
import {
  applyDeviceShellForTab,
  clearDeviceShellForTab,
  getDeviceShellForTab,
} from '../deviceShellRules';
import { QUICK_DEVICE_CHROME_UPDATE_ACTION } from '../../../shared/quickAppProfile';

interface SetDeviceEmulationResult {
  enabled: boolean;
  preset?: BrowserDevicePresetName;
  viewport?: { width: number; height: number; deviceScaleFactor: number; scale: number };
  userAgent?: string;
  mobile?: boolean;
  touch?: boolean;
  orientation?: 'portrait' | 'landscape';
  deviceShell: boolean;
  splitScreen: boolean;
  reloaded: boolean;
}

interface SetDeviceEmulationHandlerOptions {
  /** Quick Settings 内部切换时保留快捷设备的外观与选择状态。 */
  preserveQuickDeviceOwnership?: boolean;
  /** Internal composition owns the final navigation after all components are prepared. */
  deferReload?: boolean;
  preservePreviewPanel?: boolean;
}

export async function handleSetDeviceEmulation(
  data: SetDeviceEmulationParams,
  getActiveTabId: () => number | null,
  options: SetDeviceEmulationHandlerOptions = {},
): Promise<SetDeviceEmulationResult> {
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }

  if (typeof data.enabled !== 'boolean') {
    throw new Error('set_device_emulation: "enabled" is required (true to enable, false to clear)');
  }

  if (data.enabled === false) {
    const hadDeviceShell = Boolean(await getDeviceShellForTab(tabId));
    await clearDeviceShellForTab(tabId);
    await releaseAppProfileDeviceEmulationForTab(tabId);
    await disableEmulationForTab(tabId);
    await clearDeviceShellWebViewEnvironmentForTab(tabId);
    if (!options.preserveQuickDeviceOwnership) {
      await releaseQuickDeviceSimulationOwnership(tabId);
    }
    let reloaded = false;
    if (hadDeviceShell && !options.deferReload) {
      await chrome.tabs.reload(tabId);
      reloaded = true;
    }
    await chrome.tabs
      .sendMessage(tabId, { action: QUICK_DEVICE_CHROME_UPDATE_ACTION, config: null })
      .catch(() => {});
    return { enabled: false, deviceShell: false, splitScreen: false, reloaded };
  }

  // 共享逻辑：preset 解析、默认值、校验
  const config = resolveEmulationConfig(data);
  const deviceShell = data.deviceShell === true;
  if (deviceShell) assertDeviceShellSupported();
  const appProfile = await releaseAppProfileDeviceEmulationForTab(tabId, config);
  const currentDeviceShell = await getDeviceShellForTab(tabId);
  const splitScreen =
    deviceShell &&
    Boolean(appProfile) &&
    data.splitScreen === true &&
    config.orientation === 'landscape';
  const shellConfig = deviceShell
    ? await getPreferredDeviceChromeConfig(config, splitScreen, options.preserveQuickDeviceOwnership ? undefined : data.scale)
    : null;
  if (shellConfig) {
    if (splitScreen) {
      await applyDeviceShellForTab(tabId, shellConfig, config, { splitScreen });
    } else {
      await applyDeviceShellForTab(tabId, shellConfig, config);
    }
    await enableEmulationForTab(tabId, config);
    if (splitScreen) {
      await prepareDeviceShellWebViewEnvironmentForTab(tabId, config, appProfile, {
        splitScreen: true,
      });
    } else {
      await prepareDeviceShellWebViewEnvironmentForTab(tabId, config, appProfile);
    }
  } else {
    await clearDeviceShellForTab(tabId);
    await clearDeviceShellWebViewEnvironmentForTab(tabId);
  }

  // UA 是页面加载时一次性读取的，默认 reload 让页面以移动模式重新初始化
  let reloaded = false;
  const deviceShellChanged = Boolean(currentDeviceShell) !== deviceShell;
  const deviceShellConfigChanged =
    deviceShell &&
    (JSON.stringify(currentDeviceShell?.emulation ?? null) !== JSON.stringify(config) ||
      currentDeviceShell?.splitScreen !== splitScreen ||
      Boolean(currentDeviceShell?.config.phoneFrame) !== Boolean(shellConfig?.phoneFrame) ||
      currentDeviceShell?.config.phoneFrame?.maxScale !== shellConfig?.phoneFrame?.maxScale);
  const canKeepPreview = options.preservePreviewPanel && deviceShellConfigChanged &&
    currentDeviceShell?.config.phoneFrame && shellConfig?.phoneFrame &&
    currentDeviceShell.config.platform === shellConfig.platform &&
    currentDeviceShell.config.sideBarWidth === shellConfig.sideBarWidth;
  const notifyChrome = () => chrome.tabs.sendMessage(tabId, {
    action: QUICK_DEVICE_CHROME_UPDATE_ACTION,
    config: shellConfig,
  }).catch(() => {});
  if (options.deferReload || (data.reload === false && !deviceShellChanged && !deviceShellConfigChanged)) {
    await enableEmulationForTab(tabId, config);
  } else if (canKeepPreview && await reloadContainerTopFrame(tabId, {
    singleRoot: true,
    beforeNavigate: async target => {
      await refreshChildDeviceScripts(tabId);
      await notifyChrome();
      return allowLocalRootWebViewReload(tabId, target.frameId, target.url);
    },
  }).catch(() => undefined)) {
    reloaded = true;
  } else {
    let expectedUrl = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      expectedUrl = tab.url || '';
    } catch (error) {
      console.warn('[set_device_emulation] could not read tab url:', error);
    }
    const applied = appProfile
      ? await applyEmulationWithReload(tabId, config, expectedUrl, appProfile.userAgent)
      : await applyEmulationWithReload(tabId, config, expectedUrl);
    if (!applied) {
      throw new Error('Device emulation did not remain active after reload');
    }
    reloaded = true;
  }
  setEmulationFitToWindowForTab(tabId, false);
  if (!options.preserveQuickDeviceOwnership) {
    await releaseQuickDeviceSimulationOwnership(tabId, {
      preserveAppliedDeviceEnvironment: true,
    });
  }

  await notifyChrome();

  return {
    enabled: true,
    preset: config.presetName,
    viewport: {
      width: config.width,
      height: config.height,
      deviceScaleFactor: config.deviceScaleFactor,
      scale: config.scale ?? 1,
    },
    userAgent: config.userAgent,
    mobile: config.mobile,
    touch: config.touch,
    orientation: config.orientation,
    deviceShell,
    splitScreen,
    reloaded,
  };
}
