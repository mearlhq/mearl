import { browserUiText } from '@mearl/preset/bundles';
import {
  getQuickDevicePresetDefaultOrientation,
  getQuickDevicePresetLabel,
  isQuickAppProfileName,
  isQuickDevicePresetName,
  normalizeQuickDeviceFitToWindow,
  QUICK_DEVICE_PRESET_GROUPS,
  type QuickDevicePresetName,
} from '../../shared/quickAppProfile';
import type {
  QuickDeviceToolbarOperation,
  QuickDeviceToolbarState,
} from '../../shared/quickDeviceToolbar';
import { getAppProfileCatalog } from './appProfileCatalog';
import { getDevicePreviewLocale } from './devicePreviewLocale';
import { getDeviceShellForTab } from './deviceShellRules';
import {
  getQuickDeviceEmulationStateWithGlobalDefault,
  restoreQuickDeviceEmulationForTab,
  setQuickDevicePhoneFrame,
} from './quickDeviceEmulation';
import {
  setQuickAppSimulationWithAutoRuleSync,
  setQuickDeviceSimulationWithAutoRuleSync,
} from './quickSimulationAutoRules';
import { getAppProfileForTab } from './utils/appProfileRules';

export async function handleQuickDeviceToolbar(
  tabId: number,
  operation?: QuickDeviceToolbarOperation,
): Promise<QuickDeviceToolbarState | undefined> {
  if (!(await getDeviceShellForTab(tabId))?.config.phoneFrame)
    throw new Error('Device preview is unavailable');
  await restoreQuickDeviceEmulationForTab(tabId);
  if (operation?.type === 'phoneFrame') {
    await setQuickDevicePhoneFrame(tabId, false);
    return;
  }
  const device = await getQuickDeviceEmulationStateWithGlobalDefault(tabId);
  if (!device.active || !device.preset) throw new Error('Device simulation is unavailable');
  const selection = {
    preset: device.preset,
    orientation: device.orientation ?? 'portrait',
    fitToWindow: device.fitToWindow ?? true,
    deviceShell: device.deviceShell ?? true,
    splitScreen: device.splitScreen,
  };

  if (operation?.type === 'app') {
    if (operation.profile !== null && !isQuickAppProfileName(operation.profile))
      throw new Error('Invalid client');
    await setQuickAppSimulationWithAutoRuleSync({
      tabId,
      profile: operation.profile,
      deviceSelection: selection,
    });
    return;
  }
  if (
    operation?.type === 'preset' ||
    operation?.type === 'orientation' ||
    operation?.type === 'shell'
  ) {
    if (operation.type === 'preset') {
      if (operation.preset === null) {
        await setQuickDeviceSimulationWithAutoRuleSync({ tabId, deviceSelection: null });
        return;
      }
      if (!isQuickDevicePresetName(operation.preset)) throw new Error('Invalid device');
      selection.preset = operation.preset;
      selection.orientation = getQuickDevicePresetDefaultOrientation(selection.preset);
      selection.fitToWindow = normalizeQuickDeviceFitToWindow(
        selection.preset,
        device.fixedFitToWindow ?? selection.fitToWindow,
      );
      selection.splitScreen = false;
    } else if (operation.type === 'orientation') {
      selection.orientation = selection.orientation === 'portrait' ? 'landscape' : 'portrait';
    } else {
      selection.deviceShell = false;
    }
    await setQuickDeviceSimulationWithAutoRuleSync({ tabId, deviceSelection: selection });
    return;
  }

  if (operation) throw new Error('Invalid toolbar operation');
  const [profile, { profiles }, { language, message, labels }] = await Promise.all([
    getAppProfileForTab(tabId),
    getAppProfileCatalog({ refresh: false }),
    getDevicePreviewLocale(),
  ]);
  const localizePreset = (id: QuickDevicePresetName) => ({
    id,
    label: getQuickDevicePresetLabel(id, message),
  });
  return {
    profile: profile?.profile ?? null,
    profiles: profiles
      .filter(item => item.available !== false)
      .map(({ id, label, definition }) => ({
        id,
        label: definition.labels ? browserUiText(definition.labels, language) : label,
      })),
    preset: selection.preset,
    presetGroups: QUICK_DEVICE_PRESET_GROUPS.map(({ adaptive, fixed }) => ({
      adaptive: localizePreset(adaptive),
      fixed: fixed.map(localizePreset),
    })),
    orientation: selection.orientation,
    labels,
  };
}
