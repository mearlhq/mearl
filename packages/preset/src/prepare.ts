import {
  BundleError,
  MAX_BROWSER_STORAGE_BYTES,
  MAX_BUNDLE_MANIFEST_BYTES,
  bundleDigest,
  bundleSourceUrl,
  loadBundleResources,
  validateBundleManifest,
  type BundleLoader,
  type BundleManifest,
  type PreparedBundle,
} from './bundle.js';
import satisfies from 'semver/functions/satisfies.js';
import { clonePresetDefaults, validatePreset } from './manifest.js';
import { resolvePreset } from './resolve.js';
import type { PresetManifest, PresetRuntime, ResolvedComponent, ResolvedPreset } from './types.js';

export interface PreparePresetOptions {
  load: BundleLoader;
  mearlApiVersion: string;
  signal?: AbortSignal;
  /** One budget covers inheritance manifests, package manifests and resource bytes. */
  maxDownloadBytes?: number;
}

export interface PresetGraphSnapshot {
  source: string;
  manifests: Record<string, PresetManifest>;
  bundleRevisions: Record<string, string>;
  packageTargets: Record<string, PresetRuntime[]>;
  revision: string;
}

export async function presetSnapshotRevision(value: object): Promise<string> {
  return bundleDigest(new TextEncoder().encode(JSON.stringify(value)));
}

/** Select candidates without assuming that inferred locations have been discovered. */
function selectPresetPackages(
  preset: ResolvedPreset,
  runtimes: PresetRuntime[],
): Array<[string, ResolvedComponent]> {
  const entries = Object.entries(preset.packages).filter(
    ([, entry]) =>
      entry.enabled !== false &&
      (entry.targets ?? ['browser', 'node']).some(runtime =>
        runtimes.includes(runtime as PresetRuntime),
      ),
  );
  if (entries.length > 64)
    throw new BundleError('BUNDLE_QUOTA', 'A preset can activate at most 64 packages');
  return entries;
}

/** Each execution location must be able to satisfy its own package dependencies. */
export function presetPackages(
  preset: ResolvedPreset,
  runtimes: PresetRuntime[],
): Array<[string, ResolvedComponent]> {
  for (const runtime of runtimes) {
    const entries = Object.entries(preset.packages).filter(
      ([, entry]) =>
        entry.enabled !== false && (entry.targets ?? ['browser', 'node']).includes(runtime),
    );
    const ids = new Set(entries.map(([id]) => id));
    for (const [id, entry] of entries) {
      if (entry.dependsOn?.some(dependency => !ids.has(dependency))) {
        throw new BundleError(
          'BUNDLE_INCOMPATIBLE',
          `${runtime === 'browser' ? 'Browser' : 'Node'} package ${id} requires a package unavailable in ${runtime}`,
        );
      }
    }
    if (runtime === 'browser') {
      for (const target of Object.values(preset.appProfiles)) {
        if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(target) || !ids.has(target.split('/')[0])) {
          throw new BundleError(
            'BUNDLE_INVALID',
            'App implementations must belong to an enabled browser package',
          );
        }
      }
    }
  }
  return selectPresetPackages(preset, runtimes);
}

export function bundleTargets(bundle: Pick<PreparedBundle, 'manifest'>): PresetRuntime[] {
  const contributions = bundle.manifest.contributions;
  const targets: PresetRuntime[] = [];
  if (
    contributions &&
    (Object.keys(contributions.browserRuntimes ?? {}).length ||
      Object.keys(contributions.pageRuntimes ?? {}).length ||
      contributions.appProfiles?.length ||
      contributions.extension ||
      contributions.requestUi ||
      contributions.browserViews ||
      contributions.browserControls)
  )
    targets.push('browser');
  if (Object.keys(contributions?.nodeRuntimes ?? {}).length) targets.push('node');
  return targets.length ? targets : ['browser', 'node'];
}

