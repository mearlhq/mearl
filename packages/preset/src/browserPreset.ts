import { selectBrowserControl } from './browserControls.js';
import type { PreparedBundle } from './bundle.js';
import { BundleError, MAX_BROWSER_STORAGE_BYTES, verifyBundle } from './bundle.js';
import { satisfies } from 'semver';
import type { PresetManifest, ResolvedPreset } from './types.js';
import { preparePresetPackages, presetPackages, presetSnapshotRevision, verifyPresetGraph, verifyPackageTargets, type PreparePresetOptions, type PresetGraphSnapshot } from './prepare.js';

/** Core browser defaults also need synchronization when no browser package is declared. */
export function presetRequiresBrowser(preset: ResolvedPreset): boolean {
  return Object.values(preset.packages).some(entry => entry.enabled !== false && entry.targets?.includes('browser')) || Object.keys(preset.appProfiles).length > 0 || Object.keys(preset.defaults).some(key => key === 'simulation' || key === 'extension' || key === 'services');
}

/** Exact manifests allow offline resolution without trusting a second serialized resolved graph. */
export type BrowserPresetSnapshot = PresetGraphSnapshot;

export interface PreparedBrowserPreset {
  snapshot: BrowserPresetSnapshot;
  preset: ResolvedPreset;
  bundles: PreparedBundle[];
}

/** Browser selection can be derived from the same accepted batch without another download. */
export async function browserPresetSnapshot(source: string, manifests: Record<string, PresetManifest>, preset: ResolvedPreset, bundles: PreparedBundle[]): Promise<PreparedBrowserPreset> {
  const ids = new Set(presetPackages(preset, ['browser']).map(([id]) => id));
  const selected = bundles.filter(bundle => ids.has(bundle.manifest.id));
  selectBrowserControl(selected);
  const packageTargets = Object.fromEntries(Object.entries(preset.packages).filter(([, entry]) => entry.enabled !== false).map(([id, entry]) => [id, entry.targets!]));
  const data = { source, manifests, bundleRevisions: Object.fromEntries(selected.map(bundle => [bundle.manifest.id, bundle.revision])), packageTargets };
  return { snapshot: { ...data, revision: await presetSnapshotRevision(data) }, preset, bundles: selected };
}

export async function prepareBrowserPreset(source: string, options: PreparePresetOptions): Promise<PreparedBrowserPreset> {
  const prepared = await preparePresetPackages(source, options, ['browser']);
  return browserPresetSnapshot(prepared.source, prepared.manifests, prepared.preset, prepared.bundles);
}

/** Verifies an independent copy before any asynchronous work can observe caller mutations. */
export async function verifyBrowserPreset(value: BrowserPresetSnapshot, mearlApiVersion: string): Promise<{ snapshot: BrowserPresetSnapshot; preset: ResolvedPreset }> {
  return verifyPresetGraph(value, mearlApiVersion, ['browser'], false);
}

/** Captures the supplied browser batch without fetching its mutable sources again. */
export async function verifyPreparedBrowserPreset(value: Pick<PreparedBrowserPreset, 'snapshot' | 'bundles'>, mearlApiVersion: string): Promise<PreparedBrowserPreset> {
  if (!Array.isArray(value.bundles) || value.bundles.length > 64) throw new BundleError('BUNDLE_QUOTA', 'Browser preset package count exceeds 64');
  let total = 0;
  for (const bundle of value.bundles) {
    if (!bundle?.resources || typeof bundle.resources !== 'object' || Array.isArray(bundle.resources)) throw new BundleError('BUNDLE_INVALID', 'Expected package resource buffers');
    const resources = Object.values(bundle.resources);
    if (resources.length > 64) throw new BundleError('BUNDLE_QUOTA', 'Browser package resource count exceeds 64');
    for (const bytes of resources) {
      if (!(bytes instanceof Uint8Array)) throw new BundleError('BUNDLE_INVALID', 'Expected package resource buffers');
      total += bytes.byteLength;
      if (total > MAX_BROWSER_STORAGE_BYTES) throw new BundleError('BUNDLE_QUOTA', 'Browser packages exceed the storage budget');
    }
  }
  const [graph, bundles] = await Promise.all([
    verifyBrowserPreset(value.snapshot, mearlApiVersion),
    Promise.all(value.bundles.map(bundle => verifyBundle(bundle, mearlApiVersion))),
  ]);
  if (bundles.length !== Object.keys(graph.snapshot.bundleRevisions).length || new Set(bundles.map(bundle => bundle.manifest.id)).size !== bundles.length || bundles.some(bundle => {
    const entry = graph.preset.packages[bundle.manifest.id];
    return graph.snapshot.bundleRevisions[bundle.manifest.id] !== bundle.revision || entry?.source !== bundle.source || (entry.version && !satisfies(bundle.manifest.version, entry.version));
  })) throw new BundleError('BUNDLE_INTEGRITY', 'Browser activation requires every exact package');
  selectBrowserControl(bundles);
  verifyPackageTargets(graph.preset, bundles);
  return { ...graph, bundles };
}
