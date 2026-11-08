import satisfies from 'semver/functions/satisfies.js';
import valid from 'semver/functions/valid.js';
import validRange from 'semver/ranges/valid.js';
import { clonePresetDefaults } from './manifest.js';
import { validateBrowserControl } from './browserControls.js';

export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
export const MAX_BUNDLE_MANIFEST_BYTES = 64 * 1024;
export const MAX_BROWSER_STORAGE_BYTES = 64 * 1024 * 1024;
export const MAX_PAGE_RUNTIME_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_UI_BYTES = 64 * 1024;

export class BundleError extends Error {
  constructor(
    readonly code:
      | 'BUNDLE_INVALID'
      | 'BUNDLE_INTEGRITY'
      | 'BUNDLE_INCOMPATIBLE'
      | 'BUNDLE_CONFLICT'
      | 'BUNDLE_QUOTA',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'BundleError';
  }
}

export interface BundleManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  requires?: { mearlApi: string };
  defaults?: import('./types.js').JsonObject;
  resources: Record<string, { sha256: string; byteLength: number }>;
  contributions?: {
    appProfiles?: string[];
    pageRuntimes?: Record<string, string>;
    nodeRuntimes?: Record<string, CapabilityRuntimeDeclaration>;
    browserRuntimes?: Record<string, CapabilityRuntimeDeclaration>;
    extension?: string;
    requestUi?: string;
    browserViews?: Record<string, string>;
    browserControls?: string;
  };
}

export interface CapabilityRuntimeDeclaration {
  entry: string;
  bindings: Record<string, string>;
}

export interface PreparedBundle {
  source: string;
  revision: string;
  manifest: BundleManifest;
  resources: Record<string, Uint8Array>;
}

export interface BundleLoadOptions {
  maxBytes: number;
  signal?: AbortSignal;
}

export type BundleLoader = (source: string, options: BundleLoadOptions) => Promise<Uint8Array>;

export interface PrepareBundleOptions {
  load: BundleLoader;
  mearlApiVersion: string;
  expectedId?: string;
  version?: string;
  signal?: AbortSignal;
}

function invalid(message: string): never {
  throw new BundleError('BUNDLE_INVALID', message);
}

function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !names.includes(key))
  )
    invalid('Unexpected manifest structure');
}

function path(value: string): void {
  if (
    !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,255}$/.test(value) ||
    value.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) {
    invalid('Resource paths must stay inside the bundle directory');
  }
}

export function bundleSourceUrl(source: string): string {
  try {
    const url = new URL(source);
    if (!['https:', 'http:', 'file:'].includes(url.protocol) || url.username || url.password)
      invalid('Invalid bundle source');
    url.hash = '';
    return url.href;
  } catch {
    invalid('Expected an absolute HTTP(S)/file bundle source without credentials');
  }
}

