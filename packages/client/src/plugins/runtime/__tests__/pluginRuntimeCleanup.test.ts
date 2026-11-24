import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readRecord, writeRecord } from '@mearl/daemon-core';
import { cleanupPluginRuntime } from '../pluginRuntimeCleanup.js';
import { pluginHostPaths } from '../pluginHostPaths.js';
import { PluginTaskClient } from '../../clients/pluginTasks.js';
import { PluginTaskStore } from '../pluginTaskStore.js';
import type { PluginTask } from '@mearl/browser-core';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-runtime-cleanup-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', directory);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function task(state: PluginTask['state'] = 'success'): PluginTask {
  const host = { hostId: randomUUID(), epoch: randomUUID() };
  return {
    taskId: `pt_${host.hostId}_${randomUUID()}`,
    host,
    plugin: 'fixture',
    installationId: randomUUID(),
    revision: 'a'.repeat(64),
    command: 'test',
    input: {},
    source: 'sdk',
    cwd: directory,
    state,
    sequence: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

it('stops the existing service and removes execution caches while retaining persistent state', async () => {
  const paths = pluginHostPaths();
  mkdirSync(paths.home, { recursive: true });
  writeRecord(paths.lease, { pid: process.pid, epoch: 'old' });
  const stop = vi
    .spyOn(PluginTaskClient.prototype, 'stopHost')
    .mockImplementation(async function () {
      expect((this as any).configuration.autoStart).toBe(false);
      expect(readRecord(`${paths.lease}.start`)?.pid).toBe(process.pid);
      rmSync(paths.lease);
    });
  new PluginTaskStore().write({ task: task(), events: [], access: 'public' });
  for (const path of [paths.revisions, paths.state]) mkdirSync(path, { recursive: true });
  writeFileSync(paths.log, 'log');
  await cleanupPluginRuntime();
  expect(stop).toHaveBeenCalledOnce();
  for (const path of [paths.tasks, paths.revisions, paths.log])
    expect(existsSync(path)).toBe(false);
  expect(existsSync(paths.state)).toBe(true);
});

it('keeps caches if a replacement service or plugin appears during shutdown', async () => {
  const paths = pluginHostPaths();
  mkdirSync(paths.home, { recursive: true });
  writeRecord(paths.lease, { pid: process.pid, epoch: 'old' });
  vi.spyOn(PluginTaskClient.prototype, 'stopHost').mockImplementation(async () => {
    writeRecord(paths.lease, { pid: process.pid, epoch: 'new' });
  });
  new PluginTaskStore().write({ task: task(), events: [], access: 'public' });
  await expect(cleanupPluginRuntime()).rejects.toThrow('restarted');
  expect(existsSync(paths.tasks)).toBe(true);
});

it.each(['unconfirmed', 'registered'])('retains caches with %s ownership', async kind => {
  const paths = pluginHostPaths();
  new PluginTaskStore().write({
    task: task('running'),
    events: [],
    access: 'public',
    ...(kind === 'unconfirmed' ? { executorOwner: { pid: process.pid } } : {}),
  });
  if (kind === 'registered')
    writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ entry: '/fixture.mjs' }));
  await expect(cleanupPluginRuntime()).rejects.toThrow();
  expect(existsSync(paths.tasks)).toBe(true);
});

it('discards a past cleanup failure while preserving records of a live executor', async () => {
  const paths = pluginHostPaths();
  const store = new PluginTaskStore();
  const removeData = vi.fn(() => rmSync(paths.home, { recursive: true, force: true }));
  const stale = {
    ...task('error'),
    error: {
      code: 'PLUGIN_EXECUTOR_CLEANUP_FAILED',
      message: 'Unable to confirm plugin process-tree cleanup',
      details: { executionStopped: false },
    },
  };
  store.write({
    task: stale,
    events: [],
    access: 'public',
    executorOwner: { pid: 2147483647 },
  });
  const active = task('running');
  store.write({
    task: active,
    events: [],
    access: 'public',
    executorOwner: { pid: process.pid },
  });
  mkdirSync(join(paths.tasks, task().taskId));
  await expect(cleanupPluginRuntime({ removeData })).rejects.toThrow(
    'Plugin task executors are still running',
  );
  expect(existsSync(paths.tasks)).toBe(true);
  rmSync(join(paths.tasks, active.taskId), { recursive: true });
  expect(removeData).not.toHaveBeenCalled();
  await cleanupPluginRuntime({ removeData });
  expect(existsSync(paths.tasks)).toBe(false);
});

