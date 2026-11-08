import { resolveAppProfileUpdate } from '@mearl/app-profiles';
import { resolveAvailableAppProfile } from './appProfileCatalog';
import { assertDeviceShellSupported } from '../../shared/chromiumVersion';
import {
  DEVICE_PRESETS,
  resolveEmulationConfig,
  type AppProfileName,
  type InjectedAppProfileConfig,
  type SetAppProfileParams,
} from '@mearl/browser-core';
import {
  QUICK_DEVICE_CHROME_UPDATE_ACTION,
  getQuickDeviceChromeConfig,
  getQuickDevicePresetModel,
  getQuickDevicePresetOs,
  isQuickAdaptiveDevicePresetName,
  isQuickAppProfileName,
  isQuickFixedDevicePresetName,
  normalizeQuickDeviceSelection,
  type QuickAppProfileName,
  type QuickDeviceChromeConfig,
  type QuickDeviceEmulationResponse,
  type QuickDeviceOrientation,
  type QuickDeviceSelection,
  type QuickFixedDevicePresetName,
  type QuickDevicePresetName,
} from '../../shared/quickAppProfile';
import { handleSetAppProfile } from './agentHandlers/appProfileHandlers';
import { handleSetDeviceEmulation } from './agentHandlers/emulationHandlers';
import {
  disableSafeAreaInsetsForTab,
  disableEmulationForTab,
  enableEmulationForTab,
  getSafeAreaInsetsForTab,
  clearDeviceShellWebViewEnvironmentForTab,
  prepareDeviceShellWebViewEnvironmentForTab,
  reapplySafeAreaInsetsForTab,
  reloadTabInSession,
  releaseSafeAreaInsetsOwnershipForTab,
  updateDeviceFrameViewportForTab,
} from './debuggerManager';
import { rememberQuickDevicePhoneFramePreference } from './quickAppProfilePreference';
import {
  getEmulationConfigForTab,
  getEmulationFitToWindowForTab,
  setEmulationFitToWindowForTab,
} from './deviceEmulationState';
import { getAppProfileForTab } from './utils/appProfileRules';
import {
  disableQuickDeviceSimulationState,
  getRememberedQuickAppProfileForTab,
  getRememberedQuickDeviceSelectionForTab,
  getQuickDeviceSimulationState,
  hydrateQuickDeviceSimulationState,
  rememberQuickAppProfileForTab,
  setQuickDeviceSimulationState,
  type QuickDeviceSimulationSelection,
} from './quickDeviceSimulationState';
import { runSerializedQuickSimulationUpdate } from './quickSimulationUpdateQueue';
import {
  applyDeviceShellForTab,
  clearDeviceShellForTab,
  getDeviceShellForTab,
  inheritsDeviceViewport,
  type InheritedViewportDeviceEnvironmentConfig,
} from './deviceShellRules';

interface SetQuickDeviceEmulationParams {
  tabId: number;
  preset: QuickDevicePresetName;
  orientation: QuickDeviceOrientation;
  fitToWindow?: boolean;
  deviceShell?: boolean;
  splitScreen?: boolean;
}

interface SetQuickAppSimulationParams {
  tabId: number;
  profile: QuickAppProfileName | null;
  appVersion?: string;
  deviceSelection?: QuickDeviceSelection;
  updateGlobalDefault?: boolean;
}

interface ApplyQuickDeviceEmulationOptions {
  forceReload?: boolean;
  updateGlobalDefault?: boolean;
}

const DEFAULT_QUICK_APP_DEVICE_SELECTION: QuickDeviceSimulationSelection = {
  preset: 'ios-adaptive',
  orientation: 'portrait',
  fitToWindow: false,
  deviceShell: true,
  splitScreen: false,
};

const MIN_FIT_TO_WINDOW_SCALE = 0.1;

export function calculateFitToWindowScale(
  viewportWidth: number,
  viewportHeight: number,
  availableWidth: number | undefined,
  availableHeight: number | undefined,
): number {
  if (!availableWidth || !availableHeight || availableWidth <= 0 || availableHeight <= 0) {
    return 1;
  }
  const fitScale = Math.min(1, availableWidth / viewportWidth, availableHeight / viewportHeight);
  return Math.max(MIN_FIT_TO_WINDOW_SCALE, Math.floor(fitScale * 100) / 100);
}

