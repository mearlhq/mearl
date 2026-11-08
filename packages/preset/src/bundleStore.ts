import {
  BundleError,
  MAX_BUNDLE_BYTES,
  MAX_BROWSER_STORAGE_BYTES,
  MAX_PAGE_RUNTIME_BYTES,
  bundleDigest,
  verifyBundle,
  type PreparedBundle,
} from './bundle.js';
import {
  verifyBrowserPreset,
  verifyPreparedBrowserPreset,
  type BrowserPresetSnapshot,
} from './browserPreset.js';
import { mergePresetDefaults } from './resolve.js';
import type { JsonObject } from './types.js';

export interface BrowserPresetInstallation {
  revision: string;
  browserRevision: string;
  overrides: JsonObject;
}

function installationMetadata(value: BrowserPresetInstallation): BrowserPresetInstallation {
  if (
    !value ||
    Object.keys(value).some(key => !['revision', 'browserRevision', 'overrides'].includes(key)) ||
    !/^[a-f0-9]{64}$/.test(value.revision) ||
    !/^[a-f0-9]{64}$/.test(value.browserRevision)
  )
    throw new BundleError('BUNDLE_INVALID', 'Invalid browser installation identity');
  const overrides = mergePresetDefaults({}, value.overrides);
  if (new TextEncoder().encode(JSON.stringify(overrides)).byteLength > 262144)
    throw new BundleError('BUNDLE_QUOTA', 'Browser user overrides exceed 256 KiB');
  return { revision: value.revision, browserRevision: value.browserRevision, overrides };
}

const STORE = 'bundles';
const PRESET = 'preset';
const OBJECTS = 'objects';
const PINS = 'resourcePins';
interface StoredBundle {
  id: string;
  revision: string;
  byteLength: number;
  bundle: Omit<PreparedBundle, 'resources'>;
}
interface StoredObject {
  sha256: string;
  bytes: Uint8Array;
}
interface RuntimePin {
  owner: string;
  sha256: string;
}

function captureRevisions(input?: Record<string, string>): Record<string, string> | undefined {
  if (input === undefined) return;
  const entries = Object.entries(input);
  if (
    entries.length > 64 ||
    entries.some(
      ([id, revision]) => !/^[a-z][a-z0-9-]{0,79}$/.test(id) || typeof revision !== 'string',
    )
  )
    throw new BundleError('BUNDLE_INVALID', 'Invalid expected browser bundle selection');
  return Object.fromEntries(entries);
}

function checkRevisions(records: StoredBundle[], expected?: Record<string, string>): void {
  if (
    expected &&
    (records.length !== Object.keys(expected).length ||
      records.some(
        record => !Object.hasOwn(expected, record.id) || expected[record.id] !== record.revision,
      ))
  )
    throw new BundleError(
      'BUNDLE_CONFLICT',
      'Browser bundles changed while contributions were being validated',
    );
}

function storedBundle(bundle: PreparedBundle): StoredBundle {
  const { resources, ...metadata } = bundle;
  return {
    id: bundle.manifest.id,
    revision: bundle.revision,
    byteLength: Object.values(resources).reduce((sum, bytes) => sum + bytes.byteLength, 0),
    bundle: metadata,
  };
}

function bundleObjectHashes(records: StoredBundle[]): Set<string> {
  const hashes = new Set<string>();
  for (const record of records) {
    const resources = record?.bundle?.manifest?.resources;
    if (!resources || typeof resources !== 'object' || Array.isArray(resources)) continue;
    for (const resource of Object.values(resources))
      if (resource && typeof resource.sha256 === 'string' && /^[a-f0-9]{64}$/.test(resource.sha256))
        hashes.add(resource.sha256);
  }
  return hashes;
}

function referencedObjects(
  records: StoredBundle[],
  resources: StoredObject[],
  pins: RuntimePin[],
): StoredObject[] {
  const referenced = bundleObjectHashes(records);
  for (const pin of pins) referenced.add(pin.sha256);
  return resources.filter(resource => referenced.has(resource.sha256));
}

