import type { ResolvedEmulationConfig } from './deviceEmulation.js';

export interface DeviceUserAgentMetadata {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  fullVersion?: string;
  platform: string; platformVersion: string; architecture: string; model: string; mobile: boolean;
  bitness?: string; wow64?: boolean; formFactors?: string[];
}
export interface DeviceEnvironmentObservation {
  userAgent: string;
  platform: string;
  userAgentMetadata: DeviceUserAgentMetadata | null;
  screen: { width: number; height: number; deviceScaleFactor: number; orientation: string; angle: number };
  touchPoints: number;
  safeAreaInsets: { top: number; right: number; bottom: number; left: number };
}

/** Explicitly disables UA Client Hints for an emulated UA, matching Chrome's omitted-metadata behavior. */
export function emptyDeviceUserAgentMetadata(): DeviceUserAgentMetadata {
  return { brands: [], fullVersionList: [], fullVersion: '', platform: '', platformVersion: '', architecture: '', model: '',
    mobile: false, bitness: '', wow64: false, formFactors: [] };
}

/** Self-contained observation for an isolated page world; no retained DOM or page globals. */
export async function observeDeviceEnvironment(): Promise<DeviceEnvironmentObservation> {
  const data = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<any> } }).userAgentData;
  let userAgentMetadata: DeviceUserAgentMetadata | null = null;
  if (data) {
    const values = await data.getHighEntropyValues(['architecture', 'bitness', 'fullVersionList', 'model', 'platformVersion', 'uaFullVersion', 'wow64', 'formFactors']);
    userAgentMetadata = {
      brands: values.brands, fullVersionList: values.fullVersionList,
      ...(typeof values.uaFullVersion === 'string' ? { fullVersion: values.uaFullVersion } : {}),
      platform: values.platform, platformVersion: values.platformVersion, architecture: values.architecture, model: values.model, mobile: values.mobile,
      ...(typeof values.bitness === 'string' ? { bitness: values.bitness } : {}),
      ...(typeof values.wow64 === 'boolean' ? { wow64: values.wow64 } : {}),
      ...(Array.isArray(values.formFactors) ? { formFactors: values.formFactors } : {}),
    };
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'all:initial!important;position:fixed!important;visibility:hidden!important;pointer-events:none!important;width:0!important;height:0!important;padding-top:env(safe-area-inset-top)!important;padding-right:env(safe-area-inset-right)!important;padding-bottom:env(safe-area-inset-bottom)!important;padding-left:env(safe-area-inset-left)!important;';
  document.documentElement.appendChild(probe);
  try {
    const style = getComputedStyle(probe);
    return {
      userAgent: navigator.userAgent, platform: navigator.platform, userAgentMetadata,
      screen: { width: screen.width, height: screen.height, deviceScaleFactor: devicePixelRatio, orientation: screen.orientation.type, angle: screen.orientation.angle },
      touchPoints: navigator.maxTouchPoints,
      safeAreaInsets: { top: parseFloat(style.paddingTop) || 0, right: parseFloat(style.paddingRight) || 0, bottom: parseFloat(style.paddingBottom) || 0, left: parseFloat(style.paddingLeft) || 0 },
    };
  } finally { probe.remove(); }
}

export function isDeviceUserAgentMetadata(value: unknown): value is DeviceUserAgentMetadata {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as DeviceUserAgentMetadata;
  const brands = (value: unknown) => Array.isArray(value) && value.every(item => item && typeof item.brand === 'string' && typeof item.version === 'string');
  return brands(metadata.brands) && brands(metadata.fullVersionList) &&
    [metadata.platform, metadata.platformVersion, metadata.architecture, metadata.model].every(value => typeof value === 'string') &&
    typeof metadata.mobile === 'boolean' && (metadata.fullVersion === undefined || typeof metadata.fullVersion === 'string') &&
    (metadata.bitness === undefined || typeof metadata.bitness === 'string') && (metadata.wow64 === undefined || typeof metadata.wow64 === 'boolean') &&
    (metadata.formFactors === undefined || (Array.isArray(metadata.formFactors) && metadata.formFactors.every(value => typeof value === 'string')));
}
export function isDeviceEnvironmentObservation(value: unknown): value is DeviceEnvironmentObservation {
  if (!value || typeof value !== 'object') return false;
  const current = value as DeviceEnvironmentObservation;
  return typeof current.userAgent === 'string' && typeof current.platform === 'string' &&
    (current.userAgentMetadata === null || isDeviceUserAgentMetadata(current.userAgentMetadata)) &&
    Boolean(current.screen) && [current.screen.width, current.screen.height, current.screen.deviceScaleFactor].every(value => Number.isFinite(value) && value > 0) &&
    typeof current.screen.orientation === 'string' && Number.isFinite(current.screen.angle) &&
    Number.isSafeInteger(current.touchPoints) && current.touchPoints >= 0 && Boolean(current.safeAreaInsets) &&
    [current.safeAreaInsets.top, current.safeAreaInsets.right, current.safeAreaInsets.bottom, current.safeAreaInsets.left].every(value => Number.isFinite(value) && value >= 0);
}

/** CDP transports can reorder object keys. Values and array order remain significant. */
export function deviceEnvironmentObservationsEqual(left: DeviceEnvironmentObservation, right: DeviceEnvironmentObservation): boolean {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered((value as Record<string, unknown>)[key])]));
    return value;
  };
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

export function matchesEmulatedDeviceEnvironment(config: ResolvedEmulationConfig, observed: DeviceEnvironmentObservation): boolean {
  return observed.userAgent === config.userAgent && observed.platform === config.platform &&
    observed.screen.width === config.width && observed.screen.height === config.height &&
    Math.abs(observed.screen.deviceScaleFactor - config.deviceScaleFactor) < 0.0001 &&
    observed.screen.orientation.startsWith(config.orientation) && observed.screen.angle === (config.orientation === 'landscape' ? 90 : 0) &&
    observed.touchPoints === (config.touch ? 5 : 0) &&
    (['top', 'right', 'bottom', 'left'] as const).every(edge => observed.safeAreaInsets[edge] === config.safeAreaInsets[edge]);
}