const getFitToWindowScale = async (
  tabId: number,
  preset: QuickFixedDevicePresetName,
  orientation: QuickDeviceOrientation,
): Promise<number> => {
  const config = resolveEmulationConfig({ enabled: true, preset, orientation });
  try {
    const tab = await chrome.tabs.get(tabId);
    return calculateFitToWindowScale(config.width, config.height, tab.width, tab.height);
  } catch {
    return 1;
  }
};

const getAdaptiveRuntimeConfig = (
  preset: 'ios-adaptive' | 'android-adaptive',
  orientation: QuickDeviceOrientation,
): InheritedViewportDeviceEnvironmentConfig => {
  const runtimePreset = preset === 'ios-adaptive' ? 'iphone-17-pro' : 'pixel-11';
  const base = resolveEmulationConfig({ enabled: true, preset: runtimePreset, orientation });
  const chromeConfig = getQuickDeviceChromeConfig(preset, orientation);
  return {
    viewport: 'inherit',
    mobile: base.mobile,
    userAgent: base.userAgent,
    platform: base.platform,
    platformVersion: base.platformVersion,
    architecture: base.architecture,
    model: base.model,
    touch: base.touch,
    orientation: base.orientation,
    safeAreaInsets: chromeConfig.safeAreaInsets,
    appearance: { cutout: chromeConfig.cutout },
  };
};

const getProfileOs = (config: InjectedAppProfileConfig): 'ios' | 'android' =>
  config.platform === 'Android' ? 'android' : 'ios';

const getDeviceDocumentEnvironmentKey = (preset: QuickDevicePresetName): string => {
  const runtimePreset: QuickFixedDevicePresetName =
    preset === 'ios-adaptive'
      ? 'iphone-17-pro'
      : preset === 'android-adaptive'
        ? 'pixel-11'
        : preset;
  const config = resolveEmulationConfig({ enabled: true, preset: runtimePreset });
  return JSON.stringify([config.userAgent, config.platform, config.mobile, config.touch]);
};

const deviceDocumentEnvironmentChanged = (
  current: QuickDeviceSimulationSelection | null,
  targetPreset: QuickDevicePresetName,
): boolean =>
  current === null ||
  getDeviceDocumentEnvironmentKey(current.preset) !== getDeviceDocumentEnvironmentKey(targetPreset);

const isAppProfileName = (value: string): value is AppProfileName => isQuickAppProfileName(value);

const getProfileUpdateParams = (
  tabId: number,
  config: InjectedAppProfileConfig,
  os: 'ios' | 'android',
  deviceModel: string,
  reload = false,
): SetAppProfileParams => {
  if (!isAppProfileName(config.profile)) {
    throw new Error(`Unknown active App profile: ${config.profile}`);
  }
  return {
    tabId,
    enabled: true,
    profile: config.profile,
    os,
    deviceModel,
    reload,
  };
};

const getActiveSelection = (tabId: number): QuickDeviceSimulationSelection | null => {
  const remembered = getQuickDeviceSimulationState(tabId);
  if (!remembered?.enabled) return null;
  if (isQuickAdaptiveDevicePresetName(remembered.preset)) return remembered;
  const config = getEmulationConfigForTab(tabId);
  if (
    !config ||
    config.presetName !== remembered.preset ||
    config.orientation !== remembered.orientation
  ) {
    return null;
  }
  return remembered;
};

export function getQuickDeviceChromeConfigForTab(tabId: number): QuickDeviceChromeConfig | null {
  const selection = getActiveSelection(tabId);
  return selection?.deviceShell
    ? getQuickDeviceChromeConfig(selection.preset, selection.orientation)
    : null;
}

const notifyQuickDeviceChrome = async (tabId: number): Promise<void> => {
  try {
    const shell = await getDeviceShellForTab(tabId);
    await chrome.tabs.sendMessage?.(tabId, {
      action: QUICK_DEVICE_CHROME_UPDATE_ACTION,
      config: shell?.config ?? getQuickDeviceChromeConfigForTab(tabId),
    });
  } catch {
    // 页面尚未注入 content script 时，会在下一次 document_start 主动读取当前状态。
  }
};

