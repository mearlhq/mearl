/// <reference types="node" preserve="true" />
export { NodeCapabilityRegistry } from '@mearl/daemon-core/capabilities';
export type { NodeCapabilityHandler, NodeCapabilityHandlers } from '@mearl/daemon-core/capabilities';
export type { NativeCapabilityHooks, AppCapabilityCatalog } from './capability-hooks.js';
export interface NodeCapabilityHost {
  version: string;
  env: Readonly<NodeJS.ProcessEnv>;
  fetch: typeof globalThis.fetch;
  providers: {
    listInstalled: typeof import('@mearl/provider/host').listInstalledProviders;
    readLive: typeof import('@mearl/provider/runtime').readLiveProvider;
    assertProtocol: typeof import('@mearl/provider').assertProviderProtocolVersion;
    install: typeof import('@mearl/setup').installProviderPackage;
    launch: typeof import('./browser-provider.js').launchProviderBrowser;
    find: typeof import('./browser-provider.js').findProviderBrowser;
    close: typeof import('./browser-provider.js').closeProviderBrowser;
    request: typeof import('./browser-socket-request.js').requestBrowserSocket;
  };
  renderQr: (value: string) => string;
  runCommand: typeof import('@mearl/daemon-core').runCommand;
}