function bundleObjects(bundles: PreparedBundle[]): StoredObject[] {
  const result = new Map<string, StoredObject>();
  for (const bundle of bundles)
    for (const [name, resource] of Object.entries(bundle.manifest.resources))
      result.set(resource.sha256, { sha256: resource.sha256, bytes: bundle.resources[name] });
  return [...result.values()];
}

/** Schedule object reads inside the metadata transaction, preserving one consistent snapshot. */
function readObjects(records: StoredBundle[], store: IDBObjectStore): Map<string, StoredObject> {
  const result = new Map<string, StoredObject>();
  const hashes = bundleObjectHashes(records);
  for (const hash of hashes) {
    const request = store.get(hash);
    request.onsuccess = () => {
      if (request.result) result.set(hash, request.result);
    };
  }
  return result;
}

function checkStorageBudget(records: StoredBundle[], runtimes: StoredObject[]): void {
  if (
    records.some(
      record =>
        !Number.isSafeInteger(record.byteLength) ||
        record.byteLength < 0 ||
        record.byteLength > MAX_BUNDLE_BYTES,
    ) ||
    runtimes.some(
      runtime =>
        !(runtime.bytes instanceof Uint8Array) || runtime.bytes.byteLength > MAX_BUNDLE_BYTES,
    )
  ) {
    throw new BundleError('BUNDLE_INTEGRITY', 'Stored resource size is invalid');
  }
  const retained = runtimes.reduce((sum, runtime) => sum + runtime.bytes.byteLength, 0);
  const total = retained;
  if (records.length > 64 || !Number.isSafeInteger(total) || total > MAX_BROWSER_STORAGE_BYTES)
    throw new BundleError(
      'BUNDLE_QUOTA',
      'Installed and retained resources exceed the browser storage budget',
    );
}

export class BrowserBundleStore {
  private database?: Promise<IDBDatabase>;