it('holds the startup lock during deletion without deleting an external linked cache', async () => {
  const data = join(directory, 'data');
  const external = join(directory, 'external');
  vi.stubEnv('MEARL_PLUGIN_DIR', data);
  const paths = pluginHostPaths();
  mkdirSync(data);
  mkdirSync(external);
  symlinkSync(external, paths.home, 'junction');
  const saved = task();
  new PluginTaskStore().write({ task: saved, events: [], access: 'public' });
  await cleanupPluginRuntime({
    removeData: () => {
      expect(readRecord(`${paths.lease}.start`)?.pid).toBe(process.pid);
      rmSync(data, { recursive: true });
    },
  });
  expect(existsSync(data)).toBe(false);
  expect(existsSync(join(external, 'tasks', saved.taskId, 'task.json'))).toBe(true);
  expect(existsSync(join(external, 'service.json.start'))).toBe(false);
});

it('checks runtime owners in the default registry when using a custom one', async () => {
  const defaultRegistry = join(directory, 'default');
  const local = pluginHostPaths(defaultRegistry);
  const removeData = vi.fn();
  writeRecord(local.lease, { pid: process.pid });
  await expect(cleanupPluginRuntime({ defaultRegistry, removeData })).rejects.toThrow(
    'default Mearl plugin service is running',
  );
  rmSync(local.lease);
  new PluginTaskStore(local.tasks).write({
    task: task('running'),
    events: [],
    access: 'public',
    executorOwner: { pid: process.pid },
  });
  await expect(cleanupPluginRuntime({ defaultRegistry, removeData })).rejects.toThrow(
    'Plugin task executors are still running',
  );
  expect(removeData).not.toHaveBeenCalled();
});

it('recovers abandoned active task records without starting a service', async () => {
  const paths = pluginHostPaths();
  new PluginTaskStore().write({ task: task('running'), events: [], access: 'public' });
  writeRecord(paths.lease, { pid: 2147483647, epoch: 'dead' });
  const start = vi.spyOn(PluginTaskClient.prototype, 'stopHost');
  if (process.platform === 'win32') {
    await expect(cleanupPluginRuntime()).rejects.toThrow('not confirmed stopped');
    expect(existsSync(paths.tasks)).toBe(true);
    return;
  }
  await cleanupPluginRuntime();
  expect(start).not.toHaveBeenCalled();
  expect(existsSync(paths.tasks)).toBe(false);
});

it('keeps caches while another caller holds the service startup claim', async () => {
  const paths = pluginHostPaths();
  new PluginTaskStore().write({ task: task(), events: [], access: 'public' });
  writeRecord(`${paths.lease}.start`, { pid: process.pid });
  await expect(cleanupPluginRuntime()).rejects.toThrow('is starting');
  expect(existsSync(paths.tasks)).toBe(true);
  expect(readRecord(`${paths.lease}.start`)?.pid).toBe(process.pid);
});

it('retains Windows execution evidence introduced by crash recovery', async () => {
  const paths = pluginHostPaths();
  new PluginTaskStore().write({ task: task('running'), events: [], access: 'public' });
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let cleanup: Promise<void>;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    cleanup = cleanupPluginRuntime();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
  await expect(cleanup).rejects.toThrow('not confirmed stopped');
  expect(existsSync(paths.tasks)).toBe(true);
});
