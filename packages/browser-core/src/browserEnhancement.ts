import type { BrowserActionMap } from './browserActionProtocol.js';
import { isDeviceEnvironmentObservation, type DeviceEnvironmentObservation } from './deviceEnvironmentObservation.js';

export const BROWSER_ENHANCEMENT_PROTOCOL_VERSION = 1;
export const BROWSER_ENHANCEMENT_NAVIGATION_ORIGIN_VERSION = 1;
export const BROWSER_ENHANCEMENT_PREPARATION_VERSION = 1;
export const BROWSER_ENHANCEMENT_HOST_ENVIRONMENT_VERSION = 1;
export const BROWSER_ENHANCEMENT_PREPARATION_PATH = 'src/pages/browser-transport/index.html';

/** Only the installed Extension's inert top-level page can prepare a new document. */
export function isBrowserEnhancementPreparationUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return /^[a-p]{32}$/.test(url.hostname) && value === `chrome-extension://${url.hostname}/${BROWSER_ENHANCEMENT_PREPARATION_PATH}`;
  } catch { return false; }
}

/** Narrow internal host contract. Ordinary input, navigation and browser lifecycle are excluded. */
export type BrowserEnhancementAction = 'set_device_emulation' | 'set_app_profile' | 'set_timezone';
export function isBrowserEnhancementAction(value: unknown): value is BrowserEnhancementAction {
  return value === 'set_device_emulation' || value === 'set_app_profile' || value === 'set_timezone';
}
export type BrowserEnhancementInvocation = {
  [A in BrowserEnhancementAction]: { action: A; data: BrowserActionMap[A]['request'] };
}[BrowserEnhancementAction];

export function requiredBrowserEnhancementActions(invocation: BrowserEnhancementInvocation): BrowserEnhancementAction[] {
  return invocation.action === 'set_app_profile' && invocation.data?.emulation !== undefined
    ? ['set_app_profile', 'set_device_emulation'] : [invocation.action];
}

export interface BrowserEnhancementBinding {
  bindingId: string;
  generation: number;
  tabId: number;
  mainFrameId: string;
  targetId?: string;
  actions: BrowserEnhancementAction[];
}

export interface BrowserEnhancementCapabilities {
  protocolVersion: typeof BROWSER_ENHANCEMENT_PROTOCOL_VERSION;
  actions: BrowserEnhancementAction[];
  navigationOriginVersion?: typeof BROWSER_ENHANCEMENT_NAVIGATION_ORIGIN_VERSION;
  preparationVersion?: typeof BROWSER_ENHANCEMENT_PREPARATION_VERSION;
  hostEnvironmentVersion?: typeof BROWSER_ENHANCEMENT_HOST_ENVIRONMENT_VERSION;
}

export interface BrowserEnhancementPreparation {
  tabId: number;
  targetId: string;
  url: string;
  capabilities: BrowserEnhancementCapabilities;
}
export interface ProviderEnhancementPreparation extends BrowserEnhancementPreparation {
  nativeBrowserId: string;
  providerTabId: number;
}

/** Captured by the accepted external owner immediately after creating this target. */
export interface ProviderInitialEnvironment {
  device: DeviceEnvironmentObservation;
  /** Keep the physical root's captured platform while logical App/device identities remain unchanged. */
  preserveHostPlatform?: true;
  /** The external host owns native pointer/touch delivery; Chrome must not convert its mouse events. */
  preserveHostInput?: true;
}
export function isProviderInitialEnvironment(value: unknown): value is ProviderInitialEnvironment {
  if (!value || typeof value !== 'object') return false;
  const device = (value as ProviderInitialEnvironment).device;
  const only = (record: object, keys: string[]) => Object.keys(record).every(key => keys.includes(key));
  try {
    return isDeviceEnvironmentObservation(device) && device.userAgent.length <= 4096 &&
      device.platform.length <= 256 && JSON.stringify(value).length <= 32_768 && only(value, ['device', 'preserveHostPlatform', 'preserveHostInput']) &&
      ((value as ProviderInitialEnvironment).preserveHostPlatform === undefined || (value as ProviderInitialEnvironment).preserveHostPlatform === true) &&
      ((value as ProviderInitialEnvironment).preserveHostInput === undefined || (value as ProviderInitialEnvironment).preserveHostInput === true) &&
      only(device, ['userAgent', 'platform', 'userAgentMetadata', 'screen', 'touchPoints', 'safeAreaInsets']) &&
      only(device.screen, ['width', 'height', 'deviceScaleFactor', 'orientation', 'angle']) && only(device.safeAreaInsets, ['top', 'right', 'bottom', 'left']) &&
      (device.userAgentMetadata === null || (only(device.userAgentMetadata, ['brands', 'fullVersionList', 'fullVersion', 'platform', 'platformVersion', 'architecture', 'model', 'mobile', 'bitness', 'wow64', 'formFactors']) &&
        [...device.userAgentMetadata.brands, ...device.userAgentMetadata.fullVersionList].every(brand => only(brand, ['brand', 'version']))));
  } catch { return false; }
}
export function isEnhancementNavigationOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value; }
  catch { return false; }
}

