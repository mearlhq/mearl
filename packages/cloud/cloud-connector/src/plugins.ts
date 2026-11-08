import { capabilityDirectory } from '@mearl/daemon-core/page-runtimes';
import { NodeCapabilityRegistry } from '@mearl/daemon-core/capabilities';
import type { ConnectorIdentity } from './identity.js';
import type { CloudConnectorStateChange } from './state.js';

export interface ConnectorPlugin { connect(): void; disconnect(): void }
export interface ConnectorPluginOptions {
  serverUrl: string;
  identity: ConnectorIdentity;
  reconnectInterval: number;
  maxReconnectAttempts: number;
  failFast: boolean;
  onConnected(): void;
  onStateChange(change: CloudConnectorStateChange): void;
  onInitialConnectionFailed?: (message: string) => void;
}
export async function loadConnectorPlugin(scheme: string, options: ConnectorPluginOptions): Promise<ConnectorPlugin> {
  const hook = `cloud.connector.${scheme}`;
  const registry = new NodeCapabilityRegistry({}, capabilityDirectory(), { hooks: [hook] });
  await registry.refresh();
  const create = registry.require<(options: ConnectorPluginOptions & { invokeAction: (...args: any[]) => Promise<unknown> }) => ConnectorPlugin | Promise<ConnectorPlugin>>(hook);
  const plugin = await create({ ...options, invokeAction: async (action, payload, requestOptions) => {
    const client = await import('@mearl/client/local');
    return client.invoke(action, payload, { ...requestOptions, controlSource: 'remote' });
  } });
  if (!plugin || typeof plugin.connect !== 'function' || typeof plugin.disconnect !== 'function') throw new Error('Invalid connector capability');
  return plugin;
}