const profileMatchesSelection = (
  profile: InjectedAppProfileConfig,
  selection: QuickDeviceSimulationSelection | null,
): boolean => {
  if (!selection) {
    return true;
  }
  return (
    getProfileOs(profile) === getQuickDevicePresetOs(selection.preset) &&
    (profile.binding?.options.deviceModel ?? profile.globals.__DEVICE_MODEL__) === getQuickDevicePresetModel(selection.preset)
  );
};

const updateProfileForSelection = async (
  tabId: number,
  profile: InjectedAppProfileConfig,
  selection: QuickDeviceSimulationSelection | null,
  reload: boolean,
): Promise<void> => {
  const os = selection ? getQuickDevicePresetOs(selection.preset) : getProfileOs(profile);
  const deviceModel = selection
    ? getQuickDevicePresetModel(selection.preset)
    : (profile.binding?.options.deviceModel ?? profile.globals.__DEVICE_MODEL__);
  const params = getProfileUpdateParams(tabId, profile, os, deviceModel, reload);
  const { os: targetOs, deviceModel: targetModel, ...command } = params;
  await handleSetAppProfile(command, () => null, {
    current: profile,
    deviceOptions: { os: targetOs, deviceModel: targetModel },
  });
};

export function getQuickDeviceEmulationState(tabId: number): QuickDeviceEmulationResponse {
  const selection = getActiveSelection(tabId);
  const remembered = getQuickDeviceSimulationState(tabId);
  const effective = selection ?? remembered;
  return {
    success: true,
    active: Boolean(selection),
    preset: selection?.preset ?? remembered?.preset ?? null,
    ...(effective
      ? {
          orientation: effective.orientation,
          fitToWindow: effective.fitToWindow,
          ...(isQuickAdaptiveDevicePresetName(effective.preset)
            ? { fixedFitToWindow: remembered?.fixedFitToWindow ?? true }
            : {}),
          deviceShell: effective.deviceShell,
          splitScreen: effective.splitScreen,
        }
      : {}),
  };
}

export async function getQuickDeviceEmulationStateWithGlobalDefault(
  tabId: number,
): Promise<QuickDeviceEmulationResponse> {
  await hydrateQuickDeviceSimulationState(tabId);
  const state = getQuickDeviceEmulationState(tabId);
  const shell = await getDeviceShellForTab(tabId);
  if (state.active) {
    return shell?.config.phoneFrame ? { ...state, phoneFrame: true } : state;
  }
  const device = getEmulationConfigForTab(tabId) ?? shell?.emulation;
  if (device && !inheritsDeviceViewport(device) && isQuickFixedDevicePresetName(device.presetName)) {
    return {
      success: true,
      active: true,
      preset: device.presetName,
      orientation: device.orientation,
      fitToWindow: getEmulationFitToWindowForTab(tabId),
      deviceShell: Boolean(shell),
      phoneFrame: Boolean(shell?.config.phoneFrame),
      splitScreen: shell?.splitScreen ?? false,
    };
  }
  const preferred = await getRememberedQuickDeviceSelectionForTab(tabId);
  if (!preferred) return state;
  const remembered = getQuickDeviceSimulationState(tabId);
  return {
    success: true,
    active: false,
    ...preferred,
    ...(isQuickAdaptiveDevicePresetName(preferred.preset)
      ? { fixedFitToWindow: remembered?.fixedFitToWindow ?? true }
      : {}),
  };
}

