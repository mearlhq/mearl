import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { isAlive } from '@mearl/daemon-core';
import { fileURLToPath } from 'node:url';
import * as executor from '../plugins/runtime/pluginExecutor.js';
import { runMearlCli } from '../cli.js';
import { getCommandHelp } from '../commandHelp.js';
import { executeScript } from '../script.js';
import { UnifiedClient } from '../unified.js';
import { registerPlugin } from '../plugins/sdk/plugin.js';

const runtime = vi.hoisted(() => ({ script: '', plugin: '' }));
vi.mock('../runtimePaths.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../runtimePaths.js')>()),
  get SCRIPT_WORKER_PATH() {
    return runtime.script;
  },
  get PLUGIN_WORKER_PATH() {
    return runtime.plugin;
  },
}));
let runtimeDirectory: string;
beforeAll(async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), 'mearl-script-workers-'));
  await writeFile(
    join(runtimeDirectory, 'package.json'),
    JSON.stringify({ version: '0.0.0-test' }),
  );
  await build({
    entryPoints: ['scriptWorker', 'plugin-worker'].map(name =>
      fileURLToPath(new URL(`../${name}.ts`, import.meta.url)),
    ),
    outdir: join(runtimeDirectory, 'dist'),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: 'import { createRequire as __mearlCreateRequire } from "node:module"; const require = __mearlCreateRequire(import.meta.url);',
    },
  });
  runtime.script = join(runtimeDirectory, 'dist/scriptWorker.mjs');
  runtime.plugin = join(runtimeDirectory, 'dist/plugin-worker.mjs');
}, 15000);
afterAll(async () => {
  await rm(runtimeDirectory, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('agent script execution', () => {
  it('shares CLI help and inspects local values without a browser call', async () => {
    const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runMearlCli(['page_click', '--help']);
    const help = String(error.mock.calls[0][0]);
    expect(getCommandHelp('pageClick')).toBe(help);
    expect(getCommandHelp('browserRelease')).toContain('browserRelease(options?)');
    expect(getCommandHelp('browserRelease')).toContain('browserRelease(params, options)');
    const result = await executeScript(`
      const value = { items: [{ id: 1 }] }; value.self = value;
      console.log(JSON.stringify({ help: await mearl.help('pageClick'), shape: mearl.structure(value) }));
    `);
    expect(result.success).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({
      help,
      shape: { items: { _type: 'array[1]', _sample: { id: 'number' } }, self: '<circular>' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('runs top-level await, loops and imports in a separate process and only prints selected data', async () => {
    const invoke = vi
      .spyOn(UnifiedClient.prototype, 'invoke')
      .mockImplementation(async (_action, data) => ({ value: data?.count }));
    const disconnect = vi.spyOn(UnifiedClient.prototype, 'disconnect');
    const result = await executeScript(
      `
      const os = await import('node:os');
      let sum = 0;
      for (const count of [1, 2, 3]) {
        const row = await mearl.getRequests({ tabId: 7, count });
        if (row.value > 1) sum += row.value;
      }
      console.log(JSON.stringify({ sum, separate: process.pid !== ${process.pid}, platform: os.platform() }));
    `,
      { browser: 'chosen', session: 's_existing', local: true },
    );
    expect(result).toMatchObject({
      success: true,
      executionStopped: true,
      mayHaveLateEffects: false,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      sum: 5,
      separate: true,
      platform: process.platform,
    });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenLastCalledWith(
      'get_requests',
      { tabId: 7, count: 3 },
      { browser: 'chosen', session: 's_existing', local: true },
    );
    expect(new Set(invoke.mock.instances).size).toBe(1);
    expect(disconnect).toHaveBeenCalled();
  });

  it('pins a newly created session for subsequent browser and registered Skill calls', async () => {
    const session = { sessionId: 's_created', status: 'active', browserId: 'chosen' };
    const invoke = vi
      .spyOn(UnifiedClient.prototype, 'invoke')
      .mockImplementation(async action =>
        action === 'tab_open' ? { tabId: 7, session } : { tabs: [] },
      );
    const plugin = vi
      .spyOn(executor, 'executeRegisteredPlugin')
      .mockResolvedValue({ rows: [{ id: 1 }] });
    const result = await executeScript(
      `
      const tab = await mearl.tabOpen({ url: 'https://example.test' });
      const rows = await mearl.invokePlugin('registered-skill', { command: 'read', input: { tabId: tab.tabId } });
      await mearl.tabList();
      console.log(JSON.stringify({ rows, session: mearl.session }));
    `,
      { session: 'new', browser: 'chosen', source: 'cli' },
    );
    expect(result.success).toBe(true);
    expect(result.session).toEqual(session);
    expect(JSON.parse(result.stdout)).toEqual({ rows: { rows: [{ id: 1 }] }, session });
    expect(invoke).toHaveBeenLastCalledWith(
      'tab_list',
      {},
      { browser: 'chosen', session: 's_created' },
    );
    expect(plugin).toHaveBeenCalledWith(
      'registered-skill',
      { command: 'read', input: { tabId: 7 } },
      expect.any(Object),
      expect.objectContaining({
        session: 's_created',
        browser: 'chosen',
        source: 'cli',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('preserves action failures so code can decide whether to continue', async () => {
    const failure = {
      action: { success: false, stage: 'dispatch-uncertain', attempt: { dispatched: true } },
      observation: { changed: false },
    };
    const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke').mockResolvedValue(failure);
    const result = await executeScript(`
      const result = await mearl.pageClick({ tabId: 7, selector: '@e3' });
      if (!result.action.success) console.log(JSON.stringify(result));
    `);
    expect(result.success).toBe(true);
    expect(result.mayHaveLateEffects).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual(failure);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('executes a real registered Skill command with inherited routing and processes its result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mearl-script-skill-'));
    vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
    try {
      const skill = join(directory, 'skill');
      await mkdir(join(skill, 'scripts'), { recursive: true });
      await writeFile(join(skill, 'SKILL.md'), '# Fixture');
      const entry = join(skill, 'scripts/main.mjs');
      await writeFile(
        entry,
        `export default app => app.command('read <tabId>', async input => {
        console.log('plugin captured output');
        const data = await app.invoke('get_requests', { tabId: input.tabId });
        return data.rows;
      }, 'Read fixture data');`,
      );
      registerPlugin('script-fixture', entry);
      const invoke = vi
        .spyOn(UnifiedClient.prototype, 'invoke')
        .mockResolvedValue({ rows: [{ count: 2 }, { count: 3 }] });
      const result = await executeScript(
        `
        const rows = await mearl.invokePlugin('script-fixture', { command: 'read', input: { tabId: 7 } });
        console.log(rows.reduce((sum, row) => sum + row.count, 0));
      `,
        { browser: 'chosen', session: 's_existing' },
      );
      expect(result).toMatchObject({ success: true, stdout: 'plugin captured output\n5\n' });
      expect(invoke).toHaveBeenCalledWith(
        'get_requests',
        { tabId: 7 },
        { browser: 'chosen', session: 's_existing' },
      );
      invoke.mockClear();
      const helpResult = await executeScript(
        `console.log(await mearl.help({ plugin: 'script-fixture', command: 'read' }));`,
      );
      expect(helpResult.success).toBe(true);
      expect(helpResult.stdout).toContain('read <tabId>');
      expect(helpResult.stdout).toContain('Read fixture data');
      expect(helpResult.stdout).not.toContain('plugin captured output');
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);

  it('keeps options-only methods, aliases, overrides and release parameters compatible with the SDK', async () => {
    const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke').mockResolvedValue({});
    const result = await executeScript(
      `
      await mearl.browserList({ local: true });
      await mearl.getRules({ browser: 'other' });
      await mearl.getCapabilities({}, { browser: 'capability-target' });
      await mearl.getCapabilities({ app: 'example/app' });
      await mearl.selectBrowser({ browser: 'selected' });
      await mearl.captureCheckpoint({ tabId: 7 });
      await mearl.browserRelease({ session: 's_other' });
      await mearl.browserRelease({ closeCreatedTabs: true }, { session: 's_existing' });
      await mearl.invoke('page_snapshot', { tabId: 7 }, { timeoutSec: 5 });
    `,
      { browser: 'default' },
    );
    expect(result.success).toBe(true);
    expect(invoke.mock.calls).toEqual([
      ['browser_list', {}, { browser: 'default', session: undefined, local: true }],
      ['get_rules', {}, { browser: 'other', session: undefined }],
      ['get_capabilities', {}, { browser: 'capability-target', session: undefined }],
      ['get_capabilities', { app: 'example/app' }, { browser: 'default', session: undefined }],
      [
        'browser_select_browser',
        { browser: 'selected' },
        { browser: 'default', session: undefined },
      ],
      ['tab_checkpoint', { tabId: 7 }, { browser: 'default', session: undefined }],
      ['browser_release', {}, { browser: 'default', session: 's_other' }],
      [
        'browser_release',
        { closeCreatedTabs: true },
        { browser: 'default', session: 's_existing' },
      ],
      ['page_snapshot', { tabId: 7 }, { browser: 'default', session: undefined, timeoutSec: 5 }],
    ]);
  });
  it('passes Provider launch-form parameters through browserList while retaining options-only calls', async () => {
    const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke').mockResolvedValue({});
    const result = await executeScript(`await mearl.browserList({provider:'ego',launchForm:{variant:'attach',values:{}}},{local:true});`);
    expect(result.success).toBe(true);
    expect(invoke).toHaveBeenCalledWith('browser_list', { provider: 'ego', launchForm: { variant: 'attach', values: {} } }, expect.objectContaining({ local: true }));
  });

  it('exports artifacts through internal SDK transport with the inherited session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mearl-script-artifact-'));
    try {
      const output = join(directory, 'result.txt');
      const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke').mockResolvedValue({
        totalBytes: 2,
        bytes: 2,
        base64: Buffer.from('ok').toString('base64'),
      });
      const result = await executeScript(
        `await mearl.saveArtifact({ artifactId: 'a_file', bytes: 2 }, ${JSON.stringify(output)});`,
        { session: 's_existing' },
      );
      expect(result.success).toBe(true);
      expect(await readFile(output, 'utf8')).toBe('ok');
      expect(invoke).toHaveBeenCalledWith(
        '__artifact_read',
        expect.objectContaining({ artifactId: 'a_file' }),
        expect.objectContaining({ session: 's_existing' }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves structured transport failures and partial output without retrying', async () => {
    const invoke = vi.spyOn(UnifiedClient.prototype, 'invoke').mockRejectedValue(
      Object.assign(new Error('paused'), {
        code: 'CONTROL_SESSION_PAUSED',
        details: { generation: 2 },
      }),
    );
    const result = await executeScript(
      `console.log('before'); await mearl.pageSnapshot({ tabId: 7 });`,
      { session: 's_existing' },
    );
    expect(result).toMatchObject({
      success: false,
      stdout: 'before\n',
      session: { sessionId: 's_existing' },
      error: { code: 'CONTROL_SESSION_PAUSED', message: 'paused', details: { generation: 2 } },
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('cancels pending Skill execution and reports possible late effects', async () => {
    let pluginSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const plugin = vi
      .spyOn(executor, 'executeRegisteredPlugin')
      .mockImplementation(async (_name, _input, _context, options) => {
        pluginSignal = options?.signal;
        const waiting = new Promise((_, reject) =>
          pluginSignal?.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          }),
        );
        controller.abort();
        return waiting;
      });
    const result = await executeScript(
      `await mearl.invokePlugin('fixture', { command: 'wait', input: {} });`,
      { signal: controller.signal },
    );
    expect(plugin).toHaveBeenCalledOnce();
    expect(pluginSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      success: false,
      error: { code: 'SCRIPT_CANCELLED' },
      executionStopped: true,
      mayHaveLateEffects: true,
      pendingActions: ['fixture'],
    });
  });

  it('stops CPU loops, cancellation and excessive output in the child', async () => {
    const timeout = await executeScript('while (true) {}', { executionTimeoutSec: 0.2 });
    expect(timeout).toMatchObject({
      success: false,
      error: { code: 'SCRIPT_TIMEOUT' },
      executionStopped: true,
    });
    const controller = new AbortController();
    const running = executeScript(`await new Promise(() => {});`, { signal: controller.signal });
    controller.abort();
    expect(await running).toMatchObject({
      success: false,
      error: { code: 'SCRIPT_CANCELLED' },
      executionStopped: true,
    });
    const output = await executeScript(`console.log('x'.repeat(10000));`, { maxOutputBytes: 100 });
    expect(output.success).toBe(false);
    expect(output.error?.code).toBe('SCRIPT_OUTPUT_LIMIT');
    expect(Buffer.byteLength(output.stdout + output.stderr)).toBeLessThanOrEqual(100);
  });

  it('rejects unawaited calls and blocks internal actions without dispatching them', async () => {
    const invoke = vi
      .spyOn(UnifiedClient.prototype, 'invoke')
      .mockImplementation(() => new Promise(() => {}));
    const pending = await executeScript(`mearl.pageSnapshot({ tabId: 7 });`);
    expect(pending).toMatchObject({
      success: false,
      error: { code: 'SCRIPT_PENDING_CALLS' },
      mayHaveLateEffects: true,
    });
    invoke.mockClear();
    const internal = await executeScript(`await mearl.invoke('__extension_reload');`);
    expect(internal.success).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not silently accept an early process exit or syntax errors', async () => {
    expect(await executeScript('process.exit(0)')).toMatchObject({
      success: false,
      error: { code: 'SCRIPT_EXITED' },
    });
    expect(await executeScript('const =')).toMatchObject({
      success: false,
      error: { code: 'SCRIPT_ERROR' },
    });
  });

  it('bounds exception diagnostics independently of console output', async () => {
    const result = await executeScript(`throw new Error('x'.repeat(700000));`, {
      maxOutputBytes: 100,
    });
    expect(result.success).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(100000);
    expect(result.error?.details).toMatchObject({ diagnosticTruncated: true });
  });

  it('keeps Skill CPU work and output within the script execution boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mearl-isolated-skill-'));
    vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
    try {
      const entry = join(directory, 'scripts/main.mjs');
      const marker = join(directory, 'started');
      await mkdir(join(directory, 'scripts'));
      await writeFile(join(directory, 'SKILL.md'), '# Fixture');
      await writeFile(
        entry,
        `import { renameSync, writeFileSync } from 'node:fs';
        export default app => {
          app.command('slow', () => {
            const marker = ${JSON.stringify(marker)};
            writeFileSync(marker + '.tmp', String(process.pid));
            renameSync(marker + '.tmp', marker);
            const end = Date.now() + 10000; while (Date.now() < end) {}
          });
          app.command('loud', () => console.log('x'.repeat(100000)));
        };`,
      );
      registerPlugin('isolated-fixture', entry);
      const controller = new AbortController();
      const running = executeScript(
        `await mearl.invokePlugin('isolated-fixture', { command: 'slow', input: {} });`,
        { signal: controller.signal, executionTimeoutSec: 10 },
      );
      let pid: number;
      try {
        pid = await vi.waitFor(async () => {
          const value = Number(await readFile(marker, 'utf8'));
          expect(value).toBeGreaterThan(0);
          return value;
        }, { timeout: 7000 });
      } catch (error) {
        controller.abort();
        await running;
        throw error;
      }
      const cancelledAt = Date.now();
      controller.abort();
      const result = await running;
      expect(pid).not.toBe(process.pid);
      expect(Date.now() - cancelledAt).toBeLessThan(2000);
      expect(result).toMatchObject({
        success: false,
        error: { code: 'SCRIPT_CANCELLED' },
        executionStopped: true,
      });
      expect(isAlive(pid)).toBe(false);
      const loud = await executeScript(
        `await mearl.invokePlugin('isolated-fixture', { command: 'loud', input: {} });`,
        { maxOutputBytes: 100 },
      );
      expect(loud).toMatchObject({ success: false, error: { code: 'SCRIPT_OUTPUT_LIMIT' } });
      expect(Buffer.byteLength(loud.stdout + loud.stderr)).toBeLessThanOrEqual(100);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);

  it('rebuilds JavaScript state between rounds', async () => {
    expect((await executeScript('globalThis.previousRound = 1;')).success).toBe(true);
    expect((await executeScript('console.log(typeof globalThis.previousRound);')).stdout).toBe(
      'undefined\n',
    );
  });

  it('cleans up subprocesses created by a completed script', async () => {
    const result = await executeScript(`
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(child.pid);
    `);
    expect(result).toMatchObject({ success: true, executionStopped: true });
    const pid = Number(result.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(false);
  });
});

describe('mearl run', () => {
  it('reads a file, preserves the working directory and returns script failures as exit code 1', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mearl-run-cli-'));
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const file = join(directory, 'task.mjs');
      await writeFile(file, 'console.log(process.cwd());');
      expect(await runMearlCli(['run', '--file', file])).toBe(0);
      expect(output).toHaveBeenCalledWith(`${process.cwd()}\n`);
      await writeFile(file, 'throw new Error("business failure");');
      expect(await runMearlCli(['run', '--file', file])).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('business failure');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts UTF-8 JavaScript from stdin', async () => {
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from('console.log("中文脚本");');
    });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runMearlCli(['run'])).toBe(0);
    expect(output).toHaveBeenCalledWith('中文脚本\n');
  });

  it('prints help without reading input and rejects invalid arguments before execution', async () => {
    const input = vi.spyOn(process.stdin, Symbol.asyncIterator);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runMearlCli(['run', '--help'])).toBe(0);
    for (const args of [
      ['--timeout', '0'],
      ['--timeout', 'NaN'],
      ['--local', '--connector', 'remote'],
      ['--payload', '{}'],
      ['--file', '/nonexistent/script.mjs'],
    ]) {
      expect(await runMearlCli(['run', ...args])).toBe(2);
    }
    expect(input).not.toHaveBeenCalled();
  });
});
