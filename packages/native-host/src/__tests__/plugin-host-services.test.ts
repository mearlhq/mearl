import { CLIENT_VERSION } from '../../../client/src/runtimePaths.js';
import { PluginModelClient } from '../../../client/src/plugins/clients/pluginModels.js';
import { build } from 'esbuild';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPlugin } from '../../../client/src/plugins/pluginRegistry.js';
import { startPluginHostServer } from '../../../client/src/plugins/runtime/pluginHostServer.js';
import { PluginTaskClient } from '../../../client/src/plugins/clients/pluginTasks.js';
import { pluginStateSignature } from '../../../client/src/plugins/sdk/pluginStateDefinition.js';
import { PluginStateClient } from '../../../client/src/plugins/clients/pluginState.js';
import { isAlive } from '@mearl/daemon-core';

let runtime: string,
  directory: string,
  service: Awaited<ReturnType<typeof startPluginHostServer>>,
  caller: PluginTaskClient,
  states: PluginStateClient;
const model = (text: string, extra = {}) => ({
  provider: 'codex',
  mode: 'agent' as const,
  permissions: 'read-only' as const,
  prompt: JSON.stringify({ text, ...extra }),
});
const source = `
export const stateStorage = {version:1,collections:{settings:{scope:'installation',storage:'persistent',schemaVersion:1,schema:{type:'integer'}},page:{scope:'instance',storage:'cache',schemaVersion:1,schema:{type:'integer'}}}};
export default app => {
  app.command('ask', async (input, context) => context.model(input.request));
  app.command('ask-twice', async (input, context) => [await context.model(input.first), await context.model(input.second)]);
  app.command('state', (input, context) => context.state('settings','get',{key:'value'}));
};`;
const recoverable = `
export const taskRecovery = {version:1,commands:{work:{checkpointVersion:1,schema:{type:'object',properties:{done:{type:'integer'}},required:['done'],additionalProperties:false}}}};
export default app => {
  app.command('work', async (input, context) => {
    await context.checkpoint({done:7},0);
    if (input.conflict) await context.checkpoint({done:8},0);
    if (input.wait) await new Promise(()=>{});
    throw new Error('interrupted fixture');
  });
  app.recoveryCommand('work', async (input, context) => ({code:'original',done:context.recovery.checkpoint.data.done,input,from:context.recovery.fromTaskId,env:process.env.MEARL_RECOVERY_TEST}));
};`;
const oldCheckpointSchema = {
  type: 'object',
  properties: { done: { type: 'integer' } },
  required: ['done'],
  additionalProperties: false,
};
const migratedCheckpointSchema = {
  type: 'object',
  properties: { completed: { type: 'integer' } },
  required: ['completed'],
  additionalProperties: false,
};
function upgradedRecovery(handler = 'return {completed:input.checkpoint.data.done + 1};') {
  return `import {appendFileSync} from 'node:fs';
export const taskRecovery = ${JSON.stringify({ version: 1, commands: { work: { checkpointVersion: 2, schema: migratedCheckpointSchema, migrateFrom: [{ version: 1, schema: oldCheckpointSchema }] } } })};
export default app => {
 app.command('work <newArgument>', () => {throw new Error('public handler must not run');});
 app.checkpointMigration('work', async input => {${handler}});
 app.recoveryCommand('work', (input,context) => ({code:'upgraded',input,recovery:context.recovery}));
};`;
}
const fake = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
if(process.argv.includes('--version')) { console.log('codex-cli 0.156.1'); process.exit(0); }
if(process.argv.includes('--help')) process.exit(0);
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params}=JSON.parse(line);
 if(id===undefined)return;
 if(method==='initialize')send({id,result:{}});
 else if(method==='config/read')send({id,result:{config:{mcp_servers:{},apps:{}}}});
 else if(method==='thread/start')send({id,result:{thread:{id:'test-thread'},model:'test-model'}});
 else if(method==='turn/start'){
  const request=JSON.parse(params.input[0].text);
  if(request.marker)writeFileSync(request.marker,String(process.pid));
  send({id,result:{turn:{id:'test-turn'}}});
  send({method:'item/agentMessage/delta',params:{threadId:'test-thread',delta:'partial'}});
  const text=request.repeat?request.text.repeat(request.repeat):request.text;
  setTimeout(()=>{
   send({method:'item/completed',params:{threadId:'test-thread',item:{type:'agentMessage',phase:'final_answer',text:request.json?JSON.stringify({text}):text}}});
   send({method:'turn/completed',params:{threadId:'test-thread',turn:{id:'test-turn',status:'completed'}}});
  },request.delay||20);
 } else send({id,result:{}});
});`;
beforeAll(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'mearl-host-runtime-'));
  writeFileSync(
    join(runtime, 'package.json'),
    JSON.stringify({ type: 'module', version: CLIENT_VERSION }),
  );
  await build({
    entryPoints: [fileURLToPath(new URL('../../../client/src/plugin-worker.ts', import.meta.url))],
    outfile: join(runtime, 'dist/plugin-worker.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: 'import { createRequire as __hostRequire } from "node:module"; const require = __hostRequire(import.meta.url);',
    },
  });
  await build({
    entryPoints: [
      fileURLToPath(new URL('../../../client/src/pluginModelSessionWorker.ts', import.meta.url)),
    ],
    outfile: join(runtime, 'dist/pluginModelSessionWorker.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: 'import { createRequire as __hostRequire } from "node:module"; const require = __hostRequire(import.meta.url);',
    },
  });
  await build({
    entryPoints: [
      fileURLToPath(new URL('../../../client/src/plugin-task-host.ts', import.meta.url)),
    ],
    outfile: join(runtime, 'dist/plugin-task-host.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: 'import { createRequire as __hostRequire } from "node:module"; const require = __hostRequire(import.meta.url);',
    },
  });
});
afterAll(() => rmSync(runtime, { recursive: true, force: true }));
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-host-test-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
  const executable = join(directory, 'codex.mjs');
  writeFileSync(executable, fake, { mode: 0o755 });
  vi.stubEnv('MEARL_CODEX_PATH', executable);
  const skill = join(directory, 'skill');
  mkdirSync(skill);
  writeFileSync(join(skill, 'SKILL.md'), '# Host fixture');
  writeFileSync(join(skill, 'main.mjs'), source);
  registerPlugin('fixture', join(skill, 'main.mjs'));
  service = await startPluginHostServer({
    concurrency: 1,
    modelConcurrency: 1,
    workerPath: join(runtime, 'dist/plugin-worker.js'),
  });
  caller = new PluginTaskClient({ autoStart: false });
  states = new PluginStateClient({ autoStart: false });
});
afterEach(async () => {
  await service.close();
  caller.disconnect();
  states.disconnect();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('model and state service integration', { timeout: 25000 }, () => {
  it.skipIf(process.platform === 'win32')(
    'retains a checkpoint across an actual service crash without replaying the original handler',
    async () => {
      const marker = join(directory, 'external-operation');
      writeFileSync(
        join(directory, 'skill/main.mjs'),
        "import {appendFileSync} from 'node:fs';\n" +
          recoverable.replace(
            'await context.checkpoint',
            "appendFileSync(input.marker,'submitted\\n'); await context.checkpoint",
          ),
      );
      await service.close();
      caller.disconnect();
      states.disconnect();
      const child = spawn(process.execPath, [join(runtime, 'dist/plugin-task-host.js')], {
        env: process.env,
        stdio: 'ignore',
      });
      try {
        caller = new PluginTaskClient({ autoStart: false });
        await vi.waitFor(() => caller.status(), { timeout: 10000 });
        const original = await caller.start('fixture', {
          command: 'work',
          input: { wait: true, marker },
        });
        await vi.waitFor(
          async () =>
            expect(await caller.checkpoint(original.taskId)).toMatchObject({ sequence: 1 }),
          { timeout: 10000 },
        );
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
        caller.disconnect();
        service = await startPluginHostServer({
          workerPath: join(runtime, 'dist/plugin-worker.js'),
        });
        caller = new PluginTaskClient({ autoStart: false });
        expect((await caller.get(original.taskId)).state).toBe('interrupted');
        let restored!: { taskId: string };
        await vi.waitFor(
          async () => {
            restored = await caller.resume(original.taskId);
          },
          { timeout: 10000 },
        );
        expect(await caller.wait(restored.taskId)).toMatchObject({
          done: 7,
          from: original.taskId,
        });
        expect(readFileSync(marker, 'utf8')).toBe('submitted\n');
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    },
  );

  it('bridges Python checkpoint declarations and hidden recovery handlers', async () => {
    const entry = join(directory, 'skill/main.py');
    writeFileSync(
      entry,
      `taskRecovery = {"version":1,"commands":{"work":{"checkpointVersion":1,"schema":{"type":"integer"}}}}