export function validateBundleManifest(value: unknown, mearlApiVersion: string): BundleManifest {
  let json: Record<string, unknown>;
  try {
    json = clonePresetDefaults(value);
  } catch {
    invalid('Expected a JSON manifest');
  }
  fields(json, [
    'schemaVersion',
    'id',
    'version',
    'requires',
    'defaults',
    'resources',
    'contributions',
  ]);
  if (json.defaults !== undefined) json.defaults = clonePresetDefaults(json.defaults);
  if (
    json.schemaVersion !== 1 ||
    typeof json.id !== 'string' ||
    !/^[a-z][a-z0-9-]{0,79}$/.test(json.id)
  )
    invalid('Invalid bundle identity');
  if (typeof json.version !== 'string' || valid(json.version) !== json.version)
    invalid('Expected an exact bundle version');
  if (valid(mearlApiVersion) !== mearlApiVersion) invalid('Expected an exact host API version');
  if (json.requires !== undefined) {
    fields(json.requires, ['mearlApi']);
    const requirement = json.requires.mearlApi;
    if (typeof requirement !== 'string' || !requirement.trim() || validRange(requirement) === null)
      invalid('Invalid host API requirement');
    if (!satisfies(mearlApiVersion, requirement))
      throw new BundleError('BUNDLE_INCOMPATIBLE', `Requires host API ${requirement}`);
  }
  if (!json.resources || typeof json.resources !== 'object' || Array.isArray(json.resources))
    invalid('Expected a resource map');
  const resources = Object.entries(json.resources);
  if (!resources.length || resources.length > 64) invalid('A bundle requires 1–64 resources');
  let total = 0;
  for (const [name, resource] of resources) {
    path(name);
    fields(resource, ['sha256', 'byteLength']);
    if (
      typeof resource.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(resource.sha256) ||
      typeof resource.byteLength !== 'number' ||
      !Number.isSafeInteger(resource.byteLength) ||
      resource.byteLength < 0
    )
      invalid('Invalid resource metadata');
    total += resource.byteLength;
    if (total > MAX_BUNDLE_BYTES)
      throw new BundleError('BUNDLE_QUOTA', 'Bundle resources exceed 16 MiB');
  }
  if (json.contributions !== undefined) {
    fields(json.contributions, [
      'appProfiles',
      'pageRuntimes',
      'nodeRuntimes',
      'browserRuntimes',
      'extension',
      'requestUi',
      'browserViews',
      'browserControls',
    ]);
    const extension = json.contributions.extension;
    if (
      extension !== undefined &&
      (typeof extension !== 'string' || !Object.hasOwn(json.resources, extension))
    )
      invalid('Extension contributions must reference a declared resource');
    if (
      typeof extension === 'string' &&
      (json.resources as BundleManifest['resources'])[extension].byteLength > MAX_REQUEST_UI_BYTES
    )
      throw new BundleError('BUNDLE_QUOTA', 'Extension contributions exceed 64 KiB');
    const controls = json.contributions.browserControls;
    if (
      controls !== undefined &&
      (typeof controls !== 'string' || !Object.hasOwn(json.resources, controls))
    )
      invalid('Browser controls must reference a declared resource');
    if (
      typeof controls === 'string' &&
      (json.resources as BundleManifest['resources'])[controls].byteLength > MAX_REQUEST_UI_BYTES
    )
      throw new BundleError('BUNDLE_QUOTA', 'Browser controls exceed 64 KiB');
    if (
      json.contributions.requestUi !== undefined &&
      (typeof json.contributions.requestUi !== 'string' ||
        !Object.hasOwn(json.resources, json.contributions.requestUi))
    )
      invalid('Request UI must reference a declared resource');
    if (
      typeof json.contributions.requestUi === 'string' &&
      (json.resources as BundleManifest['resources'])[json.contributions.requestUi].byteLength >
        MAX_REQUEST_UI_BYTES
    )
      throw new BundleError('BUNDLE_QUOTA', 'Request UI exceeds 64 KiB');
    if (json.contributions.browserViews !== undefined) {
      fields(json.contributions.browserViews, [
        'requestImport',
        'requestCases',
        'captureLauncher',
        'captureController',
      ]);
      for (const resource of Object.values(json.contributions.browserViews)) {
        if (typeof resource !== 'string' || !Object.hasOwn(json.resources, resource))
          invalid('Browser views must reference declared resources');
        if (
          (json.resources as BundleManifest['resources'])[resource].byteLength >
          MAX_REQUEST_UI_BYTES
        )
          throw new BundleError('BUNDLE_QUOTA', 'Browser view definition exceeds 64 KiB');
      }
    }
    const profiles =
      json.contributions.appProfiles === undefined ? [] : json.contributions.appProfiles;
    if (
      !Array.isArray(profiles) ||
      profiles.some(
        name => typeof name !== 'string' || !Object.hasOwn(json.resources as object, name),
      ) ||
      new Set(profiles).size !== profiles.length
    )
      invalid('App profiles must reference distinct declared resources');
    const runtimes = json.contributions.pageRuntimes;
    if (runtimes !== undefined) {
      if (
        !runtimes ||
        typeof runtimes !== 'object' ||
        Array.isArray(runtimes) ||
        Object.entries(runtimes).some(
          ([id, name]) =>
            !/^[a-z][a-z0-9-]{0,79}$/.test(id) ||
            typeof name !== 'string' ||
            !Object.hasOwn(json.resources as object, name),
        )
      )
        invalid('Page runtimes must reference declared resources');
      for (const name of Object.values(runtimes)) {
        const resource = (json.resources as BundleManifest['resources'])[name as string];
        if (resource.byteLength > MAX_PAGE_RUNTIME_BYTES)
          throw new BundleError('BUNDLE_QUOTA', 'Page runtime exceeds 2 MiB');
      }
    }
    for (const kind of ['nodeRuntimes', 'browserRuntimes'] as const) {
      const runtimes = json.contributions[kind];
      const label = kind === 'nodeRuntimes' ? 'Node' : 'Browser';
      if (runtimes === undefined) continue;
      if (
        !runtimes ||
        typeof runtimes !== 'object' ||
        Array.isArray(runtimes) ||
        Object.keys(runtimes).length > 16
      )
        invalid(`Invalid ${label} runtime declarations`);
      for (const [host, declaration] of Object.entries(runtimes)) {
        if (!/^[a-z][a-z0-9-]{0,79}$/.test(host)) invalid(`Invalid ${label} runtime host`);
        fields(declaration, ['entry', 'bindings']);
        if (
          typeof declaration.entry !== 'string' ||
          !Object.hasOwn(json.resources as object, declaration.entry) ||
          !declaration.entry.endsWith('.cjs')
        )
          invalid(`${label} runtime entry must reference a declared CommonJS resource`);
        if (
          !declaration.bindings ||
          typeof declaration.bindings !== 'object' ||
          Array.isArray(declaration.bindings) ||
          Object.keys(declaration.bindings).length > 256 ||
          Object.entries(declaration.bindings).some(
            ([hook, handler]) =>
              !/^[a-z][a-zA-Z0-9_.-]{0,127}$/.test(hook) ||
              typeof handler !== 'string' ||
              !/^[a-z][a-zA-Z0-9_.-]{0,127}$/.test(handler),
          )
        )
          invalid(`Invalid ${label} runtime bindings`);
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(json)).byteLength > MAX_BUNDLE_MANIFEST_BYTES)
    throw new BundleError('BUNDLE_QUOTA', 'Manifest exceeds 64 KiB');
  return json as unknown as BundleManifest;
}

export async function bundleDigest(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer;
  // WebCrypto snapshots fixed, non-shared input views before hashing asynchronously.
  const data =
    buffer instanceof ArrayBuffer && !('resizable' in buffer && buffer.resizable)
      ? new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength)
      : Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function manifestRevision(source: string, manifest: BundleManifest): Promise<string> {
  return bundleDigest(new TextEncoder().encode(JSON.stringify({ source, manifest })));
}

export function readBundleJson(bundle: PreparedBundle, name: string): unknown {
  if (!Object.hasOwn(bundle.resources, name)) invalid('Bundle resource is unavailable');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bundle.resources[name]));
  } catch {
    invalid('Expected a UTF-8 JSON resource');
  }
}

