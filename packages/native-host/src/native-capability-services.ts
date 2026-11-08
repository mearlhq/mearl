import { nativeCapabilityDirectory } from './page-runtime-store.js';
import type { NodeCapabilityRegistry, NodeCapabilityHost, NodeCapabilityHandler } from './node-capabilities.js';
import type { NativeCapabilityHooks, AgentCapabilityFactory } from './capability-hooks.js';

let registry: NodeCapabilityRegistry<NodeCapabilityHost> | undefined;
let initializing: Promise<NodeCapabilityRegistry<NodeCapabilityHost>> | undefined;
async function initialize(): Promise<NodeCapabilityRegistry<NodeCapabilityHost>> {
  if (registry) return registry;
  initializing ??= (async () => {
    const [core, qr, providerHost, providerRuntime, provider, setup, daemon, browsers, transport, version] = await Promise.all([
      import('./node-capabilities.js'), import('uqr'), import('@mearl/provider/host'), import('@mearl/provider/runtime'), import('@mearl/provider'), import('@mearl/setup'), import('@mearl/daemon-core'), import('./browser-provider.js'), import('./browser-socket-request.js'), import('./version.js'),
    ]);
    return registry = new core.NodeCapabilityRegistry<NodeCapabilityHost>({
      version: version.NATIVE_HOST_VERSION, env: Object.freeze({ ...process.env }), fetch: globalThis.fetch,
      providers: Object.freeze({ listInstalled: providerHost.listInstalledProviders, readLive: providerRuntime.readLiveProvider, assertProtocol: provider.assertProviderProtocolVersion, install: setup.installProviderPackage, launch: browsers.launchProviderBrowser, find: browsers.findProviderBrowser, close: browsers.closeProviderBrowser, request: transport.requestBrowserSocket }),
      renderQr: value => qr.renderSVG(value, { pixelSize: 1, border: 2 }), runCommand: daemon.runCommand,
    }, nativeCapabilityDirectory());
  })();
  try { return await initializing; } catch (error) { initializing = undefined; throw error; }
}

/** Pure consumers can inspect optional hooks without starting any local services. */
export const nativeCapabilities = {
  get<K extends keyof NativeCapabilityHooks>(name: K): NativeCapabilityHooks[K] | undefined { return registry?.get<NativeCapabilityHooks[K]>(name); },
  entries(prefix: 'agent.provider.'): Array<[string, AgentCapabilityFactory]> { return (registry?.entries(prefix) ?? []) as Array<[string, AgentCapabilityFactory]>; },
  require<K extends keyof NativeCapabilityHooks>(name: K): NativeCapabilityHooks[K] {
    const handler = registry?.get<NativeCapabilityHooks[K]>(name);
    if (!handler) throw new Error(`Required capability is not installed: ${name}. Enable the preset that provides it.`);
    return handler;
  },
  requireCustom<T extends NodeCapabilityHandler>(name: string): T {
    if (!registry) throw new Error(`Required capability is not installed: ${name}`);
    return registry.require<T>(name);
  },
  async refresh(): Promise<string | undefined> { return (await initialize()).refresh(); },
  status() { return { revision: registry?.revision ?? null, installationRevision: registry?.installationRevision ?? null }; },
  async synchronize() {
    try {
      await nativeCapabilities.refresh();
      return { ...nativeCapabilities.status(), accepted: true };
    } catch (error) {
      return { ...nativeCapabilities.status(), accepted: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};
