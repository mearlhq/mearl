import { nativeCapabilities } from './native-capability-services.js';

export interface SandboxBrowserAccessCapability { kind: string; environment?: string; port?: number }
export interface ResolvedSandboxBrowserAccess extends SandboxBrowserAccessCapability { url: string }
export function resolveSandboxBrowserAccessCapability(): SandboxBrowserAccessCapability | null {
  return nativeCapabilities.get('browser.access.capability')?.() ?? null;
}
export async function resolveSandboxBrowserAccess(): Promise<ResolvedSandboxBrowserAccess> {
  return nativeCapabilities.require('browser.access.resolve')();
}