const applyQuickDeviceEmulation = async (
  {
    tabId,
    preset,
    orientation,
    fitToWindow = true,
    deviceShell = true,
    splitScreen,
  }: SetQuickDeviceEmulationParams,
  options: ApplyQuickDeviceEmulationOptions = {},
): Promise<QuickDeviceEmulationResponse> => {
  if (deviceShell) assertDeviceShellSupported();
  await hydrateQuickDeviceSimulationState(tabId);
  const currentDevice = getEmulationConfigForTab(tabId);
  const currentSelection = getActiveSelection(tabId);
  const documentEnvironmentChanged = deviceDocumentEnvironmentChanged(currentSelection, preset);
  const targetSelection: QuickDeviceSimulationSelection = normalizeQuickDeviceSelection({
    preset,
    orientation,
    fitToWindow,
    deviceShell,
    splitScreen,
  });
  const profile = await getAppProfileForTab(tabId);
  const targetOs = getQuickDevicePresetOs(preset);
  const targetDeviceModel = getQuickDevicePresetModel(preset);
  const profileOsChanged = Boolean(profile && getProfileOs(profile) !== targetOs);
  const profileDeviceModelChanged = Boolean(
    profile && (profile.binding?.options.deviceModel ?? profile.globals.__DEVICE_MODEL__) !== targetDeviceModel,
  );
  const profileDeviceAppearanceChanged = Boolean(
    profile && !profileMatchesSelection(profile, targetSelection),
  );
  const profileNeedsUpdate = Boolean(
    profile && (profileOsChanged || profileDeviceModelChanged || profileDeviceAppearanceChanged),
  );
  const scale =
    !isQuickAdaptiveDevicePresetName(preset) && targetSelection.fitToWindow
      ? await getFitToWindowScale(tabId, preset, orientation)
      : 1;

  if (profile && profileNeedsUpdate) {
    await updateProfileForSelection(
      tabId,
      profile,
      targetSelection,
      isQuickAdaptiveDevicePresetName(preset) && documentEnvironmentChanged,
    );
  }

  try {
    if (isQuickAdaptiveDevicePresetName(preset)) {
      const previousShell = await getDeviceShellForTab(tabId);
      if (currentDevice) await disableEmulationForTab(tabId);
      await reapplySafeAreaInsetsForTab(
        tabId,
        getQuickDeviceChromeConfig(preset, orientation).safeAreaInsets,
      );
      if (deviceShell) {
        const adaptiveConfig = getAdaptiveRuntimeConfig(preset, orientation);
        const chromeConfig = getQuickDeviceChromeConfig(preset, orientation);
        await applyDeviceShellForTab(tabId, chromeConfig, adaptiveConfig, {
          ...(targetSelection.splitScreen ? { splitScreen: true } : {}),
        });
        await prepareDeviceShellWebViewEnvironmentForTab(
          tabId,
          adaptiveConfig,
          await getAppProfileForTab(tabId),
        );
      } else {
        await clearDeviceShellForTab(tabId);
        await clearDeviceShellWebViewEnvironmentForTab(tabId);
      }
      if (
        options.forceReload ||
        Boolean(previousShell) !== deviceShell ||
        documentEnvironmentChanged ||
        previousShell?.emulation.orientation !== orientation ||
        previousShell?.splitScreen !== targetSelection.splitScreen
      ) {
        await reloadTabInSession(tabId);
      }
    } else {
      await handleSetDeviceEmulation(
        {
          tabId,
          enabled: true,
          preset,
          orientation,
          scale,
          deviceShell,
          ...(orientation === 'landscape' ? { splitScreen: targetSelection.splitScreen } : {}),
          ...(documentEnvironmentChanged || options.forceReload ? {} : { reload: false }),
        },
        () => null,
        { preserveQuickDeviceOwnership: true, preservePreviewPanel: !options.forceReload },
      );
      if (currentSelection && isQuickAdaptiveDevicePresetName(currentSelection.preset)) {
        releaseSafeAreaInsetsOwnershipForTab(tabId);
      }
    }
  } catch (error) {
    if (profile && profileNeedsUpdate) {
      await updateProfileForSelection(tabId, profile, currentSelection, true).catch(() => {});
    }
    throw error;
  }

  await setQuickDeviceSimulationState(tabId, targetSelection, {
    updateGlobalDefault: options.updateGlobalDefault,
  });
  if (!isQuickAdaptiveDevicePresetName(preset)) {
    setEmulationFitToWindowForTab(tabId, targetSelection.fitToWindow);
  }
  await notifyQuickDeviceChrome(tabId);
  return getQuickDeviceEmulationStateWithGlobalDefault(tabId);
};

export function setQuickDeviceEmulation(
  params: SetQuickDeviceEmulationParams,
  options: ApplyQuickDeviceEmulationOptions = {},
): Promise<QuickDeviceEmulationResponse> {
  return runSerializedQuickSimulationUpdate(params.tabId, () => applyQuickDeviceEmulation(params, options));
}

