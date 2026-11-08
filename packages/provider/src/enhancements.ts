import {
  BROWSER_ENHANCEMENT_PROTOCOL_VERSION,
  BROWSER_ENHANCEMENT_NAVIGATION_ORIGIN_VERSION,
  BROWSER_ENHANCEMENT_PREPARATION_VERSION, isBrowserEnhancementPreparationUrl,
  BROWSER_ENHANCEMENT_HOST_ENVIRONMENT_VERSION,
  isBrowserEnhancementAction,
  isEnhancementNavigationOrigin,
  requiredBrowserEnhancementActions,
  type BrowserEnhancementInvocation,
  type ProviderEnhancementBinding,
  type ProviderEnhancementPreparation,
  type ProviderEnhancementRequest,
  type ProviderEnhancementResponse,
} from '@mearl/browser-core';
import { requestProviderHost } from './control-rpc.js';
import { providerBrowserKey } from './registry.js';

export interface ProviderEnhancementClient {
  inspect(request: Omit<Extract<ProviderEnhancementRequest, { operation: 'inspect' }>, 'operation'>, deadline?: number): Promise<ProviderEnhancementPreparation>;
  bind(request: Omit<Extract<ProviderEnhancementRequest, { operation: 'bind' }>, 'operation'>, deadline?: number): Promise<ProviderEnhancementBinding>;
  invoke(binding: ProviderEnhancementBinding, invocation: BrowserEnhancementInvocation, deadline?: number): Promise<unknown>;
  release(binding: ProviderEnhancementBinding, deadline?: number): Promise<{ released: boolean; conflicts?: string[] }>;
}

