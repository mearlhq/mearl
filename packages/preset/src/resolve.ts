import { parseToolboxCatalogs } from './toolboxCatalogs.js';
import { parseSetupManagement } from './management.js';
import satisfies from 'semver/functions/satisfies.js';
import valid from 'semver/functions/valid.js';
import { clonePresetDefaults, isJsonObject, PresetError, validatePreset } from './manifest.js';
import type {
  JsonObject,
  PresetComponentKind,
  ResolvePresetOptions,
  ResolvedComponent,
  ResolvedPreset,
} from './types.js';

const kinds: PresetComponentKind[] = ['packages', 'skills', 'providers'];

/** Objects merge recursively; arrays, scalars and explicit null replace the previous value. */
export function mergePresetDefaults(base: JsonObject, overrides: JsonObject): JsonObject {
  const result = clonePresetDefaults(base);
  for (const [key, value] of Object.entries(clonePresetDefaults(overrides))) {
    result[key] =
      isJsonObject(value) && isJsonObject(result[key])
        ? mergePresetDefaults(result[key] as JsonObject, value as JsonObject)
        : value;
  }
  return result;
}

function sourceUrl(source: string, parent?: string): string {
  try {
    const url = parent ? new URL(source, parent) : new URL(source);
    if (!['https:', 'http:', 'file:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('unsupported source');
    }
    // URL fragments do not identify a different manifest for transport or cycle detection.
    url.hash = '';
    return url.href;
  } catch {
    throw new PresetError(
      'PRESET_INVALID',
      'Expected an absolute HTTP(S)/file source URL without embedded credentials',
    );
  }
}

/** Install sources retain the selected tool's repository, package and ref syntax. */
function componentSource(kind: PresetComponentKind, source: string, parent: string): string {
  if (kind === 'packages') return sourceUrl(source, parent);
  if (source.length > 8192 || /^[\s-]/.test(source) || /[\0-\x1f\x7f]/.test(source))
    throw new PresetError('PRESET_INVALID', 'Invalid component install source');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    try {
      if (new URL(source).password) throw new Error('embedded credentials');
    } catch {
      throw new PresetError('PRESET_INVALID', 'Invalid component install URL');
    }
  }
  if (/^(?:https?:|file:|\.{1,2}\/|\/)/i.test(source)) {
    try {
      const url = new URL(source, parent);
      if (url.username || url.password) throw new Error('embedded credentials');
      return url.href;
    } catch {
      throw new PresetError('PRESET_INVALID', 'Invalid component install URL');
    }
  }
  return source;
}

function validateDependencies(
  kind: PresetComponentKind,
  entries: Record<string, ResolvedComponent>,
): void {
  const active = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (active.has(id))
      throw new PresetError('PRESET_DEPENDENCY', `${kind}: dependency cycle at ${id}`);
    const entry = entries[id];
    if (!entry || entry.enabled === false)
      throw new PresetError('PRESET_DEPENDENCY', `${kind}: missing or disabled dependency ${id}`);
    if (!entry.source)
      throw new PresetError('PRESET_INVALID', `${kind}.${id}: enabled component requires a source`);
    active.add(id);
    for (const dependency of entry.dependsOn ?? []) visit(dependency);
    active.delete(id);
    done.add(id);
  };
  for (const [id, entry] of Object.entries(entries)) if (entry.enabled !== false) visit(id);
}

/** Pure resolution: transport and installation are supplied by the browser or Node host. */
export async function resolvePreset(
  source: string,
  options: ResolvePresetOptions,
): Promise<ResolvedPreset> {
  if (valid(options.mearlApiVersion) !== options.mearlApiVersion) {
    throw new PresetError('PRESET_INVALID', 'mearlApiVersion requires an exact semantic version');
  }
  const active = new Set<string>();
  const load = async (url: string): Promise<ResolvedPreset> => {
    options.signal?.throwIfAborted();
    if (active.has(url)) throw new PresetError('PRESET_CYCLE', `Inheritance cycle at ${url}`);
    if (active.size >= 32)
      throw new PresetError('PRESET_INVALID', 'Inheritance exceeds 32 presets');
    active.add(url);
    const manifest = validatePreset(await options.load(url));
    options.signal?.throwIfAborted();
    if (
      manifest.requires?.mearlApi &&
      !satisfies(options.mearlApiVersion, manifest.requires.mearlApi)
    ) {
      throw new PresetError(
        'PRESET_INCOMPATIBLE',
        `${manifest.id} requires Mearl API ${manifest.requires.mearlApi}`,
      );
    }
    let parent: ResolvedPreset | undefined;
    if (manifest.extends) {
      parent = await load(sourceUrl(manifest.extends.source, url));
      if (manifest.extends.version && !satisfies(parent.version, manifest.extends.version)) {
        throw new PresetError(
          'PRESET_INCOMPATIBLE',
          `${manifest.id} requires parent ${manifest.extends.version}; received ${parent.version}`,
        );
      }
    }
    const result: ResolvedPreset = {
      id: manifest.id,
      version: manifest.version,
      chain: [
        ...(parent?.chain ?? []),
        { source: url, id: manifest.id, version: manifest.version },
      ],
      packages: { ...parent?.packages },
      skills: { ...parent?.skills },
      providers: { ...parent?.providers },
      appProfiles: { ...parent?.appProfiles, ...manifest.appProfiles },
      defaults: mergePresetDefaults(parent?.defaults ?? {}, manifest.defaults ?? {}),
      permissions: {
        origins: [
          ...new Set([
            ...(parent?.permissions.origins ?? []),
            ...(manifest.permissions?.origins ?? []),
          ]),
        ],
      },
    };
    for (const kind of kinds) {
      for (const [id, patch] of Object.entries(manifest[kind] ?? {})) {
        result[kind][id] = {
          ...result[kind][id],
          ...patch,
          ...(patch.source === undefined
            ? {}
            : { source: componentSource(kind, patch.source, url) }),
          ...(patch.migrateFrom === undefined
            ? {}
            : { migrateFrom: patch.migrateFrom.map(source => componentSource(kind, source, url)) }),
          declaredBy: url,
        };
      }
    }
    active.delete(url);
    return result;
  };
  const result = await load(sourceUrl(source));
  parseSetupManagement(result.defaults.management);
  const extension = result.defaults.extension;
  if (isJsonObject(extension)) parseToolboxCatalogs(extension.toolCatalogs);
  // Dependency validity is checked on the final graph, so children may complete or disable parent entries.
  for (const kind of kinds) validateDependencies(kind, result[kind]);
  options.signal?.throwIfAborted();
  return result;
}
