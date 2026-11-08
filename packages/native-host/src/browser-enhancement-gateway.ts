import {
  BROWSER_ENHANCEMENT_PROTOCOL_VERSION,
  isBrowserEnhancementAction,
  BROWSER_ENHANCEMENT_PREPARATION_VERSION,
  isBrowserEnhancementPreparationUrl,
  BROWSER_ENHANCEMENT_HOST_ENVIRONMENT_VERSION,
  DomainPermissionError,
  requireReadyProviderEnhancementTarget,
  matchesProviderEnhancementTarget,
  requiredBrowserEnhancementActions,
  type BrowserEnhancementBinding,
  type BrowserEnhancementRequest,
  type BrowserEnhancementResponse,
  type ProviderEnhancementTarget,
} from '@mearl/browser-core';
import { assertProviderProtocolVersion } from '@mearl/provider';
import type { ProviderControlHostRecord } from '@mearl/provider/host';
import { browserConnectionIdentity, type BrowserRecord } from './browser-registry.js';

interface Dependencies {
  browsers(): BrowserRecord[];
  controlHost(): ProviderControlHostRecord | null;
  available(): boolean;
  run<T>(
    action: string,
    data: { tabId: number; [key: string]: unknown },
    work: () => Promise<T>,
  ): Promise<T>;
  tabs(deadline?: number): Promise<number[]>;
  verifySource(
    provider: BrowserRecord,
    tabId: number,
    deadline?: number,
  ): Promise<ProviderEnhancementTarget>;
  invoke(
    request: BrowserEnhancementRequest,
    deadline?: number,
  ): Promise<BrowserEnhancementResponse>;
}

/** Accept only the live control host's scoped RPC, never caller-supplied trust/owner flags. */
export class BrowserEnhancementGateway {
  private readonly bindings = new Map<
    string,
    {
      owner: string;
      sourceIdentity: string;
      issuerIdentity: string;
      providerTabId: number;
      binding: BrowserEnhancementBinding;
    }
  >();
  private pendingBindings = 0;
  constructor(private readonly dependencies: Dependencies) {}

