import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeRegisteredPlugin, loadPlugin, registerPlugin } from '../../sdk/plugin.js';
import type { PluginCommandContext } from '../pluginExecution.js';

let directory: string;
let entry: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-invocation-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
  mkdirSync(join(directory, 'scripts'));
  entry = join(directory, 'scripts/main.mjs');
  writeFileSync(
    entry,
    `export default app => {
    app.command('capture', (input, context) => { globalThis.mearlTestCommandContext = context; return context.identity; });
    app.command('wait', (input, context) => context.invoke('hold', { identity: context.identity }));
    app.command('child', (input, context) => context.invoke('child', { command: 'capture', input: {} }));
  };`,
  );
  registerPlugin('sample', entry);
});
afterEach(() => {
  delete (globalThis as any).mearlTestCommandContext;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('plugin invocation context', () => {
  it.each(['cancelled', 'completed'])(
    'does not deliver model deltas after an invocation is %s',
    async outcome => {
      writeFileSync(
        entry,
        `export default app => app.command('ask', (input, context) => context.model(input, { onProgress: progress => context.invoke('preview', progress) }));`,
      );
      const controller = new AbortController(),
        onProgress = vi.fn(),
        invoke = vi.fn();
      let emit!: (progress: any) => void;
      const runModel = vi.fn(async (_plugin, _request, options) => {
        emit = options.onProgress;
        emit('first');
        if (outcome === 'cancelled') {
          controller.abort();
          emit('cancelled');
        }
        return { text: 'final', provider: 'codex', mode: 'agent' as const };
      });
      await invokeRegisteredPlugin(
        'sample',
        { command: 'ask', input: {} },
        { invoke, runModel },
        { signal: controller.signal, onProgress },
      );
      emit('late');
      expect(onProgress.mock.calls.flat()).toEqual(['first']);
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledWith('preview', 'first', {});
    },
  );
  it('exposes per-model progress callbacks without replacing invocation progress', async () => {
    writeFileSync(
      entry,
      `export default app => app.command('ask', (input, context) => context.model(input, { onProgress: progress => context.invoke('preview', progress) }));`,
    );
    const delta = { message: 'model.delta', data: { index: 1, delta: 'partial' } };
    const invoke = vi.fn().mockResolvedValue({});
    const onProgress = vi.fn();
    const runModel = vi.fn(async (_plugin, _request, options) => {
      options.onProgress(delta);
      return { text: 'final', provider: 'codex', mode: 'agent' as const };
    });
    await invokeRegisteredPlugin(
      'sample',
      { command: 'ask', input: {} },
      { invoke, runModel },
      { onProgress },
    );
    expect(onProgress).toHaveBeenCalledWith(delta);
    expect(invoke).toHaveBeenCalledWith('preview', delta, {});
  });
  it('passes cancellation to the model runner without going through a browser action', async () => {
    writeFileSync(
      entry,
      `export default app => app.command('ask', (input, context) => context.model(input));`,
    );
    const controller = new AbortController();
    const request = {
      provider: 'codex',
      mode: 'agent' as const,
      permissions: 'read-only' as const,
      prompt: 'hello',
    };
    const invoke = vi.fn();
    const runModel = vi.fn(async (_plugin, _request, { signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error('model cancelled'));
      signal.throwIfAborted();
    });
    await expect(
      invokeRegisteredPlugin(
        'sample',
        { command: 'ask', input: request },
        { invoke, runModel },
        { signal: controller.signal },
      ),
    ).rejects.toThrow('model cancelled');
    expect(runModel).toHaveBeenCalledWith(
      'sample',
      request,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('separates trusted invocation metadata from business input', async () => {
    const result = await invokeRegisteredPlugin(
      'sample',
      {
        command: 'capture',
        input: { source: 'runtime', identity: { invocationId: 'forged' } },
      },
      { source: 'cli', invoke: vi.fn() },
    );
    expect(result).toMatchObject({
      source: 'cli',
      plugin: 'sample',
      invocationId: expect.any(String),
    });
    expect((result as any).invocationId).not.toBe('forged');
    expect(Object.isFrozen((globalThis as any).mearlTestCommandContext)).toBe(true);
  });

  it('gives concurrent invocations separate identities and the same host incarnation', async () => {
    const identities: unknown[] = [];
    const context = {
      source: 'sdk' as const,
      invoke: vi.fn(async (_action, payload) => {
        identities.push(payload.identity);
        await Promise.resolve();
        return payload.identity;
      }),
    };
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        invokeRegisteredPlugin('sample', { command: 'wait', input: {} }, context),
      ),
    );
    expect(new Set(results.map(result => result.invocationId)).size).toBe(3);
    expect(
      results.every(
        result =>
          result.host.hostId === results[0].host.hostId &&
          result.host.epoch === results[0].host.epoch,
      ),
    ).toBe(true);
  });

  it('does not let a completed context act during a subsequent invocation', async () => {
    let finish: (result: unknown) => void = () => {};
    const invoke = vi.fn(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const plugin = await loadPlugin(entry, { options: {}, invoke, progress: vi.fn() });
    await plugin.run(['capture']);
    const old = (globalThis as any).mearlTestCommandContext as PluginCommandContext;
    const next = plugin.run(['wait']);
    expect(() => old.invoke('send_request', {})).toThrow('PLUGIN_INVOCATION_ENDED');
    finish('done');
    await expect(next).resolves.toBe('done');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('rejects a pre-cancelled invocation before its handler runs', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before execution'));
    const invoke = vi.fn();
    await expect(
      invokeRegisteredPlugin(
        'sample',
        { command: 'wait', input: {} },
        { invoke },
        { signal: controller.signal },
      ),
    ).rejects.toThrow('cancelled before execution');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('links nested invocations without replacing the root host identity', async () => {
    const child = join(directory, 'scripts/child.mjs');
    writeFileSync(
      child,
      'export default app => app.command("capture", (input, context) => context.identity);',
    );
    registerPlugin('child', child);
    const parent = await invokeRegisteredPlugin(
      'sample',
      { command: 'capture', input: {} },
      { source: 'cli', invoke: vi.fn() },
    );
    const result = await invokeRegisteredPlugin(
      'child',
      { command: 'capture', input: {} },
      { source: 'cli', parentInvocation: parent, invoke: vi.fn() },
    );
    expect(result).toMatchObject({
      plugin: 'child',
      source: 'cli',
      host: parent.host,
      parentInvocationId: parent.invocationId,
    });
    expect(result.invocationId).not.toBe(parent.invocationId);
  });
});
