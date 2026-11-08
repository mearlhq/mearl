import { rebuildAppProfileConfig, updateAppProfileSetting, validateAppBridgeConfig } from '@mearl/app-profiles';
import {
  saveStoredAppProfileBridgeConfig,
  saveStoredAppProfileOptions,
} from '../../shared/appBridgeConfig';
import type { AppProfileName } from '@mearl/browser-core';
import { browserUiText } from '@mearl/preset/bundles';
import { getAppProfileForTab } from './utils/appProfileRules';
import { applyAppProfileEnvironmentForTab } from './appProfileLifecycle';
import { getAppProfileCatalog } from './appProfileCatalog';
import { handleSetAppProfile } from './agentHandlers/appProfileHandlers';
import { runQuickSimulationUpdateWithAutoRuleSync } from './quickSimulationAutoRules';
import { runSerializedQuickSimulationUpdate } from './quickSimulationUpdateQueue';
import { reloadTabInSession } from './debuggerManager';

async function listAppProfileVariants(profile: string, settingsGroup: string) {
  const { profiles } = await getAppProfileCatalog({ refresh: false });
  const active = profiles.find(entry => entry.id === profile);
  if (!active?.plugin || active.definition.settingsGroup !== settingsGroup) return [];
  return profiles.filter(entry =>
    entry.available !== false &&
    entry.plugin === active.plugin &&
    entry.definition.settingsGroup === settingsGroup,
  );
}

export async function getAppProfileVariants(tabId: number, profile: string) {
  const current = await getAppProfileForTab(tabId);
  if (current?.profile !== profile || !current.settingsGroup) return [];
  const variants = await listAppProfileVariants(profile, current.settingsGroup);
  const locale = chrome.i18n.getUILanguage();
  return variants.map(({ id, label, definition }) => ({
    value: id,
    label: definition.labels ? browserUiText(definition.labels, locale) : label,
  }));
}

export function selectAppProfileVariant(tabId: number, profile: string, next: string) {
  return runSerializedQuickSimulationUpdate(tabId, async () => {
    const current = await getAppProfileForTab(tabId);
    if (current?.profile !== profile || !current.settingsGroup) throw new Error('App profile variant is unavailable');
    const variants = await listAppProfileVariants(profile, current.settingsGroup);
    const target = variants.find(variant => variant.id === next);
    if (!target) throw new Error('App profile variant is unavailable');
    if (next === profile) return;
    const options = current.binding?.explicitOptions;
    const languages = target.definition.policies?.languages;
    const language = options?.language;
    await runQuickSimulationUpdateWithAutoRuleSync(
      tabId,
      rule => ({ ...rule, profile: next }),
      () => handleSetAppProfile({
        tabId, enabled: true, profile: next,
        os: options?.os,
        appVersion: options?.appVersion,
        language: language && (!languages || languages.includes(language)) ? language : undefined,
        deviceModel: options?.deviceModel,
      }, () => null),
    );
  });
}

export function setAppProfileSetting(
  tabId: number,
  profile: string,
  settingId: string,
  value: unknown,
) {
  return runSerializedQuickSimulationUpdate(tabId, async () => {
    const current = await getAppProfileForTab(tabId);
    if (!current?.binding || current.profile !== profile)
      throw new Error('App profile is not active for this tab');
    const active = current;
    const next = updateAppProfileSetting(active, settingId, value);
    const setting = active.binding!.definition.settings!.find(item => item.id === settingId)!;
    await applyAppProfileEnvironmentForTab(tabId, next.config, async () => {
      if ('option' in setting.target) {
        await saveStoredAppProfileOptions(profile, { language: next.options.language });
      } else {
        await saveStoredAppProfileBridgeConfig(profile as AppProfileName, {
          methods: {
            [setting.target.method]: next.options.bridgeConfig!.methods[setting.target.method],
          },
        });
      }
    });
    if (next.reload) await reloadTabInSession(tabId);
    return { success: true, responses: next.responses, reload: next.reload };
  });
}

/** The active profile may edit only responses declared by its accepted definition. */
export function setAppProfileRuntimeResponses(
  tabId: number,
  profile: string,
  responses: Record<string, unknown>,
) {
  return runSerializedQuickSimulationUpdate(tabId, async () => {
    const current = await getAppProfileForTab(tabId);
    if (!current?.binding || current.profile !== profile)
      throw new Error('App profile is not active for this tab');
    if (!responses || typeof responses !== 'object' || Array.isArray(responses) || Object.keys(responses).some(method => !Object.hasOwn(current.binding!.definition.actions.responses ?? {}, method))) throw new Error('Undeclared App response');
    const methods = Object.fromEntries(
      Object.entries(responses).map(([method, response]) => [
        method,
        { response, ...(current.actions.silent?.includes(method) && { silent: true }) },
      ]),
    );
    validateAppBridgeConfig({ methods });
    const next = rebuildAppProfileConfig(current, { bridgeConfig: { methods } });
    await applyAppProfileEnvironmentForTab(tabId, next, async () => {
      await saveStoredAppProfileBridgeConfig(profile as AppProfileName, { methods });
    });
    return { success: true };
  });
}
