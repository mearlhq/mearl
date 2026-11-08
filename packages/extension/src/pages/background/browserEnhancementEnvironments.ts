import {
  deviceEnvironmentObservationsEqual, matchesEmulatedDeviceEnvironment,
  resolveEmulationConfig, DEVICE_PRESETS,
  type DeviceEnvironmentObservation, type InjectedAppProfileConfig, type ProviderInitialEnvironment,
  type BrowserEnhancementInvocation, type ResolvedEmulationConfig,
} from '@mearl/browser-core';
import {
  changeAppDeviceEnvironment, resolveAppProfileUpdate, resolveAppDeviceUserAgent,
  type AppDeviceChanges, type AppDeviceEnvironmentHost,
} from '@mearl/app-profiles';
import { readPhysicalDeviceEnvironment } from './deviceEnvironmentObservation';
import { getEnvironmentRevision } from './environmentRevisions';
import { getEmulationConfigForTab } from './deviceEmulationState';
import { getDeviceShellForTab } from './deviceShellRules';
import { getAppProfileForTab } from './utils/appProfileRules';
import { resolveAvailableAppProfile } from './appProfileCatalog';
import { loadStoredAppProfileOptions, resolveStoredAppBridgeConfig } from '../../shared/appBridgeConfig';
import { buildAppProfileRuntimeProgram } from './appProfileRuntimeSource';
import { captureAppProfileHostCapabilities } from './appProfileHostCapabilities';
import { applyAppProfileEnvironmentForTab } from './appProfileLifecycle';
import { handleSetAppProfile } from './agentHandlers/appProfileHandlers';
import { handleSetDeviceEmulation } from './agentHandlers/emulationHandlers';
import { getSafeAreaInsetsForTab, synchronizeAppDeviceIdentityForTab, recordHostEnvironmentObservation, reloadTabInSession } from './debuggerManager';
import { getQuickDeviceSimulationState, hydrateQuickDeviceSimulationState } from './quickDeviceSimulationState';
import { navigateAndWait } from './agentHandlers/tabHandlers';
import { getEnhancementTabUrl } from './browserEnhancementTarget';

type DeviceIntent = { config: ResolvedEmulationConfig | null; shell: Awaited<ReturnType<typeof getDeviceShellForTab>> };
export type EnhancementEnvironmentValues = { device: DeviceIntent; app: InjectedAppProfileConfig | null };
export interface EnhancementEnvironmentState extends AppDeviceChanges<EnhancementEnvironmentValues> {
  initialEnvironment?: ProviderInitialEnvironment;
  appDeviceObservation?: DeviceEnvironmentObservation;
}
type Binding = EnhancementEnvironmentState & { bindingId: string; tabId: number; navigationOrigin?: string };
/** Logical App/device values survive Chrome storage's object-key reordering. Array order remains significant. */
export const appDeviceEnvironmentFingerprint = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && !Array.isArray(item) && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (left: unknown, right: unknown) => appDeviceEnvironmentFingerprint(left) === appDeviceEnvironmentFingerprint(right);
const changedDeviceFields = (before: DeviceEnvironmentObservation, after: DeviceEnvironmentObservation) =>
  (Object.keys(before) as Array<keyof DeviceEnvironmentObservation>).filter(key => !deviceEnvironmentObservationsEqual({ ...before, [key]: after[key] }, before));