export function setQuickDevicePhoneFrame(tabId: number, enabled: boolean): Promise<QuickDeviceEmulationResponse> {
  return runSerializedQuickSimulationUpdate(tabId, async () => {
    const shell = await getDeviceShellForTab(tabId);
    const emulation = shell?.emulation;
    if (!shell || shell.splitScreen || !emulation || inheritsDeviceViewport(emulation) ||
        !isQuickFixedDevicePresetName(emulation.presetName)) {
      throw new Error('Phone frame requires a fixed device with system bars and a single WebView');
    }
    const { config: { phoneFrame, ...systemBars } } = shell;
    if (Boolean(phoneFrame) === enabled) {
      await rememberQuickDevicePhoneFramePreference(enabled);
    } else {
      const fitToWindow = getEmulationFitToWindowForTab(tabId);
      const scale = !enabled && fitToWindow
        ? await getFitToWindowScale(tabId, emulation.presetName, emulation.orientation)
        : emulation.scale;
      const next = { ...emulation, scale };
      const config = enabled ? {
        ...systemBars,
        phoneFrame: {
          width: emulation.width,
          height: emulation.height,
          ...(!fitToWindow && scale !== undefined && scale !== 1 && { maxScale: scale }),
        },
      } : systemBars;
      await applyDeviceShellForTab(tabId, config, next);
      try {
        await updateDeviceFrameViewportForTab(tabId, next);
        await rememberQuickDevicePhoneFramePreference(enabled);
      } catch (error) {
        await applyDeviceShellForTab(tabId, shell.config, emulation)
          .then(() => updateDeviceFrameViewportForTab(tabId, emulation))
          .catch(() => {});
        throw error;
      }
      await notifyQuickDeviceChrome(tabId);
    }
    return { ...await getQuickDeviceEmulationStateWithGlobalDefault(tabId), phoneFrame: enabled };
  });
}

