import { pluginRecoverySignature } from '../sdk/pluginRecoveryDefinition.js';
import {
  loadPlugin,
  findPluginRegistration,
  invokeRegisteredPlugin,
  invokeRegisteredToolboxPlugin,
  invokeRegisteredRuntimePlugin,
  invokeRegisteredRecoveryPlugin,
} from '../sdk/plugin.js';
import { pluginFileVersion } from '../pluginSource.js';
import {
  MAX_PLUGIN_RESULT_BYTES,
  pluginExecutionError,
  serializePluginExecutionError,
} from './pluginExecutorProtocol.js';
import type { PluginWorkerEvent, PluginWorkerRequest } from './pluginExecutorProtocol.js';
import type { PluginInvokeOptions } from '../sdk/plugin.js';

const controller = new AbortController();
const pending = new Map<
  number,
  {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    onProgress?: PluginInvokeOptions['onProgress'];
  }
>();
let sequence = 0;
let started = false;
let completed = false;

function send(event: PluginWorkerEvent): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error('Plugin executor disconnected'));
      return;
    }
    process.send(event, error => (error ? reject(error) : resolve()));
  });
}

async function run(message: Extract<PluginWorkerRequest, { type: 'start' }>): Promise<void> {
  try {
    const registration = message.registration ?? findPluginRegistration(message.plugin);
    if (
      registration?.entry !== message.entry ||
      pluginFileVersion(message.entry) !== message.entryVersion
    )
      throw Object.assign(new Error('Plugin source changed before execution'), {
        code: 'PLUGIN_SOURCE_CHANGED',
      });
    const invokePlugin = message.recovery
      ? invokeRegisteredRecoveryPlugin
      : message.access === 'runtime'
        ? invokeRegisteredRuntimePlugin
        : message.access === 'toolbox'
          ? invokeRegisteredToolboxPlugin
          : invokeRegisteredPlugin;
    const declaration =
      message.describe || message.help
        ? await loadPlugin(
            message.entry,
            {
              options: {},
              progress: () => {},
              invoke: async () => {
                throw new Error('Host actions are unavailable during runtime declaration');
              },
            },
            message.plugin,
          )
        : undefined;
    const migration = message.migration
      ? await loadPlugin(
          message.entry,
          {
            options: {},
            signal: controller.signal,
            progress: () => {},
            invoke: async () => {
              throw Object.assign(
                new Error('Checkpoint migration cannot invoke host actions or plugins'),
                { code: 'PLUGIN_CHECKPOINT_MIGRATION_HOST_CALL' },
              );
            },
          },
          message.plugin,
        )
      : undefined;
    if (migration) {
      const definitions = migration.taskRecovery?.commands;
      const definition =
        definitions && Object.hasOwn(definitions, message.invocation.command)
          ? definitions[message.invocation.command]
          : undefined;
      if (
        !definition ||
        !message.expectedRecovery ||
        pluginRecoverySignature(definition) !== message.expectedRecovery
      )
        throw Object.assign(
          new Error('Migration declaration differs from the admitted target format'),
          { code: 'PLUGIN_RECOVERY_DECLARATION_CHANGED' },
        );
    }
    const value = migration
      ? await migration.runMigration(message.invocation)
      : declaration
        ? message.help
          ? declaration.help(message.help.namespace, message.help.command)
          : {
              pageRuntime: declaration.pageRuntime,
              stateStorage: declaration.stateStorage,
              taskRecovery: declaration.taskRecovery,
            }
        : message.model
          ? await (
              await import('@mearl/agent-runtime/codex')
            ).runCodexModel(message.model, {
              signal: controller.signal,
              cwd: process.cwd(),
              onDiagnostic: metadata => {
                void send({ type: 'diagnostic', metadata }).catch(() => process.exit(1));
              },
              onDelta: (
                delta: string,
                index: number,
                metadata?: { itemId?: string; phase?: string },
              ) => {
                void send({
                  type: 'progress',
                  progress: {
                    message: 'model.delta',
                    data: { delta, index, ...metadata, partial: true },
                  },
                }).catch(() => process.exit(1));
              },
            })
          : await invokePlugin(
              message.plugin,
              message.invocation,
              {
                invocation: Object.freeze({
                  ...message.identity,
                  host: Object.freeze(message.identity.host),
                }),
                ...(message.registration
                  ? {
                      resolveRegistration: (name: string) =>
                        name === message.plugin
                          ? message.registration
                          : findPluginRegistration(name),
                    }
                  : {}),
                invoke: (action, payload = {}, options = {}, onProgress) => {
                  controller.signal.throwIfAborted();
                  const id = ++sequence;
                  return new Promise((resolve, reject) => {
                    pending.set(id, { resolve, reject, onProgress });
                    void send({
                      type: 'invoke',
                      id,
                      action,
                      payload,
                      options,
                      ...(onProgress ? { stream: true } : {}),
                    }).catch(error => {
                      pending.delete(id);
                      reject(error);
                    });
                  });
                },
              },
              {
                ...message.options,
                signal: controller.signal,
                source: message.identity.source,
                onProgress: progress => {
                  void send({ type: 'progress', progress }).catch(() => process.exit(1));
                },
              },
            );
    // Business results use a separate lossless channel; diagnostics never supply the result.
    const json = JSON.stringify({ value });
    if (Buffer.byteLength(json) > (message.migration ? 64 * 1024 : MAX_PLUGIN_RESULT_BYTES))
      throw Object.assign(new Error('Plugin result exceeds the execution result limit'), {
        code: 'PLUGIN_RESULT_TOO_LARGE',
      });
    await send({ type: 'result', json });
    completed = true;
  } catch (error) {
    await send({ type: 'error', error: serializePluginExecutionError(error) }).catch(() => {});
    completed = true;
  }
}

export function handlePluginWorkerMessage(message: PluginWorkerRequest): void {
  if (message.type === 'start') {
    if (started) return;
    started = true;
    void run(message);
  } else if (message.type === 'cancel') {
    if (completed) return;
    const error = pluginExecutionError(message.error);
    controller.abort(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  } else if (message.type === 'invoke-progress') {
    const request = pending.get(message.id);
    try {
      request?.onProgress?.(message.progress);
    } catch (error) {
      pending.delete(message.id);
      request?.reject(error instanceof Error ? error : new Error(String(error)));
    }
  } else if (message.type === 'response') {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(pluginExecutionError(message.error));
    else request?.resolve(message.result);
  }
}
