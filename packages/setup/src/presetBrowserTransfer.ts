import { createHash, randomUUID } from 'node:crypto';
import { BundleError, MAX_PRESET_TRANSFER_HEADER_BYTES, PRESET_TRANSFER_CHUNK_BYTES, type BrowserPresetTransferHeader, type PresetTransferRequest } from '@mearl/preset/bundles';
import { PresetInstallationStore } from './presetStore.js';

interface TransferSession { id: string; revision: string; touched: number; resources: Map<string, Uint8Array> }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** One bounded, expiring transfer belongs to the host's attached extension connection. */
export class PresetBrowserTransfer {
  private session?: TransferSession;
  constructor(private readonly store = new PresetInstallationStore(), private readonly now = Date.now) {}

  async selectedRevision(acceptedNodeRevision: string | null | undefined): Promise<string | null> {
    const current = await this.store.current({ verifyResources: false });
    return current.receipt?.browserSyncRequired && current.receipt.revision === acceptedNodeRevision ? current.receipt.revision : null;
  }

  async handle(input: PresetTransferRequest): Promise<unknown> {
    if (!input || typeof input !== 'object') throw new BundleError('BUNDLE_INVALID', 'Expected a browser transfer operation');
    if (this.session && this.now() - this.session.touched > 120000) this.session = undefined;
    if (input.operation === 'open') {
      if (this.session) throw new BundleError('BUNDLE_CONFLICT', 'A browser preset transfer is already running');
      if (typeof input.installationRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.installationRevision)) throw new BundleError('BUNDLE_INVALID', 'Expected an installation revision');
      const current = await this.store.current();
      if (!current.receipt || !current.prepared || current.receipt.revision !== input.installationRevision) throw new BundleError('BUNDLE_CONFLICT', 'The selected preset changed before browser transfer');
      const header: BrowserPresetTransferHeader = {
        schemaVersion: 1, installationRevision: current.receipt.revision, snapshot: current.prepared.browser.snapshot,
        bundles: current.prepared.browser.bundles.map(({ source, revision, manifest }) => ({ source, revision, manifest })),
        overrides: current.receipt.overrides,
      };
      const bytes = Buffer.from(JSON.stringify(header));
      if (bytes.byteLength > MAX_PRESET_TRANSFER_HEADER_BYTES) throw new BundleError('BUNDLE_QUOTA', 'Browser transfer metadata exceeds 16 MiB');
      const sha256 = digest(bytes);
      const resources = new Map<string, Uint8Array>([[sha256, bytes]]);
      for (const bundle of current.prepared.browser.bundles) for (const [name, entry] of Object.entries(bundle.manifest.resources)) resources.set(entry.sha256, bundle.resources[name]);
      // A second open may finish validation while the first one is already streaming.
      if (this.session) throw new BundleError('BUNDLE_CONFLICT', 'A browser preset transfer is already running');
      this.session = { id: randomUUID(), revision: current.receipt.revision, touched: this.now(), resources };
      return { session: this.session.id, sha256, byteLength: bytes.byteLength };
    }
    const session = this.session;
    if (!session || input.session !== session.id) throw new BundleError('BUNDLE_CONFLICT', 'Browser preset transfer expired or changed');
    session.touched = this.now();
    if (input.operation === 'release') { this.session = undefined; return { released: true }; }
    if (input.operation === 'confirm') {
      const current = await this.store.current({ verifyResources: false });
      if (current.receipt?.revision !== session.revision) throw new BundleError('BUNDLE_CONFLICT', 'The selected preset changed during browser transfer');
      return { installationRevision: session.revision };
    }
    if (input.operation === 'read') {
      const bytes = session.resources.get(input.sha256);
      if (!bytes || !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset >= bytes.byteLength || input.offset % PRESET_TRANSFER_CHUNK_BYTES !== 0) throw new BundleError('BUNDLE_INVALID', 'Invalid browser transfer resource or offset');
      return { data: Buffer.from(bytes.subarray(input.offset, input.offset + PRESET_TRANSFER_CHUNK_BYTES)).toString('base64') };
    }
    throw new BundleError('BUNDLE_INVALID', 'Unsupported browser preset transfer operation');
  }
}