const buildQuickAppProfileResponse = async (
  tabId: number,
  profile: AppProfileName | null,
  device: QuickDeviceEmulationResponse,
  appResult: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => {
  const config = profile ? await getAppProfileForTab(tabId) : undefined;
  const lastProfile = profile ?? (await getRememberedQuickAppProfileForTab(tabId));
  return {
    ...appResult,
    success: true,
    enabled: profile !== null,
    profile,
    ...(lastProfile ? { lastProfile } : {}),
    appVersion: (config?.binding?.options.appVersion ?? config?.globals.__APP_VERSION__) ?? null,
    ...(config ? { os: getProfileOs(config) } : {}),
    device,
  };
};

/** 插件“客户端”开关是组合操作；底层 Agent action 仍保持 App 与设备职责独立。 */
export function setQuickAppSimulation({
  tabId,
  profile,
  appVersion,
  deviceSelection,
  updateGlobalDefault,
}: SetQuickAppSimulationParams): Promise<Record<string, unknown>> {
  return runSerializedQuickSimulationUpdate(tabId, async () => {
    await hydrateQuickDeviceSimulationState(tabId);

    if (profile) {
      const selection = normalizeQuickDeviceSelection(
        deviceSelection ??
          (await getRememberedQuickDeviceSelectionForTab(tabId)) ??
          DEFAULT_QUICK_APP_DEVICE_SELECTION,
      );
      if (selection.deviceShell) assertDeviceShellSupported();
      const previousProfile = await getAppProfileForTab(tabId);
      const previousSelection = getActiveSelection(tabId);
      const previousDevice = getEmulationConfigForTab(tabId);
      const reusePhoneFrame = selection.deviceShell && !selection.splitScreen &&
        previousDevice?.presetName === selection.preset &&
        previousDevice.orientation === selection.orientation &&
        getEmulationFitToWindowForTab(tabId) === selection.fitToWindow &&
        Boolean((await getDeviceShellForTab(tabId))?.config.phoneFrame);
      let fixedViewportPrepared = false;

      try {
        if (!reusePhoneFrame && isQuickFixedDevicePresetName(selection.preset)) {
          const scale = selection.fitToWindow
            ? await getFitToWindowScale(tabId, selection.preset, selection.orientation)
            : 1;
          await enableEmulationForTab(
            tabId,
            resolveEmulationConfig({
              enabled: true,
              preset: selection.preset,
              orientation: selection.orientation,
              scale,
            }),
          );
          fixedViewportPrepared = true;
        }

        const appResult = await handleSetAppProfile(
          {
            tabId,
            enabled: true,
            profile,
            ...(appVersion ? { appVersion } : {}),
            os: getQuickDevicePresetOs(selection.preset),
            deviceModel: getQuickDevicePresetModel(selection.preset),
            reload: reusePhoneFrame,
          },
          () => null,
        );
        let device: QuickDeviceEmulationResponse;
        if (reusePhoneFrame) {
          await setQuickDeviceSimulationState(tabId, selection, { updateGlobalDefault });
          device = await getQuickDeviceEmulationStateWithGlobalDefault(tabId);
        } else {
          device = await applyQuickDeviceEmulation(
            { tabId, ...selection },
            { forceReload: true, updateGlobalDefault },
          );
        }
        await rememberQuickAppProfileForTab(tabId, profile, { updateGlobalDefault });
        return buildQuickAppProfileResponse(
          tabId,
          profile,
          device,
          appResult as unknown as Record<string, unknown>,
        );
      } catch (error) {
        if (fixedViewportPrepared) {
          if (previousDevice) {
            await enableEmulationForTab(tabId, previousDevice).catch(() => {});
          } else {
            await disableEmulationForTab(tabId).catch(() => {});
            if (previousSelection && isQuickAdaptiveDevicePresetName(previousSelection.preset)) {
              await reapplySafeAreaInsetsForTab(
                tabId,
                getQuickDeviceChromeConfig(previousSelection.preset, previousSelection.orientation)
                  .safeAreaInsets,
              ).catch(() => {});
            }
          }
        }
        if (previousProfile) {
          await updateProfileForSelection(tabId, previousProfile, previousSelection, true).catch(
            () => {},
          );
        } else {
          await handleSetAppProfile({ tabId, enabled: false, reload: true }, () => null).catch(
            () => {},
          );
        }
        throw error;
      }
    }

    const previousProfile = await getAppProfileForTab(tabId);
    const hadProfile = Boolean(previousProfile);
    if (previousProfile && isQuickAppProfileName(previousProfile.profile)) {
      await rememberQuickAppProfileForTab(tabId, previousProfile.profile, {
        updateGlobalDefault: false,
      });
    }
    const hadDeviceShell = Boolean(await getDeviceShellForTab(tabId));
    if (hadDeviceShell) {
      await handleSetAppProfile({ tabId, enabled: false, reload: false }, () => null);
    }
    const device = await clearQuickDeviceEmulationInQueue(tabId, {
      clearUnownedDevice: true,
      syncProfile: false,
    });
    if (!hadDeviceShell && hadProfile) {
      await handleSetAppProfile({ tabId, enabled: false, reload: true }, () => null);
    }
    return buildQuickAppProfileResponse(tabId, null, device);
  });
}

/** set_app_profile 只有显式传 emulation 时才联动设备，未传时保持纯 App 注入。 */
export function handleSetAppSimulation(
  data: SetAppProfileParams,
  getActiveTabId: () => number | null,
): Promise<Record<string, unknown>> {
  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId)
    return handleSetAppProfile(data, getActiveTabId) as unknown as Promise<Record<string, unknown>>;
  return runSerializedQuickSimulationUpdate(tabId, () =>
    applyAppSimulation({ ...data, tabId }, getActiveTabId),
  );
}

