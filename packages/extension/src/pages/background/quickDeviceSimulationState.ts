import {
  isQuickAdaptiveDevicePresetName,
  isQuickAppProfileName,
  isQuickDeviceOrientation,
  isQuickDevicePresetName,
  normalizeQuickDeviceSplitScreen,
  type QuickAppProfileName,
  type QuickDeviceSelection,
  type QuickDeviceOrientation,
  type QuickDevicePresetName,
} from '../../shared/quickAppProfile';
import {
  disableSafeAreaInsetsForTab,
  releaseSafeAreaInsetsOwnershipForTab,
} from './debuggerManager';
import {
  getLastQuickAppProfile,
  getPresetSimulationDefaults,
  getLastQuickDeviceSelection,
  rememberLastQuickAppProfile,
  rememberLastQuickDeviceSelection,
} from './quickAppProfilePreference';

export interface QuickDeviceSimulationState {
  enabled: boolean;
  lastAppProfile?: QuickAppProfileName;
  preset: QuickDevicePresetName;
  orientation: QuickDeviceOrientation;
  fitToWindow: boolean;
  /** 当前为自适应预设时，保留最近一次固定设备的适应窗口偏好。 */
  fixedFitToWindow?: boolean;
  deviceShell: boolean;
  splitScreen: boolean;
}

export type QuickDeviceSimulationSelection = QuickDeviceSelection & { splitScreen: boolean };
type QuickDeviceSimulationSelectionInput = Omit<
  QuickDeviceSimulationSelection,
  'deviceShell' | 'splitScreen'
> & {
  deviceShell?: boolean;
  splitScreen?: boolean;
};

const tabQuickDeviceSimulationStates = new Map<number, QuickDeviceSimulationState>();
const hydratedTabIds = new Set<number>();
const hydrationPromises = new Map<number, Promise<void>>();
const STORAGE_KEY_PREFIX = 'quickDeviceSimulationState:';

const storageKey = (tabId: number): string => `${STORAGE_KEY_PREFIX}${tabId}`;

const getSessionStorage = (): chrome.storage.StorageArea | undefined => chrome.storage?.session;

const isStoredState = (value: unknown): value is QuickDeviceSimulationState => {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<QuickDeviceSimulationState>;
  return (
    typeof state.enabled === 'boolean' &&
    (state.lastAppProfile === undefined || isQuickAppProfileName(state.lastAppProfile)) &&
    isQuickDevicePresetName(state.preset) &&
    isQuickDeviceOrientation(state.orientation) &&
    typeof state.fitToWindow === 'boolean' &&
    (state.fixedFitToWindow === undefined || typeof state.fixedFitToWindow === 'boolean') &&
    (state.deviceShell === undefined || typeof state.deviceShell === 'boolean') &&
    (state.splitScreen === undefined || typeof state.splitScreen === 'boolean')
  );
};

const restoreStoredState = (stored: QuickDeviceSimulationState): QuickDeviceSimulationState => {
  const { fixedFitToWindow, ...state } = stored;
  return {
    ...state,
    ...(isQuickAdaptiveDevicePresetName(state.preset)
      ? { fixedFitToWindow: fixedFitToWindow ?? true }
      : {}),
    deviceShell: state.deviceShell ?? true,
    splitScreen: normalizeQuickDeviceSplitScreen(state.splitScreen),
  };
};

const getFixedFitToWindow = (
  previous: QuickDeviceSimulationState | undefined,
  preset: QuickDevicePresetName,
): boolean | undefined => {
  if (!isQuickAdaptiveDevicePresetName(preset)) return undefined;
  if (!previous) return true;
  return isQuickAdaptiveDevicePresetName(previous.preset)
    ? (previous.fixedFitToWindow ?? true)
    : previous.fitToWindow;
};

/** MV3 service worker 重启后从 session storage 恢复当前 tab 的快捷设备选择。 */
export async function hydrateQuickDeviceSimulationState(tabId: number): Promise<void> {
  if (hydratedTabIds.has(tabId)) return;
  const pending = hydrationPromises.get(tabId);
  if (pending) return pending;

  const hydration = (async () => {
    const storage = getSessionStorage();
    if (storage) {
      const key = storageKey(tabId);
      const stored: Record<string, unknown> = await storage.get(key).catch(() => ({}));
      if (!hydratedTabIds.has(tabId) && isStoredState(stored[key])) {
        tabQuickDeviceSimulationStates.set(tabId, restoreStoredState(stored[key]));
      }
    }
    hydratedTabIds.add(tabId);
  })().finally(() => hydrationPromises.delete(tabId));
  hydrationPromises.set(tabId, hydration);
  return hydration;
}

export function getQuickDeviceSimulationState(
  tabId: number,
): QuickDeviceSimulationState | undefined {
  return tabQuickDeviceSimulationStates.get(tabId);
}

export async function listActiveQuickDeviceSimulationTabIds(): Promise<number[]> {
  const storage = getSessionStorage();
  if (storage) {
    const stored = (await storage.get(null).catch(() => ({}))) as Record<string, unknown>;
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(STORAGE_KEY_PREFIX) || !isStoredState(value)) continue;
      const tabId = Number(key.slice(STORAGE_KEY_PREFIX.length));
      if (!Number.isSafeInteger(tabId) || tabId <= 0) continue;
      if (!hydratedTabIds.has(tabId)) {
        tabQuickDeviceSimulationStates.set(tabId, restoreStoredState(value));
        hydratedTabIds.add(tabId);
      }
    }
  }
  return [...tabQuickDeviceSimulationStates.entries()]
    .filter(([, state]) => state.enabled)
    .map(([tabId]) => tabId)
    .sort((a, b) => a - b);
}

