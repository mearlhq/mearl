import {
  BROWSER_ENHANCEMENT_PROTOCOL_VERSION, isBrowserEnhancementAction,
  BROWSER_ENHANCEMENT_NAVIGATION_ORIGIN_VERSION,
  BROWSER_ENHANCEMENT_PREPARATION_VERSION, isBrowserEnhancementPreparationUrl,
  BROWSER_ENHANCEMENT_HOST_ENVIRONMENT_VERSION,
  requireReadyProviderEnhancementTarget,
  matchesProviderEnhancementTarget,
  isEnhancementNavigationOrigin,
  requiredBrowserEnhancementActions,
  type BrowserEnhancementRequest, type BrowserEnhancementResponse,
  type ProviderEnhancementBinding, type ProviderEnhancementRequest, type ProviderEnhancementResponse,
  type BrowserEnhancementPreparation,
} from '@mearl/browser-core';
import { assertProviderProtocolVersion } from '@mearl/provider';
import type { BrowserRecord } from './browser-registry.js';
import { browserConnectionIdentity as identity } from './browser-registry.js';
import { randomUUID } from 'node:crypto';

interface Dependencies {
  browsers(): BrowserRecord[];
  request(browser: BrowserRecord, action: string, data: any, deadline?: number): Promise<any>;
  enhance(browser: BrowserRecord, provider: BrowserRecord, request: BrowserEnhancementRequest, deadline?: number, providerTabId?: number): Promise<BrowserEnhancementResponse>;
}
interface BoundPage {
  owner: string;
  providerIdentity: string;
  nativeIdentity: string;
  extensionBindingId: string;
  binding: ProviderEnhancementBinding;
  uncertain: boolean;
}
const slotKey = (owner: string, sourceIdentity: string, tabId: number) => JSON.stringify([owner, sourceIdentity, tabId]);

/** One bounded gateway for accepted Provider instances; no page action or code forwarding. */
export class ProviderEnhancementService {
  private readonly bindings = new Map<string, BoundPage>();
  private readonly busy = new Set<string>();
  private pendingBindings = 0;
  constructor(private readonly dependencies: Dependencies) {}

  private provider(browserId: string): BrowserRecord {
    const browser = this.dependencies.browsers().find(item => item.browserId === browserId);
    if (browser?.transport !== 'provider' || !browser.providerBrowserId || browser.status !== 'connected' ||
      browser.capabilities?.controlSessionMode !== 'external')
      throw new Error('BROWSER_ENHANCEMENT_OWNER_UNAVAILABLE');
    assertProviderProtocolVersion(browser.provider?.protocolVersion, browser.provider?.id);
    return browser;
  }

  private async verifyPage(provider: BrowserRecord, binding: ProviderEnhancementBinding, deadline?: number): Promise<BrowserRecord> {
    const frame = requireReadyProviderEnhancementTarget(await this.dependencies.request(provider, '__provider_enhancement_target', { tabId: binding.providerTabId }, deadline), binding.providerTabId);
    if (!matchesProviderEnhancementTarget(frame, binding)) throw new Error('PAGE_IDENTITY_CHANGED');
    const native = this.dependencies.browsers().find(item => item.browserId === binding.nativeBrowserId && item.transport === 'extension');
    if (!native) throw new Error('BROWSER_ENHANCEMENT_EXTENSION_UNAVAILABLE');
    return native;
  }

