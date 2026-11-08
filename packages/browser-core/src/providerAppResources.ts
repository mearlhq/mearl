import type { AppProfileOptions } from './appProfileDefinition.js';
import type { InjectedAppProfileConfig } from './app-profile-runtime/types.js';
import type { BrowserCapabilityCatalog } from './browserCapabilities.js';
import type { GetCapabilitiesParams, BrowserDevicePresetName } from './browserActionProtocol.js';
import type { ProviderEnhancementTarget } from './browserEnhancement.js';

export const PROVIDER_APP_RESOURCE_PROTOCOL_VERSION = 1;
export const MAX_PROVIDER_APP_RESOURCE_MESSAGE_BYTES = 16 * 1024 * 1024;

export type ProviderAppResourceRequest =
  | { operation: 'catalog'; params?: GetCapabilitiesParams }
  | { operation: 'resolve'; providerTabId: number; profile: string; options?: AppProfileOptions };

export interface ProviderAppResourceRevision {
  capabilityRevision: string | null;
  installationRevision: string | null;
}

export interface ResolvedProviderAppResources extends ProviderAppResourceRevision {
  config: InjectedAppProfileConfig;
  recommendedPreset: BrowserDevicePresetName;
  runtime?: { binding: { id: string; sha256: string }; source: string };
}

/** Code is returned only by explicit resolution, never with ordinary capability discovery. */
export type ProviderAppResourceResponse =
  | (ProviderAppResourceRevision & { catalog: BrowserCapabilityCatalog['apps'] })
  | (ResolvedProviderAppResources & { target: Extract<ProviderEnhancementTarget, { ready: true }> });
