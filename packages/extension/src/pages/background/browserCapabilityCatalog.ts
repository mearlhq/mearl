import { appProfileRevision, APP_PROFILE_NAMES, validateAppProfileDefinition, type AppProfileCatalogEntry } from '@mearl/browser-core';
import { mergePresetDefaults, resolveCapabilityConfig, type ResolvedPreset, type JsonObject } from '@mearl/preset';
import { BundleError, readBundleJson, readBundleText, selectBrowserControl, selectBrowserRequestUi, selectBrowserView, selectExtensionContributions, prepareBrowserBundleSnapshot, type BrowserBundleStore, type PreparedBundle, type BrowserViewSlot } from '@mearl/preset/bundles';
import { validateRequestUiSetting } from '../../shared/browserRequestUiValidation';
import { validateBrowserViewPreferences } from '../../shared/browserViewPreferences';
import { resolveBrowserPresetSettings } from '../../shared/browserPresetSettings';

export type BrowserBundleSelection = Awaited<ReturnType<BrowserBundleStore['list']>>;
export const BROWSER_BUNDLE_API_VERSION = '1.0.0';

export function presetSettings(preset: ResolvedPreset, overrides: JsonObject, bundles: PreparedBundle[], profiles = bundles.flatMap(profileEntries)) {
  const browserControl = selectBrowserControl(bundles);
  const settings = resolveBrowserPresetSettings(
    mergePresetDefaults(preset.defaults, overrides),
    {},
    new Set([
      ...APP_PROFILE_NAMES,
      ...Object.keys(preset.appProfiles),
      ...profiles.map(profile => profile.id),
    ]),
  );
  const declarations = selectExtensionContributions(bundles);
  return { ...settings, extension: { ...settings.extension, operations: declarations.operations, logins: declarations.logins }, browserControl };
}

export function browserPresetStatus(preset: ResolvedPreset, revision: string, browserReady = true) {
  const pending = (['packages', 'skills', 'providers'] as const).flatMap(kind =>
    Object.entries(preset[kind]).flatMap(([id, entry]) =>
      entry.enabled === false
        ? []
        : (entry.targets ?? ['node'])
            .filter(runtime => kind !== 'packages' || runtime !== 'browser')
            .map(runtime => ({ kind, id, runtime })),
    ),
  );
  return {
    id: preset.id,
    version: preset.version,
    revision,
    browserReady,
    ready: browserReady && pending.length === 0,
    pending,
  };
}

export function profileEntries(bundle: PreparedBundle): AppProfileCatalogEntry[] {
  const files = bundle.manifest.contributions?.appProfiles ?? [];
  const ids = new Set<string>();
  return files.map(file => {
    let definition;
    try {
      definition = validateAppProfileDefinition(readBundleJson(bundle, file));
    } catch (error) {
      throw new BundleError(
        'BUNDLE_INVALID',
        error instanceof Error ? error.message : 'Invalid app profile definition',
      );
    }
    if (!definition.name.startsWith(`${bundle.manifest.id}/`) || ids.has(definition.name)) {
      throw new BundleError(
        'BUNDLE_INVALID',
        'App profile names must be unique inside their bundle namespace',
      );
    }
    if (definition.pageRuntime) {
      const runtime = definition.pageRuntime;
      const id = runtime.id.slice(bundle.manifest.id.length + 1);
      const path = bundle.manifest.contributions?.pageRuntimes?.[id];
      if (
        !runtime.id.startsWith(`${bundle.manifest.id}/`) ||
        !path ||
        bundle.manifest.resources[path]?.sha256 !== runtime.sha256 ||
        !readBundleText(bundle, path).trim()
      ) {
        throw new BundleError(
          'BUNDLE_INVALID',
          'The app page runtime must reference its own verified installer resource',
        );
      }
    }
    ids.add(definition.name);
    return {
      id: definition.name,
      label: definition.label,
      source: 'plugin',
      plugin: bundle.manifest.id,
      available: true,
      revision: appProfileRevision(definition),
      definition,
    };
  });
}