/** Resolved activation choices are derived data; source manifests remain unchanged. */
export function applyPackageTargets(
  preset: ResolvedPreset,
  targets: Record<string, PresetRuntime[]>,
): ResolvedPreset {
  const enabled = Object.entries(preset.packages).filter(([, entry]) => entry.enabled !== false);
  if (enabled.length !== Object.keys(targets).length)
    throw new BundleError('BUNDLE_INTEGRITY', 'Package target selection does not match the preset');
  const packages = { ...preset.packages };
  for (const [id, entry] of enabled) {
    const selected = targets[id];
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      selected.length > 2 ||
      new Set(selected).size !== selected.length ||
      selected.some(target => target !== 'browser' && target !== 'node') ||
      (entry.targets && JSON.stringify(entry.targets) !== JSON.stringify(selected))
    )
      throw new BundleError('BUNDLE_INTEGRITY', 'Invalid package target selection');
    packages[id] = { ...entry, targets: [...selected] };
  }
  return { ...preset, packages };
}

export function verifyPackageTargets(preset: ResolvedPreset, bundles: PreparedBundle[]): void {
  for (const bundle of bundles) {
    const available = bundleTargets(bundle);
    if (preset.packages[bundle.manifest.id]?.targets?.some(target => !available.includes(target)))
      throw new BundleError('BUNDLE_INCOMPATIBLE', 'Package does not support the selected target');
  }
}

