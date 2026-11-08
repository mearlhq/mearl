import { mergePresetDefaults, resolveCapabilityConfig, type JsonObject } from '@mearl/preset';
import { parseBrowserUiSettings, type BrowserUiSettings } from './browserUiSettings';
import { BundleError } from '@mearl/preset/bundles';
import {
  isQuickAppProfileName,
  isQuickDeviceSelection,
  normalizeQuickDeviceSelection,
  type QuickAppProfileName,
  type QuickDeviceSelection,
} from './quickAppProfile';

export interface BrowserPresetSettings {
  services?: Record<string, boolean>;
  extension?: BrowserUiSettings;
  simulation: {
    app?: QuickAppProfileName;
    deviceSelection?: QuickDeviceSelection & { splitScreen: boolean };
  };
  pending: string[];
}

/** Defaults remain separate from stored user choices and active document state. */
export function resolveBrowserPresetSettings(
  defaults: JsonObject,
  overrides: JsonObject,
  availableProfiles: ReadonlySet<string>,
): BrowserPresetSettings {
  const value = mergePresetDefaults(defaults, overrides);
  const settings: BrowserPresetSettings = { simulation: {}, pending: [] };
  for (const key of Object.keys(value)) if (!['simulation', 'services', 'extension', 'capabilities'].includes(key)) settings.pending.push(key);
  if (value.capabilities !== undefined) resolveCapabilityConfig(value);
  if (value.extension !== undefined) {
    const parsed = parseBrowserUiSettings(value.extension);
    if (Object.keys(parsed.settings).length) settings.extension = parsed.settings;
    settings.pending.push(...parsed.pending);
  }
  if (value.services !== undefined) {
    const services = value.services;
    if (!services || typeof services !== 'object' || Array.isArray(services) || Object.entries(services).some(([key, enabled]) => !/^[a-z][a-zA-Z0-9]{0,95}Enabled$/.test(key) || typeof enabled !== 'boolean')) throw new BundleError('BUNDLE_INVALID', 'Service defaults must map setting keys to booleans');
    settings.services = { ...services } as Record<string, boolean>;
  }
  if (value.simulation === undefined) return settings;
  const simulation = value.simulation;
  if (!simulation || typeof simulation !== 'object' || Array.isArray(simulation))
    throw new BundleError('BUNDLE_INVALID', 'Simulation defaults must be an object');
  for (const key of Object.keys(simulation))
    if (!['app', 'deviceSelection'].includes(key)) settings.pending.push(`simulation.${key}`);
  if (simulation.app !== undefined) {
    if (!isQuickAppProfileName(simulation.app) || !availableProfiles.has(simulation.app))
      throw new BundleError('BUNDLE_INVALID', 'The default simulation app is unavailable');
    settings.simulation.app = simulation.app;
  }
  if (simulation.deviceSelection !== undefined) {
    const selection: unknown = simulation.deviceSelection;
    if (
      !isQuickDeviceSelection(selection) ||
      Object.keys(selection).some(
        key =>
          !['preset', 'orientation', 'fitToWindow', 'deviceShell', 'splitScreen'].includes(key),
      ) ||
      selection.splitScreen === true
    )
      throw new BundleError(
        'BUNDLE_INVALID',
        'Invalid default simulation device; split screen is a document preference',
      );
    settings.simulation.deviceSelection = normalizeQuickDeviceSelection({
      ...selection,
      splitScreen: false,
    });
  }
  return settings;
}
