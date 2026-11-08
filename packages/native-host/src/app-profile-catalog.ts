import { nativeCapabilities } from './native-capability-services.js';
import {
  findPluginRegistration,
  listPluginNames,
  refreshRegisteredPlugin,
} from '@mearl/client/plugin';
import {
  listBuiltinAppProfiles,
  resolveAppProfile,
  type ResolveAppProfileOptions,
} from '@mearl/app-profiles';
import {
  appProfileRevision,
  validateAppProfileDefinition,
  type AppProfileCatalogEntry,
  type AppProfileDefinition,
} from '@mearl/browser-core';

import type { AppCapabilityCatalog as CapabilityCatalog } from './capability-hooks.js';
let cachedFactory: (() => CapabilityCatalog) | undefined;
let cachedCatalog: AppProfileCatalogEntry[] = [];
function capabilityCatalog(): AppProfileCatalogEntry[] {
  const factory = nativeCapabilities.get('app.profileCatalog');
  if (!factory) { cachedFactory = undefined; cachedCatalog = []; return []; }
  if (factory === cachedFactory) return structuredClone(cachedCatalog);
  const contribution = structuredClone(factory());
  if (!contribution || !/^[a-z][a-z0-9-]{0,79}$/.test(contribution.namespace) || !Array.isArray(contribution.profiles) || contribution.profiles.length > 64 || !contribution.bindings || typeof contribution.bindings !== 'object' || Array.isArray(contribution.bindings) || Object.keys(contribution.bindings).length > 64) throw new Error('Invalid capability App catalog');
  const definitions = new Map<string, AppProfileDefinition>();
  for (const raw of contribution.profiles) {
    const definition = validateAppProfileDefinition(raw);
    if (!definition.name.startsWith(contribution.namespace + '/') || definitions.has(definition.name)) throw new Error('Invalid capability App namespace');
    definitions.set(definition.name, definition);
  }
  const bound = new Set<string>();
  const entries: AppProfileCatalogEntry[] = [];
  for (const [id, target] of Object.entries(contribution.bindings)) {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(id) || typeof target !== 'string' || !definitions.has(target)) throw new Error('Invalid capability App binding');
    bound.add(target);
    const definition = validateAppProfileDefinition({ ...definitions.get(target)!, name: id });
    entries.push({ id, label: definition.label, source: 'plugin', plugin: contribution.namespace, revision: appProfileRevision(definition), definition });
  }
  for (const [id, definition] of definitions) if (!bound.has(id)) entries.push({ id, label: definition.label, source: 'plugin', plugin: contribution.namespace, revision: appProfileRevision(definition), definition });
  if (contribution.order !== undefined) {
    if (!Array.isArray(contribution.order) || new Set(contribution.order).size !== contribution.order.length || contribution.order.some(id => !entries.some(entry => entry.id === id))) throw new Error('Invalid capability App order');
    entries.sort((a, b) => { const first = contribution.order!.indexOf(a.id); const second = contribution.order!.indexOf(b.id); return (first < 0 ? Infinity : first) - (second < 0 ? Infinity : second); });
  }
  cachedCatalog = entries; cachedFactory = factory;
  return entries;
}

export function findCapabilityAppProfile(id: string): AppProfileCatalogEntry | undefined { return capabilityCatalog().find(entry => entry.id === id); }

export async function listInstalledAppProfiles(options: { refresh?: boolean } = {}): Promise<{
  profiles: AppProfileCatalogEntry[];
  errors: Array<{ plugin: string; error: string }>;
}> {
  let profiles = listBuiltinAppProfiles();
  const errors: Array<{ plugin: string; error: string }> = [];
  try {
    const contributed = capabilityCatalog();
    if (contributed.length) {
      const overridden = new Set(contributed.map(entry => entry.id));
      profiles = [...contributed, ...profiles.filter(entry => !overridden.has(entry.id))];
    }
  } catch (error) { errors.push({ plugin: 'capabilities', error: error instanceof Error ? error.message : String(error) }); }

  for (const plugin of listPluginNames()) {
    try {
      const registered = findPluginRegistration(plugin);
      if (!registered) continue;
      const registration = options.refresh === false ? registered : await refreshRegisteredPlugin(plugin);
      for (const raw of registration?.appProfiles?.profiles ?? []) {
        if (raw.name.includes('/'))
          throw new Error('Plugin profile names must be local identifiers');
        const id = `${plugin}/${raw.name}`;
        const definition = validateAppProfileDefinition({ ...raw, name: id });
        profiles.push({
          id,
          label: definition.label,
          source: 'plugin',
          plugin,
          revision: appProfileRevision(definition),
          definition,
        });
      }
    } catch (error) {
      errors.push({ plugin, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { profiles, errors };
}

export async function resolveInstalledAppProfile(
  name: string,
  options: ResolveAppProfileOptions = {},
) {
  const contributed = capabilityCatalog().find(entry => entry.id === name);
  if (contributed) return resolveAppProfile(name, options, contributed.definition);
  if (!name.includes('/')) return resolveAppProfile(name, options);
  const catalog = await listInstalledAppProfiles();
  const profile = catalog.profiles.find(candidate => candidate.id === name);
  if (!profile) throw new Error(`App profile is unavailable: ${name}`);
  return resolveAppProfile(name, options, profile.definition);
}
