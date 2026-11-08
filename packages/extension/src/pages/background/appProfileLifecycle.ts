import { findAppProfileDefinitionUpdate, rebuildAppProfileConfig } from '@mearl/app-profiles';
import type { InjectedAppProfileConfig } from '@mearl/browser-core';
import { appProfileRuntimePins, replaceAppProfileRuntimePins } from './appProfileHostCapabilities';
import { resolveAvailableAppProfile } from './appProfileCatalog';
import { browserCapabilityRegistry } from './browserCapabilityRegistry';
import {
  applyAppProfileForTab,
  getAppProfileForTab,
  clearAppProfileForTab,
  appProfileOwnsDeviceEmulation,
  getAppProfileDeviceEmulationForTab,
  listAppProfileTabIds,
} from './utils/appProfileRules';
import {
  enableAppProfileDocumentBootstrapForTab,
  disableAppProfileDocumentBootstrapForTab,
  prepareDeviceShellWebViewEnvironmentForTab,
  clearDeviceShellWebViewEnvironmentForTab,
} from './debuggerManager';
import { getDeviceShellForTab } from './deviceShellRules';
import {
  isQuickSimulationUpdatePending,
  runSerializedQuickSimulationUpdate,
} from './quickSimulationUpdateQueue';
import { getAppProfileCatalog } from './appProfileCatalog';

/** Orphaned UA-only bindings must not impersonate an App without its installed capability. */
export async function removeUnavailableBasicAppProfiles(): Promise<void> {
  const candidates = (await Promise.all((await listAppProfileTabIds()).map(async tabId => ({
    tabId, config: await getAppProfileForTab(tabId),
  })))).filter(({ config }) => config && !config.pageRuntime && !config.bridges.length && !Object.keys(config.globals).length);
  if (!candidates.length) return;
  const catalog = await getAppProfileCatalog();
  if (catalog.offline || catalog.errors.length) return;
  for (const { tabId, config } of candidates) {
    if (catalog.profiles.some(profile => profile.id === config!.profile)) continue;
    await runSerializedQuickSimulationUpdate(tabId, async () => {
      if (await getAppProfileForTab(tabId) !== config) return;
      await clearAppProfileForTab(tabId);
      await disableAppProfileDocumentBootstrapForTab(tabId);
      const shell = await getDeviceShellForTab(tabId);
      if (shell) await prepareDeviceShellWebViewEnvironmentForTab(tabId, shell.emulation, undefined, {
        ...(shell.splitScreen ? { splitScreen: true } : {}),
      });
    });
  }
}

/** DNR, first-document injection and device WebViews are installed and restored together. */
export async function applyAppProfileEnvironmentForTab(
  tabId: number,
  next: InjectedAppProfileConfig,
  persist?: () => Promise<void>,
): Promise<void> {
  const previous = await getAppProfileForTab(tabId);
  const ownership = {
    ownsDeviceEmulation: await appProfileOwnsDeviceEmulation(tabId),
    deviceEmulation: await getAppProfileDeviceEmulationForTab(tabId),
  };
  const shell = await getDeviceShellForTab(tabId);
  const installWebViews = (config?: InjectedAppProfileConfig) =>
    shell
      ? prepareDeviceShellWebViewEnvironmentForTab(tabId, shell.emulation, config, {
          ...(shell.splitScreen ? { splitScreen: true } : {}),
        })
      : clearDeviceShellWebViewEnvironmentForTab(tabId);
  const runtimeOwner = Object.keys(appProfileRuntimePins('transition', previous)).length
    ? `transition:${tabId}:${crypto.randomUUID()}`
    : undefined;
  if (runtimeOwner)
    await browserCapabilityRegistry().pinPageRuntimes({
      ...appProfileRuntimePins(runtimeOwner, previous),
    });
  let releaseRuntimeOwner = true;
  try {
    if (ownership.ownsDeviceEmulation || ownership.deviceEmulation)
      await applyAppProfileForTab(tabId, next, ownership);
    else await applyAppProfileForTab(tabId, next);
    await enableAppProfileDocumentBootstrapForTab(tabId, next);
    await installWebViews(next);
    await persist?.();
  } catch (error) {
    const results = await Promise.allSettled([
      previous ? applyAppProfileForTab(tabId, previous, ownership) : clearAppProfileForTab(tabId),
      previous
        ? enableAppProfileDocumentBootstrapForTab(tabId, previous)
        : disableAppProfileDocumentBootstrapForTab(tabId),
      installWebViews(previous),
    ]);
    const failures = results.flatMap(result =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length) {
      releaseRuntimeOwner = false;
      throw new AggregateError([error, ...failures], 'App profile update and recovery failed', {
        cause: error,
      });
    }
    throw error;
  } finally {
    if (runtimeOwner && releaseRuntimeOwner)
      await browserCapabilityRegistry()
        .pinPageRuntimes(replaceAppProfileRuntimePins(runtimeOwner, previous))
        .catch(error => {
          console.warn('[AppProfile] Failed to release the completed runtime transition:', error);
        });
  }
}

/** A command-triggered reload already owns the per-tab queue; it must never wait on itself. */
export function refreshAppProfileForNavigation(
  tabId: number,
  beforeApply?: () => Promise<void>,
): Promise<InjectedAppProfileConfig | undefined> {
  if (isQuickSimulationUpdatePending(tabId)) return Promise.resolve(undefined);
  return runSerializedQuickSimulationUpdate(tabId, async () => {
    const current = await getAppProfileForTab(tabId);
    if (!current?.binding || current.binding.options.lockDefinition) return undefined;
    const definition = await findAppProfileDefinitionUpdate(
      current,
      async () => (await resolveAvailableAppProfile(current.profile)).injected.binding!.definition,
    );
    if (!definition) return undefined;
    const next = rebuildAppProfileConfig(current, {}, definition);
    await beforeApply?.();
    await applyAppProfileEnvironmentForTab(tabId, next);
    return next;
  });
}
