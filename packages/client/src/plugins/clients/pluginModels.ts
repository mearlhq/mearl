import type { PluginHostClientOptions } from './pluginHostConnection.js';
import { PluginTaskClient } from './pluginTasks.js';
import type { PluginTaskStartOptions, PluginTaskWaitOptions } from './pluginTasks.js';
import type {
  PluginModelRequest,
  PluginModelResult,
  PluginModelCapability,
  PluginModelList,
} from '@mearl/browser-core';
import type { PluginTaskStartResult } from '@mearl/browser-core';
export type * from '@mearl/browser-core';
export class PluginModelClient {
  readonly tasks: PluginTaskClient;
  constructor(options: PluginHostClientOptions = {}) {
    this.tasks = new PluginTaskClient(options);
  }
  capabilities(): Promise<{ providers: PluginModelCapability[] }> {
    return this.tasks.connection.request('model.capabilities');
  }
  list(provider = 'codex'): Promise<PluginModelList> {
    return this.tasks.connection.request('model.list', { provider }, 20000);
  }
  async start(
    plugin: string,
    request: PluginModelRequest,
    options: PluginTaskStartOptions = {},
  ): Promise<PluginTaskStartResult> {
    const {
      cwd = process.cwd(),
      environment = process.env,
      executionTimeoutMs,
      idempotencyKey,
      ...routing
    } = options;
    return this.tasks.connection.request('start', {
      kind: 'model',
      plugin,
      command: 'model',
      input: { request },
      cwd,
      environment: Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      options: routing,
      executionTimeoutMs,
      idempotencyKey,
    });
  }
  async run(
    plugin: string,
    request: PluginModelRequest,
    options: PluginTaskStartOptions & Pick<PluginTaskWaitOptions, 'signal' | 'onProgress'> = {},
  ): Promise<PluginModelResult> {
    const { signal, onProgress, ...execution } = options;
    signal?.throwIfAborted();
    const started = await this.start(plugin, request, execution);
    const cancel = () => {
      void this.tasks.cancel(started.taskId).catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) cancel();
      return (await this.tasks.wait(started.taskId, { onProgress })) as PluginModelResult;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  disconnect(): void {
    this.tasks.disconnect();
  }
}
