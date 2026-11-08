import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginModelSessions } from '../pluginModelSessions.js';
import type { PluginExecutorOptions } from '../pluginExecutor.js';

let directory: string, sessions: PluginModelSessions;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'model-conversation-'));
  const worker = join(directory, 'worker.mjs');
  writeFileSync(
    worker,
    `let round=0;process.on('message',({request})=>{round++;if(request.prompt==='hang')return;setTimeout(()=>process.send({type:'result',result:{provider:'codex',mode:'agent',text:request.prompt==='invalid-json'?'not-json':JSON.stringify({pid:process.pid,round})}}),request.prompt==='delay'?150:0);});`,
  );
  sessions = new PluginModelSessions(10000, 8, worker);
});
afterEach(async () => {
  await sessions.close();
  rmSync(directory, { recursive: true, force: true });
});
const request = {
  provider: 'codex',
  mode: 'agent' as const,
  permissions: 'read-only' as const,
  conversation: 'reading',
  prompt: 'text',
};
const context = (revision = 'one') =>
  ({ invoke: vi.fn(), invocation: { installationId: 'install', revision } }) as any;
const run = (owner: string, options: PluginExecutorOptions = {}, revision = 'one') =>
  sessions
    .execute(owner, 'fixture', { command: 'model', input: {} }, context(revision), {
      model: request,
      ...options,
    })
    .then((value: any) => JSON.parse(value.text));

it('reuses one worker for a document across callers and serializes concurrent turns', async () => {
  const [first, second] = await Promise.all([
    run('document', { model: { ...request, prompt: 'delay' } }),
    run('document'),
  ]);
  expect(second).toEqual({ pid: first.pid, round: 2 });
  expect(
    await run('document', {
      model: { ...request, prompt: 'another batch', outputSchema: { type: 'object' } },
    }),
  ).toEqual({ pid: first.pid, round: 3 });
});
it('isolates owners, revisions, instructions and model choices', async () => {
  const first = await run('document');
  const values = [
    await run('other'),
    await run('document', {}, 'two'),
    await run('document', { model: { ...request, model: 'other' } }),
    await run('document', { model: { ...request, instructions: 'different' } }),
  ];
  expect(new Set([first.pid, ...values.map(value => value.pid)]).size).toBe(5);
});
it('kills a cancelled turn and starts a fresh conversation on retry', async () => {
  const controller = new AbortController(),
    started = vi.fn(),
    stopped = vi.fn();
  const pending = run('document', {
    model: { ...request, prompt: 'hang' },
    signal: controller.signal,
    onExecutorStarted: started,
    onExecutorStopped: stopped,
  });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_EXECUTION_CANCELLED' });
  await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
  controller.abort();
  await rejected;
  expect(stopped).toHaveBeenCalledOnce();
  expect((await run('document')).round).toBe(1);
});
it('cancels a queued turn without interrupting the running turn', async () => {
  const first = run('document', { model: { ...request, prompt: 'delay' } });
  const controller = new AbortController();
  const second = run('document', { signal: controller.signal });
  const rejected = expect(second).rejects.toMatchObject({ code: 'PLUGIN_EXECUTION_CANCELLED' });
  controller.abort();
  await rejected;
  const result = await first;
  expect(await run('document')).toEqual({ pid: result.pid, round: 2 });
});
it('releases a detached document while retaining other document sessions', async () => {
  await run('document');
  const other = await run('other');
  await sessions.release('document');
  expect((await run('document')).round).toBe(1);
  expect(await run('other')).toEqual({ pid: other.pid, round: 2 });
});
it('enforces deadlines and refuses new work after shutdown', async () => {
  await expect(
    run('document', { model: { ...request, prompt: 'hang' }, executionTimeoutMs: 60 }),
  ).rejects.toMatchObject({ code: 'PLUGIN_EXECUTION_DEADLINE' });
  await sessions.close();
  await expect(run('document')).rejects.toThrow('closed');
});
it('evicts idle conversations at the limit and expires unused conversations', async () => {
  await sessions.close();
  sessions = new PluginModelSessions(40, 1, join(directory, 'worker.mjs'));
  await run('one');
  expect((await run('two')).round).toBe(1);
  expect((await run('one')).round).toBe(1);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect((await run('one')).round).toBe(1);
});
it('discards a conversation whose structured result is not JSON', async () => {
  await expect(
    run('one', { model: { ...request, prompt: 'invalid-json', outputSchema: { type: 'object' } } }),
  ).rejects.toMatchObject({ code: 'PLUGIN_MODEL_SCHEMA_INVALID' });
  expect((await run('one')).round).toBe(1);
});

it('parses structured JSON without enforcing the provider output schema locally', async () => {
  expect(
    await run('one', { model: { ...request, outputSchema: { type: 'integer' } } }),
  ).toMatchObject({ round: 1 });
  expect((await run('one')).round).toBe(2);
});
