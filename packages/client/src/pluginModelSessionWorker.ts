import type {
  PluginModelDiagnostic,
  PluginModelRequest,
  PluginModelResult,
} from '@mearl/browser-core';
import type { PluginExecutionError } from '@mearl/browser-core';
import { CLIENT_VERSION } from './runtimePaths.js';
import { serializePluginExecutionError } from './plugins/runtime/pluginExecutorProtocol.js';
import { supervisePluginExecutor } from './plugins/runtime/pluginExecutorSupervisor.js';

export type ModelSessionRequest = { request: PluginModelRequest };
export type ModelSessionEvent =
  | { type: 'diagnostic'; metadata: PluginModelDiagnostic }
  | { type: 'delta'; delta: string; index: number; metadata?: { itemId?: string; phase?: string } }
  | { type: 'result'; result: PluginModelResult }
  | { type: 'error'; error: PluginExecutionError };

if (process.argv[2] !== '--command') {
  supervisePluginExecutor<ModelSessionRequest, ModelSessionEvent>(import.meta.url);
} else {
  const ready = import('@mearl/agent-runtime/codex').then(runtime => ({
    runtime,
    provider: new runtime.CodexAgentProvider(() => {}, CLIENT_VERSION),
  }));
  const conversation: { threadId?: string } = {};
  let busy = false;
  let turns = 0;
  const diagnostic: PluginModelDiagnostic = {};
  const send = (value: ModelSessionEvent) => {
    if (process.connected) process.send?.(value);
  };
  process.on('disconnect', () => process.exit(1));
  process.on('message', (message: ModelSessionRequest) => {
    if (busy) {
      process.exit(1);
      return;
    }
    busy = true;
    void ready
      .then(async ({ runtime, provider }) => {
        send({ type: 'diagnostic', metadata: diagnostic });
        if (turns >= 32) {
          if (conversation.threadId) await provider.closeSession(conversation.threadId);
          delete conversation.threadId;
          turns = 0;
        }
        const result = await runtime.runCodexModel(
          message.request,
          {
            cwd: process.cwd(),
            conversation,
            signal: new AbortController().signal,
            onDiagnostic: metadata => {
              for (const [key, value] of Object.entries(metadata)) {
                if (!['retryCount', 'activeModel'].includes(key))
                  Object.assign(diagnostic, { [key]: value });
              }
              send({ type: 'diagnostic', metadata });
            },
            onDelta: (delta, index, metadata) => send({ type: 'delta', delta, index, metadata }),
          },
          provider,
        );
        turns++;
        return result;
      })
      .then(
        result => {
          busy = false;
          send({ type: 'result', result });
        },
        error => {
          busy = false;
          send({ type: 'error', error: serializePluginExecutionError(error) });
        },
      );
  });
}
