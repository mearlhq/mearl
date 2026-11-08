import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { withRecordLock } from './registry.js';
import {
  mergePresetDefaults,
  prepareNodeBundleSnapshot,
  prepareCapabilitySnapshot,
  verifyCapabilityActivation,
  resolveCapabilityConfig,
  MAX_CAPABILITY_SELECTION_BYTES,
  parseSetupManagement,
  type JsonObject,
  type CapabilityActivation,
  type ResolvedPreset,
} from '@mearl/preset';
import {
  BundleError,
  MAX_BROWSER_STORAGE_BYTES,
  presetRequiresBrowser,
  validateBundleManifest,
  verifyPreset,
  verifyBrowserPreset,
  verifyPreparedPreset,
  type PreparedBundle,
  type PreparedPreset,
  type PresetSnapshot,
} from '@mearl/preset/bundles';

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_OVERRIDES_BYTES = 262_144;
const POINTER_BYTES = MAX_CAPABILITY_SELECTION_BYTES + 128;

export interface PresetInstallReceipt {
  schemaVersion: 1;
  snapshot: PresetSnapshot;
  bundles: Array<Omit<PreparedBundle, 'resources'>>;
  browserRevision: string;
  nodeRevision: string;
  managedModules: string[];
  nodeSyncRequired: boolean;
  browserSyncRequired?: boolean;
  overrides: JsonObject;
  revision: string;
}

interface SelectionState {
  rawHash: string | null;
  activation?: CapabilityActivation;
  receipt?: PresetInstallReceipt;
  prepared?: PreparedPreset;
  preset?: ResolvedPreset;
}

