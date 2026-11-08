import {
  receiveBrowserPreset,
  type PresetTransferTransport,
} from '@mearl/preset/bundles';
import { BROWSER_BUNDLE_API_VERSION, browserCapabilityRegistry } from './browserCapabilityRegistry';

export async function synchronizeBrowserPreset(
  input: { operation: 'status' } | { operation: 'sync'; installationRevision: string },
  transport: PresetTransferTransport,
  registry = browserCapabilityRegistry(),
  accepted?: { expected: Awaited<ReturnType<typeof registry.captureInstallationSelection>>; confirm: () => Promise<void> },
) {
  if (input.operation === 'status') return registry.installationStatus();
  if (
    input.operation !== 'sync' ||
    typeof input.installationRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.installationRevision)
  )
    throw new Error('Expected a preset installation revision');
  const previous = accepted?.expected ?? await registry.captureInstallationSelection();
  const current = await registry.installationStatus();
  if (current.ready && current.installationRevision === input.installationRevision) { await accepted?.confirm(); return current; }
  try {
    const received = await receiveBrowserPreset(input.installationRevision, {
      transport,
      mearlApiVersion: BROWSER_BUNDLE_API_VERSION,
    });
    try {
      return await registry.applyPreparedPreset({
        prepared: received.prepared,
        installation: received.installation,
        expected: previous,
        confirm: async () => { await received.confirm(); await accepted?.confirm(); },
      });
    } finally {
      await received.release().catch(() => {});
    }
  } catch (error) {
    const current = await registry.installationStatus();
    return {
      ...current,
      ready: false,
      accepted: false,
      error: error instanceof Error ? error.message : 'Browser preset synchronization failed',
    };
  }
}
