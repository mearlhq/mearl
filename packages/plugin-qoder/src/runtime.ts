import { QoderAgentProvider } from './agent.js';
import { QoderConnector } from './connector.js';
import { requireQoderEndpoint } from './endpoint.js';
import { runQoderCloudServerCommand } from './pairing.js';

/** Factories remain idle until the host selects this installed contribution. */
export default function createQoderPlugin() {
  return {
    agent: (options: { log: (message: string) => void; version: string }) => new QoderAgentProvider(options.log, options.version),
    connector: (options: Omit<ConstructorParameters<typeof QoderConnector>[0], 'endpoint'> & { serverUrl: string }) =>
      new QoderConnector({ ...options, endpoint: requireQoderEndpoint(options.serverUrl) }),
    server: runQoderCloudServerCommand,
  };
}
