import { BundleError, readBundleJson, type PreparedBundle } from './bundle.js';
import { clonePresetDefaults, isJsonObject } from './manifest.js';
import { browserUiHttpUrl, validateBrowserUiText, type BrowserUiText } from './requestUi.js';

export interface ExtensionContributions {
  schemaVersion: 1;
  operations?: Record<string, { hook: string; setting?: string }>;
  logins?: Record<string, { url: string; title: BrowserUiText }>;
}

export function validateExtensionContributions(input: unknown): ExtensionContributions {
  const value = clonePresetDefaults(input);
  if (value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', 'operations', 'logins'].includes(key)))
    throw new BundleError('BUNDLE_INVALID', 'Invalid extension contributions');
  for (const kind of ['operations', 'logins'] as const) {
    const entries = value[kind];
    if (entries === undefined) continue;
    if (!isJsonObject(entries) || Object.keys(entries).length > 64) throw new BundleError('BUNDLE_QUOTA', 'Extension contributions exceed 64 entries');
    for (const [name, entry] of Object.entries(entries)) {
      if (!/^[a-z][a-zA-Z0-9_.-]{0,95}$/.test(name) || !isJsonObject(entry)) throw new BundleError('BUNDLE_INVALID', 'Invalid extension contribution name');
      if (kind === 'operations') {
        if (Object.keys(entry).some(key => !['hook', 'setting'].includes(key)) || typeof entry.hook !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,127}$/.test(entry.hook) || entry.setting !== undefined && (typeof entry.setting !== 'string' || !/^[a-z][a-zA-Z0-9]{0,95}Enabled$/.test(entry.setting) || ['agentEnabled', 'sseMonitoringEnabled', 'agentFloatingButtonEnabled'].includes(entry.setting)))
          throw new BundleError('BUNDLE_INVALID', 'Invalid extension operation');
      } else {
        if (Object.keys(entry).some(key => !['url', 'title'].includes(key))) throw new BundleError('BUNDLE_INVALID', 'Invalid extension login');
        entry.url = browserUiHttpUrl(entry.url, { allowFragment: true });
        validateBrowserUiText(entry.title);
      }
    }
  }
  return value as unknown as ExtensionContributions;
}

/** Definitions belong to packages; preset defaults cannot redirect their handlers. */
export function selectExtensionContributions(bundles: PreparedBundle[]) {
  const operations: NonNullable<ExtensionContributions['operations']> = {};
  const logins: NonNullable<ExtensionContributions['logins']> = {};
  const owners: Record<string, { bundleId: string; revision: string }> = {};
  for (const bundle of bundles) {
    const path = bundle.manifest.contributions?.extension;
    if (!path) continue;
    const definition = validateExtensionContributions(readBundleJson(bundle, path));
    const bindings = bundle.manifest.contributions?.browserRuntimes?.extension?.bindings ?? {};
    for (const [name, operation] of Object.entries(definition.operations ?? {})) {
      if (Object.hasOwn(operations, name)) throw new BundleError('BUNDLE_CONFLICT', `Multiple providers for extension operation: ${name}`);
      if (!Object.hasOwn(bindings, operation.hook)) throw new BundleError('BUNDLE_INVALID', 'Extension operation must use its own runtime');
      operations[name] = operation;
      owners[name] = { bundleId: bundle.manifest.id, revision: bundle.revision };
    }
    for (const [name, login] of Object.entries(definition.logins ?? {})) {
      if (Object.hasOwn(logins, name)) throw new BundleError('BUNDLE_CONFLICT', `Multiple providers for extension login: ${name}`);
      logins[name] = login;
    }
  }
  return { operations, logins, owners };
}
