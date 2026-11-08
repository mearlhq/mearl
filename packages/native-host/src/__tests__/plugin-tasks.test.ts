import { build } from 'esbuild';
import { CLIENT_VERSION } from '../../../client/src/runtimePaths.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPlugin } from '../../../client/src/plugins/pluginRegistry.js';
import { PluginTaskClient } from '../../../client/src/plugins/clients/pluginTasks.js';
import { startPluginHostServer } from '../../../client/src/plugins/runtime/pluginHostServer.js';
import { pluginHostPaths } from '../../../client/src/plugins/runtime/pluginHostPaths.js';
import { capturePluginRevision } from '../../../client/src/plugins/runtime/pluginRevision.js';
import { isAlive, writeRecord } from '@mearl/daemon-core';

let runtime: string;
let directory: string;
let skill: string;
let clients: PluginTaskClient[];
let service: Awaited<ReturnType<typeof startPluginHostServer>> | undefined;
const fixture = `
  import { existsSync, readFileSync, writeFileSync } from 'node:fs';
  export const toolbox = { version: 1, title: 'Task', page: { type: 'sandbox', entry: 'index.html', commands: ['echo', 'sleep', 'relay'] } };
  export default app => {
    app.command('echo', (input, context) => ({ input, identity: context.identity,
      resource: readFileSync(new URL('./resource.txt', import.meta.url), 'utf8'), cwd: process.cwd(), environment: process.env.TASK_FIXTURE_VALUE }));
    app.command('sleep', async (input, context) => {
      context.progress({ message: 'working', data: { input } });
      await new Promise(resolve => setTimeout(resolve, input.ms)); return { done: true };
    });
    app.command('big', () => ({ text: '译文'.repeat(400000) }));
    app.command('failure', () => { throw Object.assign(new Error('x'.repeat(2000000)), { code: 'LARGE_FAILURE', details: { diagnostic: 'x'.repeat(2000000) } }); });
    app.command('block', ({ marker }) => { writeFileSync(marker, String(process.pid)); while (true) {} });
    app.command('relay', async (input, context) => {
      writeFileSync(input.ready, 'ready');
      while (!existsSync(input.release)) await new Promise(resolve => setTimeout(resolve, 10));
      return context.invoke('fixture_browser', input);
    });
    app.command('retarget', (input, context) => context.invoke('fixture_browser', {}, { connector: 'other' }));
  };
`;

function client(options: ConstructorParameters<typeof PluginTaskClient>[0] = {}) {
  const result = new PluginTaskClient({
    runtimePath: join(runtime, 'dist/plugin-task-host.js'),
    ...options,
  });
  clients.push(result);
  return result;
}

