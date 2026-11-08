import type { PluginHostConnection } from './pluginHostConnection.js';
import { UnifiedClient } from '../../unified.js';
import type { UnifiedClientOptions, UnifiedInvokeOptions } from '../../unified.js';
import type {
  PluginPageInstance,
  PluginPageEvents,
  PluginPageOperation,
} from '@mearl/browser-core';
export type {
  PluginPageInstance,
  PluginPageEvents,
  PluginPageRuntime,
  PluginPageActivation,
  PluginPageTarget,
  PluginPageOperation,
} from '@mearl/browser-core';

export class PluginPageClient {
  private readonly client?: UnifiedClient;
  constructor(
    configuration: UnifiedClientOptions = {},
    private readonly connection?: PluginHostConnection,
  ) {
    if (!connection) this.client = new UnifiedClient(configuration);
  }
  call(
    plugin: string,
    operation: PluginPageOperation,
    input: Record<string, unknown> = {},
    options: UnifiedInvokeOptions = {},
  ): Promise<any> {
    if (this.connection)
      return this.connection.request(
        'page.call',
        {
          plugin,
          input: { ...input, operation },
          options,
          execution: {
            cwd: process.cwd(),
            environment: Object.fromEntries(
              Object.entries(process.env).filter(entry => entry[1] !== undefined),
            ),
          },
        },
        Math.max(
          120000,
          typeof input.timeoutSec === 'number' && Number.isFinite(input.timeoutSec)
            ? (Math.min(300, input.timeoutSec) + 5) * 1000
            : 0,
        ),
      );
    return this.client!.invoke('plugin_page', { ...input, plugin, operation }, options);
  }
  attach(
    plugin: string,
    input: Record<string, unknown>,
    options: UnifiedInvokeOptions = {},
  ): Promise<PluginPageInstance> {
    return this.call(plugin, 'attach', input, options);
  }
  get(plugin: string, instanceId: string): Promise<PluginPageInstance> {
    return this.call(plugin, 'get', { instanceId });
  }
  list(plugin: string): Promise<{ instances: PluginPageInstance[] }> {
    return this.call(plugin, 'list');
  }
  send(
    plugin: string,
    instanceId: string,
    message: unknown,
    options: { timeoutSec?: number } = {},
  ): Promise<unknown> {
    return this.call(plugin, 'send', { instanceId, message, ...options }, options);
  }
  detach(plugin: string, instanceId: string): Promise<PluginPageInstance> {
    return this.call(plugin, 'detach', { instanceId });
  }
  events(plugin: string, instanceId: string, cursor = 0, waitMs = 0): Promise<PluginPageEvents> {
    return this.call(plugin, 'events', { instanceId, cursor, waitMs });
  }
  disconnect(): void {
    this.client?.disconnect();
  }
}
