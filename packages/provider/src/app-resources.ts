import { createHash } from 'node:crypto';
import {
  PROVIDER_APP_RESOURCE_PROTOCOL_VERSION, MAX_PROVIDER_APP_RESOURCE_MESSAGE_BYTES,
  appProfileRevision, validateAppProfileDefinition, requireReadyProviderEnhancementTarget,
  BROWSER_DEVICE_PRESET_NAMES,
  type ProviderAppResourceRequest, type ProviderAppResourceResponse,
} from '@mearl/browser-core';
import { providerBrowserKey } from './registry.js';
import { requestProviderHost } from './control-rpc.js';

export interface ProviderAppResourceClient {
  catalog(params?: Extract<ProviderAppResourceRequest, { operation: 'catalog' }>['params'], deadline?: number): Promise<Extract<ProviderAppResourceResponse, { catalog: unknown }>>;
  resolve(request: Omit<Extract<ProviderAppResourceRequest, { operation: 'resolve' }>, 'operation'>, deadline?: number): Promise<Extract<ProviderAppResourceResponse, { config: unknown }>>;
}

/** Reads accepted installed resources. It never installs code in a page or runs host services. */
export function createProviderAppResourceClient(providerId: string, providerBrowserId: string): ProviderAppResourceClient {
  if (!providerId || !providerBrowserId) throw new Error('Provider and browser IDs are required');
  const target = providerBrowserKey(providerId, providerBrowserId);
  async function request(data: ProviderAppResourceRequest, deadline = Date.now() + 60_000): Promise<ProviderAppResourceResponse> {
    const result = await requestProviderHost<ProviderAppResourceResponse>(target, '__provider_app_resources', data, {
      deadline, maximumBytes: MAX_PROVIDER_APP_RESOURCE_MESSAGE_BYTES,
      assertHost(host) {
        if (host.appResourceProtocolVersion !== PROVIDER_APP_RESOURCE_PROTOCOL_VERSION)
          throw new Error('PROVIDER_APP_RESOURCES_UNSUPPORTED: update Mearl and restart the Provider control host');
      },
    });
    for (const revision of [result.capabilityRevision, result.installationRevision])
      if (revision !== null && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) throw new Error('Invalid App resource revision');
    return result;
  }
  return {
    async catalog(params = {}, deadline) {
      const result = await request({ operation: 'catalog', params }, deadline);
      if (!('catalog' in result) || !result.catalog || !['available', 'partial', 'unsupported'].includes(result.catalog.status) ||
        !Array.isArray(result.catalog.entries) || !Array.isArray(result.catalog.issues)) throw new Error('Invalid App resource catalog');
      return result;
    },
    async resolve(data, deadline) {
      if (!Number.isSafeInteger(data.providerTabId) || data.providerTabId < 0 || typeof data.profile !== 'string' || !data.profile || data.profile.length > 161)
        throw new Error('Invalid App resource request');
      const result = await request({ ...data, operation: 'resolve' }, deadline);
      if (!('config' in result) || result.config?.binding?.version !== 1 || result.config.profile !== data.profile ||
        typeof result.config.userAgent !== 'string' || !BROWSER_DEVICE_PRESET_NAMES.includes(result.recommendedPreset)) throw new Error('Invalid resolved App config');
      const definition = validateAppProfileDefinition(result.config.binding.definition);
      if (definition.name !== data.profile || result.config.binding.revision !== appProfileRevision(definition)) throw new Error('Invalid App definition revision');
      requireReadyProviderEnhancementTarget(result.target, data.providerTabId);
      const binding = result.config.pageRuntime;
      if (binding?.id !== definition.pageRuntime?.id || binding?.sha256 !== definition.pageRuntime?.sha256) throw new Error('App runtime binding mismatch');
      if (binding) {
        if (!result.runtime || result.runtime.binding.id !== binding.id || result.runtime.binding.sha256 !== binding.sha256 ||
          typeof result.runtime.source !== 'string' || createHash('sha256').update(result.runtime.source).digest('hex') !== binding.sha256)
          throw new Error('App runtime integrity check failed');
      } else if (result.runtime || definition.bridges.length || Object.keys(definition.globals).length) throw new Error('Required App runtime is missing');
      return result;
    },
  };
}