function browserProfileCatalog(result: BrowserBundleSelection) {
  const profiles: AppProfileCatalogEntry[] = [];
  const errors = result.errors.map(error => ({ plugin: error.id, error: error.error }));
  for (const bundle of result.bundles) {
    try {
      profiles.push(...profileEntries(bundle));
    } catch (error) {
      errors.push({
        plugin: bundle.manifest.id,
        error: error instanceof Error ? error.message : 'Invalid app profile bundle',
      });
    }
  }
  const bindings = result.activation?.preset.appProfiles ?? {};
  const selected: AppProfileCatalogEntry[] = [];
  for (const [id, target] of Object.entries(bindings)) {
    const bundleId = target.split('/')[0];
    const expected = result.activation!.snapshot.bundleRevisions[bundleId];
    const intact = result.bundles.some(
      bundle => bundle.manifest.id === bundleId && bundle.revision === expected,
    );
    const profile = intact ? profiles.find(profile => profile.id === target) : undefined;
    if (!profile) {
      errors.push({
        plugin: target.split('/')[0],
        error: 'The selected app implementation is missing',
      });
      continue;
    }
    const definition = validateAppProfileDefinition({ ...profile.definition, name: id });
    selected.push({ ...profile, id, definition, revision: appProfileRevision(definition) });
  }
  if (result.activationError) errors.push({ plugin: '', error: result.activationError });
  const selectedTargets = new Set(Object.values(bindings));
  const independentIds = new Map<string, number>();
  const standaloneId = (profile: AppProfileCatalogEntry) =>
    profile.plugin && !Object.hasOwn(result.activation?.snapshot.bundleRevisions ?? {}, profile.plugin)
      ? profile.definition.defaultAppId
      : undefined;
  for (const profile of profiles) {
    const id = standaloneId(profile);
    if (id) independentIds.set(id, (independentIds.get(id) ?? 0) + 1);
  }
  const available = profiles.filter(profile => !selectedTargets.has(profile.id)).flatMap(profile => {
    const id = standaloneId(profile);
    if (!id) return [profile];
    if (Object.hasOwn(bindings, id)) return [];
    if (independentIds.get(id) !== 1) return [profile];
    const definition = { ...profile.definition, name: id };
    return [{ ...profile, id, definition, revision: appProfileRevision(definition) }];
  });
  return {
    profiles: [...selected, ...available],
    errors,
    boundAppIds: Object.keys(bindings),
    presetUnavailable: Boolean(result.activationError),
    preset:
      result.activation &&
      browserPresetStatus(
        result.activation.preset,
        result.activation.snapshot.revision,
        selected.length === Object.keys(bindings).length &&
          !errors.some(error =>
            Object.hasOwn(result.activation!.snapshot.bundleRevisions, error.plugin),
          ),
      ),
    presetRevision: result.activeRevision,
    bundleIds: [
      ...result.bundles.map(bundle => bundle.manifest.id),
      ...result.errors.map(error => error.id),
    ],
  };
}


/** A catalog is derived from one verified snapshot; its lazy sections fail independently. */
const catalogs = new WeakMap<BrowserBundleSelection, ReturnType<typeof createCatalog>>();
function createCatalog(selection: BrowserBundleSelection) {
  let profiles: ReturnType<typeof browserProfileCatalog> | undefined;
  let settings: ReturnType<typeof presetSettings> | undefined;
  let runtimes: ReturnType<typeof prepareBrowserBundleSnapshot> | undefined;
  let request: { value: ReturnType<typeof selectBrowserRequestUi> } | undefined;
  const views = new Map<BrowserViewSlot, ReturnType<typeof selectBrowserView>>();
  const profileCatalog = () => profiles ??= browserProfileCatalog(selection);
  return {
    profiles: profileCatalog,
    settings() {
      if (!settings) {
        const preset = selection.activation?.preset ?? { id: 'standalone', version: '0.0.0', chain: [], packages: {}, skills: {}, providers: {}, appProfiles: {}, defaults: {}, permissions: { origins: [] } };
        settings = presetSettings(preset, selection.installation?.overrides ?? {}, selection.bundles, profileCatalog().profiles);
      }
      return settings;
    },
    runtimes: () => runtimes ??= prepareBrowserBundleSnapshot(selection.bundles, 'extension', BROWSER_BUNDLE_API_VERSION,
      resolveCapabilityConfig(mergePresetDefaults(selection.activation?.preset.defaults ?? {}, selection.installation?.overrides ?? {}))),
    requestUi() {
      if (!request) {
        const value = selectBrowserRequestUi(selection.bundles, BROWSER_BUNDLE_API_VERSION);
        if (value) validateRequestUiSetting(value.definition);
        request = { value };
      }
      return request.value;
    },
    view(slot: BrowserViewSlot) {
      if (!views.has(slot)) views.set(slot, validateBrowserViewPreferences(selectBrowserView(selection.bundles, slot, BROWSER_BUNDLE_API_VERSION)));
      return views.get(slot);
    },
  };
}
export function browserCapabilityCatalog(selection: BrowserBundleSelection) {
  let catalog = catalogs.get(selection);
  if (!catalog) { catalog = createCatalog(selection); catalogs.set(selection, catalog); }
  return catalog;
}
