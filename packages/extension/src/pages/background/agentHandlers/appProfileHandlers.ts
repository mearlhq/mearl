import { resolveAvailableAppProfile } from '../appProfileCatalog';
/**
 * Agent handler: set_app_profile
 *
 * App 档案只负责客户端 UA、环境变量与 JSBridge/容器协议注入。设备尺寸、根 WebView 和
 * 系统外壳由 set_device_emulation 独立管理，两者可以任意组合且互不接管所有权。
 */

import { resolveAppProfileUpdate } from '@mearl/app-profiles';
import { applyAppProfileEnvironmentForTab } from '../appProfileLifecycle';
import type {
  AppProfileOptions,
  InjectedAppProfileConfig,
  NetworkControlSelection,
  SetAppProfileParams,
} from '@mearl/browser-core';
import {
  clearDeviceShellWebViewEnvironmentForTab,
  disableAppProfileDocumentBootstrapForTab,
  prepareDeviceShellWebViewEnvironmentForTab,
  reloadTabInSession,
} from '../debuggerManager';
import { clearAppProfileForTab, getAppProfileForTab } from '../utils/appProfileRules';
import { getEmulationConfigForTab } from '../deviceEmulationState';
import { getDeviceShellForTab } from '../deviceShellRules';
import {
  loadStoredAppProfileOptions,
  resolveStoredAppBridgeConfig,
} from '../../../shared/appBridgeConfig';
import { navigateAndWait } from './tabHandlers';
import { setInstalledNetworkControl } from '../envSwitchRules';

interface SetAppProfileResult {
  enabled: boolean;
  profile?: string;
  label?: string;
  userAgent?: string;
  os?: 'ios' | 'android';
  networkControl?: NetworkControlSelection | null;
  reloaded: boolean;
}

async function reloadTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  await navigateAndWait(tabId, tab.url || '', () => reloadTabInSession(tabId));
}

function validateNetworkControlSelection(value: unknown): asserts value is NetworkControlSelection | null | undefined {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'id,value' || typeof (value as NetworkControlSelection).id !== 'string' || typeof (value as NetworkControlSelection).value !== 'string') throw new Error('set_app_profile: networkControl requires {id,value} or null');
}

export async function handleSetAppProfile(
  data: SetAppProfileParams,
  getActiveTabId: () => number | null,
  context?: { current?: InjectedAppProfileConfig; deviceOptions?: AppProfileOptions },
): Promise<SetAppProfileResult> {
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }

  if (typeof data.enabled !== 'boolean') {
    throw new Error('set_app_profile: "enabled" is required (true to enable, false to clear)');
  }
  validateNetworkControlSelection(data.networkControl);

  if (data.enabled === false) {
    const hadProfile = Boolean(await getAppProfileForTab(tabId));
    if (hadProfile) {
      await disableAppProfileDocumentBootstrapForTab(tabId);
      await clearAppProfileForTab(tabId);
      const deviceShell = await getDeviceShellForTab(tabId);
      if (deviceShell) {
        await prepareDeviceShellWebViewEnvironmentForTab(tabId, deviceShell.emulation, undefined, {
          ...(deviceShell.splitScreen ? { splitScreen: true } : {}),
        });
      } else {
        await clearDeviceShellWebViewEnvironmentForTab(tabId);
      }
    }

    if (data.networkControl !== undefined) {
      await setInstalledNetworkControl(tabId, data.networkControl);
    }

    if (!hadProfile && data.networkControl === undefined) return { enabled: false, reloaded: false };

    let reloaded = false;
    if (data.reload !== false) {
      await reloadTab(tabId);
      reloaded = true;
    }
    return {
      enabled: false,
      ...(data.networkControl !== undefined && { networkControl: data.networkControl }),
      reloaded,
    };
  }

  if (data.refreshDefinition !== undefined && typeof data.refreshDefinition !== 'boolean')
    throw new Error('refreshDefinition must be a boolean');
  if (!data.profile || typeof data.profile !== 'string') {
    throw new Error('set_app_profile: "profile" is required when enabled=true');
  }

  const current = context?.current ?? (await getAppProfileForTab(tabId));
  const active = current?.profile === data.profile ? current : undefined;
  const definition =
    !data.refreshDefinition && active?.binding?.definition
      ? active.binding.definition
      : (await resolveAvailableAppProfile(data.profile)).injected.binding!.definition;
  const device = getEmulationConfigForTab(tabId);
  const defaults = {
    ...(await loadStoredAppProfileOptions(data.profile)),
    bridgeConfig: await resolveStoredAppBridgeConfig(data.profile),
  };
  const resolved = resolveAppProfileUpdate(data.profile, {
    current: active,
    definition,
    defaults,
    options: data,
    deviceOptions: {
      devicePreset: device?.presetName,
      orientation: device?.orientation,
      ...context?.deviceOptions,
    },
  });
  let reloaded = false;
  await applyAppProfileEnvironmentForTab(tabId, resolved.injected, async () => {
    if (data.networkControl !== undefined) await setInstalledNetworkControl(tabId, data.networkControl);
    if (data.reload !== false) {
      await reloadTab(tabId);
      reloaded = true;
    }
  });

  return {
    enabled: true,
    profile: resolved.profile,
    label: resolved.label,
    userAgent: resolved.ua,
    os: resolved.injected.platform === 'Android' ? 'android' : 'ios',
    ...(data.networkControl !== undefined && { networkControl: data.networkControl }),
    reloaded,
  };
}
