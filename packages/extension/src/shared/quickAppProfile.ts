import {
  DEVICE_PRESETS,
  getDeviceChromeViewConfig,
  resolveEmulationConfig,
  type AppProfileName,
  type BrowserDevicePresetName,
  type ResolvedEmulationConfig,
  type ResolvedDeviceChromeConfig,
} from '@mearl/browser-core';

export const QUICK_APP_PROFILE_GET_ACTION = 'quickAppProfileGet';
export const QUICK_APP_PROFILE_SET_ACTION = 'quickAppProfileSet';
export const QUICK_APP_PROFILE_SET_VERSION_ACTION = 'quickAppProfileSetVersion';
export const QUICK_DEVICE_EMULATION_GET_ACTION = 'quickDeviceEmulationGet';
export const QUICK_DEVICE_EMULATION_SET_ACTION = 'quickDeviceEmulationSet';
export const QUICK_DEVICE_EMULATION_CLEAR_ACTION = 'quickDeviceEmulationClear';
export const QUICK_DEVICE_SHELL_SET_ACTION = 'quickDeviceShellSet';
export const QUICK_DEVICE_SPLIT_SCREEN_SET_ACTION = 'quickDeviceSplitScreenSet';
export const QUICK_DEVICE_CHROME_GET_ACTION = 'quickDeviceChromeGet';
export const QUICK_DEVICE_CHROME_UPDATE_ACTION = 'quickDeviceChromeUpdate';
export const QUICK_DEVICE_PHONE_FRAME_SET_ACTION = 'quickDevicePhoneFrameSet';
export const QUICK_SIMULATION_AUTO_RULE_GET_ACTION = 'quickSimulationAutoRuleGet';
export const QUICK_SIMULATION_AUTO_RULE_SET_ACTION = 'quickSimulationAutoRuleSet';

export const QUICK_DEVICE_PRESET_NAMES = [
  'ios-adaptive',
  'android-adaptive',
  'iphone-17-pro',
  'iphone-17e',
  'ipad-mini-a17-pro',
  'pixel-11',
  'galaxy-s26',
  'pura-x-max',
  'iphone-duo-folded',
  'iphone-duo-unfolded',
] as const;

export const QUICK_ADAPTIVE_DEVICE_PRESET_NAMES = ['ios-adaptive', 'android-adaptive'] as const;

export const QUICK_FIXED_DEVICE_PRESET_NAMES = [
  'iphone-17-pro',
  'iphone-17e',
  'ipad-mini-a17-pro',
  'pixel-11',
  'galaxy-s26',
  'pura-x-max',
  'iphone-duo-folded',
  'iphone-duo-unfolded',
] as const satisfies readonly BrowserDevicePresetName[];

export type QuickAppProfileName = AppProfileName;
export type QuickAppProfileOs = 'ios' | 'android';
export type QuickDevicePresetName = (typeof QUICK_DEVICE_PRESET_NAMES)[number];
export type QuickAdaptiveDevicePresetName = (typeof QUICK_ADAPTIVE_DEVICE_PRESET_NAMES)[number];
export type QuickFixedDevicePresetName = (typeof QUICK_FIXED_DEVICE_PRESET_NAMES)[number];
export type QuickDeviceOrientation = 'portrait' | 'landscape';

export function getQuickDevicePresetLabel(
  preset: QuickDevicePresetName,
  getMessage: (key: string) => string,
): string {
  switch (preset) {
    case 'ios-adaptive': return getMessage('deviceSimulationIosAdaptive');
    case 'android-adaptive': return getMessage('deviceSimulationAndroidAdaptive');
    case 'iphone-17-pro': return getMessage('deviceSimulationIphone17Pro');
    case 'iphone-17e': return getMessage('deviceSimulationIphone17e');
    case 'ipad-mini-a17-pro': return getMessage('deviceSimulationIpadMiniA17Pro');
    case 'pixel-11': return getMessage('deviceSimulationPixel11');
    case 'galaxy-s26': return getMessage('deviceSimulationGalaxyS26');
    case 'pura-x-max': return getMessage('deviceSimulationPuraXMax');
    case 'iphone-duo-folded': return getMessage('deviceSimulationIphoneDuoFolded');
    case 'iphone-duo-unfolded': return getMessage('deviceSimulationIphoneDuoUnfolded');
  }
}

export interface QuickDeviceSelection {
  preset: QuickDevicePresetName;
  orientation: QuickDeviceOrientation;
  fitToWindow: boolean;
  deviceShell: boolean;
  /** 持久化选择可省略该偏好，读取时按预设类型归一化。 */
  splitScreen?: boolean;
}

export interface QuickSimulationAutoRule {
  domain: string;
  profile: QuickAppProfileName;
  appVersion?: string;
  deviceSelection: QuickDeviceSelection;
}

export interface QuickSimulationAutoRuleResponse {
  success: boolean;
  enabled?: boolean;
  domain?: string | null;
  rule?: QuickSimulationAutoRule;
  error?: string;
}

