import { browserPresetSnapshot, type PreparedBrowserPreset } from './browserPreset.js';
import {
  preparePresetPackages,
  presetSnapshotRevision,
  verifyPresetGraph,
  verifyPackageTargets,
  type PreparePresetOptions,
  type PresetGraphSnapshot,
} from './prepare.js';
import type { PreparedBundle } from './bundle.js';
import type { ResolvedPreset } from './types.js';
import satisfies from 'semver/functions/satisfies.js';
import { BundleError, MAX_BROWSER_STORAGE_BYTES, verifyBundle } from './bundle.js';

/** Whole-preset identity includes both execution locations and the captured inheritance graph. */
export interface PresetSnapshot extends PresetGraphSnapshot {
  schemaVersion: 1;
}

export interface PreparedPreset {
  snapshot: PresetSnapshot;
  preset: ResolvedPreset;
  /** Each package is downloaded once, including packages used by both runtimes. */
  bundles: PreparedBundle[];
  /** Compatible with the browser's existing atomic activation and offline restore contract. */
  browser: PreparedBrowserPreset;
}

export async function preparePreset(
  source: string,
  options: PreparePresetOptions,
): Promise<PreparedPreset> {
  const prepared = await preparePresetPackages(source, options, ['browser', 'node']);
  const data = {
    schemaVersion: 1 as const,
    source: prepared.source,
    manifests: prepared.manifests,
    bundleRevisions: Object.fromEntries(
      prepared.bundles.map(bundle => [bundle.manifest.id, bundle.revision]),
    ),
    packageTargets: prepared.packageTargets,
  };
  const snapshot = { ...data, revision: await presetSnapshotRevision(data) };
  const browser = await browserPresetSnapshot(
    prepared.source,
    prepared.manifests,
    prepared.preset,
    prepared.bundles,
  );
  options.signal?.throwIfAborted();
  return { snapshot, preset: prepared.preset, bundles: prepared.bundles, browser };
}

/** Verifies the lock graph without fetching sources or executing capability factories. */
export async function verifyPreset(
  value: PresetSnapshot,
  mearlApiVersion: string,
): Promise<{ snapshot: PresetSnapshot; preset: ResolvedPreset }> {
  const result = await verifyPresetGraph(value, mearlApiVersion, ['browser', 'node'], true);
  return { ...result, snapshot: result.snapshot as PresetSnapshot };
}

/** Captures and validates the entire accepted batch before an installation host persists it. */
export async function verifyPreparedPreset(
  value: Pick<PreparedPreset, 'snapshot' | 'bundles'>,
  mearlApiVersion: string,
): Promise<PreparedPreset> {
  if (!Array.isArray(value.bundles) || value.bundles.length > 64)
    throw new BundleError('BUNDLE_QUOTA', 'Preset package count exceeds 64');
  let total = 0;
  for (const bundle of value.bundles) {
    if (
      !bundle?.resources ||
      typeof bundle.resources !== 'object' ||
      Array.isArray(bundle.resources)
    )
      throw new BundleError('BUNDLE_INVALID', 'Expected package resource buffers');
    const resources = Object.values(bundle.resources);
    if (resources.length > 64)
      throw new BundleError('BUNDLE_QUOTA', 'Preset package resource count exceeds 64');
    for (const bytes of resources) {
      if (!(bytes instanceof Uint8Array))
        throw new BundleError('BUNDLE_INVALID', 'Expected package resource buffers');
      total += bytes.byteLength;
      if (total > MAX_BROWSER_STORAGE_BYTES)
        throw new BundleError('BUNDLE_QUOTA', 'Preset packages exceed the storage budget');
    }
  }
  const [graph, bundles] = await Promise.all([
    verifyPreset(value.snapshot, mearlApiVersion),
    Promise.all(value.bundles.map(bundle => verifyBundle(bundle, mearlApiVersion))),
  ]);
  const { snapshot, preset } = graph;
  verifyPackageTargets(preset, bundles);
  if (
    bundles.length !== Object.keys(snapshot.bundleRevisions).length ||
    new Set(bundles.map(bundle => bundle.manifest.id)).size !== bundles.length ||
    bundles.some(bundle => {
      const entry = preset.packages[bundle.manifest.id];
      return (
        snapshot.bundleRevisions[bundle.manifest.id] !== bundle.revision ||
        entry?.source !== bundle.source ||
        (entry.version && !satisfies(bundle.manifest.version, entry.version))
      );
    })
  )
    throw new BundleError('BUNDLE_INTEGRITY', 'Preset installation requires every exact package');
  return {
    snapshot,
    preset,
    bundles,
    browser: await browserPresetSnapshot(snapshot.source, snapshot.manifests, preset, bundles),
  };
}