/** owner is derived by the accepted Provider control host, never from an ordinary action payload. */
export type BrowserEnhancementRequest = (
  | { operation: 'probe'; tabId: number }
  | { operation: 'inspect'; owner: string; tabId: number; targetId: string; actions: BrowserEnhancementAction[]; navigationOrigin: string }
  | { operation: 'bind'; owner: string; tabId: number; mainFrameId: string; targetId?: string; actions: BrowserEnhancementAction[]; navigationOrigin?: string; initialEnvironment?: ProviderInitialEnvironment }
  | ({ operation: 'invoke'; owner: string; bindingId: string; generation: number } & BrowserEnhancementInvocation)
  | { operation: 'release'; owner: string; bindingId: string; generation: number }
) & { deadline?: number };

export type BrowserEnhancementResponse =
  | { capabilities: BrowserEnhancementCapabilities; tabId: number; mainFrameId: string; targetId?: string }
  | { preparation: BrowserEnhancementPreparation }
  | { binding: BrowserEnhancementBinding }
  | { result: unknown }
  | { released: boolean; conflicts?: string[] };

export interface ProviderEnhancementBinding extends BrowserEnhancementBinding {
  nativeBrowserId: string;
  providerTabId: number;
}

/** Read-only control/identity preflight supplied by the external page owner. */
export type ProviderEnhancementTarget =
  | { tabId: number; ready: false }
  | { tabId: number; ready: true; mainFrameId?: string; targetId?: string; url: string; initialEnvironment?: ProviderInitialEnvironment };

export function isProviderEnhancementTarget(value: unknown): value is ProviderEnhancementTarget {
  if (!value || typeof value !== 'object') return false;
  const target = value as Partial<Extract<ProviderEnhancementTarget, { ready: true }>>;
  return Number.isSafeInteger(target.tabId) && target.tabId! >= 0 &&
    ((value as { ready?: unknown }).ready === false || (target.ready === true &&
      (target.mainFrameId === undefined || validIdentity(target.mainFrameId)) &&
      (target.targetId === undefined || validIdentity(target.targetId)) &&
      (target.initialEnvironment === undefined || isProviderInitialEnvironment(target.initialEnvironment)) &&
      (target.mainFrameId !== undefined || target.targetId !== undefined) && typeof target.url === 'string' && Boolean(target.url)));
}

function validIdentity(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }

/** Match every identity asserted by the external owner; URL alone is never proof. */
export function matchesProviderEnhancementTarget(
  target: Extract<ProviderEnhancementTarget, { ready: true }>,
  physical: { mainFrameId: string; targetId?: string },
): boolean {
  return Boolean(target.mainFrameId || target.targetId) &&
    (target.mainFrameId === undefined || target.mainFrameId === physical.mainFrameId) &&
    (target.targetId === undefined || target.targetId === physical.targetId);
}

export function requireReadyProviderEnhancementTarget(value: unknown, tabId: number): Extract<ProviderEnhancementTarget, { ready: true }> {
  if (!isProviderEnhancementTarget(value) || value.tabId !== tabId)
    throw new Error('BROWSER_ENHANCEMENT_PAGE_IDENTITY_UNAVAILABLE');
  if (!value.ready) throw new Error('EXTERNAL_CONTROL_PAUSED: the external page owner has not granted Agent control');
  return value;
}

/** Provider-side request. The control host supplies ownership and physical tab mappings. */
export type ProviderEnhancementRequest =
  | { operation: 'inspect'; providerTabId: number; nativeBrowserId?: string; actions: BrowserEnhancementAction[]; navigationOrigin: string }
  | { operation: 'bind'; providerTabId: number; nativeBrowserId?: string; actions: BrowserEnhancementAction[]; navigationOrigin?: string }
  | ({ operation: 'invoke'; bindingId: string; generation: number } & BrowserEnhancementInvocation)
  | { operation: 'release'; bindingId: string; generation: number };

export type ProviderEnhancementResponse =
  | { preparation: ProviderEnhancementPreparation }
  | { binding: ProviderEnhancementBinding }
  | { result: unknown }
  | { released: boolean; conflicts?: string[] };