beforeAll(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'mearl-task-runtime-'));
  writeFileSync(
    join(runtime, 'package.json'),
    JSON.stringify({ version: CLIENT_VERSION, type: 'module' }),
  );
  await build({
    entryPoints: ['plugin-worker', 'plugin-task-host'].map(name =>
      fileURLToPath(new URL(`../../../client/src/${name}.ts`, import.meta.url)),
    ),
    outdir: join(runtime, 'dist'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: 'import { createRequire as __mearlCreateRequire } from "node:module"; const require = __mearlCreateRequire(import.meta.url);',
    },
  });
});
afterAll(() => rmSync(runtime, { recursive: true, force: true }));
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-task-test-'));
  skill = join(directory, 'skill');
  clients = [];
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
  mkdirSync(skill);
  writeFileSync(join(skill, 'SKILL.md'), '# Task fixture');
  writeFileSync(join(skill, 'index.html'), '<!doctype html><body>Task</body>');
  writeFileSync(join(skill, 'resource.txt'), 'pinned');
  writeFileSync(join(skill, 'main.mjs'), fixture);
  registerPlugin('fixture', join(skill, 'main.mjs'), undefined, {
    toolbox: {
      version: 1,
      title: 'Task',
      page: { type: 'sandbox', entry: 'index.html', commands: ['echo', 'sleep', 'relay'] },
    },
  });
});
afterEach(async () => {
  if (service) {
    await service.close();
    service = undefined;
  } else if (existsSync(pluginHostPaths().lease)) {
    try {
      await client().stopHost();
    } catch {
      /* Process cleanup remains observable in the failing test. */
    }
  }
  clients.forEach(value => value.disconnect());
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('persistent plugin tasks', () => {
  it('accepts the existing toolbox Skill distributions as self-contained revisions', () => {
    for (const name of ['browser-tab-manager', 'notes-memory', 'tinypng-compress']) {
      registerPlugin(
        'fixture',
        fileURLToPath(new URL(`../../../../skills/${name}/scripts/main.mjs`, import.meta.url)),
      );
      expect(capturePluginRevision('fixture').revision).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('shares one daemon across concurrent clients and stops before returning', async () => {
    const callers = [client(), client(), client()];
    const statuses = await Promise.all(callers.map(value => value.status()));
    expect(new Set(statuses.map(value => value.pid)).size).toBe(1);
    expect(statuses[0].pid).not.toBe(process.pid);
    await callers[0].stopHost();
    expect(existsSync(pluginHostPaths().lease)).toBe(false);
    const restarted = await client().status();
    expect(restarted.host.hostId).toBe(statuses[0].host.hostId);
    expect(restarted.host.epoch).not.toBe(statuses[0].host.epoch);
  });

  it('pins source, resources, cwd, environment and audit identity at acceptance', async () => {
    service = await startPluginHostServer({
      concurrency: 1,
      workerPath: join(runtime, 'dist/plugin-worker.js'),
    });
    const caller = client({ autoStart: false, source: 'cli' });
    const blocker = await caller.start('fixture', { command: 'sleep', input: { ms: 250 } });
    const accepted = await caller.start(
      'fixture',
      { command: 'echo', input: { value: 1 } },
      {
        cwd: directory,
        environment: { ...process.env, TASK_FIXTURE_VALUE: 'captured' },
      },
    );
    writeFileSync(join(skill, 'resource.txt'), 'changed');
    writeFileSync(join(skill, 'main.mjs'), 'throw new Error("live code must not execute");');
    await caller.wait(blocker.taskId);
    const result = (await caller.wait(accepted.taskId)) as any;
    expect(result).toMatchObject({
      resource: 'pinned',
      cwd: realpathSync(directory),
      environment: 'captured',
      identity: { taskId: accepted.taskId, source: 'cli', host: accepted.host },
    });
    expect((await caller.get(accepted.taskId)).revision).toBe(result.identity.revision);
    expect(JSON.stringify(service.host.tasks.store.read(accepted.taskId))).not.toContain(
      'TASK_FIXTURE_VALUE',
    );
  });

  it('continues pure tasks after caller disconnect and verifies a multi-megabyte result', async () => {
    const caller = client();
    const started = await caller.start('fixture', { command: 'sleep', input: { ms: 150 } });
    caller.disconnect();
    const query = client();
    await expect(query.wait(started.taskId)).resolves.toEqual({ done: true });
    const big = await query.start('fixture', { command: 'big', input: {} });
    await expect(query.wait(big.taskId)).resolves.toEqual({ text: '译文'.repeat(400000) });
    const task = await query.get(big.taskId);
    expect(task.result!.chunks).toBeGreaterThan(10);
    writeFileSync(
      join(pluginHostPaths().tasks, big.taskId, 'result.json'),
      Buffer.alloc(task.result!.bytes, 32),
    );
    await expect(query.result(big.taskId)).rejects.toThrow('integrity');
  });

  it('separates wait timeout, cancellation, execution deadline and queued cancellation', async () => {
    service = await startPluginHostServer({
      concurrency: 1,
      workerPath: join(runtime, 'dist/plugin-worker.js'),
    });
    const caller = client({ autoStart: false });
    const first = await caller.start('fixture', { command: 'sleep', input: { ms: 500 } });
    await expect(caller.wait(first.taskId, { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'PLUGIN_TASK_WAIT_TIMEOUT',
    });
    expect((await caller.get(first.taskId)).state).toBe('running');
    const queued = await caller.start('fixture', { command: 'echo', input: {} });
    expect((await caller.cancel(queued.taskId)).state).toBe('cancelled');
    await caller.cancel(first.taskId);
    await vi.waitFor(async () => expect((await caller.get(first.taskId)).state).toBe('cancelled'), {
      timeout: 10000,
    });
    const marker = join(directory, 'blocking-pid');
    const blocked = await caller.start(
      'fixture',
      { command: 'block', input: { marker } },
      { executionTimeoutMs: 200 },
    );
    await expect(caller.wait(blocked.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_EXECUTION_DEADLINE',
    });
    expect((await caller.get(blocked.taskId)).state).toBe('error');
  });

  it('scopes toolbox history and cancellation to toolbox tasks and preserves idempotency', async () => {
    const publicClient = client();
    const started = await publicClient.start(
      'fixture',
      { command: 'sleep', input: { ms: 200 } },
      { idempotencyKey: 'once' },
    );
    await expect(
      publicClient.start(
        'fixture',
        { command: 'sleep', input: { ms: 200 } },
        { idempotencyKey: 'once' },
      ),
    ).resolves.toMatchObject({ taskId: started.taskId, reused: true });
    await expect(
      publicClient.start(
        'fixture',
        { command: 'sleep', input: { ms: 200 } },
        { idempotencyKey: 'once', executionTimeoutMs: 900 },
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_TASK_IDEMPOTENCY_CONFLICT' });
    const toolbox = client({
      access: 'toolbox',
      plugin: 'fixture',
      source: 'toolbox',
      invoke: async () => null,
    });
    await expect(toolbox.get(started.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_TASK_NOT_FOUND',
    });
    await expect(toolbox.cancel(started.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_TASK_NOT_FOUND',
    });
    expect((await toolbox.list()).tasks).toHaveLength(0);
    await expect(toolbox.start('fixture', { command: 'big', input: {} })).rejects.toMatchObject({
      code: 'PLUGIN_COMMAND_NOT_ALLOWED',
    });
    const own = await toolbox.start('fixture', { command: 'sleep', input: { ms: 20 } });
    await expect(toolbox.wait(own.taskId)).resolves.toEqual({ done: true });
    await expect(toolbox.get(`pt_${randomUUID()}_${randomUUID()}`)).rejects.toMatchObject({
      code: 'PLUGIN_TASK_WRONG_HOST',
    });
  });

  it('interrupts a disconnected browser bridge without switching to another caller', async () => {
    service = await startPluginHostServer({ workerPath: join(runtime, 'dist/plugin-worker.js') });
    const ready = join(directory, 'relay-ready');
    const release = join(directory, 'relay-release');
    const invoke = vi.fn(async () => ({ bridged: true }));
    const caller = client({ invoke, autoStart: false });
    const task = await caller.start('fixture', { command: 'relay', input: { ready, release } });
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10000 });
    caller.disconnect();
    const wrongInvoke = vi.fn(async () => ({ wrong: true }));
    const query = client({ invoke: wrongInvoke, autoStart: false });
    await query.status();
    writeFileSync(release, 'released');
    await expect(query.wait(task.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_TASK_BRIDGE_UNAVAILABLE',
    });
    expect((await query.get(task.taskId)).state).toBe('interrupted');
    expect(invoke).not.toHaveBeenCalled();
    expect(wrongInvoke).not.toHaveBeenCalled();
    const retarget = await query.start('fixture', { command: 'retarget', input: {} });
    await expect(query.wait(retarget.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_TASK_TARGET_CHANGED',
    });
  }, 20000);

  it('recovers interrupted tasks after a crash without replaying them', async () => {
    const caller = client();
    const status = await caller.status();
    const marker = join(directory, 'started');
    const started = await caller.start('fixture', { command: 'block', input: { marker } });
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10000 });
    process.kill(status.pid, 'SIGKILL');
    caller.disconnect();
    await vi.waitFor(() => expect(isAlive(status.pid)).toBe(false));
    const restarted = client();
    const next = await restarted.status();
    expect(next.host.hostId).toBe(started.host.hostId);
    expect(next.host.epoch).not.toBe(started.host.epoch);
    await expect(restarted.get(started.taskId)).resolves.toMatchObject({
      state: 'interrupted',
      error: { code: 'PLUGIN_TASK_HOST_RESTARTED' },
    });
    await vi.waitFor(() => expect(isAlive(Number(readFileSync(marker, 'utf8')))).toBe(false));
  });

  it.each(['missing-package', '../outside.mjs'])(
    'reports dependency resolution failure during execution: %s',
    async specifier => {
      writeFileSync(join(skill, 'main.mjs'), `import '${specifier}'; export default () => {};`);
      const caller = client();
      const started = await caller.start('fixture', { command: 'echo', input: {} });
      await expect(caller.wait(started.taskId)).rejects.toMatchObject({
        code: 'PLUGIN_LOAD_FAILED',
        message: expect.stringContaining(specifier.split('/').at(-1)!),
      });
      expect((await caller.get(started.taskId)).state).toBe('error');
    },
  );

  it('recovers a reused pid lease', async () => {
    writeRecord(pluginHostPaths().lease, {
      pid: process.pid,
      processIdentity: 'unrelated-old-process',
      protocolVersion: 1,
    });
    expect((await client().status()).pid).not.toBe(process.pid);
  });

  it('aborts subscriptions promptly while leaving execution running', async () => {
    const caller = client();
    const started = await caller.start('fixture', { command: 'sleep', input: { ms: 10000 } });
    await vi.waitFor(
      async () => expect((await caller.get(started.taskId)).progress).toBeDefined(),
      { timeout: 10000 },
    );
    const task = await caller.get(started.taskId);
    const controller = new AbortController();
    const subscription = caller.subscribe(started.taskId, {
      cursor: task.sequence,
      signal: controller.signal,
    });
    const next = subscription.next();
    controller.abort(new Error('stop observing'));
    await expect(next).rejects.toThrow('stop observing');
    expect((await caller.get(started.taskId)).state).toBe('running');
  }, 20000);

  it('bounds list responses, provides stable cursors and limits error diagnostics', async () => {
    const caller = client();
    const started = [];
    for (let index = 0; index < 3; index++)
      started.push(
        await caller.start('fixture', {
          command: 'echo',
          input: { value: 'x'.repeat(220 * 1024), index },
        }),
      );
    const first = await caller.list(false, { limit: 2 });
    expect(first.tasks).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const second = await caller.list(false, { cursor: first.nextCursor });
    expect(second.tasks).toHaveLength(1);
    expect(second.tasks[0].taskId).not.toBe(first.tasks[0].taskId);
    await expect(caller.list(false, { cursor: 'invalid' })).rejects.toThrow('cursor');
    expect(new Set([...first.tasks, ...second.tasks].map(task => task.taskId)).size).toBe(2);
    expect(started).toHaveLength(3);
    const failed = await caller.start('fixture', { command: 'failure', input: {} });
    await expect(caller.wait(failed.taskId)).rejects.toMatchObject({ code: 'LARGE_FAILURE' });
    const record = await caller.get(failed.taskId);
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(64 * 1024);
    expect(record.error?.details).toEqual({ diagnosticTruncated: true });
  });
});
