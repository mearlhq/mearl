import type {
  PluginModelDiagnostic,
  PluginModelRequest,
  PluginModelResult,
} from '@mearl/browser-core/pluginModels';
import { readFileSync } from 'node:fs';
import { CodexAgentProvider } from './codex-provider.js';
import type { AgentProviderEvent } from './provider.js';

export { CODEX_MODEL_CAPABILITY } from './capabilities.js';
export interface ModelExecutionContext {
  signal: AbortSignal;
  cwd: string;
  /** The supervised conversation worker owns this in-memory thread and provider. */
  conversation?: { threadId?: string };
  onDiagnostic?(metadata: PluginModelDiagnostic): void;
  onDelta(delta: string, index: number, metadata?: { itemId?: string; phase?: string }): void;
}
/** A supervised worker owns the provider; explicit conversations retain its in-memory thread. */
export async function runCodexModel(
  request: PluginModelRequest,
  context: ModelExecutionContext,
  provider = new CodexAgentProvider(
    () => {},
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  ),
): Promise<PluginModelResult> {
  if (
    request.provider !== 'codex' ||
    request.mode !== 'agent' ||
    request.permissions !== 'read-only'
  )
    throw Object.assign(
      new Error(
        'Codex supports explicit read-only agent execution; strict tool-free generation is unavailable',
      ),
      { code: 'PLUGIN_MODEL_CAPABILITY_UNSUPPORTED' },
    );
  context.signal.throwIfAborted();
  let session: string | undefined, turn: string | undefined, text: string | undefined;
  let bytes = 0,
    index = 0,
    retries = 0;
  let buffered = '';
  let streamItem: string | undefined, streamPhase: string | undefined;
  const phases = new Map<string, string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    try {
      for (let offset = 0; offset < buffered.length; offset += 4000)
        if (streamItem || streamPhase)
          context.onDelta(buffered.slice(offset, offset + 4000), ++index, {
            ...(streamItem ? { itemId: streamItem } : {}),
            ...(streamPhase ? { phase: streamPhase } : {}),
          });
        else context.onDelta(buffered.slice(offset, offset + 4000), ++index);
    } catch (error) {
      fail(error);
    }
    buffered = '';
  };
  let finish!: (value: string) => void, fail!: (error: unknown) => void;
  const completed = new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  void completed.catch(() => {});
  const listener = (event: AgentProviderEvent) => {
    const params = event.params as any;
    if (event.method === 'provider/model/diagnostic') context.onDiagnostic?.(params);
    if (event.method === 'account/updated')
      context.onDiagnostic?.({
        authentication: ['apikey', 'chatgpt', 'chatgptAuthTokens'].includes(params?.authMode)
          ? params.authMode
          : 'unknown',
      });
    if (event.method === 'session/model/updated' && typeof params?.model?.id === 'string')
      context.onDiagnostic?.({ selectedModel: params.model.id });
    if (event.method === 'session/activeModel/updated' && typeof params?.model?.id === 'string')
      context.onDiagnostic?.({ activeModel: params.model.id });
    const relevant = event.providerSessionId === undefined || event.providerSessionId === session;
    if (event.kind === 'request' && relevant) {
      try {
        provider.respondToRequest(event.requestId!, {
          error: 'Interactive requests are disabled for background model tasks',
        });
      } catch {
        /* Disposal also closes unanswered provider requests. */
      }
      fail(
        Object.assign(new Error('Model requested interactive input'), {
          code: 'PLUGIN_MODEL_INTERACTION_REQUIRED',
        }),
      );
      provider.dispose();
      return;
    }
    if ((event.kind === 'error' || event.method === 'provider/exited') && relevant) {
      if (event.method !== 'provider/exited' && params?.willRetry === true) {
        context.onDiagnostic?.({ retryCount: ++retries });
        return;
      }
      fail(
        Object.assign(
          new Error(String(params?.error?.message ?? params?.message ?? 'Model provider failed')),
          { code: 'PLUGIN_MODEL_PROVIDER_ERROR' },
        ),
      );
      provider.dispose();
      return;
    }
    if (!session || event.providerSessionId !== session) return;
    if (event.method === 'item/started' && params?.item?.type === 'agentMessage') {
      flush();
      streamItem = params.item.id;
      streamPhase = params.item.phase;
      if (streamItem && streamPhase) phases.set(streamItem, streamPhase);
    } else if (event.method === 'item/agentMessage/delta' && typeof params?.delta === 'string') {
      const itemId = params.itemId ?? streamItem;
      const phase = params.phase ?? (itemId ? phases.get(itemId) : streamPhase);
      if (itemId !== streamItem || phase !== streamPhase) flush();
      streamItem = itemId;
      streamPhase = phase;
      bytes += Buffer.byteLength(params.delta);
      if (bytes > 32 * 1024 * 1024) {
        fail(new Error('Model output exceeds 32 MiB'));
        return;
      }
      buffered += params.delta;
      if (buffered.length >= 16000) flush();
      else flushTimer ??= setTimeout(flush, 50);
    } else if (
      event.method === 'item/completed' &&
      params?.item?.type === 'agentMessage' &&
      typeof params.item.text === 'string'
    ) {
      flush();
      if (Buffer.byteLength(params.item.text) > 32 * 1024 * 1024) {
        fail(new Error('Model output exceeds 32 MiB'));
        return;
      }
      // Only final messages supply the business result; progress deltas may contain commentary.
      if (!params.item.phase || params.item.phase === 'final_answer') text = params.item.text;
    } else if (event.method === 'turn/completed') {
      if (params?.turn?.status !== 'completed')
        fail(
          Object.assign(
            new Error(
              `Model turn ended with ${String(params?.turn?.status)}${params?.turn?.error?.message ? `: ${params.turn.error.message}` : ''}`,
            ),
            { code: 'PLUGIN_MODEL_TURN_FAILED' },
          ),
        );
      else if (text === undefined) fail(new Error('Model returned no final text'));
      else {
        flush();
        finish(text);
      }
    }
  };
  const unsubscribe = provider.onEvent(listener);
  const abort = () => {
    fail(
      Object.assign(new Error('Model execution cancelled'), { code: 'PLUGIN_EXECUTION_CANCELLED' }),
    );
    if (session && turn) void provider.interrupt(session, turn).catch(() => {});
    provider.dispose();
  };
  context.signal.addEventListener('abort', abort, { once: true });
  try {
    session =
      context.conversation?.threadId ??
      (await provider.startSession({
        cwd: context.cwd,
        ephemeral: true,
        readOnly: true,
        modelExecution: true,
        ...(request.model ? { modelId: request.model } : {}),
        ...(request.instructions ? { developerInstructions: request.instructions } : {}),
      }));
    if (context.conversation) context.conversation.threadId = session;
    context.onDiagnostic?.({
      ...(provider.getSessionModel(session)?.id
        ? { selectedModel: provider.getSessionModel(session)!.id }
        : {}),
    });
    context.signal.throwIfAborted();
    const [, result] = await Promise.all([
      provider
        .sendMessage(session, request.prompt, [], {
          reasoningSummary: 'none',
          reasoningEffort: request.reasoningEffort,
          outputSchema: request.outputSchema,
          modelExecution: true,
        })
        .then(value => {
          turn = value.turnId;
        }),
      completed,
    ]);
    context.signal.throwIfAborted();
    return {
      text: result,
      provider: request.provider,
      mode: request.mode,
      ...(provider.getSessionModel(session)?.id
        ? { model: provider.getSessionModel(session)!.id }
        : {}),
    };
  } catch (error) {
    if (context.conversation) {
      delete context.conversation.threadId;
      provider.dispose();
    }
    throw error;
  } finally {
    clearTimeout(flushTimer);
    context.signal.removeEventListener('abort', abort);
    unsubscribe();
    if (!context.conversation) provider.dispose();
  }
}
