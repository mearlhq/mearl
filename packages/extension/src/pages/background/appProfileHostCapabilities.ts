import type { AppProfileHostCapabilities, InjectedAppProfileConfig } from '@mearl/browser-core';
import { clonePresetDefaults } from '@mearl/preset';
import { type BrowserCapabilityInvocation } from '@mearl/preset/bundles';
import { prepareBrowserCapabilities } from './browserCapabilities';
import { browserCapabilityRegistry } from './browserCapabilityRegistry';

const hooks = ['app.userInfo.scope', 'app.userInfo.resolve', 'request.protocol.resolve', 'request.protocol.prepare', 'request.protocol.streamError'];

/** The App and its host protocols retain the implementation accepted for that binding. */
export async function captureAppProfileHostCapabilities(config: InjectedAppProfileConfig): Promise<InjectedAppProfileConfig> {
  if (config.hostCapabilities !== undefined || !config.pageRuntime && !config.bridges.length) return config;
  const accepted = await prepareBrowserCapabilities(hooks);
  const snapshot: AppProfileHostCapabilities = { modules: {}, bindings: {} };
  for (const [hook, value] of Object.entries(accepted)) {
    const { code: _code, handler, ...module } = value.invocation;
    if (!handler) throw new Error('App host capability requires a handler');
    snapshot.modules[value.bundleId] = { ...module, revision: value.revision };
    snapshot.bindings[hook] = { module: value.bundleId, handler };
  }
  return { ...config, hostCapabilities: snapshot };
}

export function appProfileRuntimePins(owner: string, config?: InjectedAppProfileConfig): Record<string, string> {
  return {
    ...(config?.pageRuntime ? { [owner]: config.pageRuntime.sha256 } : {}),
    ...Object.fromEntries(Object.entries(config?.hostCapabilities?.modules ?? {}).map(([id, module]) => [`${owner}:host:${id}`, module.sha256])),
  };
}

export function replaceAppProfileRuntimePins(owner: string, previous?: InjectedAppProfileConfig, next?: InjectedAppProfileConfig): Record<string, string | null> {
  return { ...Object.fromEntries(Object.keys(appProfileRuntimePins(owner, previous)).map(key => [key, null])), ...appProfileRuntimePins(owner, next) };
}

/** Current authorization is checked by the caller; retained code does not retain permissions. */
export async function prepareAppProfileCapabilities(requested: string[], snapshot?: AppProfileHostCapabilities): Promise<Record<string, { bundleId: string; revision: string; invocation: Omit<BrowserCapabilityInvocation, 'input'> }>> {
  if (!snapshot) return prepareBrowserCapabilities(requested);
  const resources = new Map<string, Promise<Uint8Array>>();
  return Object.fromEntries(await Promise.all(requested.filter(hook => Object.hasOwn(snapshot.bindings, hook)).map(async hook => {
    const binding = snapshot.bindings[hook], module = snapshot.modules[binding.module];
    if (!module || !module.handlers.includes(binding.handler)) throw new Error('Invalid accepted App host capability');
    let bytes = resources.get(module.sha256);
    if (!bytes) { bytes = browserCapabilityRegistry().browserRuntimeBytes(module.sha256); resources.set(module.sha256, bytes); }
    return [hook, { bundleId: binding.module, revision: module.revision, invocation: { code: await bytes, sha256: module.sha256, handlers: [...module.handlers], handler: binding.handler, config: clonePresetDefaults(module.config ?? {}) } }];
  })));
}