async function applyAppSimulation(
  data: SetAppProfileParams,
  getActiveTabId: () => number | null,
): Promise<Record<string, unknown>> {
  if (data.emulation === undefined) {
    return handleSetAppProfile(data, getActiveTabId) as unknown as Promise<Record<string, unknown>>;
  }
  if (typeof data.enabled !== 'boolean') {
    throw new Error('set_app_profile: "enabled" is required (true to enable, false to clear)');
  }

  const tabId = data.tabId ?? getActiveTabId();
  if (!tabId) {
    throw new Error('No active tab found. Specify tabId or focus a browser tab.');
  }

  if (!data.enabled) {
    const hadDeviceShell = Boolean(await getDeviceShellForTab(tabId));
    let appResult: Record<string, unknown>;
    let deviceResult: Record<string, unknown>;
    if (hadDeviceShell) {
      appResult = (await handleSetAppProfile(
        { ...data, tabId, reload: false },
        () => null,
      )) as unknown as Record<string, unknown>;
      deviceResult = (await handleSetDeviceEmulation(
        { tabId, enabled: false },
        () => null,
      )) as unknown as Record<string, unknown>;
    } else {
      deviceResult = (await handleSetDeviceEmulation(
        { tabId, enabled: false },
        () => null,
      )) as unknown as Record<string, unknown>;
      appResult = (await handleSetAppProfile({ ...data, tabId }, () => null)) as unknown as Record<
        string,
        unknown
      >;
    }
    return {
      ...appResult,
      device: deviceResult,
      reloaded: appResult.reloaded === true || deviceResult.reloaded === true,
    };
  }

  if (!data.profile) {
    return handleSetAppProfile(data, getActiveTabId) as unknown as Promise<Record<string, unknown>>;
  }
  if (data.emulation.deviceShell !== false) assertDeviceShellSupported();

  const previousProfile = await getAppProfileForTab(tabId);
  const definition =
    previousProfile?.profile === data.profile && !data.refreshDefinition
      ? previousProfile.binding?.definition
      : undefined;
  const profile = resolveAppProfileUpdate(data.profile, {
    current: previousProfile,
    options: data,
    definition:
      definition ?? (await resolveAvailableAppProfile(data.profile)).injected.binding!.definition,
  });
  const deviceConfig = resolveEmulationConfig({
    enabled: true,
    preset: profile.recommendedPreset,
    ...data.emulation,
    deviceShell: data.emulation.deviceShell ?? true,
  });
  const targetOs =
    deviceConfig.platform === 'Android' || deviceConfig.platform === 'OpenHarmony'
      ? 'android'
      : 'ios';
  const targetDeviceModel =
    data.deviceModel ??
    (deviceConfig.presetName
      ? DEVICE_PRESETS[deviceConfig.presetName].appProfileModel
      : (profile.injected.binding?.options.deviceModel ?? profile.injected.globals.__DEVICE_MODEL__));
  const appResult = (await handleSetAppProfile(
    {
      ...data,
      tabId,
      os: targetOs,
      deviceModel: targetDeviceModel,
      reload: false,
    },
    () => null,
  )) as unknown as Record<string, unknown>;

  try {
    const deviceResult = (await handleSetDeviceEmulation(
      {
        tabId,
        enabled: true,
        preset: profile.recommendedPreset,
        ...data.emulation,
        deviceShell: data.emulation.deviceShell ?? true,
        reload: data.reload,
      },
      () => null,
    )) as unknown as Record<string, unknown>;
    return {
      ...appResult,
      device: deviceResult,
      reloaded: appResult.reloaded === true || deviceResult.reloaded === true,
    };
  } catch (error) {
    if (previousProfile) {
      await updateProfileForSelection(
        tabId,
        previousProfile,
        getActiveSelection(tabId),
        true,
      ).catch(() => {});
    } else {
      await handleSetAppProfile({ tabId, enabled: false, reload: true }, () => null).catch(
        () => {},
      );
    }
    throw error;
  }
}

/** 根据 session storage 中的选择重建 service worker 重启后丢失的 CDP 内存状态。 */
export function restoreQuickDeviceEmulationForTab(tabId: number): Promise<void> {
  return runSerializedQuickSimulationUpdate(tabId, async () => {
    await hydrateQuickDeviceSimulationState(tabId);
    const remembered = getQuickDeviceSimulationState(tabId);
    if (!remembered?.enabled) return;

    if (isQuickAdaptiveDevicePresetName(remembered.preset)) {
      const insets = getQuickDeviceChromeConfig(
        remembered.preset,
        remembered.orientation,
      ).safeAreaInsets;
      const currentInsets = getSafeAreaInsetsForTab(tabId);
      const matches =
        currentInsets &&
        (['top', 'right', 'bottom', 'left'] as const).every(
          side => currentInsets[side] === insets[side],
        );
      if (!matches) await reapplySafeAreaInsetsForTab(tabId, insets);
      const currentShell = await getDeviceShellForTab(tabId);
      const expectedSplitScreen = remembered.splitScreen;
      if (
        remembered.deviceShell &&
        (!currentShell ||
          !inheritsDeviceViewport(currentShell.emulation) ||
          currentShell.splitScreen !== expectedSplitScreen)
      ) {
        const config = getAdaptiveRuntimeConfig(remembered.preset, remembered.orientation);
        await applyDeviceShellForTab(
          tabId,
          getQuickDeviceChromeConfig(remembered.preset, remembered.orientation),
          config,
          {
            ...(remembered.splitScreen ? { splitScreen: true } : {}),
          },
        );
        await prepareDeviceShellWebViewEnvironmentForTab(
          tabId,
          config,
          await getAppProfileForTab(tabId),
        );
      }
      return;
    }

    const current = getEmulationConfigForTab(tabId);
    if (
      current?.presetName === remembered.preset &&
      current.orientation === remembered.orientation
    ) {
      setEmulationFitToWindowForTab(tabId, remembered.fitToWindow);
      return;
    }

    const scale = remembered.fitToWindow
      ? await getFitToWindowScale(tabId, remembered.preset, remembered.orientation)
      : 1;
    await handleSetDeviceEmulation(
      {
        tabId,
        enabled: true,
        preset: remembered.preset,
        orientation: remembered.orientation,
        scale,
        deviceShell: remembered.deviceShell,
        ...(remembered.orientation === 'landscape' ? { splitScreen: remembered.splitScreen } : {}),
        reload: false,
      },
      () => null,
      { preserveQuickDeviceOwnership: true },
    );
    setEmulationFitToWindowForTab(tabId, remembered.fitToWindow);
  });
}