  async invoke(owner: string, request: ProviderEnhancementRequest, deadline?: number): Promise<ProviderEnhancementResponse> {
    if (deadline !== undefined && (!Number.isSafeInteger(deadline) || Date.now() >= deadline))
      throw new Error('Browser enhancement deadline exceeded');
    if (!request || typeof request !== 'object' || !['inspect', 'bind', 'invoke', 'release'].includes(request.operation))
      throw new Error('Invalid Provider enhancement request');
    const provider = { ...this.provider(owner) };
    const activeOwners = new Set(this.dependencies.browsers().filter(browser => browser.transport === 'provider' && browser.status === 'connected').map(browser => `${browser.browserId}:${identity(browser)}`));
    for (const [id, binding] of this.bindings) if (!activeOwners.has(`${binding.owner}:${binding.providerIdentity}`) &&
      !this.busy.has(slotKey(binding.owner, binding.providerIdentity, binding.binding.providerTabId))) this.bindings.delete(id);
    if (request.operation === 'inspect' || request.operation === 'bind') {
      const slot = slotKey(owner, identity(provider), request.providerTabId);
      if (this.busy.has(slot)) throw new Error('BROWSER_ENHANCEMENT_BUSY');
      this.busy.add(slot);
      try { return await this.negotiate(provider, request, deadline); }
      finally { this.busy.delete(slot); }
    }
    const page = this.bindings.get(request.bindingId);
    if (!page || page.owner !== owner || page.providerIdentity !== identity(provider) || page.binding.generation !== request.generation)
      throw new Error('ENVIRONMENT_BINDING_NOT_FOUND: reverify and rebind the page');
    const slot = slotKey(owner, identity(provider), page.binding.providerTabId);
    if (this.busy.has(slot)) throw new Error('BROWSER_ENHANCEMENT_BUSY');
    this.busy.add(slot);
    try {
      return await this.mutate(provider, request, page, deadline);
    } finally { this.busy.delete(slot); }
  }

  private async mutate(
    provider: BrowserRecord,
    request: Exclude<ProviderEnhancementRequest, { operation: 'bind' | 'inspect' }>,
    page: BoundPage,
    deadline?: number,
  ): Promise<ProviderEnhancementResponse> {
    const owner = provider.browserId;
    if (page.uncertain) throw new Error('ENVIRONMENT_UNCONFIRMED: reverify the binding before another mutation');
    const native = await this.verifyPage(provider, page.binding, deadline);
    if (identity(native) !== page.nativeIdentity) throw new Error('ENVIRONMENT_BINDING_NOT_FOUND: the native host changed; rebind first');
    let physical: BrowserEnhancementRequest;
    if (request.operation === 'invoke') {
      if (!isBrowserEnhancementAction(request.action) || requiredBrowserEnhancementActions(request).some(action => !page.binding.actions.includes(action)) ||
        !request.data || typeof request.data !== 'object' || Array.isArray(request.data) ||
        (request.data.tabId !== undefined && request.data.tabId !== page.binding.providerTabId))
        throw new Error('BROWSER_ENHANCEMENT_SCOPE_MISMATCH');
      physical = {
        ...request, bindingId: page.extensionBindingId, owner, data: { ...request.data, tabId: page.binding.tabId },
      } as BrowserEnhancementRequest;
    } else {
      physical = { ...request, bindingId: page.extensionBindingId, owner };
    }
    try {
      const result = await this.dependencies.enhance(native, provider, physical, deadline, page.binding.providerTabId);
      if (request.operation === 'invoke' && !('result' in result)) throw new Error('Invalid enhancement invocation response');
      if (request.operation === 'release' && (!('released' in result) || typeof result.released !== 'boolean' ||
        (result.conflicts !== undefined && (!Array.isArray(result.conflicts) || result.conflicts.some(conflict => typeof conflict !== 'string')))))
        throw new Error('Invalid enhancement release response');
      if (request.operation === 'release' && 'released' in result && result.released) this.bindings.delete(request.bindingId);
      if ('binding' in result || 'capabilities' in result || 'preparation' in result) throw new Error('Invalid enhancement mutation response');
      return result;
    } catch (error) {
      page.uncertain = true;
      throw error;
    }
  }