/** Called inside the existing per-tab queue. Only the external owner's captured new-target baseline is accepted. */
export function appDeviceEnvironmentHost(record: Binding, save: (fields: EnhancementEnvironmentState) => Promise<void>): AppDeviceEnvironmentHost<EnhancementEnvironmentValues> {
  let latest: DeviceEnvironmentObservation | undefined;
  let initial = record.initialEnvironment?.device;
  return {
    read: async () => {
      if (!initial) throw new Error('ENVIRONMENT_BASELINE_UNSUPPORTED: a captured Provider-created target is required');
      const device: DeviceIntent = { config: getEmulationConfigForTab(record.tabId) ?? null, shell: await getDeviceShellForTab(record.tabId) };
      const app = await getAppProfileForTab(record.tabId) ?? null;
      await hydrateQuickDeviceSimulationState(record.tabId);
      if (!record.device && (getSafeAreaInsetsForTab(record.tabId) || getQuickDeviceSimulationState(record.tabId)?.enabled))
        throw new Error('ENVIRONMENT_BASELINE_UNSUPPORTED: existing Quick Device state is not owned by this binding');
      if ((!record.device && (device.config || device.shell)) || (!record.app && app))
        throw new Error('ENVIRONMENT_BASELINE_UNSUPPORTED: existing App/device state is not owned by this binding');
      const actual = await readPhysicalDeviceEnvironment(record.tabId);
      if (!initial.userAgentMetadata && !record.device && !record.app && actual.userAgentMetadata)
        initial = { ...initial, userAgentMetadata: actual.userAgentMetadata };
      if (!initial.userAgentMetadata) throw new Error('ENVIRONMENT_BASELINE_UNSUPPORTED: native Client Hints must be captured before an override');
      if (!actual.userAgentMetadata) throw new Error('ENVIRONMENT_OBSERVATION_UNAVAILABLE: Client Hints are not observable in this document');
      const active = [record.device, record.app].some(change => change && change.phase === 'active');
      const pending = [record.device, record.app].some(change => change && change.phase !== 'active');
      if (active && !pending && record.appDeviceObservation && !deviceEnvironmentObservationsEqual(actual, record.appDeviceObservation))
        throw new Error(`ENVIRONMENT_STATE_CONFLICT: the physical App/device environment changed (${changedDeviceFields(record.appDeviceObservation, actual).join(', ')})`);
      if (!record.device && !record.app) {
        // Client Hints can first become observable when the blank target reaches a secure document.
        if (!deviceEnvironmentObservationsEqual(actual, initial)) {
          throw new Error(`ENVIRONMENT_BASELINE_UNSUPPORTED: the new-target environment changed (${changedDeviceFields(initial, actual).join(', ')})`);
        }
      } else {
        const identity = resolveAppDeviceUserAgent(initial, device.config, device.shell && app ? app.userAgent : undefined);
        const matches = device.config
          ? matchesEmulatedDeviceEnvironment({ ...device.config, userAgent: identity.userAgent,
            platform: record.initialEnvironment?.preserveHostPlatform ? initial.platform : device.config.platform }, actual) && deviceEnvironmentObservationsEqual(actual, { ...actual, userAgentMetadata: identity.userAgentMetadata })
          : deviceEnvironmentObservationsEqual(actual, initial);
        if (!matches) throw new Error('ENVIRONMENT_EFFECT_UNCONFIRMED: the composed App/device environment does not match its configuration');
      }
      latest = actual;
      const snapshot = async <K extends 'device' | 'app'>(component: K, value: EnhancementEnvironmentValues[K]) => ({
        revision: await getEnvironmentRevision(record.tabId, component), value, fingerprint: appDeviceEnvironmentFingerprint(value),
      });
      return { device: await snapshot('device', device), app: await snapshot('app', app) };
    },
    save: async changes => {
      const committed = (['device', 'app'] as const).every(key => !changes[key] || changes[key]!.phase === 'active');
      await save({ ...record, device: changes.device, app: changes.app,
        ...(initial ? { initialEnvironment: { ...record.initialEnvironment, device: initial } } : {}),
        ...(committed && latest ? { appDeviceObservation: structuredClone(latest) } : {}),
      });
      if (committed && latest) await recordHostEnvironmentObservation(record.tabId, latest);
    },
    matchesRestored: (_component, baseline, current) => same(baseline, current),
  };
}

/** Prepare a fixed accepted App definition and code before any page mutation. */
async function prepareApp(record: Binding, data: Extract<BrowserEnhancementInvocation, { action: 'set_app_profile' }>['data']) {
  if (!data.enabled) return undefined;
  if (!data.profile) throw new Error('set_app_profile requires profile');
  if (data.refreshDefinition !== undefined && typeof data.refreshDefinition !== 'boolean') throw new Error('refreshDefinition must be a boolean');
  if (data.lockDefinition !== undefined && typeof data.lockDefinition !== 'boolean') throw new Error('lockDefinition must be a boolean');
  if (data.lockDefinition === false) throw new Error('BROWSER_ENHANCEMENT_UNSUPPORTED: automatic App definition refresh is not available on this binding');
  if (data.emulation !== undefined && (!data.emulation || typeof data.emulation !== 'object' || Array.isArray(data.emulation))) throw new Error('Invalid App device emulation options');
  const current = await getAppProfileForTab(record.tabId);
  const definition = current?.profile === data.profile && !data.refreshDefinition ? current.binding?.definition
    : (await resolveAvailableAppProfile(data.profile)).injected.binding!.definition;
  const defaults = { ...(await loadStoredAppProfileOptions(data.profile)), bridgeConfig: await resolveStoredAppBridgeConfig(data.profile) };
  const base = resolveAppProfileUpdate(data.profile, { current, definition, defaults, options: { ...data, lockDefinition: true } });
  const device = data.emulation ? resolveEmulationConfig({ enabled: true, preset: base.recommendedPreset, ...data.emulation }) : getEmulationConfigForTab(record.tabId);
  const deviceOptions = device ? {
    devicePreset: device.presetName, orientation: device.orientation,
    ...(data.emulation ? {
      os: device.platform === 'Android' || device.platform === 'OpenHarmony' ? 'android' as const : 'ios' as const,
      deviceModel: data.deviceModel ?? (device.presetName ? DEVICE_PRESETS[device.presetName].appProfileModel : base.injected.binding!.options.deviceModel),
    } : {}),
  } : {};
  const resolved = resolveAppProfileUpdate(data.profile, { current, definition, defaults, options: { ...data, lockDefinition: true }, deviceOptions });
  const config = await captureAppProfileHostCapabilities(resolved.injected);
  await buildAppProfileRuntimeProgram('config', config);
  return { config, device };
}