def register(app):
    def work(input, context):
        context.checkpoint(42, 0)
        raise RuntimeError("python interrupted")
    def recover(input, context):
        context.checkpoint(context.recovery["checkpoint"]["data"] + 1, 0)
        return {"data":context.recovery["checkpoint"]["data"]}
    app.command("work", work)
    app.recoveryCommand("work", recover)
`,
    );
    registerPlugin('python-fixture', entry);
    const original = await caller.start('python-fixture', { command: 'work', input: {} });
    await expect(caller.wait(original.taskId)).rejects.toThrow('python interrupted');
    const recovered = await caller.resume(original.taskId);
    expect(await caller.wait(recovered.taskId)).toEqual({ data: 42 });
    expect(await caller.checkpoint(recovered.taskId)).toMatchObject({ sequence: 1, data: 43 });
  });

  it('resumes checkpoints as one new attempt using the retained source and fresh caller environment', async () => {
    writeFileSync(join(directory, 'skill/main.mjs'), recoverable);
    const original = await caller.start(
      'fixture',
      { command: 'work', input: { original: true } },
      { environment: { ...process.env, MEARL_RECOVERY_TEST: 'old-secret-environment' } },
    );
    await expect(caller.wait(original.taskId)).rejects.toThrow('interrupted fixture');
    expect(await caller.checkpoint(original.taskId)).toMatchObject({
      sequence: 1,
      version: 1,
      data: { done: 7 },
    });
    expect(JSON.stringify(service.host.tasks.store.read(original.taskId))).not.toContain(
      'old-secret-environment',
    );
    writeFileSync(
      join(directory, 'skill/main.mjs'),
      recoverable.replace("code:'original'", "code:'changed'"),
    );
    const environment = { ...process.env, MEARL_RECOVERY_TEST: 'fresh-environment' };
    const [first, second] = await Promise.all([
      caller.resume(original.taskId, { environment }),
      caller.resume(original.taskId, { environment }),
    ]);
    expect(first.taskId).toBe(second.taskId);
    expect(first.taskId).not.toBe(original.taskId);
    expect(await caller.wait(first.taskId)).toEqual({
      code: 'original',
      done: 7,
      input: { original: true },
      from: original.taskId,
      env: 'fresh-environment',
    });
    expect(await caller.get(first.taskId)).toMatchObject({
      resumedFrom: { taskId: original.taskId, checkpointSequence: 1 },
      revision: (await caller.get(original.taskId)).revision,
    });
    expect((await caller.get(original.taskId)).state).toBe('error');
    expect((await caller.events(original.taskId)).events).toContainEqual(
      expect.objectContaining({
        type: 'checkpoint',
        checkpoint: {
          version: 1,
          sequence: 1,
          schemaHash: expect.any(String),
          updatedAt: expect.any(Number),
        },
      }),
    );
  });

  it('migrates explicitly to a pinned current revision once and preserves historical input and provenance', async () => {
    const entry = join(directory, 'skill/main.mjs'),
      marker = join(directory, 'migration-count');
    writeFileSync(entry, recoverable);
    const original = await caller.start('fixture', {
      command: 'work',
      input: { historical: true },
    });
    await expect(caller.wait(original.taskId)).rejects.toThrow();
    const checkpoint = await caller.checkpoint(original.taskId),
      source = await caller.get(original.taskId);
    const upgraded = upgradedRecovery(
      "appendFileSync(process.env.MEARL_MIGRATION_MARKER,'converted\\n'); await new Promise(resolve=>setTimeout(resolve,500)); return {completed:input.checkpoint.data.done+1};",
    );
    writeFileSync(entry, upgraded);
    const options = {
      revision: 'current' as const,
      environment: { ...process.env, MEARL_MIGRATION_MARKER: marker },
    };
    const pending = caller.resume(original.taskId, options);
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10000 });
    writeFileSync(entry, upgraded.replace("code:'upgraded'", "code:'changed-again'"));
    const concurrent = caller.resume(original.taskId, options);
    await expect(
      caller.resume(original.taskId, { revision: 'original', environment: options.environment }),
    ).rejects.toMatchObject({ code: 'PLUGIN_TASK_IDEMPOTENCY_CONFLICT' });
    const [first, second] = await Promise.all([pending, concurrent]);
    expect(first.taskId).toBe(second.taskId);
    expect(await caller.wait(first.taskId)).toMatchObject({
      code: 'upgraded',
      input: { historical: true },
      recovery: {
        fromTaskId: original.taskId,
        fromRevision: source.revision,
        sourceCheckpoint: {
          sequence: checkpoint!.sequence,
          version: checkpoint!.version,
          schemaHash: checkpoint!.schemaHash,
          updatedAt: checkpoint!.updatedAt,
        },
        checkpoint: { sequence: 1, version: 2, data: { completed: 8 } },
      },
    });
    const successor = await caller.get(first.taskId);
    expect(successor.revision).not.toBe(source.revision);
    expect(successor.resumedFrom).toEqual({
      taskId: source.taskId,
      revision: source.revision,
      checkpointSequence: 1,
      checkpointVersion: 1,
    });
    expect(await caller.checkpoint(first.taskId)).toMatchObject({
      sequence: 0,
      version: 2,
      data: { completed: 8 },
      schemaHash: expect.any(String),
    });
    expect(await caller.checkpoint(original.taskId)).toEqual(checkpoint);
    await expect(caller.resume(original.taskId, options)).rejects.toMatchObject({
      code: 'PLUGIN_TASK_IDEMPOTENCY_CONFLICT',
    });
    writeFileSync(entry, upgraded);
    expect((await caller.resume(original.taskId, options)).taskId).toBe(first.taskId);
    expect(readFileSync(marker, 'utf8')).toBe('converted\n');
  });

  it('can resume a failed recovery attempt using its own retained snapshot and checkpoint', async () => {
    const entry = join(directory, 'skill/main.mjs');
    writeFileSync(
      entry,
      recoverable.replace(
        "async (input, context) => ({code:'original',done:context.recovery.checkpoint.data.done,input,from:context.recovery.fromTaskId,env:process.env.MEARL_RECOVERY_TEST})",
        "async () => {throw new Error('retryable recovery failure');}",
      ),
    );
    const original = await caller.start('fixture', { command: 'work', input: {} });
    await expect(caller.wait(original.taskId)).rejects.toThrow();
    const first = await caller.resume(original.taskId);
    await expect(caller.wait(first.taskId)).rejects.toThrow('retryable recovery failure');
    const second = await caller.resume(first.taskId);
    await expect(caller.wait(second.taskId)).rejects.toThrow('retryable recovery failure');
    expect((await caller.get(second.taskId)).resumedFrom).toMatchObject({
      taskId: first.taskId,
      checkpointSequence: 0,
    });
  });

  it.each([true, false])(
    'fences target declaration drift before hidden handlers (migration=%s)',
    async migrate => {
      const entry = join(directory, 'skill/main.mjs'),
        marker = join(directory, 'unexpected-handler');
      writeFileSync(entry, recoverable);
      const original = await caller.start('fixture', { command: 'work', input: {} });
      await expect(caller.wait(original.taskId)).rejects.toThrow();
      const target = migrate
        ? upgradedRecovery(
            "appendFileSync(process.env.MEARL_MIGRATION_MARKER,'called'); return {completed:8};",
          ).replace(
            'checkpointVersion":2',
            'checkpointVersion":Number(process.env.MEARL_DRIFT_VERSION || 2)',
          )
        : recoverable.replace(
            'checkpointVersion:1',
            'checkpointVersion:Number(process.env.MEARL_DRIFT_VERSION || 1)',
          );
      writeFileSync(entry, target);
      const options = {
        revision: 'current' as const,
        environment: { ...process.env, MEARL_DRIFT_VERSION: '3', MEARL_MIGRATION_MARKER: marker },
      };
      if (migrate)
        await expect(caller.resume(original.taskId, options)).rejects.toMatchObject({
          code: 'PLUGIN_RECOVERY_DECLARATION_CHANGED',
        });
      else {
        const resumed = await caller.resume(original.taskId, options);
        await expect(caller.wait(resumed.taskId)).rejects.toMatchObject({
          code: 'PLUGIN_RECOVERY_DECLARATION_CHANGED',
        });
      }
      expect(existsSync(marker)).toBe(false);
    },
  );

  it('refuses to label a checkpoint with a declaration different from the executing plugin', async () => {
    writeFileSync(
      join(directory, 'skill/main.mjs'),
      recoverable.replace(
        'checkpointVersion:1',
        'checkpointVersion:Number(process.env.MEARL_DRIFT_VERSION || 1)',
      ),
    );
    const original = await caller.start(
      'fixture',
      { command: 'work', input: {} },
      { environment: { ...process.env, MEARL_DRIFT_VERSION: '3' } },
    );
    await expect(caller.wait(original.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_RECOVERY_DECLARATION_CHANGED',
    });
    expect(await caller.checkpoint(original.taskId)).toBeNull();
  });

  it('accepts unchanged formats in a new revision without migration and ignores schema key order', async () => {
    const entry = join(directory, 'skill/main.mjs');
    writeFileSync(entry, recoverable);
    const original = await caller.start('fixture', { command: 'work', input: {} });
    await expect(caller.wait(original.taskId)).rejects.toThrow();
    writeFileSync(
      entry,
      recoverable
        .replace(
          "properties:{done:{type:'integer'}},required:['done']",
          "required:['done'],properties:{done:{type:'integer'}}",
        )
        .replace("code:'original'", "code:'current'"),
    );
    const recovered = await caller.resume(original.taskId, { revision: 'current' });
    expect(await caller.wait(recovered.taskId)).toMatchObject({ code: 'current', done: 7 });
  });

  it('uses checkpoint schemas as format identity while plugins validate their data', async () => {
    const entry = join(directory, 'skill/main.mjs');
    writeFileSync(entry, recoverable.replace('{done:7}', "{done:'plugin-owned'}"));
    const original = await caller.start('fixture', { command: 'work', input: {} });
    await expect(caller.wait(original.taskId)).rejects.toThrow('interrupted fixture');
    expect(await caller.checkpoint(original.taskId)).toMatchObject({
      data: { done: 'plugin-owned' },
    });
    writeFileSync(entry, upgradedRecovery('return {completed:input.checkpoint.data.done};'));
    const resumed = await caller.resume(original.taskId, { revision: 'current' });
    expect(await caller.wait(resumed.taskId)).toMatchObject({
      recovery: { checkpoint: { data: { completed: 'plugin-owned' } } },
    });
  });

  it.each([
    ['missing JSON output', 'return undefined;', 'PLUGIN_TASK_CHECKPOINT_INVALID'],
    ['host action', "return app.invoke('browser_list');", 'PLUGIN_CHECKPOINT_MIGRATION_HOST_CALL'],
    [
      'nested plugin',
      "return app.invoke('fixture',{command:'work',input:{}});",
      'PLUGIN_CHECKPOINT_MIGRATION_HOST_CALL',
    ],
  ])('rejects %s before creating any successor', async (_name, handler, code) => {
    const entry = join(directory, 'skill/main.mjs');
    writeFileSync(entry, recoverable);
    const original = await caller.start('fixture', { command: 'work', input: {} });
    await expect(caller.wait(original.taskId)).rejects.toThrow();
    writeFileSync(entry, upgradedRecovery(handler));
    await expect(caller.resume(original.taskId, { revision: 'current' })).rejects.toMatchObject({
      code,
    });
    expect((await caller.list()).tasks).toHaveLength(1);
  });

  it('rejects same-version schema changes, undeclared source formats and historical declaration drift', async () => {
    const entry = join(directory, 'skill/main.mjs');
    writeFileSync(entry, recoverable);
    const original = await caller.start('fixture', { command: 'work', input: {} });
    await expect(caller.wait(original.taskId)).rejects.toThrow();
    for (const changed of [
      recoverable.replace("done:{type:'integer'}", "done:{type:'number'}"),
      upgradedRecovery().replace('"done":{"type":"integer"}', '"done":{"type":"number"}'),
    ]) {
      writeFileSync(entry, changed);
      await expect(caller.resume(original.taskId, { revision: 'current' })).rejects.toMatchObject({
        code: 'PLUGIN_CHECKPOINT_MIGRATION_UNSUPPORTED',
      });
    }
    writeFileSync(
      entry,
      recoverable.replace(
        "done:{type:'integer'}",
        "done:{type:'integer',minimum:Number(process.env.MEARL_CHECKPOINT_MIN || 0)}",
      ),
    );
    const dynamic = await caller.start('fixture', { command: 'work', input: {} });
    await expect(caller.wait(dynamic.taskId)).rejects.toThrow();
    vi.stubEnv('MEARL_CHECKPOINT_MIN', '1');
    await expect(caller.resume(dynamic.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_TASK_RECOVERY_UNAVAILABLE',
    });
    expect((await caller.list()).tasks).toHaveLength(2);
  });

  it('aborts and cleans a running migration on service shutdown without accepting a successor', async () => {
    const entry = join(directory, 'skill/main.mjs'),
      marker = join(directory, 'migration-worker');
    writeFileSync(entry, recoverable);
    const original = await caller.start('fixture', { command: 'work', input: {} });
    await expect(caller.wait(original.taskId)).rejects.toThrow();
    writeFileSync(
      entry,
      upgradedRecovery(
        'appendFileSync(process.env.MEARL_MIGRATION_MARKER,String(process.pid)); await new Promise(()=>{});',
      ),
    );
    const pending = caller
      .resume(original.taskId, {
        revision: 'current',
        environment: { ...process.env, MEARL_MIGRATION_MARKER: marker },
      })
      .catch(cause => cause);
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10000 });
    await service.close();
    expect(await pending).toBeInstanceOf(Error);
    const pid = Number(readFileSync(marker, 'utf8'));
    expect(isAlive(pid)).toBe(false);
    expect(service.host.tasks.store.list()).toHaveLength(1);
    caller.disconnect();
    states.disconnect();
    service = await startPluginHostServer({ workerPath: join(runtime, 'dist/plugin-worker.js') });
    caller = new PluginTaskClient({ autoStart: false });
    states = new PluginStateClient({ autoStart: false });
    writeFileSync(entry, upgradedRecovery());
    const resumed = await caller.resume(original.taskId, { revision: 'current' });
    expect(await caller.wait(resumed.taskId)).toMatchObject({ code: 'upgraded' });
  });

  it('enforces the migration deadline and rechecks installation after conversion', async () => {
    const entry = join(directory, 'skill/main.mjs'),
      marker = join(directory, 'deadline-worker');
    writeFileSync(entry, recoverable);
    const original = await caller.start('fixture', { command: 'work', input: {} });
    await expect(caller.wait(original.taskId)).rejects.toThrow();
    writeFileSync(
      entry,
      upgradedRecovery(
        'appendFileSync(process.env.MEARL_MIGRATION_MARKER,String(process.pid)); await new Promise(()=>{});',
      ),
    );
    await expect(
      caller.resume(original.taskId, {
        revision: 'current',
        environment: { ...process.env, MEARL_MIGRATION_MARKER: marker },
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_EXECUTION_DEADLINE' });
    expect(isAlive(Number(readFileSync(marker, 'utf8')))).toBe(false);
    const nextMarker = join(directory, 'replacement-window');
    writeFileSync(
      entry,
      upgradedRecovery(
        "appendFileSync(process.env.MEARL_MIGRATION_MARKER,'started'); await new Promise(resolve=>setTimeout(resolve,500)); return {completed:8};",
      ),
    );
    const pending = caller
      .resume(original.taskId, {
        revision: 'current',
        environment: { ...process.env, MEARL_MIGRATION_MARKER: nextMarker },
      })
      .catch(cause => cause);
    await vi.waitFor(() => expect(existsSync(nextMarker)).toBe(true), { timeout: 10000 });
    const replacement = join(directory, 'other-installation');
    mkdirSync(replacement);
    writeFileSync(join(replacement, 'main.mjs'), upgradedRecovery());
    registerPlugin('fixture', join(replacement, 'main.mjs'));
    expect(await pending).toMatchObject({ code: 'PLUGIN_TASK_INSTALLATION_CHANGED' });
    expect((await caller.list()).tasks).toHaveLength(1);
  });

  it('checks Python run-process declarations before acknowledging hidden or public execution', async () => {
    const entry = join(directory, 'skill/main.py'),
      counter = join(directory, 'python-import-count');
    writeFileSync(
      entry,
      `import os