  private async negotiate(
    provider: BrowserRecord,
    request: Extract<ProviderEnhancementRequest, { operation: 'bind' | 'inspect' }>,
    deadline?: number,
  ): Promise<ProviderEnhancementResponse> {
    if (!Number.isSafeInteger(request.providerTabId) || request.providerTabId < 0 ||
      !Array.isArray(request.actions) || !request.actions.length || new Set(request.actions).size !== request.actions.length ||
      request.actions.some(action => !isBrowserEnhancementAction(action)) ||
      (request.navigationOrigin !== undefined && !isEnhancementNavigationOrigin(request.navigationOrigin)) ||
      (request.nativeBrowserId !== undefined && (typeof request.nativeBrowserId !== 'string' || !request.nativeBrowserId)))
      throw new Error('Invalid Provider enhancement binding request');
    const frame = requireReadyProviderEnhancementTarget(await this.dependencies.request(provider, '__provider_enhancement_target', { tabId: request.providerTabId }, deadline), request.providerTabId);
    if (request.operation === 'inspect' && (!frame.targetId || !isEnhancementNavigationOrigin(request.navigationOrigin)))
      throw new Error('BROWSER_ENHANCEMENT_UNSUPPORTED: preparation requires a physical target and navigation origin');
    const previous = [...this.bindings.values()].find(page => page.owner === provider.browserId &&
      page.binding.providerTabId === request.providerTabId && matchesProviderEnhancementTarget(frame, page.binding));
    const candidates = this.dependencies.browsers().filter(browser => browser.transport === 'extension' &&
      (request.nativeBrowserId === undefined || request.nativeBrowserId === browser.browserId));
    const matches: Array<{ browser: BrowserRecord; tabId: number; mainFrameId?: string; targetId?: string; preparation?: BrowserEnhancementPreparation }> = [];
    const liveTabs = new Map<string, Set<number>>();
    let probes = 0, failure: Error | undefined, denied: Error | undefined;
    const recordFailure = (error: unknown) => {
      const issue = error instanceof Error ? error : new Error(String(error));
      if (issue.message.startsWith('BROWSER_ENHANCEMENT_PERMISSION_DENIED:') || issue.message.startsWith('BROWSER_ENHANCEMENT_AGENT_DISABLED:')) denied ??= issue;
      failure ??= issue;
    };
    if (candidates.length > 64) throw new Error('Specify a nativeBrowserId to narrow enhancement discovery');
    // One stale unrelated browser must not consume the entire discovery deadline.
    const discoveryDeadline = () => Math.min(deadline ?? Infinity, Date.now() + 5_000);
    for (const browser of candidates) {
      try {
        const result = await this.dependencies.request(browser, 'tab_list', {}, discoveryDeadline());
        if (!Array.isArray(result?.tabs)) throw new Error('Invalid enhancement discovery response');
        liveTabs.set(browser.browserId, new Set(result.tabs.map((tab: any) => tab?.tabId).filter(Number.isSafeInteger)));
        for (const tab of result.tabs) {
          // Browser-owned documents may omit URL metadata. Only a Provider's physical
          // target proof permits probing them; URL absence never establishes identity.
          const missingUrl = tab?.url === undefined || tab?.url === '';
          if ((tab?.url !== frame.url && !(missingUrl && frame.targetId)) || !Number.isSafeInteger(tab?.tabId) || tab.tabId < 0) continue;
          if (++probes > 128) throw new Error('Too many matching pages; narrow enhancement discovery');
          try {
            const probe = await this.dependencies.enhance(browser, provider, request.operation === 'inspect'
              ? { operation: 'inspect', owner: provider.browserId, tabId: tab.tabId, targetId: frame.targetId!, actions: request.actions, navigationOrigin: request.navigationOrigin }
              : { operation: 'probe', tabId: tab.tabId }, discoveryDeadline(), request.providerTabId);
            const capabilities = 'preparation' in probe ? probe.preparation.capabilities : 'capabilities' in probe ? probe.capabilities : undefined;
            if ((frame.initialEnvironment?.preserveHostPlatform || frame.initialEnvironment?.preserveHostInput) && capabilities?.hostEnvironmentVersion !== BROWSER_ENHANCEMENT_HOST_ENVIRONMENT_VERSION)
              throw new Error('BROWSER_ENHANCEMENT_UNSUPPORTED: the Extension cannot preserve the captured host environment');
            if (request.operation === 'inspect') {
              if (!('preparation' in probe) || probe.preparation.capabilities?.preparationVersion !== BROWSER_ENHANCEMENT_PREPARATION_VERSION ||
                probe.preparation.capabilities?.protocolVersion !== BROWSER_ENHANCEMENT_PROTOCOL_VERSION ||
                probe.preparation.capabilities?.navigationOriginVersion !== BROWSER_ENHANCEMENT_NAVIGATION_ORIGIN_VERSION)
                throw new Error('BROWSER_ENHANCEMENT_UNSUPPORTED: the Extension cannot negotiate a preparation page');
              if (probe.preparation.tabId !== tab.tabId || probe.preparation.targetId !== frame.targetId ||
                !isBrowserEnhancementPreparationUrl(probe.preparation.url) || !Array.isArray(probe.preparation.capabilities.actions) ||
                request.actions.some(action => !probe.preparation.capabilities.actions.includes(action))) continue;
              matches.push({ browser, tabId: tab.tabId, targetId: probe.preparation.targetId, preparation: probe.preparation });
              continue;
            }
            if (!('capabilities' in probe) || probe.capabilities.protocolVersion !== BROWSER_ENHANCEMENT_PROTOCOL_VERSION ||
              (request.navigationOrigin !== undefined && probe.capabilities.navigationOriginVersion !== BROWSER_ENHANCEMENT_NAVIGATION_ORIGIN_VERSION) ||
              !matchesProviderEnhancementTarget(frame, probe) || request.actions.some(action => !probe.capabilities.actions.includes(action))) continue;
            matches.push({ browser, tabId: tab.tabId, mainFrameId: probe.mainFrameId, ...(probe.targetId ? { targetId: probe.targetId } : {}) });
          } catch (error) { recordFailure(error); }
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'Too many matching pages; narrow enhancement discovery') throw error;
        recordFailure(error);
      }
    }
    if (!matches.length && denied) throw denied;
    if (!matches.length && failure) throw failure;
    if (matches.length !== 1)
      throw new Error(matches.length ? 'BROWSER_ENHANCEMENT_AMBIGUOUS_PAGE' : 'BROWSER_ENHANCEMENT_UNAVAILABLE: no verified extension page');
    const match = matches[0]!;
    // Recheck the Provider side after discovery; a same-URL page is never identity proof.
    const current = requireReadyProviderEnhancementTarget(await this.dependencies.request(provider, '__provider_enhancement_target', { tabId: request.providerTabId }, deadline), request.providerTabId);
    if (request.operation === 'inspect') {
      if (!current.targetId || current.targetId !== match.targetId) throw new Error('PAGE_IDENTITY_CHANGED');
      return { preparation: { ...match.preparation!, nativeBrowserId: match.browser.browserId, providerTabId: request.providerTabId } };
    }
    if (!match.mainFrameId || !matchesProviderEnhancementTarget(current, { ...match, mainFrameId: match.mainFrameId })) throw new Error('PAGE_IDENTITY_CHANGED');
    for (const [id, page] of this.bindings) if (liveTabs.has(page.binding.nativeBrowserId) &&
      !liveTabs.get(page.binding.nativeBrowserId)!.has(page.binding.tabId) &&
      !this.busy.has(slotKey(page.owner, page.providerIdentity, page.binding.providerTabId))) this.bindings.delete(id);
    if (this.bindings.size + this.pendingBindings >= 512 && !previous)
      throw new Error('Provider enhancement binding limit reached');
    if (!previous) this.pendingBindings++;
    try {
      const result = await this.dependencies.enhance(match.browser, provider, {
        operation: 'bind', owner: provider.browserId, tabId: match.tabId, mainFrameId: match.mainFrameId, ...(match.targetId ? { targetId: match.targetId } : {}), actions: request.actions,
        ...(request.navigationOrigin ? { navigationOrigin: request.navigationOrigin } : {}),
      }, deadline, request.providerTabId);
      if (!('binding' in result) || result.binding.mainFrameId !== match.mainFrameId || result.binding.targetId !== match.targetId)
        throw new Error('Invalid enhancement binding response');
      const binding: ProviderEnhancementBinding = {
        ...result.binding,
        bindingId: previous && previous.providerIdentity === identity(provider) &&
          previous.nativeIdentity === identity(match.browser) && previous.extensionBindingId === result.binding.bindingId &&
          previous.binding.generation === result.binding.generation ? previous.binding.bindingId : randomUUID(),
        nativeBrowserId: match.browser.browserId, providerTabId: request.providerTabId,
      };
      if (previous && previous.binding.bindingId !== binding.bindingId) this.bindings.delete(previous.binding.bindingId);
      this.bindings.set(binding.bindingId, {
        owner: provider.browserId, providerIdentity: identity(provider), nativeIdentity: identity(match.browser),
        extensionBindingId: result.binding.bindingId, binding, uncertain: false,
      });
      return { binding };
    } finally { if (!previous) this.pendingBindings--; }
  }
}
