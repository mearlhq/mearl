import { BundleError, MAX_BROWSER_STORAGE_BYTES, MAX_BUNDLE_BYTES, bundleDigest, validateBundleManifest } from './bundle.js';
import { clonePresetDefaults, isJsonObject } from './manifest.js';
import { mergePresetDefaults } from './resolve.js';
import type { JsonObject } from './types.js';

export interface CapabilitySelection {
  schemaVersion: 1;
  modules: Record<string, { sha256: string; byteLength: number; config?: JsonObject }>;
  bindings: Record<string, { module: string; handler: string }>;
}
export interface CapabilitySnapshot extends CapabilitySelection { revision: string }
export interface CapabilityActivation extends CapabilitySnapshot { installationRevision?: string }
export const MAX_CAPABILITY_SELECTION_BYTES = 262_144;

const identifier = /^[a-z][a-z0-9-]{0,79}$/;
const hookName = /^[a-z][a-zA-Z0-9_.-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
function invalid(message: string): never { throw new BundleError('BUNDLE_INVALID', message); }
function fields(value: unknown, allowed: string[]): asserts value is JsonObject {
  if (!isJsonObject(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('Invalid Capability selection structure');
}

/** Explicit module configuration survives periods where a preset disables its module. */
export function validateCapabilityConfig(value: Record<string, JsonObject>): Record<string, JsonObject> {
  const configs = clonePresetDefaults(value);
  if (Object.keys(configs).length > 64 || new TextEncoder().encode(JSON.stringify(configs)).byteLength > MAX_CAPABILITY_SELECTION_BYTES) throw new BundleError('BUNDLE_QUOTA', 'Capability module configuration exceeds its limit');
  for (const [id, config] of Object.entries(configs)) if (!identifier.test(id) || !isJsonObject(config)) invalid('Capability module configuration must map IDs to JSON objects');
  return configs as Record<string, JsonObject>;
}

/** Preset defaults are inherited; explicit host configuration stays a separate override. */
export function resolveCapabilityConfig(defaults: JsonObject, overrides: Record<string, JsonObject> = {}): Record<string, JsonObject> {
  const value = defaults.capabilities === undefined ? {} : defaults.capabilities;
  if (!isJsonObject(value)) invalid('Capability defaults must map module IDs to configuration objects');
  return validateCapabilityConfig(mergePresetDefaults(validateCapabilityConfig(value as Record<string, JsonObject>), validateCapabilityConfig(overrides)) as Record<string, JsonObject>);
}

/** Exact content and bindings are selected together; filesystem and code loading belong to hosts. */
export async function prepareCapabilitySnapshot(input: CapabilitySelection): Promise<CapabilitySnapshot> {
  const value = clonePresetDefaults(input);
  fields(value, ['schemaVersion', 'modules', 'bindings']);
  if (value.schemaVersion !== 1 || !isJsonObject(value.modules) || !isJsonObject(value.bindings)) invalid('Invalid Capability selection');
  if (Object.keys(value.modules).length > 64 || Object.keys(value.bindings).length > 256) throw new BundleError('BUNDLE_QUOTA', 'Capability selection exceeds the entry limit');
  const modules: CapabilitySelection['modules'] = {};
  let total = 0;
  for (const id of Object.keys(value.modules).sort()) {
    if (!identifier.test(id)) invalid('Invalid Capability module ID');
    const entry = value.modules[id];
    fields(entry, ['sha256', 'byteLength', 'config']);
    if (typeof entry.sha256 !== 'string' || !digest.test(entry.sha256) || typeof entry.byteLength !== 'number' || !Number.isSafeInteger(entry.byteLength) || entry.byteLength <= 0 || entry.byteLength > MAX_BUNDLE_BYTES) invalid('Invalid Capability module resource');
    if (entry.config !== undefined && !isJsonObject(entry.config)) invalid('Capability module configuration must be a JSON object');
    total += entry.byteLength;
    if (total > MAX_BROWSER_STORAGE_BYTES) throw new BundleError('BUNDLE_QUOTA', 'Capability resources exceed 64 MiB');
    modules[id] = { sha256: entry.sha256, byteLength: entry.byteLength, ...(entry.config === undefined ? {} : { config: clonePresetDefaults(entry.config) }) };
  }
  const bindings: CapabilitySelection['bindings'] = {};
  for (const name of Object.keys(value.bindings).sort()) {
    if (!hookName.test(name)) invalid('Invalid Capability hook name');
    const binding = value.bindings[name];
    fields(binding, ['module', 'handler']);
    if (typeof binding.module !== 'string' || !Object.hasOwn(modules, binding.module) || typeof binding.handler !== 'string' || !hookName.test(binding.handler)) invalid('Capability hook must bind a declared module handler');
    bindings[name] = { module: binding.module, handler: binding.handler };
  }
  const selection: CapabilitySelection = { schemaVersion: 1, modules, bindings };
  if (new TextEncoder().encode(JSON.stringify(selection)).byteLength + 80 > MAX_CAPABILITY_SELECTION_BYTES) throw new BundleError('BUNDLE_QUOTA', 'Capability selection metadata exceeds 256 KiB');
  return { ...selection, revision: await bundleDigest(new TextEncoder().encode(JSON.stringify(selection))) };
}

export async function verifyCapabilitySnapshot(input: CapabilitySnapshot): Promise<CapabilitySnapshot> {
  const value = clonePresetDefaults(input);
  fields(value, ['schemaVersion', 'modules', 'bindings', 'revision']);
  if (typeof value.revision !== 'string' || !digest.test(value.revision)) invalid('Invalid Capability revision');
  const { revision, ...selection } = value;
  const prepared = await prepareCapabilitySnapshot(selection as unknown as CapabilitySelection);
  if (prepared.revision !== revision) throw new BundleError('BUNDLE_INTEGRITY', 'Capability selection revision does not match');
  return prepared;
}

/** The installer receipt and Node selection share one atomic filesystem pointer. */
export async function verifyCapabilityActivation(input: CapabilityActivation): Promise<CapabilityActivation> {
  const value = clonePresetDefaults(input);
  const { installationRevision, ...selection } = value;
  if (installationRevision !== undefined && (typeof installationRevision !== 'string' || !digest.test(installationRevision))) invalid('Invalid capability installation revision');
  const snapshot = await verifyCapabilitySnapshot(selection as unknown as CapabilitySnapshot);
  return { ...snapshot, ...(installationRevision === undefined ? {} : { installationRevision: installationRevision as string }) };
}

async function prepareRuntimeBundleSnapshot(bundles: import('./bundle.js').PreparedBundle[], kind: 'nodeRuntimes' | 'browserRuntimes', host: string, mearlApiVersion: string, config: Record<string, JsonObject>): Promise<{ snapshot: CapabilitySnapshot; resources: Record<string, Uint8Array> }> {
  if (!identifier.test(host)) invalid('Invalid capability runtime host');
  const configs = validateCapabilityConfig(config);
  const modules: CapabilitySelection['modules'] = {};
  const bindings: CapabilitySelection['bindings'] = {};
  const resources: Record<string, Uint8Array> = {};
  const pending: Array<{ id: string; bytes: Uint8Array; sha256: string }> = [];
  let total = 0;
  for (const bundle of bundles) {
    const manifest = validateBundleManifest(bundle.manifest, mearlApiVersion);
    const runtime = manifest.contributions?.[kind]?.[host];
    if (!runtime) continue;
    if (Object.hasOwn(modules, manifest.id)) invalid('Duplicate Capability module ID');
    const metadata = manifest.resources[runtime.entry];
    if (!Object.hasOwn(bundle.resources, runtime.entry)) invalid('Capability module resource is missing');
    total += metadata.byteLength;
    if (pending.length >= 64 || total > MAX_BROWSER_STORAGE_BYTES) throw new BundleError('BUNDLE_QUOTA', 'Capability resources exceed the selection limit');
    pending.push({ id: manifest.id, bytes: bundle.resources[runtime.entry], sha256: metadata.sha256 });
    if (pending[pending.length - 1].bytes.byteLength !== metadata.byteLength) invalid('Capability module length does not match');
    const effectiveConfig = mergePresetDefaults(manifest.defaults ?? {}, configs[manifest.id] ?? {});
    modules[manifest.id] = { ...metadata, ...(Object.keys(effectiveConfig).length ? { config: effectiveConfig } : {}) };
    for (const [name, handler] of Object.entries(runtime.bindings)) {
      if (Object.hasOwn(bindings, name)) invalid('Capability hook has multiple providers');
      bindings[name] = { module: manifest.id, handler };
    }
  }
  // Capture the complete accepted batch before the first asynchronous digest.
  const captured = pending.map(resource => ({ ...resource, bytes: Uint8Array.from(resource.bytes) }));
  for (const resource of captured) {
    if (await bundleDigest(resource.bytes) !== resource.sha256) throw new BundleError('BUNDLE_INTEGRITY', `Capability module digest does not match: ${resource.id}`);
    resources[resource.sha256] = resource.bytes;
  }
  return { snapshot: await prepareCapabilitySnapshot({ schemaVersion: 1, modules, bindings }), resources };
}

export function prepareNodeBundleSnapshot(bundles: import('./bundle.js').PreparedBundle[], host: string, mearlApiVersion: string, config: Record<string, JsonObject> = {}) {
  return prepareRuntimeBundleSnapshot(bundles, 'nodeRuntimes', host, mearlApiVersion, config);
}

/** Browser factories use the same exact module/configuration selection without a Node loader. */
export function prepareBrowserBundleSnapshot(bundles: import('./bundle.js').PreparedBundle[], host: string, mearlApiVersion: string, config: Record<string, JsonObject> = {}) {
  return prepareRuntimeBundleSnapshot(bundles, 'browserRuntimes', host, mearlApiVersion, config);
}