import signal
from pathlib import Path
signal.signal(signal.SIGTERM,signal.SIG_IGN)
counter = Path(os.environ["MEARL_PYTHON_METADATA_COUNTER"])
count = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(count))
taskRecovery = {"version":1,"commands":{"work":{"checkpointVersion":count,"schema":{"type":"integer"}}}}
def register(app):
    def work(input, context):
        context.checkpoint(42, 0)
    app.command("work",work)
    app.recoveryCommand("work",lambda input: None)
`,
    );
    registerPlugin('python-drifting', entry);
    const original = await caller.start(
      'python-drifting',
      { command: 'work', input: {} },
      { environment: { ...process.env, MEARL_PYTHON_METADATA_COUNTER: counter } },
    );
    await expect(caller.wait(original.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_DECLARATION_CHANGED',
    });
    expect(readFileSync(counter, 'utf8')).toBe('2');
    expect(await caller.checkpoint(original.taskId)).toBeNull();
  });

  it('bridges Python checkpoint migration into the new hidden recovery handler', async () => {
    const entry = join(directory, 'skill/main.py');
    const originalCode = `taskRecovery = {"version":1,"commands":{"work":{"checkpointVersion":1,"schema":{"type":"integer"}}}}
def register(app):
    def work(input, context):
        context.checkpoint(42, 0)
        raise RuntimeError("interrupted")
    app.command("work", work)
    app.recoveryCommand("work", lambda input, context: context.recovery["checkpoint"]["data"])