/** One coordinated transaction for App + device, with one final navigation and separate original baselines. */
export async function invokeAppDeviceEnvironment(record: Binding, invocation: Exclude<BrowserEnhancementInvocation, { action: 'set_timezone' }>, save: (fields: EnhancementEnvironmentState) => Promise<void>, deadline: () => void): Promise<unknown> {
  const data = invocation.data;
  if (typeof data.enabled !== 'boolean') throw new Error(`${invocation.action} requires enabled`);
  if (invocation.action === 'set_app_profile' && invocation.data.networkControl !== undefined)
    throw new Error('BROWSER_ENHANCEMENT_UNSUPPORTED: request environment is managed separately');
  if (invocation.action === 'set_app_profile' && !data.enabled && data.reload === false)
    throw new Error('BROWSER_ENHANCEMENT_UNSUPPORTED: App removal requires a confirmed reload');
  const appData = invocation.action === 'set_app_profile' ? invocation.data : undefined;
  const currentUrl = await getEnhancementTabUrl(record.tabId);
  const firstDocumentPending = Boolean(record.navigationOrigin && !record.device && !record.app &&
    ['about:blank', 'chrome://newtab/'].includes(currentUrl));
  const previousShell = await getDeviceShellForTab(record.tabId);
  if (invocation.action === 'set_device_emulation' && invocation.data.enabled) resolveEmulationConfig(invocation.data);
  const prepared = appData ? await prepareApp(record, appData) : undefined;
  const components = invocation.action === 'set_device_emulation' ? ['device' as const]
    : appData?.emulation !== undefined ? ['device' as const, 'app' as const] : ['app' as const];
  const host = appDeviceEnvironmentHost(record, save);
  const changed = await changeAppDeviceEnvironment(record.bindingId, components, { device: record.device, app: record.app }, host, async () => {
    deadline();
    let result: Record<string, unknown>;
    if (appData) {
      result = await handleSetAppProfile({ ...appData, tabId: record.tabId, reload: false, lockDefinition: true, refreshDefinition: false }, () => null,
        prepared ? { current: prepared.config, deviceOptions: {
          devicePreset: prepared.device?.presetName, orientation: prepared.device?.orientation,
          ...(appData.emulation ? { os: prepared.config.binding!.options.os, deviceModel: prepared.config.binding!.options.deviceModel } : {}),
        } } : undefined) as unknown as Record<string, unknown>;
      if (appData.emulation) {
        deadline();
        result.device = await handleSetDeviceEmulation({ preset: prepared?.device?.presetName, ...appData.emulation, deviceShell: appData.emulation.deviceShell ?? true, tabId: record.tabId, enabled: appData.enabled, reload: false }, () => null, { deferReload: true });
      }
    } else result = await handleSetDeviceEmulation({ ...invocation.data, tabId: record.tabId, reload: false }, () => null, { deferReload: true }) as unknown as Record<string, unknown>;
    // App teardown and device changes share UA/safe area. Recompute the remaining composition.
    const remainingApp = await getAppProfileForTab(record.tabId);
    if (remainingApp) { deadline(); await applyAppProfileEnvironmentForTab(record.tabId, remainingApp); }
    deadline(); await synchronizeAppDeviceIdentityForTab(record.tabId, record.initialEnvironment!.device,
      { preserveHostPlatform: record.initialEnvironment?.preserveHostPlatform, preserveHostInput: record.initialEnvironment?.preserveHostInput });
    const shell = await getDeviceShellForTab(record.tabId);
    const shellChanged = Boolean(previousShell) !== Boolean(shell) || (shell && !same(previousShell, shell));
    if (data.reload !== false || (shellChanged && !firstDocumentPending)) {
      deadline(); const url = await getEnhancementTabUrl(record.tabId);
      await navigateAndWait(record.tabId, url, () => reloadTabInSession(record.tabId));
      result.reloaded = true;
      if (result.device && typeof result.device === 'object') (result.device as Record<string, unknown>).reloaded = true;
    }
    return result;
  }, !data.enabled);
  return changed.result ?? { enabled: false, reloaded: false, ...(invocation.action === 'set_device_emulation' ? { deviceShell: false, splitScreen: false } : {}) };
}
