import {
  PluginModelClient,
  PluginStateClient,
  PluginPageClient,
  PluginHostConnection,
} from '@mearl/client';
import type { PluginExecutionContext } from '@mearl/client/plugin';
import type { PluginPageOperation } from '@mearl/client';
import type { PluginStateOperation } from '@mearl/client';

function getClient(
  plugin: string,
  invoke: () => PluginExecutionContext['invoke'],
  event = false,
  interactive = false,
  scope = 'extension',
) {
  if (!/^[a-z][a-z0-9_-]*$/.test(plugin)) throw new Error('Invalid plugin name');
  const key = `${scope}:${event ? 'runtime' : interactive ? 'interactive' : 'toolbox'}:${plugin}`;
  let client = clients.get(key);
  if (!client) {
    const connection = new PluginHostConnection({
      plugin,
      access: event ? 'runtime' : 'toolbox',
      source: event ? 'runtime' : 'toolbox',
      scopeId: `${process.pid}:${scope}`,
      invoke: (action, payload, options) => invoke()(action, payload, options),
    });
    client = {
      connection,
      models: new PluginModelClient({ connection }),
      state: new PluginStateClient({ connection }),
      pages: new PluginPageClient({}, connection),
    };
    clients.set(key, client);
  }
  return client;
}
const clients = new Map<
  string,
  {
    connection: PluginHostConnection;
    models: PluginModelClient;
    state: PluginStateClient;
    pages: PluginPageClient;
  }
>();
export function callPluginPageService(
  plugin: string,
  input: Record<string, unknown>,
  invoke: () => PluginExecutionContext['invoke'],
  event = false,
  interactive = false,
  scope = 'extension',
): Promise<any> {
  const client = getClient(plugin, invoke, event, interactive, scope);
  return event
    ? client.connection.request('page.event', { plugin, input, options: {} }, 40000)
    : client.pages.call(plugin, input.operation as PluginPageOperation, input);
}

export function callPluginStateService(
  plugin: string,
  input: Record<string, unknown>,
  invoke: () => PluginExecutionContext['invoke'],
) {
  return getClient(plugin, invoke).state.call(
    plugin,
    input.collection as string,
    input.operation as PluginStateOperation,
    input,
  );
}
export async function callPluginModelService(
  plugin: string,
  input: Record<string, any>,
  invoke: () => PluginExecutionContext['invoke'],
  execution: { signal?: AbortSignal; onProgress?: (progress: any) => void } = {},
) {
  const client = getClient(plugin, invoke);
  execution.signal?.throwIfAborted();
  if (input.operation === 'capabilities') return client.models.capabilities();
  if (input.operation === 'list') return client.models.list(input.provider);
  if (!['start', 'run'].includes(input.operation)) throw new Error('Invalid model operation');
  const options = input.taskOptions ?? {};
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(key => !['cwd', 'executionTimeoutMs', 'idempotencyKey'].includes(key))
  )
    throw new Error('Invalid toolbox model execution options');
  const started = await client.models.start(plugin, input.request, options);
  if (input.operation === 'start') return started;
  const cancel = () => {
    void client.models.tasks.cancel(started.taskId).catch(() => {});
  };
  execution.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (execution.signal?.aborted) cancel();
    return await client.models.tasks.wait(started.taskId, { onProgress: execution.onProgress });
  } finally {
    execution.signal?.removeEventListener('abort', cancel);
  }
}
