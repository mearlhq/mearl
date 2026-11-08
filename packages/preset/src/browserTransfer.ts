import { BundleError, MAX_BROWSER_STORAGE_BYTES, bundleDigest, validateBundleManifest, type PreparedBundle } from './bundle.js';
import { verifyBrowserPreset, verifyPreparedBrowserPreset, type BrowserPresetSnapshot, type PreparedBrowserPreset } from './browserPreset.js';
import { mergePresetDefaults } from './resolve.js';
import type { BrowserPresetInstallation } from './bundleStore.js';
import type { JsonObject } from './types.js';

/** Every encoded response stays well below Native Messaging's one MiB host limit. */
export const PRESET_TRANSFER_CHUNK_BYTES = 128 * 1024;
export const MAX_PRESET_TRANSFER_HEADER_BYTES = 16 * 1024 * 1024;
export interface BrowserPresetTransferHeader {
  schemaVersion: 1;
  installationRevision: string;
  snapshot: BrowserPresetSnapshot;
  bundles: Array<Omit<PreparedBundle, 'resources'>>;
  overrides: JsonObject;
}
export type PresetTransferRequest =
  | { operation: 'open'; installationRevision: string }
  | { operation: 'read'; session: string; sha256: string; offset: number }
  | { operation: 'confirm' | 'release'; session: string };
export type PresetTransferTransport = (request: PresetTransferRequest) => Promise<unknown>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BundleError('BUNDLE_INVALID', 'Invalid preset transfer response');
  return value as Record<string, unknown>;
}
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }

export async function readPresetTransferResource(sha256: string, byteLength: number, options: { read: (offset: number) => Promise<unknown>; signal?: AbortSignal }): Promise<Uint8Array> {
    if (!hash(sha256) || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_BROWSER_STORAGE_BYTES) throw new BundleError('BUNDLE_QUOTA', 'Invalid preset resource digest or size');
    const bytes = new Uint8Array(byteLength);
    for (let offset = 0; offset < byteLength; offset += PRESET_TRANSFER_CHUNK_BYTES) {
      options.signal?.throwIfAborted();
      const count = Math.min(PRESET_TRANSFER_CHUNK_BYTES, byteLength - offset);
      const response = object(await options.read(offset));
      if (typeof response.data !== 'string' || response.data.length !== Math.ceil(count / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.data)) throw new BundleError('BUNDLE_INTEGRITY', 'Invalid preset resource chunk');
      const decoded = atob(response.data);
      if (decoded.length !== count) throw new BundleError('BUNDLE_INTEGRITY', 'Truncated preset resource chunk');
      for (let i = 0; i < count; i++) bytes[offset + i] = decoded.charCodeAt(i);
    }
    if (await bundleDigest(bytes) !== sha256) throw new BundleError('BUNDLE_INTEGRITY', 'Preset transfer resource digest does not match');
    return bytes;
  }

/** Receives the captured browser projection, excluding Node-only packages and executing no factories. */
export async function receiveBrowserPreset(installationRevision: string, options: { transport: PresetTransferTransport; mearlApiVersion: string; signal?: AbortSignal }): Promise<{ prepared: PreparedBrowserPreset; installation: BrowserPresetInstallation; confirm: () => Promise<void>; release: () => Promise<void> }> {
  if (!hash(installationRevision)) throw new BundleError('BUNDLE_INVALID', 'Expected an installation revision');
  options.signal?.throwIfAborted();
  const opened = object(await options.transport({ operation: 'open', installationRevision }));
  if (typeof opened.session !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(opened.session)) throw new BundleError('BUNDLE_INVALID', 'Invalid preset transfer session');
  const session = opened.session;
  let released = false;
  const release = async () => { if (!released) { released = true; await options.transport({ operation: 'release', session }); } };
  const confirm = async () => {
    options.signal?.throwIfAborted();
    const response = object(await options.transport({ operation: 'confirm', session }));
    if (response.installationRevision !== installationRevision) throw new BundleError('BUNDLE_CONFLICT', 'The selected installation changed during browser transfer');
  };
  const read = (sha256: string, byteLength: number) => readPresetTransferResource(sha256, byteLength, { signal: options.signal, read: offset => options.transport({ operation: 'read', session, sha256, offset }) });
  try {
    if (!hash(opened.sha256) || !Number.isSafeInteger(opened.byteLength) || (opened.byteLength as number) < 1 || (opened.byteLength as number) > MAX_PRESET_TRANSFER_HEADER_BYTES) throw new BundleError('BUNDLE_QUOTA', 'Invalid preset transfer header or size');
    const metadataBytes = await read(opened.sha256, opened.byteLength as number);
    const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)));
    if (Object.keys(value).some(key => !['schemaVersion', 'installationRevision', 'snapshot', 'bundles', 'overrides'].includes(key)) || value.schemaVersion !== 1 || value.installationRevision !== installationRevision || !Array.isArray(value.bundles) || value.bundles.length > 64) throw new BundleError('BUNDLE_INVALID', 'Invalid browser transfer metadata');
    const graph = await verifyBrowserPreset(value.snapshot as BrowserPresetSnapshot, options.mearlApiVersion);
    const overrides = mergePresetDefaults({}, value.overrides as JsonObject);
    if (new TextEncoder().encode(JSON.stringify(overrides)).byteLength > 262144) throw new BundleError('BUNDLE_QUOTA', 'User overrides exceed 256 KiB');
    let total = 0;
    const descriptors = value.bundles.map(entry => {
      const bundle = object(entry);
      if (Object.keys(bundle).some(key => !['source', 'revision', 'manifest'].includes(key)) || typeof bundle.source !== 'string' || !hash(bundle.revision)) throw new BundleError('BUNDLE_INVALID', 'Invalid browser package descriptor');
      const manifest = validateBundleManifest(bundle.manifest, options.mearlApiVersion);
      total += Object.values(manifest.resources).reduce((sum, resource) => sum + resource.byteLength, 0);
      if (total > MAX_BROWSER_STORAGE_BYTES) throw new BundleError('BUNDLE_QUOTA', 'Browser transfer resources exceed 64 MiB');
      return { source: bundle.source, revision: bundle.revision, manifest };
    });
    if (descriptors.length !== Object.keys(graph.snapshot.bundleRevisions).length || new Set(descriptors.map(bundle => bundle.manifest.id)).size !== descriptors.length || descriptors.some(bundle => graph.snapshot.bundleRevisions[bundle.manifest.id] !== bundle.revision)) throw new BundleError('BUNDLE_INTEGRITY', 'Browser transfer requires every exact package');
    const resources = new Map<string, Uint8Array>();
    const bundles: PreparedBundle[] = [];
    for (const bundle of descriptors) {
      const entries: Record<string, Uint8Array> = {};
      for (const [name, entry] of Object.entries(bundle.manifest.resources)) {
        const bytes = resources.get(entry.sha256) ?? await read(entry.sha256, entry.byteLength);
        if (bytes.byteLength !== entry.byteLength) throw new BundleError('BUNDLE_INTEGRITY', 'Resource digest has inconsistent lengths');
        resources.set(entry.sha256, bytes);
        entries[name] = bytes;
      }
      bundles.push({ ...bundle, resources: entries });
    }
    const prepared = await verifyPreparedBrowserPreset({ snapshot: graph.snapshot, bundles }, options.mearlApiVersion);
    await confirm();
    return { prepared, installation: { revision: installationRevision, browserRevision: prepared.snapshot.revision, overrides }, confirm, release };
  } catch (error) {
    try { await release(); } catch { /* The transport may have closed with the failed transfer. */ }
    throw error;
  }
}
