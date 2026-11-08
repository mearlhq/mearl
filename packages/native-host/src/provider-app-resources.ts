import {
  MAX_PROVIDER_APP_RESOURCE_MESSAGE_BYTES,
  describeBrowserCapabilities, requireReadyProviderEnhancementTarget, validateAppProfileDefinition,
  type ProviderAppResourceRequest, type ProviderAppResourceResponse, type ProviderAppResourceRevision,
  type ProviderEnhancementTarget,
} from '@mearl/browser-core';
import { mergeAppProfileOptions, resolveAppProfile } from '@mearl/app-profiles';
import { assertProviderProtocolVersion } from '@mearl/provider';
import { NodePageRuntimeStore } from '@mearl/daemon-core/page-runtimes';
import type { PageRuntimeBinding } from '@mearl/preset/bundles';
import { nativeCapabilities } from './native-capability-services.js';
import { listInstalledAppProfiles } from './app-profile-catalog.js';
import { browserConnectionIdentity, type BrowserRecord } from './browser-registry.js';

/** Capture functions and definitions from one accepted installation; do not refresh Skill source. */
export async function acceptedAppResources() {
  await nativeCapabilities.refresh();
  const status = nativeCapabilities.status();
  const runtime = nativeCapabilities.get('app.pageRuntime');
  const defaultRuntime = nativeCapabilities.get('app.defaultPageRuntime');
  const catalog = await listInstalledAppProfiles({ refresh: false });
  if (JSON.stringify(nativeCapabilities.status()) !== JSON.stringify(status)) throw new Error('APP_RESOURCE_CATALOG_CHANGED');
  return { ...status, catalog, runtime, defaultRuntime };
}
type Snapshot = Awaited<ReturnType<typeof acceptedAppResources>>;
interface Dependencies {
  browsers(): BrowserRecord[];
  verify(provider: BrowserRecord, tabId: number, deadline?: number): Promise<ProviderEnhancementTarget>;
  snapshot(): Promise<Snapshot>;
  store?: Pick<NodePageRuntimeStore, 'resolve'>;
}
const revision = (snapshot: Snapshot): ProviderAppResourceRevision => ({ capabilityRevision: snapshot.revision, installationRevision: snapshot.installationRevision });

/** Read-only resource preparation for a live external owner, separate from all page effects. */
export class ProviderAppResourceService {
  constructor(private readonly dependencies: Dependencies) {}
  async invoke(owner: string, request: ProviderAppResourceRequest, deadline?: number): Promise<ProviderAppResourceResponse> {
    const assertDeadline = () => {
      if (deadline !== undefined && (!Number.isSafeInteger(deadline) || Date.now() >= deadline)) throw new Error('App resource deadline exceeded');
    };
    assertDeadline();
    const provider = this.dependencies.browsers().find(browser => browser.browserId === owner);
    if (!provider || provider.transport !== 'provider' || !provider.providerBrowserId || provider.status !== 'connected' || provider.capabilities?.controlSessionMode !== 'external')
      throw new Error('APP_RESOURCE_OWNER_UNAVAILABLE');
    assertProviderProtocolVersion(provider.provider?.protocolVersion, provider.provider?.id);
    const identity = browserConnectionIdentity(provider);
    const assertCurrent = () => {
      assertDeadline();
      const current = this.dependencies.browsers().find(browser => browser.browserId === owner);
      if (!current || current.status !== 'connected' || current.capabilities?.controlSessionMode !== 'external' || browserConnectionIdentity(current) !== identity)
        throw new Error('APP_RESOURCE_OWNER_CHANGED');
    };
    if (!request || typeof request !== 'object' || Array.isArray(request) || !['catalog', 'resolve'].includes(request.operation)) throw new Error('Invalid App resource request');
    const allowed = request.operation === 'catalog' ? ['operation', 'params'] : ['operation', 'providerTabId', 'profile', 'options'];
    if (Object.keys(request).some(key => !allowed.includes(key))) throw new Error('Invalid App resource request');
    let target: Extract<ProviderEnhancementTarget, { ready: true }> | undefined;
    if (request.operation === 'resolve') {
      if (!Number.isSafeInteger(request.providerTabId) || request.providerTabId < 0 || typeof request.profile !== 'string' || !request.profile || request.profile.length > 161 ||
        (request.options !== undefined && (!request.options || typeof request.options !== 'object' || Array.isArray(request.options)))) throw new Error('Invalid App resource request');
      target = requireReadyProviderEnhancementTarget(await this.dependencies.verify(provider, request.providerTabId, deadline), request.providerTabId);
      assertCurrent();
    }
    const snapshot = await this.dependencies.snapshot();
    assertCurrent();
    let result: ProviderAppResourceResponse;
    if (request.operation === 'catalog') {
      result = { ...revision(snapshot), catalog: describeBrowserCapabilities(['set_app_profile'], snapshot.catalog, request.params).apps };
    } else {
      const entry = snapshot.catalog.profiles.find(entry => entry.id === request.profile);
      if (!entry || entry.available === false) throw new Error(`App profile is unavailable: ${request.profile}`);
      let definition = entry.definition;
      if (!definition.pageRuntime && (definition.bridges.length || Object.keys(definition.globals).length)) {
        const binding = snapshot.defaultRuntime?.();
        if (!binding) throw new Error('Required App runtime is not installed');
        definition = validateAppProfileDefinition({ ...definition, pageRuntime: binding });
      }
      const options = mergeAppProfileOptions(request.options);
      if (Object.keys(request.options ?? {}).some(key => !Object.hasOwn(options, key))) throw new Error('Unsupported App resource option');
      const resolved = resolveAppProfile(request.profile, options, definition);
      const binding = resolved.injected.pageRuntime;
      const source = binding ? (this.dependencies.store ?? new NodePageRuntimeStore()).resolve(binding, snapshot.runtime) : undefined;
      const current = requireReadyProviderEnhancementTarget(await this.dependencies.verify(provider, request.providerTabId, deadline), request.providerTabId);
      assertCurrent();
      if (current.mainFrameId !== target!.mainFrameId || current.targetId !== target!.targetId) throw new Error('PAGE_IDENTITY_CHANGED');
      result = { ...revision(snapshot), config: resolved.injected, recommendedPreset: resolved.recommendedPreset, target: current,
        ...(binding && source !== undefined ? { runtime: { binding, source } } : {}) };
    }
    if (Buffer.byteLength(JSON.stringify(result)) + 256 > MAX_PROVIDER_APP_RESOURCE_MESSAGE_BYTES) throw new Error('App resource response exceeded its byte limit');
    return result;
  }
}