/** Uses the accepted instance's narrow control-host gateway; never forwards ordinary actions. */
export function createProviderEnhancementClient(
  providerId: string,
  providerBrowserId: string,
  options: { timeoutMs?: number; requireHostEnvironment?: boolean } = {},
): ProviderEnhancementClient {
  if (!providerId || !providerBrowserId) throw new Error('Provider and browser IDs are required');
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new Error('Enhancement timeout must be between 1 and 300000 milliseconds');
  const providerTarget = providerBrowserKey(providerId, providerBrowserId);
  const uncertain = new Set<string>();

  async function request(data: ProviderEnhancementRequest, callerDeadline?: number): Promise<ProviderEnhancementResponse> {
    return requestProviderHost(providerTarget, '__provider_enhancement', data, {
      deadline: callerDeadline ?? Date.now() + timeoutMs, maximumBytes: 1024 * 1024,
      assertHost(host) {
        if (host.enhancementProtocolVersion !== BROWSER_ENHANCEMENT_PROTOCOL_VERSION)
          throw new Error('BROWSER_ENHANCEMENT_UNSUPPORTED: update Mearl and restart the Provider control host');
        // Support negotiation only. The Creator's verified initial environment decides the policy.
        if (options.requireHostEnvironment && host.enhancementHostEnvironmentVersion !== BROWSER_ENHANCEMENT_HOST_ENVIRONMENT_VERSION)
          throw new Error('BROWSER_ENHANCEMENT_UNSUPPORTED: the control host cannot preserve the captured host environment');
        if (data.operation === 'inspect' && host.enhancementPreparationVersion !== BROWSER_ENHANCEMENT_PREPARATION_VERSION)
          throw new Error('BROWSER_ENHANCEMENT_UNSUPPORTED: the control host cannot negotiate a preparation page');
        if ((data.operation === 'bind' || data.operation === 'inspect') && data.navigationOrigin !== undefined &&
          host.enhancementNavigationOriginVersion !== BROWSER_ENHANCEMENT_NAVIGATION_ORIGIN_VERSION)
          throw new Error('BROWSER_ENHANCEMENT_UNSUPPORTED: the control host cannot authorize a first navigation origin');
      },
    });
  }

  function assertConfirmed(binding: ProviderEnhancementBinding) {
    if (uncertain.has(binding.bindingId))
      throw new Error('ENVIRONMENT_UNCONFIRMED: reverify and rebind before another mutation');
  }
  return {
    async inspect(data, deadline) {
      if (!Number.isSafeInteger(data.providerTabId) || data.providerTabId < 0 || !isEnhancementNavigationOrigin(data.navigationOrigin) ||
        !Array.isArray(data.actions) || !data.actions.length || data.actions.some(action => !isBrowserEnhancementAction(action)))
        throw new Error('Invalid enhancement inspection request');
      const result = await request({ ...data, operation: 'inspect' }, deadline);
      if (!('preparation' in result) || result.preparation.providerTabId !== data.providerTabId ||
        !Number.isSafeInteger(result.preparation.tabId) || result.preparation.tabId < 0 ||
        typeof result.preparation.targetId !== 'string' || !result.preparation.targetId || result.preparation.targetId.length > 256 ||
        typeof result.preparation.nativeBrowserId !== 'string' || !result.preparation.nativeBrowserId ||
        (data.nativeBrowserId !== undefined && result.preparation.nativeBrowserId !== data.nativeBrowserId) ||
        !isBrowserEnhancementPreparationUrl(result.preparation.url) ||
        result.preparation.capabilities?.protocolVersion !== BROWSER_ENHANCEMENT_PROTOCOL_VERSION ||
        result.preparation.capabilities?.preparationVersion !== BROWSER_ENHANCEMENT_PREPARATION_VERSION ||
        !Array.isArray(result.preparation.capabilities.actions) || data.actions.some(action => !result.preparation.capabilities.actions.includes(action)))
        throw new Error('Invalid enhancement preparation response');
      return result.preparation;
    },
    async bind(data, deadline) {
      if (!Number.isSafeInteger(data.providerTabId) || data.providerTabId < 0 || !Array.isArray(data.actions) ||
        (data.navigationOrigin !== undefined && !isEnhancementNavigationOrigin(data.navigationOrigin)) ||
        !data.actions.length || data.actions.some(action => !isBrowserEnhancementAction(action)))
        throw new Error('Invalid enhancement binding request');
      const result = await request({ ...data, operation: 'bind' }, deadline);
      if (!('binding' in result) || typeof result.binding?.bindingId !== 'string' || !result.binding.bindingId ||
        !Number.isSafeInteger(result.binding.generation) || result.binding.generation < 1 ||
        !Number.isSafeInteger(result.binding.tabId) || result.binding.tabId < 0 ||
        typeof result.binding.mainFrameId !== 'string' || !result.binding.mainFrameId ||
        (result.binding.targetId !== undefined && (typeof result.binding.targetId !== 'string' || !result.binding.targetId || result.binding.targetId.length > 256)) ||
        typeof result.binding.nativeBrowserId !== 'string' || !result.binding.nativeBrowserId ||
        (data.nativeBrowserId !== undefined && result.binding.nativeBrowserId !== data.nativeBrowserId) ||
        result.binding.providerTabId !== data.providerTabId || !Array.isArray(result.binding.actions) ||
        data.actions.some(action => !result.binding.actions.includes(action)))
        throw new Error('Invalid enhancement binding response');
      uncertain.delete(result.binding.bindingId);
      return result.binding;
    },
    async invoke(binding, invocation, deadline) {
      assertConfirmed(binding);
      if (!isBrowserEnhancementAction(invocation.action) || requiredBrowserEnhancementActions(invocation).some(action => !binding.actions.includes(action)))
        throw new Error('BROWSER_ENHANCEMENT_SCOPE_MISMATCH');
      try {
        const result = await request({ ...invocation, operation: 'invoke', bindingId: binding.bindingId, generation: binding.generation }, deadline);
        if (!('result' in result)) throw new Error('Invalid enhancement invocation response');
        return result.result;
      } catch (error) { uncertain.add(binding.bindingId); throw error; }
    },
    async release(binding, deadline) {
      assertConfirmed(binding);
      try {
        const result = await request({ operation: 'release', bindingId: binding.bindingId, generation: binding.generation }, deadline);
        if (!('released' in result) || typeof result.released !== 'boolean') throw new Error('Invalid enhancement release response');
        return result;
      } catch (error) { uncertain.add(binding.bindingId); throw error; }
    },
  };
}