/** Shared preparation performs no installation, code execution or permission changes. */
export async function preparePresetPackages(
  source: string,
  options: PreparePresetOptions,
  runtimes: PresetRuntime[],
): Promise<{
  source: string;
  manifests: Record<string, PresetManifest>;
  preset: ResolvedPreset;
  bundles: PreparedBundle[];
  packageTargets: Record<string, PresetRuntime[]>;
}> {
  source = bundleSourceUrl(source);
  let remaining = options.maxDownloadBytes ?? MAX_BROWSER_STORAGE_BYTES;
  if (!Number.isSafeInteger(remaining) || remaining <= 0 || remaining > MAX_BROWSER_STORAGE_BYTES)
    throw new BundleError('BUNDLE_QUOTA', 'Invalid preset download budget');
  const load: BundleLoader = async (url, request) => {
    if (remaining <= 0)
      throw new BundleError('BUNDLE_QUOTA', 'Preset downloads exceed the shared budget');
    const limit = Math.min(request.maxBytes, remaining);
    const bytes = await options.load(url, { ...request, maxBytes: limit });
    if (bytes.byteLength > limit)
      throw new BundleError('BUNDLE_QUOTA', 'Preset download exceeds its size limit');
    remaining -= bytes.byteLength;
    return bytes;
  };
  const manifests: Record<string, PresetManifest> = {};
  let preset = await resolvePreset(source, {
    mearlApiVersion: options.mearlApiVersion,
    signal: options.signal,
    load: async url => {
      const bytes = Uint8Array.from(await load(url, { maxBytes: 262_144, signal: options.signal }));
      let manifest: PresetManifest;
      try {
        manifest = validatePreset(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
      } catch (error) {
        throw new BundleError(
          'BUNDLE_INVALID',
          error instanceof Error ? error.message : 'Invalid preset manifest',
        );
      }
      manifests[url] = manifest;
      return manifest;
    },
  });
  const targetsKnown = Object.values(preset.packages).every(
    entry => entry.enabled === false || Boolean(entry.targets?.length),
  );
  const entries = targetsKnown
    ? presetPackages(preset, runtimes)
    : selectPresetPackages(preset, runtimes);
  const bundles: PreparedBundle[] = [];
  const pending: Array<{ source: string; manifest: BundleManifest; bytes: Uint8Array }> = [];
  const packageTargets: Record<string, PresetRuntime[]> = Object.fromEntries(
    Object.entries(preset.packages)
      .filter(([, entry]) => entry.enabled !== false)
      .map(([id, entry]) => [id, entry.targets ?? []]),
  );
  for (const [id, entry] of entries) {
    const manifestSource = bundleSourceUrl(entry.source!);
    const bytes = Uint8Array.from(
      await load(manifestSource, { maxBytes: MAX_BUNDLE_MANIFEST_BYTES, signal: options.signal }),
    );
    let manifest;
    try {
      manifest = validateBundleManifest(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        options.mearlApiVersion,
      );
    } catch (error) {
      if (error instanceof BundleError) throw error;
      throw new BundleError(
        'BUNDLE_INVALID',
        error instanceof Error ? error.message : 'Invalid package manifest',
      );
    }
    if (manifest.id !== id)
      throw new BundleError('BUNDLE_INVALID', 'Package identity does not match the preset');
    if (entry.version && !satisfies(manifest.version, entry.version))
      throw new BundleError('BUNDLE_INCOMPATIBLE', 'Package version does not satisfy the preset');
    const available = bundleTargets({ manifest });
    const targets = entry.targets ?? available;
    if (targets.some(target => !available.includes(target)))
      throw new BundleError('BUNDLE_INCOMPATIBLE', 'Package does not support the selected target');
    packageTargets[id] = targets;
    pending.push({ source: manifestSource, manifest, bytes });
  }
  preset = applyPackageTargets(preset, packageTargets);
  const selected = new Set(presetPackages(preset, runtimes).map(([id]) => id));
  for (const { source: manifestSource, manifest, bytes } of pending) {
    if (!selected.has(manifest.id)) continue;
    bundles.push(
      await loadBundleResources(manifestSource, manifest, {
        // A resource at the manifest URL belongs to the same captured response.
        load: (url, request) =>
          url === manifestSource ? Promise.resolve(bytes) : load(url, request),
        signal: options.signal,
      }),
    );
  }
  options.signal?.throwIfAborted();
  return { source, manifests, preset, bundles, packageTargets };
}

/** The exact graph is checked offline; installed resources are verified by the target store. */
export async function verifyPresetGraph(
  value: PresetGraphSnapshot & { schemaVersion?: 1 },
  mearlApiVersion: string,
  runtimes: PresetRuntime[],
  full: boolean,
): Promise<{ snapshot: PresetGraphSnapshot & { schemaVersion?: 1 }; preset: ResolvedPreset }> {
  const json = clonePresetDefaults(value);
  const allowed = [
    'source',
    'manifests',
    'bundleRevisions',
    'packageTargets',
    'revision',
    ...(full ? ['schemaVersion'] : []),
  ];
  if (
    Object.keys(json).some(key => !allowed.includes(key)) ||
    (full && json.schemaVersion !== 1) ||
    typeof json.source !== 'string' ||
    typeof json.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(json.revision)
  ) {
    throw new BundleError('BUNDLE_INTEGRITY', 'Invalid stored preset identity');
  }
  const source = bundleSourceUrl(json.source);
  const manifests = clonePresetDefaults(json.manifests);
  if (Object.keys(manifests).length > 32)
    throw new BundleError('BUNDLE_QUOTA', 'Stored preset inheritance exceeds 32 manifests');
  const bundleRevisions = clonePresetDefaults(json.bundleRevisions) as Record<string, string>;
  if (
    Object.keys(bundleRevisions).length > 64 ||
    Object.values(bundleRevisions).some(
      revision => typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision),
    )
  ) {
    throw new BundleError('BUNDLE_INTEGRITY', 'Invalid stored package revisions');
  }
  const validated: Record<string, PresetManifest> = {};
  for (const [url, manifest] of Object.entries(manifests)) {
    if (url !== bundleSourceUrl(url))
      throw new BundleError('BUNDLE_INTEGRITY', 'Invalid stored preset source');
    validated[url] = validatePreset(manifest);
  }
  const packageTargets = clonePresetDefaults(json.packageTargets) as Record<
    string,
    PresetRuntime[]
  >;
  const data = {
    ...(full ? { schemaVersion: 1 as const } : {}),
    source,
    manifests: validated,
    bundleRevisions,
    packageTargets,
  };
  if ((await presetSnapshotRevision(data)) !== json.revision)
    throw new BundleError('BUNDLE_INTEGRITY', 'Stored preset revision does not match');
  let preset = await resolvePreset(source, {
    mearlApiVersion,
    load: async url => {
      if (!Object.hasOwn(validated, url))
        throw new BundleError('BUNDLE_INTEGRITY', 'Stored parent preset is missing');
      return validated[url];
    },
  });
  preset = applyPackageTargets(preset, packageTargets);
  const entries = presetPackages(preset, runtimes);
  if (
    preset.chain.length !== Object.keys(validated).length ||
    entries.length !== Object.keys(bundleRevisions).length ||
    entries.some(([id]) => !Object.hasOwn(bundleRevisions, id))
  ) {
    throw new BundleError('BUNDLE_INTEGRITY', 'Stored preset package graph does not match');
  }
  return { snapshot: { ...data, revision: json.revision }, preset };
}
