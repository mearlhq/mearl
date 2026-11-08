import { describe, expect, it, vi } from 'vitest';
import { runCodexModel } from '../model.js';
import { CodexAgentProvider } from '../codex-provider.js';

function fixture() {
  let listener: (event: any) => void;
  const provider = {
    onEvent: vi.fn(fn => {
      listener = fn;
      return vi.fn();
    }),
    startSession: vi.fn().mockResolvedValue('thread'),
    sendMessage: vi.fn(async () => ({ turnId: 'turn' })),
    interrupt: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    respondToRequest: vi.fn(),
    getSessionModel: vi.fn(() => ({ id: 'chosen-model' })),
  };
  return {
    provider,
    emitGlobal: (kind: string, params: any) =>
      listener({
        kind,
        params,
        method: kind === 'request' ? 'account/auth' : 'error',
        requestId: 2,
      }),
    emit: (method: string, params: any, kind = 'notification') =>
      listener({ providerSessionId: 'thread', method, params, kind, requestId: 1 }),
  };
}
describe('supervised local model execution', () => {
  it('keeps message boundaries and phases on streamed text', async () => {
    const { provider, emit } = fixture(),
      delta = vi.fn();
    const pending = runCodexModel(
      { provider: 'codex', mode: 'agent', permissions: 'read-only', prompt: 'translate' },
      { signal: new AbortController().signal, cwd: process.cwd(), onDelta: delta },
      provider as any,
    );
    await vi.waitFor(() => expect(provider.sendMessage).toHaveBeenCalled());
    emit('item/started', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary' } });
    emit('item/agentMessage/delta', { itemId: 'comment', delta: '说明' });
    emit('item/started', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer' } });
    emit('item/agentMessage/delta', { itemId: 'answer', delta: '译文' });
    await vi.waitFor(() => expect(delta).toHaveBeenCalledTimes(2));
    expect(delta.mock.calls).toEqual([
      ['说明', 1, { itemId: 'comment', phase: 'commentary' }],
      ['译文', 2, { itemId: 'answer', phase: 'final_answer' }],
    ]);
    emit('item/completed', {
      item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '最终译文' },
    });
    emit('turn/completed', { turn: { status: 'completed' } });
    await expect(pending).resolves.toMatchObject({ text: '最终译文' });
  });
  const request = {
    provider: 'codex',
    mode: 'agent' as const,
    permissions: 'read-only' as const,
    prompt: 'Return text',
  };
  it('keeps lossless final output separate from commentary and reports deltas', async () => {
    const { provider, emit } = fixture();
    const delta = vi.fn();
    const pending = runCodexModel(
      request,
      { signal: new AbortController().signal, cwd: process.cwd(), onDelta: delta },
      provider as any,
    );
    await vi.waitFor(() => expect(provider.sendMessage).toHaveBeenCalled());
    emit('item/agentMessage/delta', { delta: '译文😀' });
    emit('item/completed', {
      item: { type: 'agentMessage', phase: 'commentary', text: 'working' },
    });
    const text = '译文😀'.repeat(100000);
    emit('item/completed', { item: { type: 'agentMessage', phase: 'final_answer', text } });
    emit('turn/completed', { turn: { status: 'completed' } });
    await expect(pending).resolves.toEqual({
      text,
      provider: 'codex',
      mode: 'agent',
      model: 'chosen-model',
    });
    expect(delta).toHaveBeenCalledWith('译文😀', 1);
    expect(provider.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ modelExecution: true, readOnly: true, ephemeral: true }),
    );
    expect(provider.dispose).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'interrupted'])('does not accept a %s turn as success', async status => {
    const { provider, emit } = fixture();
    const pending = runCodexModel(
      request,
      { signal: new AbortController().signal, cwd: process.cwd(), onDelta: vi.fn() },
      provider as any,
    );
    const rejected = expect(pending).rejects.toThrow(status);
    await vi.waitFor(() => expect(provider.sendMessage).toHaveBeenCalled());
    emit('turn/completed', { turn: { status } });
    await rejected;
  });

  it('allows a retryable provider error to recover without disposing the turn', async () => {
    const { provider, emit } = fixture();
    const pending = runCodexModel(
      request,
      { signal: new AbortController().signal, cwd: process.cwd(), onDelta: vi.fn() },
      provider as any,
    );
    await vi.waitFor(() => expect(provider.sendMessage).toHaveBeenCalled());
    emit('error', { willRetry: true, error: { message: 'Reconnecting' } }, 'error');
    expect(provider.dispose).not.toHaveBeenCalled();
    emit('item/completed', {
      item: { type: 'agentMessage', phase: 'final_answer', text: 'recovered' },
    });
    emit('turn/completed', { turn: { status: 'completed' } });
    await expect(pending).resolves.toMatchObject({ text: 'recovered' });
  });

  it('preserves the provider failure reason and rejects partial output', async () => {
    const { provider, emit } = fixture();
    const pending = runCodexModel(
      request,
      { signal: new AbortController().signal, cwd: process.cwd(), onDelta: vi.fn() },
      provider as any,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'PLUGIN_MODEL_PROVIDER_ERROR',
      message: 'Model is unavailable for this account',
    });
    await vi.waitFor(() => expect(provider.sendMessage).toHaveBeenCalled());
    emit('item/agentMessage/delta', { delta: 'partial' });
    emit(
      'error',
      { willRetry: false, error: { message: 'Model is unavailable for this account' } },
      'error',
    );
    await rejected;
    expect(provider.dispose).toHaveBeenCalled();
  });

  it('reports a failed turn reason when no separate error notification arrives', async () => {
    const { provider, emit } = fixture();
    const pending = runCodexModel(
      request,
      { signal: new AbortController().signal, cwd: process.cwd(), onDelta: vi.fn() },
      provider as any,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'PLUGIN_MODEL_TURN_FAILED',
      message: 'Model turn ended with failed: Quota exceeded',
    });
    await vi.waitFor(() => expect(provider.sendMessage).toHaveBeenCalled());
    emit('turn/completed', { turn: { status: 'failed', error: { message: 'Quota exceeded' } } });
    await rejected;
  });

  it('rejects unsupported generation before starting and disposes a cancelled provider', async () => {
    const { provider } = fixture();
    await expect(
      runCodexModel(
        { ...request, mode: 'generate', permissions: undefined },
        { signal: new AbortController().signal, cwd: process.cwd(), onDelta: vi.fn() },
        provider as any,
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_MODEL_CAPABILITY_UNSUPPORTED' });
    expect(provider.startSession).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = runCodexModel(
      request,
      { signal: controller.signal, cwd: process.cwd(), onDelta: vi.fn() },
      provider as any,
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_EXECUTION_CANCELLED' });
    await vi.waitFor(() => expect(provider.sendMessage).toHaveBeenCalled());
    controller.abort();
    await rejected;
    expect(provider.dispose).toHaveBeenCalled();
  });

  it.each(['request', 'error'])('fails immediately on a sessionless %s', async kind => {
    const { provider, emitGlobal } = fixture();
    const pending = runCodexModel(
      request,
      { signal: new AbortController().signal, cwd: process.cwd(), onDelta: vi.fn() },
      provider as any,
    );
    const rejected = expect(pending).rejects.toThrow(
      kind === 'request' ? 'interactive' : 'global failure',
    );
    await vi.waitFor(() => expect(provider.sendMessage).toHaveBeenCalled());
    emitGlobal(kind, { message: 'global failure' });
    await rejected;
    expect(provider.dispose).toHaveBeenCalled();
  });

  it('reports observed execution metadata independently from business text', async () => {
    const { provider, emit } = fixture();
    const diagnostic = vi.fn();
    const pending = runCodexModel(
      request,
      {
        signal: new AbortController().signal,
        cwd: process.cwd(),
        onDelta: vi.fn(),
        onDiagnostic: diagnostic,
      },
      provider as any,
    );
    await vi.waitFor(() => expect(provider.sendMessage).toHaveBeenCalled());
    emit('account/updated', { authMode: 'chatgpt', token: 'never-export' });
    emit('error', { willRetry: true }, 'error');
    emit('session/activeModel/updated', { model: { id: 'active-model' } });
    emit('item/completed', {
      item: { type: 'agentMessage', phase: 'final_answer', text: 'answer' },
    });
    emit('turn/completed', { turn: { status: 'completed' } });
    await pending;
    expect(diagnostic).toHaveBeenCalledWith({ authentication: 'chatgpt' });
    expect(diagnostic).toHaveBeenCalledWith({ retryCount: 1 });
    expect(diagnostic).toHaveBeenCalledWith({ activeModel: 'active-model' });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('never-export');
  });

  it('omits absent config/read fields before serializing per-thread TOML overrides', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const rpc = vi.spyOn(provider as any, 'request').mockImplementation(async (method: any) =>
      method === 'config/read'
        ? {
            config: {
              mcp_servers: {
                node_repl: {
                  command: 'node',
                  args: ['server.mjs'],
                  tool_timeout_sec: null,
                  env: { MODE: 'test' },
                },
              },
              apps: {
                sample: {
                  enabled: true,
                  tools: { sample: { approval_mode: null, enabled: true } },
                },
              },
            },
          }
        : { thread: { id: 'thread' } },
    );
    await provider.startSession({ modelExecution: true, readOnly: true });
    const overrides = rpc.mock.calls.find(([method]) => method === 'thread/start')![1].config;
    expect(overrides.mcp_servers.node_repl).toEqual({
      command: 'node',
      args: ['server.mjs'],
      env: { MODE: 'test' },
      enabled: false,
    });
    expect(overrides.apps.sample).toEqual({ enabled: false, tools: { sample: { enabled: true } } });
    expect(JSON.stringify(overrides)).not.toContain('null');
  });

  it('applies per-thread tool restrictions and per-turn schema without changing interactive sessions', async () => {
    const provider = new CodexAgentProvider(vi.fn(), 'test');
    vi.spyOn(provider as any, 'ensureStarted').mockResolvedValue(undefined);
    const rpc = vi.spyOn(provider as any, 'request').mockImplementation(async (method: any) =>
      method === 'config/read'
        ? {
            config: {
              mcp_servers: { external: { command: 'server' } },
              apps: { sample: { enabled: true } },
            },
          }
        : method === 'thread/start'
          ? { thread: { id: 'thread' } }
          : { turn: { id: 'turn' } },
    );
    await provider.startSession({ modelExecution: true, readOnly: true });
    expect(rpc).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({
        sandbox: 'read-only',
        approvalPolicy: 'never',
        config: expect.objectContaining({
          mcp_servers: { external: { command: 'server', enabled: false } },
          apps: expect.objectContaining({ sample: { enabled: false } }),
          web_search: 'disabled',
        }),
      }),
    );
    const schema = { type: 'object' };
    await provider.sendMessage('thread', 'text', [], {
      outputSchema: schema,
      modelExecution: true,
    });
    expect(rpc).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({
        outputSchema: schema,
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        approvalPolicy: 'never',
      }),
    );
  });
});

it('reuses the explicitly owned conversation without disposing it between turns', async () => {
  const { provider, emit } = fixture(),
    conversation = {};
  const run = async (prompt: string) => {
    const pending = runCodexModel(
      { provider: 'codex', mode: 'agent', permissions: 'read-only', prompt },
      { signal: new AbortController().signal, cwd: process.cwd(), onDelta: vi.fn(), conversation },
      provider as any,
    );
    await vi.waitFor(() =>
      expect(provider.sendMessage).toHaveBeenLastCalledWith(
        'thread',
        prompt,
        [],
        expect.any(Object),
      ),
    );
    emit('item/completed', { item: { type: 'agentMessage', text: 'result' } });
    emit('turn/completed', { turn: { status: 'completed' } });
    await pending;
  };
  await run('one');
  await run('two');
  expect(provider.startSession).toHaveBeenCalledOnce();
  expect(provider.dispose).not.toHaveBeenCalled();
});
