import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginTaskStore } from '../pluginTaskStore.js';
import type { PluginTask } from '@mearl/browser-core';

let directory: string;
let store: PluginTaskStore;
let task: PluginTask;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-task-store-'));
  store = new PluginTaskStore(directory);
  const host = { hostId: randomUUID(), epoch: randomUUID() };
  task = {
    taskId: `pt_${host.hostId}_${randomUUID()}`,
    host,
    plugin: 'fixture',
    installationId: randomUUID(),
    revision: 'a'.repeat(64),
    command: 'echo',
    input: {},
    source: 'sdk',
    cwd: directory,
    state: 'queued',
    sequence: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.write({ task, events: [], access: 'public' });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('persistent task records', () => {
  it('indexes active identities at recovery and reads no terminal history during polling', () => {
    store.recover(task.host.epoch);
    const list = vi.spyOn(store, 'list');
    expect(store.listActive().map(record => record.task.taskId)).toEqual([task.taskId]);
    store.update(task.taskId, { state: 'running', progress: { message: 'latest' } });
    expect(store.listActive()[0].task.progress).toEqual({ message: 'latest' });
    store.update(task.taskId, { state: 'cancelling' });
    expect(store.listActive()[0].task.state).toBe('cancelling');
    store.update(task.taskId, { state: 'cancelled' });
    expect(store.listActive()).toEqual([]);
    const next = { ...task, taskId: `pt_${task.host.hostId}_${randomUUID()}` };
    store.write({ task: next, events: [], access: 'public' });
    expect(store.listActive().map(record => record.task.taskId)).toEqual([next.taskId]);
    rmSync(join(directory, next.taskId), { recursive: true });
    expect(store.listActive()).toEqual([]);
    expect(store.listActive()).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it('initializes active polling once and excludes recovered tasks from an earlier host', () => {
    const list = vi.spyOn(store, 'list');
    expect(store.listActive()).toHaveLength(1);
    expect(store.listActive()).toHaveLength(1);
    expect(list).toHaveBeenCalledOnce();
    store.recover(randomUUID());
    expect(store.listActive()).toEqual([]);
    expect(store.read(task.taskId).task.state).toBe('interrupted');
  });

  it('indexes idempotent requests once and reads only matching current records', () => {
    store.write({ task, events: [], access: 'public', dedupeKey: 'explicit:one' });
    const list = vi.spyOn(store, 'list');
    expect(store.findDedupe('explicit:one')?.task.state).toBe('queued');
    store.update(task.taskId, { state: 'success' });
    expect(store.findDedupe('explicit:one')?.task.state).toBe('success');
    expect(store.findDedupe('explicit:missing')).toBeUndefined();
    expect(list).toHaveBeenCalledOnce();
    expect(new PluginTaskStore(directory).findDedupe('explicit:one')?.task.state).toBe('success');
  });

  it('releases automatic dedupe entries after completion and tracks changed keys', () => {
    store.write({ task, events: [], access: 'toolbox', dedupeKey: 'active:one' });
    expect(store.findDedupe('active:one', true)?.task.taskId).toBe(task.taskId);
    store.update(task.taskId, { state: 'success' });
    expect(store.findDedupe('active:one', true)).toBeUndefined();
    const next = { ...task, taskId: `pt_${task.host.hostId}_${randomUUID()}` };
    store.write({ task: next, events: [], access: 'toolbox', dedupeKey: 'active:one' });
    expect(store.findDedupe('active:one', true)?.task.taskId).toBe(next.taskId);
    store.write({ task: next, events: [], access: 'public', dedupeKey: 'explicit:next' });
    expect(store.findDedupe('active:one', true)).toBeUndefined();
    expect(store.findDedupe('explicit:next')?.task.taskId).toBe(next.taskId);
  });

  it('removes indexed requests when retention deletes their records', () => {
    store.write({
      task: { ...task, state: 'success' },
      events: [],
      access: 'public',
      dedupeKey: 'explicit:one',
    });
    expect(store.findDedupe('explicit:one')).toBeDefined();
    store.prune(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(store.findDedupe('explicit:one')).toBeUndefined();
  });

  it('retains old ownership evidence while a terminal execution cannot be confirmed stopped', () => {
    store.write({
      task: { ...task, state: 'interrupted' },
      events: [],
      access: 'public',
      executorOwner: { pid: process.pid },
    });
    store.prune(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(store.list()).toHaveLength(1);
    store.write({
      task: {
        ...task,
        state: 'error',
        error: { message: 'cleanup unknown', details: { executionStopped: false } },
      },
      events: [],
      access: 'public',
    });
    store.prune(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(store.list()).toHaveLength(1);
  });

  it.each([0, -1, 1.5, NaN])(
    'retains terminal records with invalid executor ownership: %s',
    pid => {
      store.write({
        task: { ...task, state: 'interrupted' },
        events: [],
        access: 'public',
        executorOwner: { pid },
      });
      store.prune(Date.now() + 8 * 24 * 60 * 60 * 1000);
      expect(store.list()).toHaveLength(1);
    },
  );
  it('bounds diagnostic scanning and includes a requested task before the scan budget', () => {
    for (let index = 0; index < 515; index++)
      store.write({
        task: { ...task, taskId: `pt_${task.host.hostId}_${randomUUID()}` },
        events: [],
        access: 'public',
      });
    const page = store.diagnosticRecords(task.taskId);
    expect(page.records).toHaveLength(512);
    expect(page.limited).toBe(true);
    expect(page.records[0].task.taskId).toBe(task.taskId);
    truncateSync(join(directory, task.taskId, 'task.json'), 17 * 1024 * 1024);
    expect(store.diagnosticRecords(task.taskId)).toEqual({ records: [], limited: true });
  });

  it('bounds history and reports a cursor gap with the latest snapshot', () => {
    for (let index = 0; index < 270; index++)
      store.update(task.taskId, { progress: { message: String(index) } }, 'progress');
    const page = new PluginTaskStore(directory).events(task.taskId, 0);
    expect(page.gap).toBe(true);
    expect(page.firstAvailableSequence).toBe(15);
    expect(page.task.progress).toEqual({ message: '269' });
    expect(page.events).toHaveLength(256);
    expect(page.nextCursor).toBe(270);
    expect(() => store.events(task.taskId, 271)).toThrow('cursor');
  });

  it('reconstructs result chunks and prevents result reads before terminal commit', () => {
    const value = { text: '结果'.repeat(100000) };
    const reference = store.saveResult(task.taskId, value)!;
    expect(() => store.resultChunk(task.taskId, 0)).toThrow('not available');
    store.update(task.taskId, { state: 'success', result: reference });
    const bytes = Buffer.concat(
      Array.from({ length: reference.chunks }, (_, index) =>
        Buffer.from(store.resultChunk(task.taskId, index).data, 'base64'),
      ),
    );
    expect(JSON.parse(bytes.toString('utf8')).value).toEqual(value);
    expect(() => store.resultChunk(task.taskId, reference.chunks)).toThrow('chunk');
    expect(() => store.read('../task')).toThrow('Invalid plugin task ID');
  });

  it('interrupts an old epoch once, retains terminal results and prunes only expired terminal tasks', () => {
    const nextEpoch = randomUUID();
    store.recover(nextEpoch);
    expect(store.read(task.taskId).task).toMatchObject({ state: 'interrupted', sequence: 1 });
    store.recover(nextEpoch);
    expect(store.read(task.taskId).task.sequence).toBe(1);
    store.prune(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(store.list()).toEqual([]);
    store.write({ task, events: [], access: 'public' });
    store.prune(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(store.list()).toHaveLength(1);
  });
});