export function setQuickDeviceSimulationState(
  tabId: number,
  selection: QuickDeviceSimulationSelectionInput,
  options: { updateGlobalDefault?: boolean } = {},
): Promise<QuickDeviceSimulationState> {
  const previous = tabQuickDeviceSimulationStates.get(tabId);
  const lastAppProfile = previous?.lastAppProfile;
  const fixedFitToWindow = getFixedFitToWindow(previous, selection.preset);
  const state: QuickDeviceSimulationState = {
    enabled: true,
    ...(lastAppProfile ? { lastAppProfile } : {}),
    ...selection,
    ...(fixedFitToWindow === undefined ? {} : { fixedFitToWindow }),
    deviceShell: selection.deviceShell ?? true,
    splitScreen: normalizeQuickDeviceSplitScreen(selection.splitScreen),
  };
  hydratedTabIds.add(tabId);
  tabQuickDeviceSimulationStates.set(tabId, state);
  const persistTabState = (
    getSessionStorage()?.set({ [storageKey(tabId)]: state }) ?? Promise.resolve()
  ).catch(() => {});
  const persistGlobalDefault =
    options.updateGlobalDefault === false
      ? Promise.resolve()
      : rememberLastQuickDeviceSelection(state);
  return Promise.all([persistTabState, persistGlobalDefault]).then(() => state);
}

export async function rememberQuickAppProfileForTab(
  tabId: number,
  profile: QuickAppProfileName,
  options: { updateGlobalDefault?: boolean } = {},
): Promise<QuickDeviceSimulationState | undefined> {
  await Promise.all([
    hydrateQuickDeviceSimulationState(tabId),
    options.updateGlobalDefault === false
      ? Promise.resolve()
      : rememberLastQuickAppProfile(profile),
  ]);
  const current = tabQuickDeviceSimulationStates.get(tabId);
  if (!current) return undefined;

  const state = { ...current, lastAppProfile: profile };
  tabQuickDeviceSimulationStates.set(tabId, state);
  await getSessionStorage()
    ?.set({ [storageKey(tabId)]: state })
    .catch(() => {});
  return state;
}

export async function getRememberedQuickAppProfileForTab(
  tabId: number,
): Promise<QuickAppProfileName | undefined> {
  await hydrateQuickDeviceSimulationState(tabId);
  return (
    (await getLastQuickAppProfile()) ??
    tabQuickDeviceSimulationStates.get(tabId)?.lastAppProfile ??
    (await getPresetSimulationDefaults()).app
  );
}

export async function getRememberedQuickDeviceSelectionForTab(
  tabId: number,
): Promise<QuickDeviceSimulationSelection | undefined> {
  await hydrateQuickDeviceSimulationState(tabId);
  const globalSelection = await getLastQuickDeviceSelection();
  if (globalSelection) return globalSelection;
  const tabState = tabQuickDeviceSimulationStates.get(tabId);
  if (!tabState) return (await getPresetSimulationDefaults()).deviceSelection;
  const selection = {
    preset: tabState.preset,
    orientation: tabState.orientation,
    fitToWindow: tabState.fitToWindow,
    deviceShell: tabState.deviceShell,
    splitScreen: false,
  };
  await rememberLastQuickDeviceSelection(selection);
  return selection;
}

export function disableQuickDeviceSimulationState(
  tabId: number,
): Promise<QuickDeviceSimulationState | undefined> {
  const current = tabQuickDeviceSimulationStates.get(tabId);
  if (!current) return Promise.resolve(undefined);

  const state = { ...current, enabled: false, splitScreen: false };
  tabQuickDeviceSimulationStates.set(tabId, state);
  return (getSessionStorage()?.set({ [storageKey(tabId)]: state }) ?? Promise.resolve())
    .catch(() => {})
    .then(() => state);
}

export async function deleteQuickDeviceSimulationState(tabId: number): Promise<void> {
  await hydrationPromises.get(tabId);
  tabQuickDeviceSimulationStates.delete(tabId);
  hydratedTabIds.add(tabId);
  await getSessionStorage()
    ?.remove(storageKey(tabId))
    .catch(() => {});
}

/** 非 Quick 控制面接管设备时释放其可视层所有权，并保留最后一次快捷选择。 */
export async function releaseQuickDeviceSimulationOwnership(
  tabId: number,
  options: { preserveAppliedDeviceEnvironment?: boolean } = {},
): Promise<void> {
  await hydrateQuickDeviceSimulationState(tabId);
  const current = getQuickDeviceSimulationState(tabId);
  if (!current?.enabled) return;
  if (isQuickAdaptiveDevicePresetName(current.preset)) {
    if (options.preserveAppliedDeviceEnvironment) {
      releaseSafeAreaInsetsOwnershipForTab(tabId);
    } else {
      await disableSafeAreaInsetsForTab(tabId);
    }
  }
  await disableQuickDeviceSimulationState(tabId);
}
