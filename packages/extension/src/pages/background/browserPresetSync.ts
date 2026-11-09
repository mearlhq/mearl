import { receiveBrowserPreset, type PresetTransferTransport } from '@mearl/preset/bundles';
import type { HostToExtensionActionMap } from '@mearl/browser-core';
import { BROWSER_BUNDLE_API_VERSION, browserCapabilityRegistry } from './browserCapabilityRegistry';
import {
  PERMISSION_REQUEST_PAGE,
  PRESET_PERMISSION_REVISION_PARAM,
} from '../../shared/permissionRequest';
import { openPermissionRequestWindow } from './permissionRequestWindow';

async function openPresetPermissions(revision: string) {
  const url = chrome.runtime.getURL(
    `${PERMISSION_REQUEST_PAGE}?${PRESET_PERMISSION_REVISION_PARAM}=${revision}`,
  );
  const contexts = await chrome.runtime.getContexts({ documentUrls: [url] }).catch(() => []);
  const existing = contexts.find(context => context.frameId === 0 && context.windowId >= 0);
  if (existing) {
    const focused = await chrome.windows
      .update(existing.windowId, { focused: true })
      .catch(() => undefined);
    if (focused) return;
  }
  await openPermissionRequestWindow(url, 440, 440);
}

export async function synchronizeBrowserPreset(
  input: HostToExtensionActionMap['__preset_browser']['request'],
  transport: PresetTransferTransport,
  registry = browserCapabilityRegistry(),
  accepted?: {
    expected: Awaited<ReturnType<typeof registry.captureInstallationSelection>>;
    confirm: () => Promise<void>;
  },
) {
  if (input.operation === 'status') return registry.installationStatus(true);
  if (input.operation === 'uninstall') {
    const isRevision = (value: unknown): value is string =>
      typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (
      !isRevision(input.browserRevision) ||
      (input.installationToken !== null && !isRevision(input.installationToken))
    )
      throw new Error('Expected a browser preset revision and installation token');
    return registry.uninstallPreset(input.browserRevision, input.installationToken);
  }
  if (
    input.operation !== 'sync' ||
    typeof input.installationRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.installationRevision)
  )
    throw new Error('Expected a preset installation revision');
  const previous = accepted?.expected ?? (await registry.captureInstallationSelection());
  const current = await registry.installationStatus();
  if (current.ready && current.installationRevision === input.installationRevision) {
    await accepted?.confirm();
    return current;
  }
  try {
    const received = await receiveBrowserPreset(input.installationRevision, {
      transport,
      mearlApiVersion: BROWSER_BUNDLE_API_VERSION,
    });
    try {
      const status = await registry.applyPreparedPreset({
        prepared: received.prepared,
        installation: received.installation,
        expected: previous,
        confirm: async () => {
          await received.confirm();
          await accepted?.confirm();
        },
      });
      if (
        input.showPermissions === true &&
        status.installationRevision === input.installationRevision &&
        status.permissionPending.length
      ) {
        await openPresetPermissions(input.installationRevision).catch(error =>
          console.warn('[Preset] Could not open domain permissions:', error),
        );
      }
      return status;
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