`;
    writeFileSync(entry, originalCode);
    registerPlugin('python-migration', entry);
    const original = await caller.start('python-migration', { command: 'work', input: {} });
    await expect(caller.wait(original.taskId)).rejects.toThrow();
    writeFileSync(
      entry,
      `taskRecovery = {"version":1,"commands":{"work":{"checkpointVersion":2,"schema":{"type":"string"},"migrateFrom":[{"version":1,"schema":{"type":"integer"}}]}}}
def register(app):
    app.command("work <newArgument>", lambda input: None)
    app.checkpointMigration("work", lambda input: str(input["checkpoint"]["data"]))
    app.recoveryCommand("work", lambda input, context: context.recovery["checkpoint"]["data"])
`,
    );
    const recovered = await caller.resume(original.taskId, { revision: 'current' });
    expect(await caller.wait(recovered.taskId)).toBe('42');
    expect(await caller.checkpoint(recovered.taskId)).toMatchObject({
      sequence: 0,
      version: 2,
      data: '42',
    });
  });

  it('keeps the last valid checkpoint on a CAS conflict and waits for cancellation cleanup before resume', async () => {
    writeFileSync(join(directory, 'skill/main.mjs'), recoverable);
    const conflict = await caller.start('fixture', { command: 'work', input: { conflict: true } });
    await expect(caller.wait(conflict.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_TASK_CHECKPOINT_CONFLICT',
    });
    expect(await caller.checkpoint(conflict.taskId)).toMatchObject({
      sequence: 1,
      data: { done: 7 },
    });
    const running = await caller.start('fixture', { command: 'work', input: { wait: true } });
    await vi.waitFor(async () => expect(await caller.checkpoint(running.taskId)).not.toBeNull(), {
      timeout: 12000,
    });
    await expect(caller.resume(running.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_TASK_RECOVERY_UNAVAILABLE',
    });
    await caller.cancel(running.taskId);
    await expect(caller.wait(running.taskId)).rejects.toBeDefined();
    const resumed = await caller.resume(running.taskId);
    expect(await caller.wait(resumed.taskId)).toMatchObject({ done: 7 });
  });

  it('refuses recovery after installation replacement, snapshot tampering or uncertain process ownership', async () => {
    writeFileSync(join(directory, 'skill/main.mjs'), recoverable);
    const original = await caller.start('fixture', { command: 'work', input: {} });
    await expect(caller.wait(original.taskId)).rejects.toThrow();
    const record = service.host.tasks.store.read(original.taskId);
    service.host.tasks.store.write({ ...record, executorOwner: { pid: process.pid } });
    await expect(caller.resume(original.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_TASK_EXECUTION_STILL_ACTIVE',
    });
    service.host.tasks.store.write(record);
    const childId = original.taskId.slice(0, -1) + (original.taskId.endsWith('0') ? '1' : '0');
    const child = {
      ...record,
      task: {
        ...record.task,
        taskId: childId,
        parentTaskId: original.taskId,
        kind: 'model' as const,
        state: 'interrupted' as const,
      },
      executorOwner: { pid: process.pid },
    };
    service.host.tasks.store.write(child);
    await expect(caller.resume(original.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_TASK_EXECUTION_STILL_ACTIVE',
    });
    rmSync(join(directory, 'registry/.host/tasks', childId), { recursive: true, force: true });
    const replacement = join(directory, 'replacement');
    mkdirSync(replacement);
    writeFileSync(join(replacement, 'main.mjs'), recoverable);
    registerPlugin('fixture', join(replacement, 'main.mjs'));
    await expect(caller.resume(original.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_TASK_INSTALLATION_CHANGED',
    });
    registerPlugin('fixture', join(directory, 'skill/main.mjs'));
    const snapshot = join(
      directory,
      'registry/.host/revisions',
      record.task.installationId,
      record.task.revision,
      record.execution!.entry,
    );
    chmodSync(snapshot, 0o644);
    writeFileSync(snapshot, recoverable + '\n// modified snapshot');
    await expect(caller.resume(original.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_TASK_REVISION_UNAVAILABLE',
    });
  });

  it('executes a structured model task and preserves complete Unicode output', async () => {
    const output = { text: '译文😀'.repeat(40000) };
    const request = {
      ...model('译文😀', { repeat: 40000, json: true }),
      outputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    };
    const started = await new PluginModelClient({ connection: caller.connection }).start(
      'fixture',
      request,
    );
    expect(await caller.wait(started.taskId)).toEqual({
      text: JSON.stringify(output),
      output,
      provider: 'codex',
      mode: 'agent',
      model: 'test-model',
    });
    expect((await caller.get(started.taskId)).kind).toBe('model');
    expect((await caller.events(started.taskId)).events).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        progress: expect.objectContaining({ message: 'model.delta' }),
      }),
    );
  });

  it('runs a nested model with one command slot and propagates progress and parent identity', async () => {
    const parent = await caller.start('fixture', {
      command: 'ask',
      input: { request: model('answer') },
    });
    expect(await caller.wait(parent.taskId)).toMatchObject({ text: 'answer' });
    const child = (await caller.list()).tasks.find(task => task.parentTaskId === parent.taskId)!;
    expect(child).toMatchObject({ kind: 'model', plugin: 'fixture', state: 'success' });
    expect((await caller.get(parent.taskId)).progress).toMatchObject({ message: 'model.delta' });
  });

  it('reuses a supervised conversation across nested calls and releases it with its calling task', async () => {
    const first = join(directory, 'first-model-pid'),
      second = join(directory, 'second-model-pid');
    const parent = await caller.start('fixture', {
      command: 'ask-twice',
      input: {
        first: { ...model('first', { marker: first }), conversation: 'reading' },
        second: { ...model('second', { marker: second }), conversation: 'reading' },
      },
    });
    expect(await caller.wait(parent.taskId)).toMatchObject([{ text: 'first' }, { text: 'second' }]);
    expect(readFileSync(first, 'utf8')).toBe(readFileSync(second, 'utf8'));
    const pid = Number(readFileSync(first, 'utf8'));
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
  });

  it('exposes model discovery without admitting a model task', async () => {
    const before = (await caller.list()).tasks.length;
    const discover = vi
      .spyOn(service.host.models, 'list')
      .mockResolvedValue({ provider: 'codex', models: [{ id: 'local', displayName: 'Local' }] });
    expect(await new PluginModelClient({ connection: caller.connection }).list('codex')).toEqual({
      provider: 'codex',
      models: [{ id: 'local', displayName: 'Local' }],
    });
    expect(discover).toHaveBeenCalledWith('codex');
    expect((await caller.list()).tasks).toHaveLength(before);
    discover.mockRestore();
  });

  it('rejects unsupported modes before admission and invalid JSON before successful completion', async () => {
    expect(
      (await new PluginModelClient({ connection: caller.connection }).capabilities()).providers[0]
        .modes,
    ).toEqual(['agent']);
    await expect(
      new PluginModelClient({ connection: caller.connection }).start('fixture', {
        ...model('text'),
        mode: 'generate',
        permissions: undefined,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_MODEL_CAPABILITY_UNSUPPORTED' });
    const started = await new PluginModelClient({ connection: caller.connection }).start(
      'fixture',
      {
        ...model('not-json'),
        outputSchema: { type: 'object' },
      },
    );
    await expect(caller.wait(started.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_MODEL_SCHEMA_INVALID',
    });
    expect((await caller.get(started.taskId)).state).toBe('error');
  });

  it('cancels a parent and its live model process before reporting terminal cleanup', async () => {
    const marker = join(directory, 'model-pid');
    const parent = await caller.start('fixture', {
      command: 'ask',
      input: { request: model('late', { delay: 60000, marker }) },
    });
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 12000 });
    const pid = Number(readFileSync(marker, 'utf8'));
    await caller.cancel(parent.taskId);
    await expect(caller.wait(parent.taskId)).rejects.toBeDefined();
    await vi.waitFor(async () => expect((await caller.list(true)).tasks).toHaveLength(0), {
      timeout: 10000,
    });
    expect(isAlive(pid)).toBe(false);
  });

  it('rejects a synchronous handler carrying an outdated state declaration', async () => {
    const old = {
      scope: 'installation' as const,
      storage: 'persistent' as const,
      schemaVersion: 1,
      schema: { type: 'integer' },
    };
    await states.get('fixture', 'settings', 'value');
    writeFileSync(
      join(directory, 'skill/main.mjs'),
      source.replace(
        "schemaVersion:1,schema:{type:'integer'}",
        "schemaVersion:2,schema:{type:'string'}",
      ),
    );
    await expect(
      states.call('fixture', 'settings', 'transact', {
        expectedDeclaration: pluginStateSignature(old),
        transaction: {
          operations: [{ type: 'put', key: 'value', value: 1, expectedVersion: 'a:0' }],
        },
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_STATE_REVISION_CHANGED' });
  });

  it('shares state across clients and command contexts while enforcing CAS and declared scope', async () => {
    const initial = await states.get('fixture', 'settings', 'value');
    expect(initial).toMatchObject({ exists: false, version: 'a:0', schemaVersion: 1 });
    const transaction = {
      operations: [
        { type: 'put' as const, key: 'value', value: 42, expectedVersion: initial.version },
      ],
      idempotencyKey: 'write',
    };
    expect(await states.transact('fixture', 'settings', transaction)).toMatchObject({
      revision: 1,
    });
    expect(await states.transact('fixture', 'settings', transaction)).toMatchObject({
      reused: true,
    });
    await expect(
      states.transact('fixture', 'settings', {
        operations: [{ ...transaction.operations[0], value: 43 }],
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_STATE_CONFLICT' });
    expect(await states.getMany('fixture', 'settings', ['value', 'missing'])).toMatchObject({
      entries: [
        { key: 'value', exists: true, value: 42 },
        { key: 'missing', exists: false },
      ],
    });
    const task = await caller.start('fixture', { command: 'state', input: {} });
    expect(await caller.wait(task.taskId)).toMatchObject({ exists: true, value: 42 });
    await expect(states.getMany('fixture', 'undeclared', ['value'])).rejects.toMatchObject({
      code: 'PLUGIN_STATE_NOT_DECLARED',
    });
    await expect(states.get('fixture', 'undeclared', 'value')).rejects.toMatchObject({
      code: 'PLUGIN_STATE_NOT_DECLARED',
    });
    await expect(states.get('fixture', 'page', 'value')).rejects.toMatchObject({
      code: 'PLUGIN_PAGE_NOT_FOUND',
    });
  });

  it('exposes declared state and model execution through Python contexts', async () => {
    const entry = join(directory, 'skill/main.py');
    writeFileSync(
      entry,
      `stateStorage = {"version":1,"collections":{"settings":{"scope":"installation","storage":"persistent","schemaVersion":1,"schema":{"type":"integer"}}}}