function readBounded(file: string, limit: number): Buffer {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit)
    throw new Error('Invalid preset resource file or size');
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > limit)
      throw new Error('Invalid preset resource file or size');
    const bytes = Buffer.alloc(Math.min(stat.size, limit) + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const count = readSync(descriptor, bytes, length, bytes.byteLength - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > stat.size) throw new Error('Preset resource changed while reading');
    return bytes.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

function optionalFile(file: string, limit: number): Buffer | undefined {
  try {
    return readBounded(file, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function atomicWrite(file: string, bytes: string | Uint8Array): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function revision(state: SelectionState): string | null {
  return (
    state.activation?.installationRevision ??
    (state.activation ? `node:${state.activation.revision}` : null)
  );
}

function overrides(value: JsonObject): JsonObject {
  if (Object.hasOwn(value, 'management'))
    throw new BundleError('BUNDLE_INVALID', 'Installation management cannot be overridden');
  const accepted = mergePresetDefaults({}, value);
  if (Buffer.byteLength(JSON.stringify(accepted)) > MAX_OVERRIDES_BYTES)
    throw new BundleError('BUNDLE_QUOTA', 'User overrides exceed 256 KiB');
  return accepted;
}

/** One pointer binds the desired preset, user overrides and exact Node selection. */
export class PresetInstallationStore {
  readonly directory: string;
  readonly mearlApiVersion: string;
  private readonly pointer: string;

  constructor(options: { directory?: string; mearlApiVersion?: string } = {}) {
    this.directory = resolve(
      options.directory ??
        (process.env.MEARL_CAPABILITY_DIR || join(homedir(), '.mearl/capabilities')),
    );
    this.mearlApiVersion = options.mearlApiVersion ?? '1.0.0';
    this.pointer = join(this.directory, 'active-node.json');
  }

  private assertCurrent(expected: string | null): void {
    const bytes = optionalFile(this.pointer, POINTER_BYTES);
    if ((bytes ? digest(bytes) : null) !== expected)
      throw new BundleError('BUNDLE_CONFLICT', 'The installed preset changed during preparation');
  }

  async current(options: { verifyResources?: boolean } = {}): Promise<SelectionState> {
    const raw = optionalFile(this.pointer, POINTER_BYTES);
    if (!raw) return { rawHash: null };
    const rawHash = digest(raw);
    const activation = await verifyCapabilityActivation(JSON.parse(raw.toString('utf8')));
    if (!activation.installationRevision) return { rawHash, activation };
    const captured = withRecordLock(this.pointer, () => {
      this.assertCurrent(rawHash);
      const receiptBytes = readBounded(
        join(this.directory, 'installations', `${activation.installationRevision}.json`),
        MAX_RECEIPT_BYTES,
      );
      const receipt = JSON.parse(receiptBytes.toString('utf8')) as PresetInstallReceipt;
      const { revision: receiptRevision, ...data } = receipt;
      if (
        receiptRevision !== activation.installationRevision ||
        digest(JSON.stringify(data)) !== receiptRevision ||
        data.schemaVersion !== 1 ||
        Object.keys(data).some(
          key =>
            ![
              'schemaVersion',
              'snapshot',
              'bundles',
              'browserRevision',
              'nodeRevision',
              'managedModules',
              'nodeSyncRequired',
              'browserSyncRequired',
              'overrides',
            ].includes(key),
        ) ||
        typeof data.nodeSyncRequired !== 'boolean' ||
        (data.browserSyncRequired !== undefined && typeof data.browserSyncRequired !== 'boolean') ||
        data.nodeRevision !== activation.revision ||
        !Array.isArray(data.bundles) ||
        data.bundles.length > 64 ||
        !Array.isArray(data.managedModules) ||
        new Set(data.managedModules).size !== data.managedModules.length ||
        data.managedModules.some(
          id => typeof id !== 'string' || !Object.hasOwn(activation.modules, id),
        )
      ) {
        throw new BundleError(
          'BUNDLE_INTEGRITY',
          'Installed preset receipt does not match its selection',
        );
      }
      const acceptedOverrides = overrides(data.overrides);
      let total = 0;
      const metadata = data.bundles.map(bundle => {
        if (Object.keys(bundle).some(key => !['source', 'manifest', 'revision'].includes(key)))
          throw new BundleError('BUNDLE_INVALID', 'Invalid installed package metadata');
        const manifest = validateBundleManifest(bundle.manifest, this.mearlApiVersion);
        total += Object.values(manifest.resources).reduce(
          (sum, entry) => sum + entry.byteLength,
          0,
        );
        return { ...bundle, manifest };
      });
      if (total > MAX_BROWSER_STORAGE_BYTES)
        throw new BundleError('BUNDLE_QUOTA', 'Installed preset resources exceed 64 MiB');
      const bundles =
        options.verifyResources === false
          ? []
          : metadata.map(bundle => ({
              ...bundle,
              resources: Object.fromEntries(
                Object.entries(bundle.manifest.resources).map(([name, entry]) => [
                  name,
                  readBounded(
                    join(this.directory, 'blobs', `${entry.sha256}.bin`),
                    entry.byteLength,
                  ),
                ]),
              ),
            }));
      for (const entry of options.verifyResources === false
        ? []
        : Object.values(activation.modules)) {
        const bytes = readBounded(
          join(this.directory, 'objects', `${entry.sha256}.cjs`),
          entry.byteLength,
        );
        if (bytes.byteLength !== entry.byteLength || digest(bytes) !== entry.sha256)
          throw new BundleError('BUNDLE_INTEGRITY', 'Installed Node object is missing or corrupt');
      }
      return { receipt: { ...receipt, overrides: acceptedOverrides }, bundles };
    });
    if (options.verifyResources === false) {
      const graph = await verifyPreset(captured.receipt.snapshot, this.mearlApiVersion);
      await verifyBrowserPreset(
        {
          source: graph.snapshot.source,
          manifests: graph.snapshot.manifests,
          packageTargets: graph.snapshot.packageTargets,
          bundleRevisions: Object.fromEntries(
            Object.entries(graph.snapshot.bundleRevisions).filter(([id]) =>
              graph.preset.packages[id].targets?.includes('browser'),
            ),
          ),
          revision: captured.receipt.browserRevision,
        },
        this.mearlApiVersion,
      );
      return { rawHash, activation, receipt: captured.receipt, preset: graph.preset };
    }
    const prepared = await verifyPreparedPreset(
      { snapshot: captured.receipt.snapshot, bundles: captured.bundles },
      this.mearlApiVersion,
    );
    if (prepared.browser.snapshot.revision !== captured.receipt.browserRevision)
      throw new BundleError('BUNDLE_INTEGRITY', 'Installed browser projection does not match');
    const selected = await prepareNodeBundleSnapshot(
      prepared.bundles.filter(bundle =>
        prepared.preset.packages[bundle.manifest.id].targets?.includes('node'),
      ),
      'native-host',
      this.mearlApiVersion,
      resolveCapabilityConfig(
        mergePresetDefaults(prepared.preset.defaults, captured.receipt.overrides),
      ),
    );
    if (
      Object.keys(selected.snapshot.modules).length !== captured.receipt.managedModules.length ||
      captured.receipt.managedModules.some(id => !Object.hasOwn(selected.snapshot.modules, id)) ||
      Object.entries(selected.snapshot.modules).some(
        ([id, entry]) => JSON.stringify(entry) !== JSON.stringify(activation.modules[id]),
      ) ||
      Object.entries(selected.snapshot.bindings).some(
        ([hook, entry]) => JSON.stringify(entry) !== JSON.stringify(activation.bindings[hook]),
      ) ||
      Object.values(activation.bindings).filter(entry =>
        captured.receipt.managedModules.includes(entry.module),
      ).length !== Object.keys(selected.snapshot.bindings).length
    ) {
      throw new BundleError(
        'BUNDLE_INTEGRITY',
        'Installed managed Node selection does not match its packages',
      );
    }
    return { rawHash, activation, prepared, receipt: captured.receipt, preset: prepared.preset };
  }

  async apply(
    input: Pick<PreparedPreset, 'snapshot' | 'bundles'>,
    options: {
      expectedRevision: string | null;
      overrides?: JsonObject;
      signal?: AbortSignal;
      confirm?: () => Promise<void>;
    },
  ): Promise<PresetInstallReceipt> {
    options.signal?.throwIfAborted();
    const acceptedOverrides =
      options.overrides === undefined ? undefined : overrides(options.overrides);
    const [current, prepared] = await Promise.all([
      this.current({ verifyResources: false }),
      verifyPreparedPreset(input, this.mearlApiVersion),
    ]);
    if (revision(current) !== options.expectedRevision)
      throw new BundleError('BUNDLE_CONFLICT', 'The installed preset changed');
    const selected = await prepareNodeBundleSnapshot(
      prepared.bundles.filter(bundle =>
        prepared.preset.packages[bundle.manifest.id].targets?.includes('node'),
      ),
      'native-host',
      this.mearlApiVersion,
      resolveCapabilityConfig(
        mergePresetDefaults(
          prepared.preset.defaults,
          acceptedOverrides ?? current.receipt?.overrides ?? {},
        ),
      ),
    );
    const previousManaged = new Set(current.receipt?.managedModules ?? []);
    const unmanaged = Object.fromEntries(
      Object.entries(current.activation?.modules ?? {}).filter(([id]) => !previousManaged.has(id)),
    );
    for (const entry of Object.values(unmanaged)) {
      const bytes = readBounded(
        join(this.directory, 'objects', `${entry.sha256}.cjs`),
        entry.byteLength,
      );
      if (bytes.byteLength !== entry.byteLength || digest(bytes) !== entry.sha256)
        throw new BundleError('BUNDLE_INTEGRITY', 'An independent Node module is corrupt');
    }
    if (Object.keys(selected.snapshot.modules).some(id => Object.hasOwn(unmanaged, id)))
      throw new BundleError(
        'BUNDLE_CONFLICT',
        'A preset module conflicts with an independently installed Node module',
      );
    const bindings = Object.fromEntries(
      Object.entries(current.activation?.bindings ?? {}).filter(([, entry]) =>
        Object.hasOwn(unmanaged, entry.module),
      ),
    );
    if (Object.keys(selected.snapshot.bindings).some(hook => Object.hasOwn(bindings, hook)))
      throw new BundleError(
        'BUNDLE_CONFLICT',
        'A preset hook conflicts with an independently installed Node module',
      );
    const snapshot = await prepareCapabilitySnapshot({
      schemaVersion: 1,
      modules: { ...unmanaged, ...selected.snapshot.modules },
      bindings: { ...bindings, ...selected.snapshot.bindings },
    });
    const data = {
      schemaVersion: 1 as const,
      snapshot: prepared.snapshot,
      bundles: prepared.bundles.map(({ source, revision, manifest }) => ({
        source,
        revision,
        manifest,
      })),
      browserRevision: prepared.browser.snapshot.revision,
      nodeRevision: snapshot.revision,
      managedModules: Object.keys(selected.snapshot.modules),
      overrides: acceptedOverrides ?? current.receipt?.overrides ?? {},
      nodeSyncRequired: Boolean(
        current.receipt?.nodeSyncRequired ||
        current.receipt?.managedModules.length ||
        Object.values(prepared.preset.packages).some(
          entry => entry.enabled !== false && entry.targets?.includes('node'),
        ),
      ),
      browserSyncRequired: Boolean(
        current.receipt?.browserSyncRequired || presetRequiresBrowser(prepared.preset),
      ),
    };
    const receipt: PresetInstallReceipt = { ...data, revision: digest(JSON.stringify(data)) };
    const receiptBytes = JSON.stringify(receipt);
    if (Buffer.byteLength(receiptBytes) > MAX_RECEIPT_BYTES)
      throw new BundleError('BUNDLE_QUOTA', 'Preset installation receipt exceeds 16 MiB');
    const activation: CapabilityActivation = {
      ...snapshot,
      installationRevision: receipt.revision,
    };
    await options.confirm?.();
    withRecordLock(this.pointer, () => {
      this.assertCurrent(current.rawHash);
      options.signal?.throwIfAborted();
      for (const child of ['blobs', 'objects', 'installations'])
        mkdirSync(join(this.directory, child), { recursive: true, mode: 0o700 });
      for (const bundle of prepared.bundles)
        for (const [name, entry] of Object.entries(bundle.manifest.resources)) {
          atomicWrite(join(this.directory, 'blobs', `${entry.sha256}.bin`), bundle.resources[name]);
        }
      for (const entry of Object.values(selected.snapshot.modules)) {
        const destination = join(this.directory, 'objects', `${entry.sha256}.cjs`);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
          linkSync(join(this.directory, 'blobs', `${entry.sha256}.bin`), temporary);
          renameSync(temporary, destination);
        } finally {
          rmSync(temporary, { force: true });
        }
      }
      atomicWrite(join(this.directory, 'installations', `${receipt.revision}.json`), receiptBytes);
      if (current.receipt?.revision !== receipt.revision)
        atomicWrite(
          join(this.directory, 'rollback.json'),
          JSON.stringify({ candidate: receipt.revision, previous: current.activation ?? null }),
        );
      atomicWrite(this.pointer, JSON.stringify(activation));
    });
    return receipt;
  }

  async uninstall(
    expectedRevision: string,
    beforeRemove?: (selection: { path: string; sha256: string }) => void,
  ): Promise<CapabilityActivation | undefined> {
    const current = await this.current({ verifyResources: false });
    if (current.receipt?.revision !== expectedRevision || !current.activation || !current.rawHash) {
      throw new BundleError('BUNDLE_CONFLICT', 'The installed preset changed before removal');
    }
    const managed = new Set(current.receipt.managedModules);
    const modules = Object.fromEntries(
      Object.entries(current.activation.modules).filter(([id]) => !managed.has(id)),
    );
    const bindings = Object.fromEntries(
      Object.entries(current.activation.bindings).filter(([, entry]) =>
        Object.hasOwn(modules, entry.module),
      ),
    );
    const remaining = Object.keys(modules).length
      ? await prepareCapabilitySnapshot({ schemaVersion: 1, modules, bindings })
      : undefined;
    const sha256 = current.rawHash;
    withRecordLock(this.pointer, () => {
      this.assertCurrent(sha256);
      beforeRemove?.({ path: this.pointer, sha256 });
      rmSync(join(this.directory, 'rollback.json'), { force: true });
      if (remaining) atomicWrite(this.pointer, JSON.stringify(remaining));
      else rmSync(this.pointer);
    });
    return remaining;
  }

  async rollback(expectedRevision: string): Promise<void> {
    const current = await this.current({ verifyResources: false });
    if (current.activation?.installationRevision !== expectedRevision)
      throw new BundleError('BUNDLE_CONFLICT', 'A newer preset installation cannot be rolled back');
    const record = JSON.parse(
      readBounded(join(this.directory, 'rollback.json'), POINTER_BYTES + 256).toString('utf8'),
    );
    if (record.candidate !== expectedRevision)
      throw new BundleError('BUNDLE_CONFLICT', 'The preset rollback record has changed');
    const previous =
      record.previous === null ? undefined : await verifyCapabilityActivation(record.previous);
    withRecordLock(this.pointer, () => {
      this.assertCurrent(current.rawHash);
      if (previous) atomicWrite(this.pointer, JSON.stringify(previous));
      else rmSync(this.pointer, { force: true });
      rmSync(join(this.directory, 'rollback.json'), { force: true });
      this.collectLocked(previous);
    });
  }

  async collectGarbage(): Promise<void> {
    const current = await this.current({ verifyResources: false });
    const raw = optionalFile(join(this.directory, 'rollback.json'), POINTER_BYTES + 256);
    const record = raw && JSON.parse(raw.toString('utf8'));
    const previous =
      record &&
      record.candidate === current.activation?.installationRevision &&
      record.previous !== null
        ? await verifyCapabilityActivation(record.previous)
        : undefined;
    withRecordLock(this.pointer, () => {
      this.assertCurrent(current.rawHash);
      for (const child of ['blobs', 'objects', 'installations'])
        mkdirSync(join(this.directory, child), { recursive: true, mode: 0o700 });
      this.collectLocked(current.activation, previous);
    });
  }

  private collectLocked(active?: CapabilityActivation, previous?: CapabilityActivation): void {
    const receipts = new Set(
      [active?.installationRevision, previous?.installationRevision].filter(
        (value): value is string => Boolean(value),
      ),
    );
    const blobs = new Set<string>();
    const modules = new Set(
      [active, previous].flatMap(selection =>
        Object.values(selection?.modules ?? {}).map(entry => entry.sha256),
      ),
    );
    for (const id of receipts) {
      const record = JSON.parse(
        readBounded(
          join(this.directory, 'installations', `${id}.json`),
          MAX_RECEIPT_BYTES,
        ).toString('utf8'),
      ) as PresetInstallReceipt;
      for (const bundle of record.bundles)
        for (const entry of Object.values(bundle.manifest.resources)) blobs.add(entry.sha256);
    }
    for (const [directory, extension, retained] of [
      ['blobs', '.bin', blobs],
      ['objects', '.cjs', modules],
      ['installations', '.json', receipts],
    ] as const) {
      for (const name of readdirSync(join(this.directory, directory))) {
        const id = name.slice(0, -extension.length);
        if (name.endsWith(extension) && hashPattern.test(id) && !retained.has(id))
          rmSync(join(this.directory, directory, name), { force: true });
      }
    }
  }
}

export function presetSelectionRevision(state: SelectionState): string | null {
  return revision(state);
}

/** Reads accepted local metadata without loading capability factories, browsers or network sources. */
export async function readInstallationManagement(options: { directory?: string } = {}) {
  const current = await new PresetInstallationStore(options).current({ verifyResources: false });
  return {
    setup: parseSetupManagement(current.preset?.defaults.management),
    source: current.receipt?.snapshot.source,
    revision: current.receipt?.revision,
  };
}

export { setupManagementCommand, setupRuntimeCompatible } from '@mearl/preset';
export type { SetupManagement } from '@mearl/preset';
