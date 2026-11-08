import { build } from 'esbuild';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPlugin } from '@mearl/client/plugin';
import { executeRegisteredPlugin } from '../../../client/src/plugins/runtime/pluginExecutor.js';
import { stopPluginProcessTree } from '../../../client/src/plugins/runtime/pluginProcessTree.js';
import { isAlive } from '@mearl/daemon-core';

let workerDirectory: string;
let workerPath: string;
let ownerPath: string;
let directory: string;
let entry: string;
let controllers: AbortController[];
let pending: Promise<unknown>[];

function cancellationController(): AbortController {
  const controller = new AbortController();
  controllers.push(controller);
  return controller;
}

function observe(result: Promise<unknown>): Promise<{ error?: unknown; value?: unknown }> {
  const settled = result.then(
    value => ({ value }),
    error => ({ error }),
  );
  pending.push(settled);
  return settled;
}

beforeAll(async () => {
  workerDirectory = mkdtempSync(join(tmpdir(), 'mearl-executor-worker-'));
  workerPath = join(workerDirectory, 'dist/worker.mjs');
  ownerPath = join(workerDirectory, 'dist/owner.mjs');
  writeFileSync(join(workerDirectory, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  await build({
    entryPoints: [fileURLToPath(new URL('../../../client/src/plugin-worker.ts', import.meta.url))],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: 'import { createRequire as __mearlCreateRequire } from "node:module"; const require = __mearlCreateRequire(import.meta.url);',
    },
  });
  await build({
    stdin: {
      contents: `import { executeRegisteredPlugin } from ${JSON.stringify(fileURLToPath(new URL('../../../client/src/plugins/runtime/pluginExecutor.ts', import.meta.url)))};
        void executeRegisteredPlugin('sample', { command: 'orphan', input: {} }, { invoke: async () => null }, {
          workerPath: process.argv[2], onProgress: progress => process.send?.(progress),
        });`,
      loader: 'ts',
      resolveDir: process.cwd(),
    },
    outfile: ownerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: 'import { createRequire as __mearlCreateRequire } from "node:module"; const require = __mearlCreateRequire(import.meta.url);',
    },
  });
});
afterAll(() => rmSync(workerDirectory, { recursive: true, force: true }));
beforeEach(() => {
  controllers = [];
  pending = [];
  directory = mkdtempSync(join(tmpdir(), 'mearl-executor-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
  entry = join(directory, 'scripts/main.mjs');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    `
    import { writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    export default app => {
      app.command('echo', (input, context) => ({ input, identity: context.identity, pid: process.pid }));
      app.command('relay', async (input, context) => {
        context.progress({ message: 'working', data: { id: input.id } });
        return context.invoke('send_request', input);
      });
      app.command('nested', (input, context) => context.invoke('child', { command: 'echo', input }));
      app.command('block', ({ marker }) => { writeFileSync(marker, 'started'); while (true) {} });
      app.command('cooperative', ({ marker }, context) => new Promise(resolve => {
        writeFileSync(marker, 'started');
        context.signal.addEventListener('abort', () => {
          writeFileSync(marker, 'cancelled'); resolve('stopped');
        }, { once: true });
      }));
      app.command('throw', () => { throw Object.assign(new Error('rejected'), { code: 'BUSINESS_REJECTED', details: { retry: false } }); });
      app.command('spawn', ({ marker, stdio }) => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio });
        child.unref(); writeFileSync(marker, String(child.pid)); return { pid: child.pid };
      });
      app.command('orphan', (_input, context) => { context.progress({ message: 'ready', data: { pid: process.pid } }); while (true) {} });
      app.command('unawaited', (input, context) => { void context.invoke('hold'); return 'done'; });
      app.command('stream', async (input, context) => {
        const results = await Promise.all(['first', 'second'].map(prompt => {
          const chunks = [];
          return context.model({ provider: 'codex', mode: 'agent', permissions: 'read-only', prompt }, {
            onProgress: progress => { chunks.push(progress); context.progress({ message: 'observed', data: { prompt } }); },
          }).then(result => ({ prompt, chunks, result }));
        }));
        return results;
      });
    };
  `,
  );
  registerPlugin('sample', entry);
});
afterEach(async () => {
  for (const controller of controllers) controller.abort();
  await Promise.allSettled(pending);
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('managed plugin executor', () => {
  it('delivers isolated per-call model progress across the worker IPC before final results', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const observed = vi.fn();
    const invoke = vi.fn(async (_action, payload, _options, onProgress) => {
      onProgress({ message: 'model.delta', data: { index: 1, delta: payload.request.prompt } });
      await gate;
      return { text: `${payload.request.prompt}-final`, provider: 'codex', mode: 'agent' };
    });
    const work = observe(
      executeRegisteredPlugin(
        'sample',
        { command: 'stream', input: {} },
        { invoke },
        { workerPath, onProgress: observed },
      ),
    );
    try {
      await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(2), { timeout: 4000 });
      expect(observed.mock.calls.map(([p]) => p.data.prompt).sort()).toEqual(['first', 'second']);
    } finally {
      release();
    }
    const { value, error } = await work;
    expect(error).toBeUndefined();
    expect(value).toEqual(
      ['first', 'second'].map(prompt => ({
        prompt,
        chunks: [{ message: 'model.delta', data: { index: 1, delta: prompt } }],
        result: { text: `${prompt}-final`, provider: 'codex', mode: 'agent' },
      })),
    );
  });
  it('preserves large business results and supplies an isolated invocation identity', async () => {
    const text = '完整输出🙂'.repeat(150000);
    const first = await executeRegisteredPlugin(
      'sample',
      { command: 'echo', input: { text } },
      { source: 'toolbox', invoke: vi.fn() },
      { workerPath },
    );
    const second = await executeRegisteredPlugin(
      'sample',
      { command: 'echo', input: {} },
      { source: 'toolbox', invoke: vi.fn() },
      { workerPath },
    );
    expect(first).toMatchObject({
      input: { text },
      identity: { plugin: 'sample', source: 'toolbox' },
    });
    expect((first as any).pid).not.toBe(process.pid);
    expect((first as any).identity.invocationId).not.toBe((second as any).identity.invocationId);
    expect((first as any).identity.host).toEqual((second as any).identity.host);
  });

  it('relays host calls and progress without forwarding executor options', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 200 });
    const onProgress = vi.fn();
    await expect(
      executeRegisteredPlugin(
        'sample',
        { command: 'relay', input: { id: 7 } },
        { invoke },
        { workerPath, onProgress, browser: 'chosen-browser' },
      ),
    ).resolves.toEqual({ status: 200 });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'send_request',
      { id: 7 },
      { browser: 'chosen-browser' },
    );
    expect(onProgress).toHaveBeenCalledWith({ message: 'working', data: { id: 7 } });
  });

  it('preserves structured host and business errors', async () => {
    const error = Object.assign(new Error('permission required'), {
      code: 'DOMAIN_PERMISSION_REQUIRED',
      action: 'send_request',
      domain: 'example.test',
      requestDispatched: false,
    });
    await expect(
      executeRegisteredPlugin(
        'sample',
        { command: 'relay', input: {} },
        { invoke: vi.fn().mockRejectedValue(error) },
        { workerPath },
      ),
    ).rejects.toMatchObject({
      code: error.code,
      action: error.action,
      domain: error.domain,
      requestDispatched: false,
    });
    await expect(
      executeRegisteredPlugin(
        'sample',
        { command: 'throw', input: {} },
        { invoke: vi.fn() },
        { workerPath },
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_REJECTED', details: { retry: false } });
  });

  it('retains parent identity for nested plugin calls', async () => {
    const child = join(directory, 'child.mjs');
    writeFileSync(
      child,
      'export default app => app.command("echo", (input, context) => context.identity);',
    );
    registerPlugin('child', child);
    const result = await executeRegisteredPlugin(
      'sample',
      { command: 'nested', input: {} },
      { invoke: vi.fn() },
      { workerPath, source: 'mcp' },
    );
    expect(result).toMatchObject({
      plugin: 'child',
      source: 'mcp',
      parentInvocationId: expect.any(String),
    });
  });

  it('waits for cooperative shutdown and reports cancellation rather than the late result', async () => {
    const controller = cancellationController();
    const marker = join(directory, 'marker');
    const result = executeRegisteredPlugin(
      'sample',
      { command: 'cooperative', input: { marker } },
      { invoke: vi.fn() },
      { workerPath, signal: controller.signal },
    );
    const settled = observe(result);
    await vi.waitFor(() => expect(readFileSync(marker, 'utf8')).toBe('started'), { timeout: 5000 });
    controller.abort();
    expect((await settled).error).toMatchObject({
      code: 'PLUGIN_EXECUTION_CANCELLED',
      details: { executionStopped: true },
    });
    expect(readFileSync(marker, 'utf8')).toBe('cancelled');
  });

  it('terminates a blocking command without blocking the host event loop', async () => {
    const controller = cancellationController();
    const marker = join(directory, 'marker');
    const result = executeRegisteredPlugin(
      'sample',
      { command: 'block', input: { marker } },
      { invoke: vi.fn() },
      { workerPath, signal: controller.signal, cancellationGraceMs: 30 },
    );
    const settled = observe(result);
    await vi.waitFor(() => expect(readFileSync(marker, 'utf8')).toBe('started'), { timeout: 5000 });
    controller.abort();
    expect((await settled).error).toMatchObject({ code: 'PLUGIN_EXECUTION_CANCELLED' });
  });

  it('distinguishes an execution deadline from cancellation', async () => {
    await expect(
      executeRegisteredPlugin(
        'sample',
        { command: 'block', input: { marker: join(directory, 'marker') } },
        { invoke: vi.fn() },
        { workerPath, executionTimeoutMs: 100, cancellationGraceMs: 20 },
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_EXECUTION_DEADLINE' });
  });

  it('waits for tree-cleanup confirmation and retains a failure after the root exits', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let rootPid = 0;
    let failCleanup = false;
    let finished = false;
    const settled = observe(
      executeRegisteredPlugin(
        'sample',
        { command: 'echo', input: {} },
        { invoke: vi.fn() },
        { workerPath },
        {
          stopProcessTree: async pid => {
            rootPid = pid;
            await stopPluginProcessTree(pid);
            await gate;
            if (failCleanup) throw new Error('process tree was only partially stopped');
          },
        },
      ),
    );
    void settled.then(() => {
      finished = true;
    });
    try {
      await vi.waitFor(() => expect(rootPid).toBeGreaterThan(0), { timeout: 4000 });
      await vi.waitFor(() => expect(isAlive(rootPid)).toBe(false), { timeout: 4000 });
      expect(finished).toBe(false);
      failCleanup = true;
      release();
      expect((await settled).error).toMatchObject({
        code: 'PLUGIN_EXECUTOR_CLEANUP_FAILED',
        details: { executionStopped: false },
      });
    } finally {
      release();
    }
  });

  it.skipIf(process.platform === 'win32').each(['ignore', 'inherit'])(
    'cleans up descendant processes after success with %s stdio',
    async stdio => {
      const marker = join(directory, 'child-pid');
      try {
        const result = await executeRegisteredPlugin(
          'sample',
          { command: 'spawn', input: { marker, stdio } },
          { invoke: vi.fn() },
          { workerPath },
        );
        await vi.waitFor(() => expect(isAlive((result as any).pid)).toBe(false), {
          timeout: 5000,
        });
      } finally {
        try {
          process.kill(Number(readFileSync(marker, 'utf8')), 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'stops a blocked command when its owning host dies',
    async () => {
      const owner = fork(ownerPath, [workerPath], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        execArgv: [],
      });
      const exited = once(owner, 'exit');
      let stderr = '';
      owner.stderr?.on('data', chunk => {
        stderr += chunk;
      });
      let pid: number | undefined;
      try {
        // Readiness separates cold process startup from the parent-death cleanup deadline.
        const [ready] = await Promise.race([
          once(owner, 'message', { signal: AbortSignal.timeout(10000) }),
          exited.then(([code, signal]) => {
            throw new Error(
              `Executor owner exited before readiness (${code ?? signal}): ${stderr}`,
            );
          }),
        ]);
        const workerPid: number = ready.data.pid;
        pid = workerPid;
        expect(ready.message).toBe('ready');
        expect(workerPid).toBeGreaterThan(0);
        owner.kill('SIGKILL');
        await exited;
        await vi.waitFor(() => expect(isAlive(workerPid)).toBe(false), {
          timeout: 4000,
        });
      } finally {
        owner.kill('SIGKILL');
        await exited;
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
          }
        }
      }
    },
    20000,
  );

  it('reports host subcalls that are still pending when the executor stops', async () => {
    const controller = cancellationController();
    const invoke = vi.fn(() => new Promise(() => {}));
    const result = executeRegisteredPlugin(
      'sample',
      { command: 'relay', input: {} },
      { invoke },
      { workerPath, signal: controller.signal },
    );
    const settled = observe(result);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce(), { timeout: 5000 });
    controller.abort();
    expect((await settled).error).toMatchObject({ details: { pendingActions: ['send_request'] } });
  });

  it('rejects success when the command leaves host subcalls pending', async () => {
    await expect(
      executeRegisteredPlugin(
        'sample',
        { command: 'unawaited', input: {} },
        { invoke: () => new Promise(() => {}) },
        { workerPath },
      ),
    ).rejects.toMatchObject({
      code: 'PLUGIN_PENDING_HOST_CALLS',
      details: { pendingActions: ['hold'] },
    });
  });

  it('enforces public versus toolbox-only command access in the child', async () => {
    writeFileSync(
      entry,
      `export const toolbox = { version: 1, title: 'Tool', page: { type: 'sandbox', entry: 'assets/index.html', commands: ['chunk'] } };
      export default app => app.toolboxCommand('chunk', (input, context) => ({ source: context.identity.source }));`,
    );
    await expect(
      executeRegisteredPlugin(
        'sample',
        { command: 'chunk', input: {} },
        { invoke: vi.fn() },
        { workerPath },
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_COMMAND_TOOLBOX_ONLY' });
    await expect(
      executeRegisteredPlugin(
        'sample',
        { command: 'chunk', input: {} },
        { source: 'toolbox', invoke: vi.fn() },
        { workerPath, access: 'toolbox' },
      ),
    ).resolves.toEqual({ source: 'toolbox' });
  });

  it('gives Python handlers the same identity and host-call context', async () => {
    const pythonEntry = join(directory, 'scripts/main.py');
    writeFileSync(
      pythonEntry,
      `def register(app):
    def echo(input, context):
        result = context.invoke('send_request', input)
        return {"source": context.identity["source"], "plugin": context.identity["plugin"], "result": result}
    app.command('echo', echo)
`,
    );
    registerPlugin('python', pythonEntry);
    await expect(
      executeRegisteredPlugin(
        'python',
        { command: 'echo', input: { id: 3 } },
        { source: 'cli', invoke: vi.fn().mockResolvedValue({ ok: true }) },
        { workerPath },
      ),
    ).resolves.toEqual({ source: 'cli', plugin: 'python', result: { ok: true } });
    await expect(
      executeRegisteredPlugin(
        'python',
        { command: 'echo', input: {} },
        {
          invoke: vi.fn().mockRejectedValue(
            Object.assign(new Error('permission required'), {
              code: 'DOMAIN_PERMISSION_REQUIRED',
              domain: 'example.test',
              requestDispatched: false,
            }),
          ),
        },
        { workerPath },
      ),
    ).rejects.toMatchObject({
      code: 'DOMAIN_PERMISSION_REQUIRED',
      domain: 'example.test',
      requestDispatched: false,
    });
  });

  it('finishes Python results after exit while inherited-stdio descendants are still alive', async () => {
    const pythonEntry = join(directory, 'scripts/main.py');
    writeFileSync(
      pythonEntry,
      `import subprocess
import sys
import threading
import time
def register(app):
    threading.Thread(target=lambda:time.sleep(60)).start()
    def work(input):
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(60)"])
        return {"pid":child.pid,"text":"完整😀" * 100000}
    app.command("work",work)
`,
    );
    registerPlugin('python-pipes', pythonEntry);
    const result = (await executeRegisteredPlugin(
      'python-pipes',
      { command: 'work', input: {} },
      { invoke: vi.fn() },
      { workerPath, executionTimeoutMs: 10000 },
    )) as { pid: number; text: string };
    expect(result.text).toBe('完整😀'.repeat(100000));
    await vi.waitFor(() => expect(isAlive(result.pid)).toBe(false), { timeout: 5000 });
  }, 20000);

  it.skipIf(process.platform === 'win32')(
    'cancels Python execution and waits for its cleanup',
    async () => {
      const pythonEntry = join(directory, 'scripts/main.py');
      const marker = join(directory, 'python-marker');
      writeFileSync(
        pythonEntry,
        `import time
def register(app):
    def wait(input, context):
        with open(input['marker'], 'w') as file:
            file.write('started')
        try:
            time.sleep(60)
        finally:
            with open(input['marker'], 'w') as file:
                file.write('stopped')
    app.command('wait', wait)
`,
      );
      registerPlugin('python', pythonEntry);
      const controller = cancellationController();
      const settled = observe(
        executeRegisteredPlugin(
          'python',
          { command: 'wait', input: { marker } },
          { invoke: vi.fn() },
          { workerPath, signal: controller.signal },
        ),
      );
      await vi.waitFor(() => expect(readFileSync(marker, 'utf8')).toBe('started'), {
        timeout: 4000,
      });
      controller.abort();
      expect((await settled).error).toMatchObject({ code: 'PLUGIN_EXECUTION_CANCELLED' });
      expect(readFileSync(marker, 'utf8')).toBe('stopped');
    },
  );

  it('publishes one complete host identity under concurrent process startup', async () => {
    const moduleUrl = new URL(
      '../../../client/dist/plugins/runtime/pluginExecution.js',
      import.meta.url,
    ).href;
    const script = `import { localPluginExecutionHost } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(localPluginExecutionHost()));`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
          env: process.env,
        }),
      ),
    );
    const identities = results.map(result => JSON.parse(result.stdout));
    expect(new Set(identities.map(value => value.hostId)).size).toBe(1);
    expect(new Set(identities.map(value => value.epoch)).size).toBe(5);
  });
});
