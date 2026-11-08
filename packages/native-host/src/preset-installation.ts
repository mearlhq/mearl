import {
  MAX_BUNDLE_BYTES, presetRequiresBrowser, readPresetTransferResource, type BundleLoader,
} from '@mearl/preset/bundles';
import { PresetInstaller, presetSelectionRevision, type PresetInstallerOptions } from '@mearl/setup/preset';

export const PRESET_INSTALLATION_PROTOCOL = 1;
interface Dependencies {
  directory?: string;
  request: (data: Record<string, unknown>, timeoutMs: number) => Promise<any>;
  invoke: NonNullable<PresetInstallerOptions['invoke']>;
}
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new Error('INVALID_PRESET_INSTALLATION_REQUEST');
  return value as Record<string, unknown>;
}
function selection(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && /^(?:node:)?[a-f0-9]{64}$/.test(value);
}

/** Resources come from the attached browser's accepted installation, including its existing login state. */
export function createInstallationResourceLoader(session: string, request: Dependencies['request']): BundleLoader {
  return async (source, options) => {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > MAX_BUNDLE_BYTES) throw new Error('INVALID_PRESET_RESOURCE_LIMIT');
    options.signal?.throwIfAborted();
    const first = await request({ operation: 'resource', session, source, maxBytes: options.maxBytes, offset: 0 }, 130_000);
    if (!first || !Number.isSafeInteger(first.byteLength) || first.byteLength < 0 || first.byteLength > options.maxBytes || typeof first.sha256 !== 'string') throw new Error('INVALID_PRESET_RESOURCE_RESPONSE');
    return readPresetTransferResource(first.sha256, first.byteLength, { signal: options.signal, read: offset => offset === 0 ? Promise.resolve(first) : request({ operation: 'resource', session, source, maxBytes: options.maxBytes, offset }, 15_000) });
  };
}

/** Only extension-background RPC reaches this installer; socket clients cannot invoke it. */
export class NativePresetInstallation {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly dependencies: Dependencies) {}

  private installer(session?: string): PresetInstaller {
    return new PresetInstaller({
      directory: this.dependencies.directory,
      hosts: () => [{ id: 'attached' }],
      ...(session ? { load: createInstallationResourceLoader(session, this.dependencies.request) } : {}),
      invoke: async (action, data = {}, options) => {
        if (action === 'preset_browser_sync' && session) return this.dependencies.request({ operation: 'sync', session, installationRevision: data.installationRevision }, 130_000);
        return this.dependencies.invoke(action, data, options);
      },
    });
  }

  async handle(value: unknown): Promise<unknown> {
    const input = record(value, ['operation', 'session', 'source', 'presetId', 'expectedRevision', 'replaceSkills']);
    if (input.replaceSkills !== undefined && (input.operation !== 'resume' || !Array.isArray(input.replaceSkills) || !input.replaceSkills.length || input.replaceSkills.length > 256 || input.replaceSkills.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(id)) || new Set(input.replaceSkills).size !== input.replaceSkills.length)) throw new Error('INVALID_PRESET_INSTALLATION_REQUEST');
    if (input.operation === 'inspect') {
      if (Object.keys(input).length !== 1) throw new Error('INVALID_PRESET_INSTALLATION_REQUEST');
      const current = await this.installer().store.current({ verifyResources: false });
      return { protocol: PRESET_INSTALLATION_PROTOCOL, selection: presetSelectionRevision(current), id: current.preset?.id, source: current.receipt?.snapshot.source, browserRequired: current.receipt?.browserSyncRequired };
    }
    if (input.operation === 'status') {
      if (Object.keys(input).some(key => !['operation', 'source', 'presetId', 'expectedRevision'].includes(key)) || typeof input.presetId !== 'string' || typeof input.source !== 'string' || !selection(input.expectedRevision)) throw new Error('INVALID_PRESET_INSTALLATION_REQUEST');
      const installer = this.installer();
      const current = await installer.store.current({ verifyResources: false });
      if (!current.receipt || current.preset?.id !== input.presetId || current.receipt.snapshot.source !== input.source || presetSelectionRevision(current) !== input.expectedRevision) return { ready: false, changed: true };
      return installer.status();
    }
    if (!['apply', 'resume', 'update'].includes(String(input.operation)) || typeof input.session !== 'string' || !/^[a-f0-9-]{36}$/.test(input.session) || typeof input.source !== 'string' || typeof input.presetId !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(input.presetId) || !selection(input.expectedRevision)) throw new Error('INVALID_PRESET_INSTALLATION_REQUEST');
    const source = new URL(input.source);
    if (source.protocol !== 'https:' || source.username || source.password || source.hash || source.href !== input.source) throw new Error('INVALID_PRESET_INSTALLATION_SOURCE');
    const run = async () => {
      const session = input.session as string;
      const installer = this.installer(session);
      if (input.operation === 'resume') {
        const current = await installer.store.current({ verifyResources: false });
        if (!current.receipt || current.preset?.id !== input.presetId || current.receipt.snapshot.source !== source.href || current.receipt.revision !== input.expectedRevision) throw new Error('INSTALLATION_SELECTION_CHANGED');
        await this.dependencies.request({ operation: 'confirm', session }, 15_000);
        return installer.resume(current.receipt.revision, { replaceSkills: input.replaceSkills as string[] | undefined });
      }
      return installer.apply(source.href, {
        skipUnchanged: input.operation === 'update',
        validatePrepared: input.operation === 'update' ? async prepared => {
          await this.dependencies.request({ operation: 'permissions', session, origins: prepared.preset.permissions.origins, browserRevision: prepared.browser.snapshot.revision, browserRequired: presetRequiresBrowser(prepared.preset) }, 15_000);
        } : undefined,
        expectedId: input.presetId as string,
        expectedRevision: input.expectedRevision as string | null,
        confirm: async () => { await this.dependencies.request({ operation: 'confirm', session }, 15_000); },
      });
    };
    const next = this.pending.catch(() => {}).then(run);
    this.pending = next;
    return next;
  }
}