  constructor(
    private readonly options: {
      mearlApiVersion: string;
      databaseName?: string;
      indexedDB?: IDBFactory;
    },
  ) {}

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = (this.options.indexedDB ?? indexedDB).open(
        this.options.databaseName ?? 'mearl-capabilities-v3',
        1,
      );
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE, { keyPath: 'id' });
        if (!request.result.objectStoreNames.contains(PRESET))
          request.result.createObjectStore(PRESET);
        if (!request.result.objectStoreNames.contains(OBJECTS))
          request.result.createObjectStore(OBJECTS, { keyPath: 'sha256' });
        if (!request.result.objectStoreNames.contains(PINS))
          request.result.createObjectStore(PINS, { keyPath: 'owner' });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          this.database = undefined;
        };
        resolve(database);
      };
    }).catch(error => {
      this.database = undefined;
      throw error;
    });
    return this.database;
  }

  async close(): Promise<void> {
    const current = this.database;
    this.database = undefined;
    if (current) (await current).close();
  }

  private async records(): Promise<{
    objects: Map<string, StoredObject>;
    records: StoredBundle[];
    active?: BrowserPresetSnapshot;
    installation?: BrowserPresetInstallation;
    installationToken: string | null;
  }> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction([STORE, PRESET, OBJECTS], 'readonly');
      const request = transaction.objectStore(STORE).getAll();
      let objects = new Map<string, StoredObject>();
      request.onsuccess = () => {
        objects = readObjects(request.result, transaction.objectStore(OBJECTS));
      };
      const active = transaction.objectStore(PRESET).get('active');
      const installation = transaction.objectStore(PRESET).get('installation');
      const token = transaction.objectStore(PRESET).get('installationToken');
      transaction.oncomplete = () =>
        resolve({
          objects,
          records: request.result,
          active: active.result,
          installation: installation.result,
          installationToken: token.result ?? null,
        });
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error ?? new Error('Bundle read failed'));
    });
  }

  async get(id: string): Promise<PreparedBundle | undefined> {
    const database = await this.open();
    let objects = new Map<string, StoredObject>();
    const record = await new Promise<StoredBundle | undefined>((resolve, reject) => {
      const transaction = database.transaction([STORE, OBJECTS], 'readonly');
      const request = transaction.objectStore(STORE).get(id);
      request.onsuccess = () => {
        objects = readObjects(
          request.result ? [request.result] : [],
          transaction.objectStore(OBJECTS),
        );
      };
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error ?? new Error('Bundle read failed'));
    });
    return record ? this.verified(record, objects) : undefined;
  }

  private async verified(
    record: StoredBundle,
    objects: Map<string, StoredObject>,
  ): Promise<PreparedBundle> {
    if (record.id !== record.bundle?.manifest?.id || record.revision !== record.bundle?.revision) {
      throw new BundleError('BUNDLE_INTEGRITY', 'Stored bundle identity does not match');
    }
    const resources: Record<string, Uint8Array> = {};
    for (const [name, metadata] of Object.entries(record.bundle.manifest.resources)) {
      const object = objects.get(metadata.sha256);
      if (!object || object.sha256 !== metadata.sha256)
        throw new BundleError(
          'BUNDLE_INTEGRITY',
          'Stored resource integrity check failed: object is missing',
        );
      resources[name] = object.bytes;
    }
    const bundle = await verifyBundle(
      { ...record.bundle, resources },
      this.options.mearlApiVersion,
    );
    if (
      Object.values(bundle.resources).reduce((sum, bytes) => sum + bytes.byteLength, 0) !==
      record.byteLength
    ) {
      throw new BundleError('BUNDLE_INTEGRITY', 'Stored resource size does not match');
    }
    return bundle;
  }

  async list() {
    const bundles: PreparedBundle[] = [];
    const errors: Array<{ id: string; error: string }> = [];
    const {
      objects,
      records,
      active,
      installation: storedInstallation,
      installationToken,
    } = await this.records();
    for (const record of records) {
      try {
        bundles.push(await this.verified(record, objects));
      } catch (error) {
        errors.push({
          id: record.id,
          error: error instanceof Error ? error.message : 'Invalid stored bundle',
        });
      }
    }
    let activation: Awaited<ReturnType<typeof verifyBrowserPreset>> | undefined;
    let activationError: string | undefined;
    let installation: BrowserPresetInstallation | undefined;
    let installationError: string | undefined;
    if (active) {
      try {
        activation = await verifyBrowserPreset(active, this.options.mearlApiVersion);
      } catch (error) {
        activation = undefined;
        activationError = error instanceof Error ? error.message : 'Invalid active preset';
      }
      if (activation) {
        for (const [id, revision] of Object.entries(activation.snapshot.bundleRevisions)) {
          if (
            !bundles.some(bundle => bundle.manifest.id === id && bundle.revision === revision) &&
            !errors.some(error => error.id === id)
          ) {
            errors.push({
              id,
              error: 'BUNDLE_INTEGRITY: An active preset package is missing or corrupt',
            });
          }
        }
      }
    }
    if (storedInstallation !== undefined) {
      try {
        installation = installationMetadata(storedInstallation);
        if (!activation || installation.browserRevision !== activation.snapshot.revision)
          throw new BundleError(
            'BUNDLE_INTEGRITY',
            'Browser installation does not match its active preset',
          );
      } catch (error) {
        installation = undefined;
        installationError = error instanceof Error ? error.message : 'Invalid browser installation';
      }
    }
    return {
      bundles,
      errors,
      activation,
      activationError,
      installation,
      installationError,
      installationToken,
      activeRevision: active?.revision ?? null,
      revisions: Object.fromEntries(records.map(record => [record.id, record.revision])),
    };
  }

  async activePreset() {
    const database = await this.open();
    const active = await new Promise<BrowserPresetSnapshot | undefined>((resolve, reject) => {
      const transaction = database.transaction(PRESET, 'readonly');
      const request = transaction.objectStore(PRESET).get('active');
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error ?? new Error('Preset read failed'));
    });
    return active ? verifyBrowserPreset(active, this.options.mearlApiVersion) : undefined;
  }

  /** Verified browser modules remain addressable while a bound document retains them. */
  async browserRuntimeBytes(sha256: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(sha256))
      throw new BundleError('BUNDLE_INVALID', 'Invalid browser runtime digest');
    const database = await this.open();
    const record = await new Promise<StoredObject | undefined>((resolve, reject) => {
      const transaction = database.transaction(OBJECTS, 'readonly');
      const request = transaction.objectStore(OBJECTS).get(sha256);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error ?? new Error('Browser runtime read failed'));
    });
    if (
      !(record?.bytes instanceof Uint8Array) ||
      record.sha256 !== sha256 ||
      record.bytes.byteLength > MAX_BUNDLE_BYTES ||
      (await bundleDigest(record.bytes)) !== sha256
    ) {
      throw new BundleError('BUNDLE_INTEGRITY', 'Pinned browser runtime is missing or corrupt');
    }
    return Uint8Array.from(record.bytes);
  }

  /** Content-addressed code survives package updates so pinned documents can still navigate. */
  async pageRuntimeSource(sha256: string): Promise<string> {
    const bytes = await this.browserRuntimeBytes(sha256);
    if (bytes.byteLength > MAX_PAGE_RUNTIME_BYTES)
      throw new BundleError('BUNDLE_INTEGRITY', 'Page runtime exceeds its size limit');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new BundleError('BUNDLE_INTEGRITY', 'Page runtime is not UTF-8');
    }
  }

  async pinPageRuntimes(patch: Record<string, string | null>): Promise<void> {
    await this.updateRuntimePins(patch, false);
  }

  /** Hosts rebuild these references from their authoritative session state after restart. */
  async synchronizePageRuntimePins(pins: Record<string, string>): Promise<void> {
    await this.updateRuntimePins(pins, true);
  }

  private async updateRuntimePins(
    input: Record<string, string | null>,
    replace: boolean,
  ): Promise<void> {
    const patch = Object.entries(input).map(([owner, sha256]) => {
      if (
        !/^[a-zA-Z0-9:._-]{1,200}$/.test(owner) ||
        (sha256 !== null && !/^[a-f0-9]{64}$/.test(sha256))
      )
        throw new BundleError('BUNDLE_INVALID', 'Invalid page runtime reference');
      return { owner, sha256 };
    });
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE, OBJECTS, PINS], 'readwrite');
      const runtimeStore = transaction.objectStore(OBJECTS);
      const pinStore = transaction.objectStore(PINS);
      const records = transaction.objectStore(STORE).getAll();
      const resources = runtimeStore.getAll();
      const request = pinStore.getAll();
      let failure: Error | undefined;
      request.onsuccess = () => {
        const cached = new Map(
          (resources.result as StoredObject[]).map(resource => [resource.sha256, resource]),
        );
        const available = [...cached.values()];
        const pins = new Map<string, RuntimePin>(
          replace ? [] : request.result.map((pin: RuntimePin) => [pin.owner, pin]),
        );
        for (const { owner, sha256 } of patch) {
          if (sha256 === null) {
            pins.delete(owner);
            continue;
          }
          if (!replace && !cached.has(sha256)) {
            failure = new BundleError('BUNDLE_INTEGRITY', 'Cannot retain a missing page runtime');
            transaction.abort();
            return;
          }
          pins.set(owner, { owner, sha256 });
        }
        pinStore.clear();
        for (const pin of pins.values()) pinStore.put(pin);
        const retained = new Set(
          referencedObjects(records.result, available, [...pins.values()]).map(
            runtime => runtime.sha256,
          ),
        );
        for (const runtime of available)
          if (!retained.has(runtime.sha256)) runtimeStore.delete(runtime.sha256);
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(failure ?? transaction.error ?? new Error('Page runtime reference update failed'));
    });
  }

  /** Pins the verified selection while reading its package from the same IndexedDB snapshot. */
  async profileBinding(
    name: string,
  ): Promise<{ target: string; bundle: PreparedBundle } | undefined> {
    const activation = await this.activePreset();
    if (!activation || !Object.hasOwn(activation.preset.appProfiles, name)) return undefined;
    const target = activation.preset.appProfiles[name]!;
    const id = target.split('/')[0];
    const database = await this.open();
    let objects = new Map<string, StoredObject>();
    const record = await new Promise<StoredBundle | undefined>((resolve, reject) => {
      const transaction = database.transaction([PRESET, STORE, OBJECTS], 'readonly');
      const current = transaction.objectStore(PRESET).get('active');
      const bundle = transaction.objectStore(STORE).get(id);
      bundle.onsuccess = () => {
        objects = readObjects(
          bundle.result ? [bundle.result] : [],
          transaction.objectStore(OBJECTS),
        );
      };
      transaction.oncomplete = () => {
        if (current.result?.revision !== activation.snapshot.revision) {
          reject(
            new BundleError('BUNDLE_CONFLICT', 'The selected preset changed during profile lookup'),
          );
        } else {
          resolve(bundle.result);
        }
      };
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error ?? new Error('Preset binding read failed'));
    });
    if (!record || record.revision !== activation.snapshot.bundleRevisions[id])
      throw new BundleError('BUNDLE_INTEGRITY', 'The selected app provider is missing');
    return { target, bundle: await this.verified(record, objects) };
  }

  /** Packages and the exact preset graph become visible together, after host contribution checks. */
  async activatePreset(
    input: BrowserPresetSnapshot,
    replacements: Array<{ bundle: PreparedBundle; expectedRevision: string | null }>,
    expectedRevision: string | null,
    association?: {
      installation?: BrowserPresetInstallation;
      expectedInstallationToken: string | null;
    },
    expectedBundleRevisions?: Record<string, string>,
  ): Promise<void> {
    const selection = captureRevisions(expectedBundleRevisions);
    const accepted = association?.installation && {
      installation: installationMetadata(association.installation),
      expected: association.expectedInstallationToken,
    };
    if (
      (association &&
        association.expectedInstallationToken !== null &&
        !/^[a-f0-9]{64}$/.test(association.expectedInstallationToken)) ||
      (accepted && accepted.installation.browserRevision !== input.revision)
    )
      throw new BundleError('BUNDLE_INVALID', 'Invalid browser installation selection');
    if (
      replacements.length > 64 ||
      replacements.reduce(
        (total, item) =>
          total +
          Object.values(item.bundle.resources).reduce((sum, bytes) => sum + bytes.byteLength, 0),
        0,
      ) > MAX_BROWSER_STORAGE_BYTES
    ) {
      throw new BundleError('BUNDLE_QUOTA', 'Preset packages exceed the browser storage budget');
    }
    const expected = replacements.map(item => item.expectedRevision);
    const { snapshot, bundles } = await verifyPreparedBrowserPreset(
      { snapshot: input, bundles: replacements.map(item => item.bundle) },
      this.options.mearlApiVersion,
    );
    const next = bundles.map((bundle, index) => ({ bundle, expectedRevision: expected[index] }));
    const token = accepted ? await bundleDigest(crypto.getRandomValues(new Uint8Array(32))) : null;
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE, PRESET, OBJECTS, PINS], 'readwrite');
      const store = transaction.objectStore(STORE);
      const presets = transaction.objectStore(PRESET);
      const records = store.getAll();
      const runtimeStore = transaction.objectStore(OBJECTS);
      const retained = runtimeStore.getAll();
      const pins = transaction.objectStore(PINS).getAll();
      const installation = presets.get('installationToken');
      const active = presets.get('active');
      let failure: Error | undefined;
      active.onsuccess = () => {
        try {
          checkRevisions(records.result, selection);
        } catch (error) {
          failure = error as Error;
          transaction.abort();
          return;
        }
        if (
          (active.result?.revision ?? null) !== expectedRevision ||
          (association &&
            (installation.result ?? null) !== association.expectedInstallationToken) ||
          next.some(
            item =>
              (records.result.find(record => record.id === item.bundle.manifest.id)?.revision ??
                null) !== item.expectedRevision,
          )
        ) {
          failure = new BundleError(
            'BUNDLE_CONFLICT',
            'Preset or packages changed while activation was being prepared',
          );
          transaction.abort();
          return;
        }
        const replacing = new Set(next.map(item => item.bundle.manifest.id));
        const previousManaged = new Set(Object.keys(active.result?.bundleRevisions ?? {}));
        if (
          accepted &&
          next.some(
            item =>
              !previousManaged.has(item.bundle.manifest.id) &&
              records.result.some(record => record.id === item.bundle.manifest.id),
          )
        ) {
          failure = new BundleError(
            'BUNDLE_CONFLICT',
            'A preset package conflicts with an independently installed browser package',
          );
          transaction.abort();
          return;
        }
        const result = (records.result as StoredBundle[]).filter(
          record => !replacing.has(record.id) && !previousManaged.has(record.id),
        );
        for (const { bundle } of next) result.push(storedBundle(bundle));
        const resources = bundleObjects(next.map(item => item.bundle));
        const cache = new Map(
          (retained.result as StoredObject[]).map(runtime => [runtime.sha256, runtime]),
        );
        for (const runtime of resources) cache.set(runtime.sha256, runtime);
        const keeping = referencedObjects(result, [...cache.values()], pins.result);
        try {
          checkStorageBudget(result, keeping);
        } catch (error) {
          failure = error as Error;
          transaction.abort();
          return;
        }
        for (const record of result) if (replacing.has(record.id)) store.put(record);
        for (const id of previousManaged) if (!replacing.has(id)) store.delete(id);
        for (const runtime of resources) runtimeStore.put(runtime);
        const keep = new Set(keeping.map(runtime => runtime.sha256));
        for (const runtime of retained.result as StoredObject[])
          if (!keep.has(runtime.sha256)) runtimeStore.delete(runtime.sha256);
        presets.put(snapshot, 'active');
        if (accepted) {
          presets.put(accepted.installation, 'installation');
          presets.put(token, 'installationToken');
        } else {
          presets.delete('installation');
          presets.delete('installationToken');
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(failure ?? transaction.error ?? new Error('Preset activation failed'));
    });
  }

  async uninstallPreset(
    expectedRevision: string,
    expectedInstallationToken: string | null,
  ): Promise<void> {
    const selection = await this.activePreset();
    if (selection?.snapshot.revision !== expectedRevision)
      throw new BundleError('BUNDLE_CONFLICT', 'The browser preset changed before removal');
    const managed = selection.snapshot.bundleRevisions;
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE, PRESET, OBJECTS, PINS], 'readwrite');
      const store = transaction.objectStore(STORE);
      const presets = transaction.objectStore(PRESET);
      const objects = transaction.objectStore(OBJECTS);
      const records = store.getAll();
      const retained = objects.getAll();
      const pins = transaction.objectStore(PINS).getAll();
      const token = presets.get('installationToken');
      const active = presets.get('active');
      let failure: Error | undefined;
      active.onsuccess = () => {
        if (
          active.result?.revision !== expectedRevision ||
          (token.result ?? null) !== expectedInstallationToken
        ) {
          failure = new BundleError('BUNDLE_CONFLICT', 'The browser preset changed before removal');
          transaction.abort();
          return;
        }
        const remaining = (records.result as StoredBundle[]).filter(record => {
          if (!Object.hasOwn(managed, record.id) || managed[record.id] !== record.revision)
            return true;
          store.delete(record.id);
          return false;
        });
        const keep = new Set(
          referencedObjects(remaining, retained.result, pins.result).map(object => object.sha256),
        );
        for (const object of retained.result as StoredObject[])
          if (!keep.has(object.sha256)) objects.delete(object.sha256);
        for (const key of ['active', 'installation', 'installationToken']) presets.delete(key);
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(failure ?? transaction.error ?? new Error('Browser preset removal failed'));
    });
  }

  /** Verifies all resources before a compare-and-swap transaction replaces the active snapshot. */
  async install(
    bundle: PreparedBundle,
    expectedRevision: string | null,
    expectedBundleRevisions?: Record<string, string>,
  ): Promise<void> {
    const selection = captureRevisions(expectedBundleRevisions);
    const verified = await verifyBundle(bundle, this.options.mearlApiVersion);
    await this.change(
      verified.manifest.id,
      expectedRevision,
      storedBundle(verified),
      selection,
      bundleObjects([verified]),
    );
  }

  async remove(id: string, expectedRevision: string): Promise<void> {
    await this.change(id, expectedRevision);
  }

  private async change(
    id: string,
    expectedRevision: string | null,
    next?: StoredBundle,
    selection?: Record<string, string>,
    resources: StoredObject[] = [],
  ): Promise<void> {
    const database = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE, PRESET, OBJECTS, PINS], 'readwrite');
      const store = transaction.objectStore(STORE);
      const active = transaction.objectStore(PRESET).get('active');
      const runtimeStore = transaction.objectStore(OBJECTS);
      const retained = runtimeStore.getAll();
      const pins = transaction.objectStore(PINS).getAll();
      let failure: Error | undefined;
      const request = store.getAll();
      request.onsuccess = () => {
        const records = request.result as StoredBundle[];
        try {
          checkRevisions(records, selection);
        } catch (error) {
          failure = error as Error;
          transaction.abort();
          return;
        }
        if (Object.hasOwn(active.result?.bundleRevisions ?? {}, id)) {
          failure = new BundleError(
            'BUNDLE_CONFLICT',
            'The package is managed by the active preset',
          );
          transaction.abort();
          return;
        }
        const current = records.find(record => record.id === id);
        if ((current?.revision ?? null) !== expectedRevision) {
          failure = new BundleError(
            'BUNDLE_CONFLICT',
            'Bundle changed while the operation was being prepared',
          );
          transaction.abort();
          return;
        }
        if (next) {
          const others = records.filter(record => record.id !== id);
          const cache = new Map(
            (retained.result as StoredObject[]).map(runtime => [runtime.sha256, runtime]),
          );
          for (const runtime of resources) cache.set(runtime.sha256, runtime);
          const keeping = referencedObjects([...others, next], [...cache.values()], pins.result);
          try {
            checkStorageBudget([...others, next], keeping);
          } catch (error) {
            failure = error as Error;
            transaction.abort();
            return;
          }
          store.put(next);
          for (const runtime of resources) runtimeStore.put(runtime);
          const keep = new Set(keeping.map(runtime => runtime.sha256));
          for (const runtime of retained.result as StoredObject[])
            if (!keep.has(runtime.sha256)) runtimeStore.delete(runtime.sha256);
        } else {
          store.delete(id);
          const keep = new Set(
            referencedObjects(
              records.filter(record => record.id !== id),
              retained.result,
              pins.result,
            ).map(runtime => runtime.sha256),
          );
          for (const runtime of retained.result as StoredObject[])
            if (!keep.has(runtime.sha256)) runtimeStore.delete(runtime.sha256);
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(failure ?? transaction.error ?? new Error('Bundle transaction failed'));
    });
  }
}
