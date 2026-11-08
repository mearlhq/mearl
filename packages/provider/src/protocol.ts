import type { BrowserControlSessionMode } from '@mearl/browser-core';

export const MEARL_PROVIDER_PROTOCOL_VERSION = 3;

export function isProviderControlSessionModes(value: unknown): value is BrowserControlSessionMode[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every(mode => mode === 'mearl' || mode === 'external') &&
    new Set(value).size === value.length;
}

export function assertProviderProtocolVersion(actual: unknown, peer = 'Provider'): void {
  if (actual !== MEARL_PROVIDER_PROTOCOL_VERSION) {
    throw new Error(
      `PROVIDER_PROTOCOL_MISMATCH: ${peer} uses protocol ${String(actual ?? 'unknown')}; expected ${MEARL_PROVIDER_PROTOCOL_VERSION}. Update Mearl and the Provider package, then restart the services.`,
    );
  }
}