export function readBundleText(bundle: PreparedBundle, name: string): string {
  if (!Object.hasOwn(bundle.resources, name)) invalid('Bundle resource is unavailable');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bundle.resources[name]);
  } catch {
    invalid('Expected a UTF-8 text resource');
  }
}

export async function prepareBundle(
  source: string,
  options: PrepareBundleOptions,
): Promise<PreparedBundle> {
  options.signal?.throwIfAborted();
  source = bundleSourceUrl(source);
  if (
    options.version !== undefined &&
    (!options.version.trim() || validRange(options.version) === null)
  )
    invalid('Invalid requested bundle version');
  const bytes = Uint8Array.from(
    await options.load(source, { maxBytes: MAX_BUNDLE_MANIFEST_BYTES, signal: options.signal }),
  );
  options.signal?.throwIfAborted();
  if (bytes.byteLength > MAX_BUNDLE_MANIFEST_BYTES)
    throw new BundleError('BUNDLE_QUOTA', 'Manifest exceeds 64 KiB');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    invalid('Expected a UTF-8 JSON manifest');
  }
  const manifest = validateBundleManifest(value, options.mearlApiVersion);
  if (options.expectedId !== undefined && manifest.id !== options.expectedId)
    invalid('Bundle identity does not match the requested package');
  if (options.version && !satisfies(manifest.version, options.version))
    throw new BundleError(
      'BUNDLE_INCOMPATIBLE',
      'Bundle version does not satisfy the requested range',
    );
  return loadBundleResources(source, manifest, options);
}

