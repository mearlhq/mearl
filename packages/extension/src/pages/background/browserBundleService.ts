import { BundleError } from '@mearl/preset/bundles';
import { browserCapabilityRegistry } from './browserCapabilityRegistry';
import { isExtensionUiSender } from './extensionMessageTrust';
import { getAppProfileForTab, hydrateAppProfileRules } from './utils/appProfileRules';
import { installProfileFromSettings } from './profileInstallation';

export const BROWSER_BUNDLE_ACTION = 'browserCapabilityBundle';

interface InstallInput {
  id: string;
  source: string;
  expectedRevision: string | null;
  version?: string;
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BundleError('BUNDLE_INVALID', 'Expected a bundle operation');
  return value as Record<string, unknown>;
}

function identity(input: Record<string, unknown>, nullable: boolean): void {
  if (
    typeof input.id !== 'string' ||
    !/^[a-z][a-z0-9-]{0,79}$/.test(input.id) ||
    (!(nullable && input.expectedRevision === null) &&
      !(
        typeof input.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(input.expectedRevision)
      ))
  ) {
    throw new BundleError('BUNDLE_INVALID', 'Expected a bundle ID and its current revision');
  }
}

export async function handleBrowserBundleRequest(
  data: unknown,
  sender: Pick<chrome.runtime.MessageSender, 'id' | 'url'>,
  dependencies: {
    extensionId: string;
    registry?: ReturnType<typeof browserCapabilityRegistry>;
    inUse?: (id: string) => Promise<boolean>;
  },
) {
  if (!isExtensionUiSender(sender, dependencies.extensionId)) {
    return {
      success: false,
      code: 'EXTENSION_UI_REQUIRED',
      error: 'Bundle installation requires an extension UI',
    };
  }
  try {
    const input = inputRecord(data);
    const registry = dependencies.registry ?? browserCapabilityRegistry();
    if (!dependencies.registry) await hydrateAppProfileRules();
    if (input.operation === 'list') return { success: true, data: await registry.catalog() };
    if (input.operation === 'installProfile') {
      if (typeof input.source !== 'string' || (input.confirmation !== undefined && typeof input.confirmation !== 'string')) {
        throw new BundleError('BUNDLE_INVALID', 'Expected an App profile source');
      }
      return { success: true, data: await installProfileFromSettings(input.source, input.confirmation) };
    }
    if (input.operation === 'applyPreset') {
      if (
        typeof input.source !== 'string' ||
        !(
          input.expectedRevision === null ||
          (typeof input.expectedRevision === 'string' &&
            /^[a-f0-9]{64}$/.test(input.expectedRevision))
        )
      ) {
        throw new BundleError(
          'BUNDLE_INVALID',
          'Expected a preset source and its current revision',
        );
      }
      return {
        success: true,
        data: await registry.applyPreset({
          source: input.source,
          expectedRevision: input.expectedRevision,
        }),
      };
    }
    if (input.operation === 'install') {
      identity(input, true);
      if (
        typeof input.source !== 'string' ||
        (input.version !== undefined && typeof input.version !== 'string')
      ) {
        throw new BundleError(
          'BUNDLE_INVALID',
          'Expected a bundle source and optional version range',
        );
      }
      return { success: true, data: await registry.install(input as unknown as InstallInput) };
    }
    if (input.operation === 'remove') {
      identity(input, false);
      const id = input.id as string;
      const inUse =
        dependencies.inUse ??
        (async (bundleId: string) => {
          for (const tab of await chrome.tabs.query({})) {
            if (tab.id === undefined) continue;
            const active = await getAppProfileForTab(tab.id);
            if (active?.profile.startsWith(`${bundleId}/`) || active?.pageRuntime?.id.startsWith(`${bundleId}/`)) return true;
          }
          return false;
        });
      if (await inUse(id))
        throw new BundleError(
          'BUNDLE_CONFLICT',
          'Disable the active app simulation before removing its bundle',
        );
      await registry.remove(id, input.expectedRevision as string);
      return { success: true };
    }
    throw new BundleError('BUNDLE_INVALID', 'Unsupported bundle operation');
  } catch (error) {
    return {
      success: false,
      code:
        typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : 'BUNDLE_INVALID',
      error: error instanceof Error ? error.message : 'Bundle operation failed',
    };
  }
}