def register(app):
    def run(input, context):
        previous = context.state("settings", "get", {"key":"value"})
        context.state("settings", "transact", {"transaction":{"operations":[{"type":"put","key":"value","value":7,"expectedVersion":previous["version"]}]}})
        return context.model(input["request"])
    app.command("run", run)
`,
    );
    registerPlugin('python-fixture', entry);
    const task = await caller.start('python-fixture', {
      command: 'run',
      input: { request: model('python result') },
    });
    expect(await caller.wait(task.taskId)).toMatchObject({ text: 'python result' });
    expect(await states.get('python-fixture', 'settings', 'value')).toMatchObject({ value: 7 });
  });

  it('gives nested plugins independent revisions, state, model children and diagnostic links with one command slot', async () => {
    const childRoot = join(directory, 'child');
    mkdirSync(childRoot);
    writeFileSync(join(childRoot, 'SKILL.md'), '# Child');
    writeFileSync(
      join(childRoot, 'main.mjs'),
      source.replace(
        "app.command('state',",
        "app.command('identity', (input, context) => context.identity); app.command('write', async (input, context) => { const current = await context.state('settings','get',{key:'value'}); return context.state('settings','transact',{transaction:{operations:[{type:'put',key:'value',value:7,expectedVersion:current.version}]}}); }); app.command('state',",
      ),
    );
    registerPlugin('child', join(childRoot, 'main.mjs'));
    writeFileSync(
      join(directory, 'skill/main.mjs'),
      source.replace(
        "app.command('state',",
        "app.command('nested', input => app.invoke('child', {command:input.command,input:input.input})); app.command('state',",
      ),
    );
    const run = async (command: string, input = {}) => {
      const task = await caller.start('fixture', { command: 'nested', input: { command, input } });
      return { task, result: await caller.wait(task.taskId) };
    };
    const identity = await run('identity');
    const parent = await caller.get(identity.task.taskId);
    const childIdentity = identity.result as any;
    expect(childIdentity).toMatchObject({
      plugin: 'child',
      parentInvocationId: expect.any(String),
      taskId: expect.any(String),
      installationId: expect.any(String),
      revision: expect.any(String),
    });
    expect(childIdentity.installationId).not.toBe(parent.installationId);
    expect(childIdentity.revision).not.toBe(parent.revision);
    const graph = await caller.diagnose({ taskId: identity.task.taskId });
    expect(graph.links).toContainEqual({
      from: parent.taskId,
      to: childIdentity.taskId,
      kind: 'parent',
    });
    expect(graph.tasks.find(task => task.taskId === childIdentity.taskId)?.executor.state).toBe(
      'stop-confirmed',
    );
    await run('write');
    expect(await states.get('fixture', 'settings', 'value')).toMatchObject({ exists: false });
    expect(await states.get('child', 'settings', 'value')).toMatchObject({ value: 7 });
    expect((await run('ask', { request: model('nested') })).result).toMatchObject({
      text: 'nested',
    });
    const modelTask = service.host.tasks.store
      .list()
      .find(record => record.task.kind === 'model')!.task;
    expect(modelTask.plugin).toBe('child');
    expect(modelTask.parentTaskId).not.toBe(parent.taskId);
    const diagnostic = await caller.diagnose({ taskId: modelTask.taskId });
    expect(diagnostic.tasks.find(task => task.taskId === modelTask.taskId)?.model).toMatchObject({
      runtime: { executable: expect.any(String), selection: 'explicit', started: true },
      selectedModel: 'test-model',
      threadRestrictionsAccepted: true,
      turnRestrictionsAccepted: true,
    });
  });

  it('rejects cross-plugin cycles and toolbox-only child commands', async () => {
    const child = join(directory, 'skill/child.mjs');
    writeFileSync(join(directory, 'skill/child.html'), '<html></html>');
    writeFileSync(
      child,
      `export const toolbox={version:1,title:'Child',page:{type:'sandbox',entry:'child.html',commands:['hidden']}}; export default app => { app.command('cycle', () => app.invoke('fixture', {command:'state',input:{}})); app.toolboxCommand('hidden', () => 'hidden'); };`,
    );
    registerPlugin('child', child);
    writeFileSync(
      join(directory, 'skill/main.mjs'),
      source.replace(
        "app.command('state',",
        "app.command('nested', input => app.invoke('child', {command:input.command,input:{}})); app.command('state',",
      ),
    );
    const cycle = await caller.start('fixture', { command: 'nested', input: { command: 'cycle' } });
    await expect(caller.wait(cycle.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_INVOCATION_CYCLE',
    });
    const hidden = await caller.start('fixture', {
      command: 'nested',
      input: { command: 'hidden' },
    });
    await expect(caller.wait(hidden.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_COMMAND_TOOLBOX_ONLY',
    });
  });

  it('cancels the nested plugin and its model before the parent becomes terminal', async () => {
    const child = join(directory, 'skill/child.mjs');
    writeFileSync(child, source);
    registerPlugin('child', child);
    writeFileSync(
      join(directory, 'skill/main.mjs'),
      source.replace(
        "app.command('state',",
        "app.command('nested', input => app.invoke('child', {command:'ask',input})); app.command('state',",
      ),
    );
    const parent = await caller.start('fixture', {
      command: 'nested',
      input: { request: model('never', { delay: 10000 }) },
    });
    await vi.waitFor(
      () =>
        expect(
          service.host.tasks.store
            .list()
            .some(record => record.task.kind === 'model' && record.task.state === 'running'),
        ).toBe(true),
      { timeout: 10000 },
    );
    await caller.cancel(parent.taskId);
    await expect(caller.wait(parent.taskId)).rejects.toMatchObject({
      code: 'PLUGIN_EXECUTION_CANCELLED',
    });
    expect(
      service.host.tasks.store
        .list()
        .every(record => !['queued', 'running', 'cancelling'].includes(record.task.state)),
    ).toBe(true);
  });
});