  async invoke(
    source: unknown,
    proof: unknown,
    request: BrowserEnhancementRequest,
    deadline?: number,
    sourceIdentity?: unknown,
    sourceTabId?: unknown,
  ): Promise<BrowserEnhancementResponse> {
    const host = this.dependencies.controlHost();
    if (
      !host?.ready ||
      !host.token ||
      typeof proof !== 'string' ||
      proof !== host.token ||
      host.enhancementProtocolVersion !== BROWSER_ENHANCEMENT_PROTOCOL_VERSION
    )
      throw new Error('BROWSER_ENHANCEMENT_UNTRUSTED_HOST');
    const issuerIdentity = JSON.stringify([host.pid, host.socketPath, proof]);
    const provider = this.dependencies.browsers().find(browser => browser.browserId === source);
    if (
      !provider ||
      provider.transport !== 'provider' ||
      provider.status !== 'connected' ||
      provider.capabilities?.controlSessionMode !== 'external'
    )
      throw new Error('BROWSER_ENHANCEMENT_OWNER_UNAVAILABLE');
    const expectedIdentity = browserConnectionIdentity(provider);
    if (sourceIdentity !== expectedIdentity) throw new Error('BROWSER_ENHANCEMENT_OWNER_CHANGED');
    assertProviderProtocolVersion(provider.provider?.protocolVersion, provider.provider?.id);
    if (!this.dependencies.available())
      throw new Error('BROWSER_ENHANCEMENT_EXTENSION_UNAVAILABLE');
    if (
      !request ||
      typeof request !== 'object' ||
      !['inspect', 'probe', 'bind', 'invoke', 'release'].includes(request.operation)
    )
      throw new Error('Invalid browser enhancement request');
    if (
      request.operation === 'inspect' &&
      host.enhancementPreparationVersion !== BROWSER_ENHANCEMENT_PREPARATION_VERSION
    )
      throw new Error(
        'BROWSER_ENHANCEMENT_UNSUPPORTED: the control host cannot negotiate a preparation page',
      );
    if (request.operation !== 'probe' && request.owner !== provider.browserId)
      throw new Error('ENVIRONMENT_OWNER_CONFLICT');
    if (!Number.isSafeInteger(sourceTabId) || (sourceTabId as number) < 0)
      throw new Error('Invalid Provider enhancement page scope');
    const providerTabId = sourceTabId as number;
    const owners = new Map(
      this.dependencies
        .browsers()
        .filter(browser => browser.transport === 'provider')
        .map(browser => [browser.browserId, browserConnectionIdentity(browser)]),
    );
    for (const [id, binding] of this.bindings)
      if (
        owners.get(binding.owner) !== binding.sourceIdentity ||
        binding.issuerIdentity !== issuerIdentity
      )
        this.bindings.delete(id);

    let tabId: number;
    if (
      request.operation === 'inspect' ||
      request.operation === 'probe' ||
      request.operation === 'bind'
    ) {
      tabId = request.tabId;
    } else {
      const known = this.bindings.get(request.bindingId);
      if (
        !known ||
        known.owner !== provider.browserId ||
        known.sourceIdentity !== expectedIdentity ||
        known.providerTabId !== providerTabId ||
        known.binding.generation !== request.generation
      )
        throw new Error('ENVIRONMENT_BINDING_NOT_FOUND: reverify and rebind the page');
      tabId = known.binding.tabId;
      if (
        request.operation === 'invoke' &&
        (!isBrowserEnhancementAction(request.action) ||
          requiredBrowserEnhancementActions(request).some(
            action => !known.binding.actions.includes(action),
          ) ||
          !request.data ||
          typeof request.data !== 'object' ||
          Array.isArray(request.data) ||
          (request.data.tabId !== undefined && request.data.tabId !== tabId))
      )
        throw new Error('BROWSER_ENHANCEMENT_SCOPE_MISMATCH');
    }
    if (!Number.isSafeInteger(tabId) || tabId < 0)
      throw new Error('A valid enhancement tabId is required');
    const assertDeadline = () => {
      if (deadline !== undefined && (!Number.isSafeInteger(deadline) || Date.now() >= deadline))
        throw new Error('Browser enhancement deadline exceeded');
    };
    assertDeadline();
    if (request.operation === 'bind' && this.bindings.size >= 512) {
      const openTabs = new Set(await this.dependencies.tabs(deadline));
      for (const [id, binding] of this.bindings)
        if (!openTabs.has(binding.binding.tabId)) this.bindings.delete(id);
      if (
        this.bindings.size >= 512 &&
        ![...this.bindings.values()].some(
          binding =>
            binding.owner === provider.browserId &&
            binding.sourceIdentity === expectedIdentity &&
            binding.providerTabId === providerTabId &&
            binding.binding.tabId === tabId &&
            binding.binding.mainFrameId === request.mainFrameId,
        )
      )
        throw new Error('Native enhancement binding limit reached');
    }
    const action = request.operation === 'invoke' ? request.action : 'page_frames';
    const payload = request.operation === 'invoke' ? { ...request.data, tabId } : { tabId };
    return this.dependencies.run(action, payload, async () => {
      assertDeadline();
      const assertCurrent = () => {
        const issuer = this.dependencies.controlHost();
        if (
          !issuer?.ready ||
          issuer.enhancementProtocolVersion !== BROWSER_ENHANCEMENT_PROTOCOL_VERSION ||
          JSON.stringify([issuer.pid, issuer.socketPath, issuer.token]) !== issuerIdentity
        )
          throw new Error('BROWSER_ENHANCEMENT_UNTRUSTED_HOST');
        const current = this.dependencies
          .browsers()
          .find(browser => browser.browserId === provider.browserId);
        if (
          !current ||
          browserConnectionIdentity(current) !== expectedIdentity ||
          current.status !== 'connected' ||
          current.capabilities?.controlSessionMode !== 'external'
        )
          throw new Error('BROWSER_ENHANCEMENT_OWNER_CHANGED');
      };
      assertCurrent();
      const verified = requireReadyProviderEnhancementTarget(
        await this.dependencies.verifySource(provider, providerTabId, deadline),
        providerTabId,
      );
      if (
        (verified.initialEnvironment?.preserveHostPlatform ||
          verified.initialEnvironment?.preserveHostInput) &&
        host.enhancementHostEnvironmentVersion !== BROWSER_ENHANCEMENT_HOST_ENVIRONMENT_VERSION
      )
        throw new Error(
          'BROWSER_ENHANCEMENT_UNSUPPORTED: the control host cannot preserve the captured host environment',
        );
      if (
        request.operation === 'inspect' &&
        (!verified.targetId || verified.targetId !== request.targetId)
      )
        throw new Error('PAGE_IDENTITY_CHANGED');
      const expected =
        request.operation === 'bind'
          ? request
          : request.operation === 'probe' || request.operation === 'inspect'
            ? undefined
            : this.bindings.get(request.bindingId)?.binding;
      if (expected && !matchesProviderEnhancementTarget(verified, expected))
        throw new Error('PAGE_IDENTITY_CHANGED');
      assertDeadline();
      assertCurrent();
      const previous =
        request.operation === 'bind'
          ? [...this.bindings.values()].find(
              binding =>
                binding.owner === provider.browserId &&
                binding.sourceIdentity === expectedIdentity &&
                binding.providerTabId === providerTabId &&
                binding.binding.tabId === tabId &&
                binding.binding.mainFrameId === request.mainFrameId,
            )
          : undefined;
      const reserve = request.operation === 'bind' && !previous;
      if (reserve && this.bindings.size + this.pendingBindings >= 512)
        throw new Error('Native enhancement binding limit reached');
      if (reserve) this.pendingBindings++;
      try {
        let result: BrowserEnhancementResponse;
        try {
          if (request.operation === 'bind') {
            // Never accept a baseline supplied through the enhancement payload itself.
            const { initialEnvironment: _ignored, ...binding } = request;
            result = await this.dependencies.invoke(
              {
                ...binding,
                ...(verified.initialEnvironment
                  ? { initialEnvironment: verified.initialEnvironment }
                  : {}),
              },
              deadline,
            );
          } else result = await this.dependencies.invoke(request, deadline);
        } catch (error) {
          /* eslint-disable preserve-caught-error -- Translate host errors to the existing gateway protocol errors. */
          if (
            request.operation === 'inspect' &&
            error instanceof Error &&
            error.message === 'Invalid browser enhancement request'
          )
            throw new Error(
              'BROWSER_ENHANCEMENT_UNSUPPORTED: the Extension cannot negotiate a preparation page',
            );
          if (error instanceof DomainPermissionError)
            throw new Error('BROWSER_ENHANCEMENT_PERMISSION_DENIED: ' + error.message);
          if (error instanceof Error && error.message === 'Agent service is disabled')
            throw new Error('BROWSER_ENHANCEMENT_AGENT_DISABLED: ' + error.message);
          /* eslint-enable preserve-caught-error */
          throw error;
        }
        if (request.operation === 'inspect') {
          if (
            !('preparation' in result) ||
            result.preparation.tabId !== tabId ||
            result.preparation.targetId !== request.targetId ||
            !isBrowserEnhancementPreparationUrl(result.preparation.url) ||
            result.preparation.capabilities?.preparationVersion !==
              BROWSER_ENHANCEMENT_PREPARATION_VERSION
          )
            throw new Error(
              'BROWSER_ENHANCEMENT_UNSUPPORTED: the Extension cannot negotiate a preparation page',
            );
        } else if (request.operation === 'bind') {
          if (
            !('binding' in result) ||
            result.binding.tabId !== tabId ||
            result.binding.mainFrameId !== request.mainFrameId ||
            result.binding.targetId !== request.targetId ||
            typeof result.binding.bindingId !== 'string' ||
            !result.binding.bindingId ||
            !Number.isSafeInteger(result.binding.generation) ||
            result.binding.generation < 1 ||
            !Array.isArray(result.binding.actions) ||
            request.actions.some(action => !result.binding.actions.includes(action))
          )
            throw new Error('Invalid enhancement binding response');
          if (previous && previous.binding.bindingId !== result.binding.bindingId)
            this.bindings.delete(previous.binding.bindingId);
          this.bindings.set(result.binding.bindingId, {
            owner: provider.browserId,
            sourceIdentity: expectedIdentity,
            issuerIdentity,
            providerTabId,
            binding: result.binding,
          });
        } else if (request.operation === 'invoke' && !('result' in result)) {
          throw new Error('Invalid enhancement invocation response');
        } else if (
          request.operation === 'release' &&
          (!('released' in result) || typeof result.released !== 'boolean')
        ) {
          throw new Error('Invalid enhancement release response');
        } else if (request.operation === 'release' && 'released' in result && result.released) {
          this.bindings.delete(request.bindingId);
        }
        return result;
      } finally {
        if (reserve) this.pendingBindings--;
      }
    });
  }
}