/** Loads the resources declared by a validated manifest at its canonical source. */
export async function loadBundleResources(
  source: string,
  manifest: BundleManifest,
  options: Pick<PrepareBundleOptions, 'load' | 'signal'>,
): Promise<PreparedBundle> {
  const resources: Record<string, Uint8Array> = {};
  for (const [name, expected] of Object.entries(manifest.resources)) {
    options.signal?.throwIfAborted();
    const resource = Uint8Array.from(
      await options.load(new URL(name, source).href, {
        maxBytes: expected.byteLength,
        signal: options.signal,
      }),
    );
    options.signal?.throwIfAborted();
    if (
      resource.byteLength !== expected.byteLength ||
      (await bundleDigest(resource)) !== expected.sha256
    ) {
      throw new BundleError('BUNDLE_INTEGRITY', `Resource integrity check failed: ${name}`);
    }
    resources[name] = resource;
  }
  options.signal?.throwIfAborted();
  const prepared = {
    source,
    manifest,
    revision: await manifestRevision(source, manifest),
    resources,
  };
  if (manifest.contributions?.browserControls)
    validateBrowserControl(readBundleJson(prepared, manifest.contributions.browserControls));
  return prepared;
}

/** Revalidates persisted snapshots without network access and returns independent resource buffers. */
export async function verifyBundle(
  bundle: PreparedBundle,
  mearlApiVersion: string,
): Promise<PreparedBundle> {
  const source = bundleSourceUrl(bundle.source);
  const manifest = validateBundleManifest(bundle.manifest, mearlApiVersion);
  const revision = bundle.revision;
  if (
    !bundle.resources ||
    typeof bundle.resources !== 'object' ||
    Object.keys(bundle.resources).length !== Object.keys(manifest.resources).length
  )
    invalid('Stored resource set does not match the manifest');
  const resources: Record<string, Uint8Array> = {};
  for (const [name, expected] of Object.entries(manifest.resources)) {
    const original = bundle.resources[name];
    if (!(original instanceof Uint8Array))
      throw new BundleError('BUNDLE_INTEGRITY', 'Stored resource is not a byte buffer');
    const bytes = Uint8Array.from(original);
    if (bytes.byteLength !== expected.byteLength) {
      throw new BundleError('BUNDLE_INTEGRITY', `Stored resource integrity check failed: ${name}`);
    }
    resources[name] = bytes;
  }
  if ((await manifestRevision(source, manifest)) !== revision)
    throw new BundleError('BUNDLE_INTEGRITY', 'Stored manifest revision does not match');
  for (const [name, expected] of Object.entries(manifest.resources)) {
    if ((await bundleDigest(resources[name])) !== expected.sha256)
      throw new BundleError('BUNDLE_INTEGRITY', `Stored resource integrity check failed: ${name}`);
  }
  const prepared = { source, manifest, revision, resources };
  if (manifest.contributions?.browserControls)
    validateBrowserControl(readBundleJson(prepared, manifest.contributions.browserControls));
  return prepared;
}
