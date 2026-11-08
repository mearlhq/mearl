import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerPlugin } from '../../pluginRegistry.js';
import { PluginTaskManager } from '../pluginTaskManager.js';
import type { PluginTaskBridge, PluginTaskManagerOptions } from '../pluginTaskManager.js';
import { isPluginTaskActive } from '@mearl/browser-core';

let directory: string;
let manager: PluginTaskManager;
const bridge: PluginTaskBridge = {
  id: 'test',
  scope: { access: 'public', source: 'sdk', bridge: 'caller' },
  invoke: async () => {
    throw new Error('Unexpected browser call');
  },
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-task-manager-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
  const skill = join(directory, 'skill');
  mkdirSync(skill);
  writeFileSync(join(skill, 'SKILL.md'), '# Fixture');
  writeFileSync(
    join(skill, 'main.mjs'),
    'export default app => app.command("echo", input => input);',
  );
  registerPlugin('fixture', join(skill, 'main.mjs'));
  registerPlugin('child', join(skill, 'main.mjs'));
});
afterEach(async () => {
  await manager?.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function start(command = 'echo', input = {}) {
  return manager.start(
    { plugin: 'fixture', command, input, cwd: directory, environment: {}, options: {} },
    bridge,
  );
}
async function terminal(taskId: string) {
  let cursor = 0;
  while (true) {
    const page = await manager.events(taskId, bridge.scope, cursor, 1000);
    if (!isPluginTaskActive(page.task.state)) return page.task;
    cursor = page.nextCursor;
  }
}

it('forwards model child deltas only to their requesting call before the model completes', async () => {
  const received = { first: vi.fn(), second: vi.fn() };
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  manager = new PluginTaskManager({
    concurrency: 1,
    modelConcurrency: 2,
    execute: async (_plugin, invocation, context, options) => {
      if (!options?.model) {
        return Promise.all(
          ['first', 'second'].map(prompt =>
            context.invoke(
              'plugin_model',
              {
                plugin: 'fixture',
                operation: 'run',
                request: { provider: 'codex', mode: 'agent', permissions: 'read-only', prompt },
              },
              {},
              received[prompt as keyof typeof received],
            ),
          ),
        );
      }
      options.onProgress?.({
        message: 'model.delta',
        data: { index: 1, delta: options.model.prompt },
      });
      await gate;
      return { text: options.model.prompt, provider: 'codex', mode: 'agent' };
    },
  });
  const parent = start('stream');
  try {
    await vi.waitFor(() => {
      expect(received.first).toHaveBeenCalledWith({
        message: 'model.delta',
        data: { index: 1, delta: 'first' },
      });
      expect(received.second).toHaveBeenCalledWith({
        message: 'model.delta',
        data: { index: 1, delta: 'second' },
      });
    });
    expect((await manager.get(parent.taskId, bridge.scope)).state).toBe('running');
    expect(received.first).toHaveBeenCalledOnce();
    expect(received.second).toHaveBeenCalledOnce();
  } finally {
    release();
  }
  expect((await terminal(parent.taskId)).state).toBe('success');
});

it('finishes tasks without reading retained history', async () => {
  manager = new PluginTaskManager({ execute: async () => ({ ok: true }) });
  const original = start();
  await terminal(original.taskId);
  const record = manager.store.read(original.taskId);
  for (let index = 0; index < 5; index++)
    manager.store.write({
      ...record,
      task: {
        ...record.task,
        taskId: `pt_${manager.host.hostId}_${randomUUID()}`,
        input: { text: 'x'.repeat(192 * 1024) },
      },
    });
  const list = vi.spyOn(manager.store, 'list');
  const task = start();
  expect((await terminal(task.taskId)).state).toBe('success');
  expect(list).not.toHaveBeenCalled();
});

it.each(['success', 'error', 'cancelled'])(
  'cleans active child ownership after %s without scanning history',
  async outcome => {
    let childId: string | undefined;
    let runningChild!: () => void;
    const childStarted = new Promise<void>(resolve => {
      runningChild = resolve;
    });
    const execute = vi.fn<NonNullable<PluginTaskManagerOptions['execute']>>(
      async (_plugin, invocation, context, options) => {
        if (invocation.command === 'parent')
          return context.invoke('plugin_invoke_child', {
            plugin: 'child',
            invocation: { command: 'child', input: {} },
          });
        childId = context.invocation!.taskId;
        runningChild();
        if (outcome === 'error') throw new Error('child failed');
        if (outcome === 'cancelled')
          await new Promise<void>((_resolve, reject) => {
            const abort = () =>
              reject(Object.assign(new Error('cancelled'), { code: 'PLUGIN_EXECUTION_CANCELLED' }));
            options?.signal?.addEventListener('abort', abort, { once: true });
            if (options?.signal?.aborted) abort();
          });
        return { ok: true };
      },
    );
    manager = new PluginTaskManager({ execute, concurrency: 1 });
    const list = vi.spyOn(manager.store, 'list');
    const parent = start('parent');
    await childStarted;
    if (outcome === 'cancelled') manager.cancel(parent.taskId, bridge.scope);
    expect((await terminal(parent.taskId)).state).toBe(outcome);
    expect((await terminal(childId!)).state).toBe(outcome);
    expect(list).not.toHaveBeenCalled();
    expect((manager as any).activeChildren.size).toBe(0);
  },
);
