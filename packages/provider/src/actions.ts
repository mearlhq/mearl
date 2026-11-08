import { BROWSER_CAPABILITY_ACTIONS, isBrowserCapabilityAction, type BrowserCapabilityAction } from '@mearl/browser-core/browserActionProtocol';

export type ProviderAction = BrowserCapabilityAction;
export const PROVIDER_ACTIONS: readonly ProviderAction[] = Object.keys(BROWSER_CAPABILITY_ACTIONS) as ProviderAction[];
export function isProviderAction(value: unknown): value is ProviderAction {
  return typeof value === 'string' && isBrowserCapabilityAction(value);
}