const clearQuickDeviceEmulationInQueue = async (
  tabId: number,
  options: { clearUnownedDevice?: boolean; syncProfile?: boolean } = {},
): Promise<QuickDeviceEmulationResponse> => {
  const currentSelection = getActiveSelection(tabId);
  const profile = await getAppProfileForTab(tabId);
  if (currentSelection && isQuickFixedDevicePresetName(currentSelection.preset)) {
    try {
      await handleSetDeviceEmulation({ tabId, enabled: false }, () => null, {
        preserveQuickDeviceOwnership: true,
      });
    } catch (error) {
      if (profile) {
        await updateProfileForSelection(tabId, profile, currentSelection, true).catch(() => {});
      }
      throw error;
    }
  } else if (currentSelection && isQuickAdaptiveDevicePresetName(currentSelection.preset)) {
    await disableSafeAreaInsetsForTab(tabId);
    const hadShell = await clearDeviceShellForTab(tabId);
    await clearDeviceShellWebViewEnvironmentForTab(tabId);
    if (hadShell) await reloadTabInSession(tabId);
  } else if (options.clearUnownedDevice && (getEmulationConfigForTab(tabId) || await getDeviceShellForTab(tabId))) {
    await handleSetDeviceEmulation({ tabId, enabled: false }, () => null, {
      preserveQuickDeviceOwnership: true,
    });
  }
  if (options.syncProfile !== false && profile && !profileMatchesSelection(profile, null)) {
    await updateProfileForSelection(tabId, profile, null, true);
  }
  await disableQuickDeviceSimulationState(tabId);
  await notifyQuickDeviceChrome(tabId);
  return getQuickDeviceEmulationStateWithGlobalDefault(tabId);
};

export function clearQuickDeviceEmulation(tabId: number, options?: { clearUnownedDevice: boolean }): Promise<QuickDeviceEmulationResponse> {
  return runSerializedQuickSimulationUpdate(tabId, async () => {
    await hydrateQuickDeviceSimulationState(tabId);
    return clearQuickDeviceEmulationInQueue(tabId, options);
  });
}

export async function refreshQuickDeviceFitToWindowForWindow(windowId: number): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId });
  await Promise.all(
    tabs.map(tab => {
      if (typeof tab.id !== 'number') return Promise.resolve();
      const tabId = tab.id;
      return runSerializedQuickSimulationUpdate(tabId, async () => {
        if (!getEmulationFitToWindowForTab(tabId)) return;
        const config = getEmulationConfigForTab(tabId);
        if (!config || !isQuickFixedDevicePresetName(config.presetName)) return;
        if ((await getDeviceShellForTab(tabId))?.config.phoneFrame) return;

        const currentTab = await chrome.tabs.get(tabId);
        const scale = calculateFitToWindowScale(
          config.width,
          config.height,
          currentTab.width,
          currentTab.height,
        );
        if (Math.abs(scale - (config.scale ?? 1)) < 0.005) return;

        await enableEmulationForTab(tabId, { ...config, scale });
        setEmulationFitToWindowForTab(tabId, true);
      });
    }),
  );
}
