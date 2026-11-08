import { PluginHostConnection } from './pluginHostConnection.js';
import type { PluginHostClientOptions } from './pluginHostConnection.js';
import type { PluginOptions } from '../sdk/plugin.js';
import type {
  PluginStateOperation,
  PluginStateSnapshot,
  PluginStateList,
  PluginStateTransaction,
} from '@mearl/browser-core';
export type * from '@mearl/browser-core';
export class PluginStateClient {
  readonly connection: PluginHostConnection;
  constructor(private readonly options: PluginHostClientOptions = {}) {
    this.connection = options.connection ?? new PluginHostConnection(options);
  }
  call(
    plugin: string,
    collection: string,
    operation: PluginStateOperation,
    input: Record<string, unknown> = {},
    options: PluginOptions = {},
  ): Promise<any> {
    return this.connection.request(
      'state.call',
      { plugin, input: { ...input, collection, operation }, options },
      30000,
    );
  }
  get(
    plugin: string,
    collection: string,
    key: string,
    input: { instanceId?: string } = {},
  ): Promise<PluginStateSnapshot> {
    return this.call(plugin, collection, 'get', { ...input, key });
  }
  getMany(
    plugin: string,
    collection: string,
    keys: string[],
    input: { instanceId?: string } = {},
  ): Promise<PluginStateList> {
    return this.call(plugin, collection, 'get-many', { ...input, keys });
  }
  list(
    plugin: string,
    collection: string,
    input: Record<string, unknown> = {},
  ): Promise<PluginStateList> {
    return this.call(plugin, collection, 'list', input);
  }
  transact(
    plugin: string,
    collection: string,
    transaction: PluginStateTransaction,
    input: { instanceId?: string } = {},
  ): Promise<{ revision: number; schemaVersion: number; reused?: boolean }> {
    return this.call(plugin, collection, 'transact', { ...input, transaction });
  }
  disconnect(): void {
    if (!this.options.connection) this.connection.disconnect();
  }
}
