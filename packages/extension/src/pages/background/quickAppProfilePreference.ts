import { browserCapabilityRegistry } from './browserCapabilityRegistry';
import type { ResolvedEmulationConfig } from '@mearl/browser-core';

import {
  isQuickAppProfileName,
  isQuickFixedDevicePresetName,
  isQuickDeviceSelection,
  getDeviceChromeConfig,
  normalizeQuickDeviceSelection,
  type QuickAppProfileName,
  type QuickDeviceSelection,
} from '../../shared/quickAppProfile';

export async function getPresetSimulationDefaults() {
  try {
    return (await browserCapabilityRegistry().settings()).simulation;
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'ReferenceError',
        'SecurityError',
        'InvalidStateError',
        'UnknownError',
        'VersionError',
      ].includes(error.name)
    )
      return {};
    throw error;
  }
}

const APP_PROFILE_STORAGE_KEY = 'quickLastAppProfile';
const DEVICE_SELECTION_STORAGE_KEY = 'quickLastDeviceSelection';
const PHONE_FRAME_STORAGE_KEY = 'quickDevicePhoneFrame';

export async function getPreferredDeviceChromeConfig(
  config: ResolvedEmulationConfig,
  splitScreen: boolean,
  maxScale?: number,
) {
  const chromeConfig = getDeviceChromeConfig(config);
  if (!splitScreen && isQuickFixedDevicePresetName(config.presetName)) {
    const stored = await chrome.storage.local.get(PHONE_FRAME_STORAGE_KEY);
    if (stored?.[PHONE_FRAME_STORAGE_KEY] !== false) {
      chromeConfig.phoneFrame = {
        width: config.width,
        height: config.height,
        ...(maxScale !== undefined && { maxScale }),
      };
    }
  }
  return chromeConfig;
}

export async function rememberQuickDevicePhoneFramePreference(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [PHONE_FRAME_STORAGE_KEY]: enabled });
}

export async function getLastQuickAppProfile(): Promise<QuickAppProfileName | undefined> {
  const stored = (await Promise.resolve(chrome.storage.local.get(APP_PROFILE_STORAGE_KEY)).catch(
    () => ({}),
  )) as Record<string, unknown> | undefined;
  const profile = stored?.[APP_PROFILE_STORAGE_KEY];
  return isQuickAppProfileName(profile) ? profile : undefined;
}

export async function rememberLastQuickAppProfile(profile: QuickAppProfileName): Promise<void> {
  await Promise.resolve(chrome.storage.local.set({ [APP_PROFILE_STORAGE_KEY]: profile })).catch(
    () => {},
  );
}

/** 分屏只保留在当前页面，不作为新模拟的全局默认。 */
export async function getLastQuickDeviceSelection(): Promise<
  (QuickDeviceSelection & { splitScreen: boolean }) | undefined
> {
  const stored = (await Promise.resolve(
    chrome.storage.local.get(DEVICE_SELECTION_STORAGE_KEY),
  ).catch(() => ({}))) as Record<string, unknown> | undefined;
  const selection = stored?.[DEVICE_SELECTION_STORAGE_KEY];
  return isQuickDeviceSelection(selection)
    ? normalizeQuickDeviceSelection({ ...selection, splitScreen: false })
    : undefined;
}

export async function rememberLastQuickDeviceSelection(
  selection: QuickDeviceSelection,
): Promise<void> {
  const normalized = normalizeQuickDeviceSelection(selection);
  await Promise.resolve(
    chrome.storage.local.set({
      [DEVICE_SELECTION_STORAGE_KEY]: {
        preset: normalized.preset,
        orientation: normalized.orientation,
        fitToWindow: normalized.fitToWindow,
        deviceShell: normalized.deviceShell,
        splitScreen: false,
      },
    }),
  ).catch(() => {});
}
