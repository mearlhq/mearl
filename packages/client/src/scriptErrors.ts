import { serializePluginExecutionError } from './plugins/runtime/pluginExecutorProtocol.js';

export function serializeScriptError(error: unknown, fallback = 'SCRIPT_ERROR') {
  const value = error as {
    message?: unknown;
    code?: unknown;
    stack?: unknown;
    details?: Record<string, unknown>;
    stage?: unknown;
    attempt?: unknown;
  } | null;
  const diagnostic = serializePluginExecutionError({
    message: typeof value?.message === 'string' ? value.message : String(error),
    code: typeof value?.code === 'string' ? value.code : fallback,
    details: {
      ...value?.details,
      ...(value?.attempt !== undefined ? { attempt: value.attempt } : {}),
    },
    ...(typeof value?.stage === 'string' ? { stage: value.stage } : {}),
  });
  return {
    code: diagnostic.code ?? fallback,
    message: diagnostic.message,
    ...(diagnostic.details ? { details: diagnostic.details } : {}),
    ...(typeof diagnostic.metadata?.stage === 'string' ? { stage: diagnostic.metadata.stage } : {}),
    ...(diagnostic.details?.attempt !== undefined ? { attempt: diagnostic.details.attempt } : {}),
    ...(typeof value?.stack === 'string' ? { stack: value.stack.slice(0, 16384) } : {}),
  };
}