export interface QuickDeviceChromeConfig extends ResolvedDeviceChromeConfig {
  phoneFrame?: { width: number; height: number; maxScale?: number };
}

export interface QuickAppProfileResponse {
  success: boolean;
  profile?: QuickAppProfileName | null;
  lastProfile?: QuickAppProfileName;
  appVersion?: string | null;
  os?: QuickAppProfileOs;
  device?: QuickDeviceEmulationResponse;
  error?: string;
}

export interface QuickDeviceEmulationResponse {
  success: boolean;
  active?: boolean;
  preset?: QuickDevicePresetName | null;
  orientation?: QuickDeviceOrientation;
  fitToWindow?: boolean;
  /** 自适应预设生效期间保留的固定设备适应窗口偏好。 */
  fixedFitToWindow?: boolean;
  deviceShell?: boolean;
  phoneFrame?: boolean;
  splitScreen?: boolean;
  error?: string;
}

export function getDeviceChromeConfig(emulation: ResolvedEmulationConfig): QuickDeviceChromeConfig {
  return getDeviceChromeViewConfig(emulation);
}

export function isQuickAppProfileName(value: unknown): value is QuickAppProfileName {
  return (
    typeof value === 'string' &&
    value.length <= 161 &&
    !['constructor', 'prototype'].includes(value) &&
    /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/.test(value)
  );
}

export function isQuickDevicePresetName(value: unknown): value is QuickDevicePresetName {
  return QUICK_DEVICE_PRESET_NAMES.some(name => name === value);
}

export function isQuickAdaptiveDevicePresetName(
  value: unknown,
): value is QuickAdaptiveDevicePresetName {
  return QUICK_ADAPTIVE_DEVICE_PRESET_NAMES.some(name => name === value);
}

export function isQuickFixedDevicePresetName(value: unknown): value is QuickFixedDevicePresetName {
  return QUICK_FIXED_DEVICE_PRESET_NAMES.some(name => name === value);
}

export function isQuickDeviceOrientation(value: unknown): value is QuickDeviceOrientation {
  return value === 'portrait' || value === 'landscape';
}

export function isQuickDeviceSelection(value: unknown): value is QuickDeviceSelection {
  if (!value || typeof value !== 'object') return false;
  const selection = value as Partial<QuickDeviceSelection>;
  return (
    isQuickDevicePresetName(selection.preset) &&
    isQuickDeviceOrientation(selection.orientation) &&
    typeof selection.fitToWindow === 'boolean' &&
    typeof selection.deviceShell === 'boolean' &&
    (selection.splitScreen === undefined || typeof selection.splitScreen === 'boolean')
  );
}

export function normalizeQuickDeviceFitToWindow(
  preset: QuickDevicePresetName,
  fitToWindow: boolean,
): boolean {
  return isQuickAdaptiveDevicePresetName(preset) ? false : fitToWindow;
}

export function normalizeQuickDeviceSplitScreen(splitScreen: boolean | undefined): boolean {
  return splitScreen ?? false;
}

/** 自适应视口不缩放；分屏需显式开启。 */
export function normalizeQuickDeviceSelection(
  selection: QuickDeviceSelection,
): QuickDeviceSelection & { splitScreen: boolean } {
  return {
    ...selection,
    fitToWindow: normalizeQuickDeviceFitToWindow(selection.preset, selection.fitToWindow),
    splitScreen: normalizeQuickDeviceSplitScreen(selection.splitScreen),
  };
}

export function getQuickDevicePresetOs(preset: QuickDevicePresetName): QuickAppProfileOs {
  if (preset === 'ios-adaptive') return 'ios';
  if (preset === 'android-adaptive') return 'android';
  return DEVICE_PRESETS[preset].appProfileOs;
}

export function getQuickDevicePresetDefaultOrientation(
  preset: QuickDevicePresetName,
): QuickDeviceOrientation {
  if (isQuickAdaptiveDevicePresetName(preset)) return 'portrait';
  return DEVICE_PRESETS[preset].defaultOrientation ?? 'portrait';
}

export function getQuickDevicePresetModel(preset: QuickDevicePresetName): string {
  if (preset === 'ios-adaptive') return DEVICE_PRESETS['iphone-17-pro'].appProfileModel;
  if (preset === 'android-adaptive') return DEVICE_PRESETS['pixel-11'].appProfileModel;
  return DEVICE_PRESETS[preset].appProfileModel;
}

export function getQuickDeviceChromeConfig(
  preset: QuickDevicePresetName,
  orientation: QuickDeviceOrientation = 'portrait',
): QuickDeviceChromeConfig {
  if (preset === 'ios-adaptive') {
    return getQuickDeviceChromeConfig('iphone-17-pro', orientation);
  }
  if (preset === 'android-adaptive') {
    return getQuickDeviceChromeConfig('pixel-11', orientation);
  }
  return getDeviceChromeViewConfig(resolveEmulationConfig({ enabled: true, preset, orientation }));
}
