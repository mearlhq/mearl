import type { PluginTaskDiagnosticMetadata } from '@mearl/browser-core';
import { createHash } from 'node:crypto';
import {
  closeSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { isPluginTaskActive, isPluginTaskId } from '@mearl/browser-core';
import type {
  PluginTask,
  PluginTaskEvent,
  PluginTaskEvents,
  PluginTaskResultChunk,
} from '@mearl/browser-core';
import { writePluginHostFile } from './pluginHostFiles.js';
import { pluginHostPaths } from './pluginHostPaths.js';
import type { PluginTaskCheckpoint } from '@mearl/browser-core';
import type { PluginOptions } from '../sdk/plugin.js';
import { isProcessGroupAlive, isProcessOwnerAlive } from '@mearl/daemon-core';

export const PLUGIN_TASK_RESULT_CHUNK_BYTES = 192 * 1024;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface PluginTaskRecord {
  task: PluginTask;
  events: PluginTaskEvent[];
  dedupeKey?: string;
  requestHash?: string;
  access: 'public' | 'toolbox' | 'runtime';
  checkpoint?: PluginTaskCheckpoint;
  diagnostics?: PluginTaskDiagnosticMetadata;
  execution?: {
    entry: string;
    options: PluginOptions;
    bridge: 'service' | 'caller';
    executionTimeoutMs?: number;
  };
  executorOwner?: { pid: number; processIdentity?: string };
}

export function pluginTaskExecutionUnconfirmed(record: PluginTaskRecord): boolean {
  const owner = record.executorOwner;
  if (owner && (!Number.isSafeInteger(owner.pid) || owner.pid < 1)) return true;
  if (
    (owner && isProcessOwnerAlive(owner)) ||
    record.task.error?.details?.executionStopped === false ||
    (process.platform === 'win32' && record.task.error?.code === 'PLUGIN_TASK_HOST_RESTARTED')
  )
    return true;
  if (owner && process.platform !== 'win32') return isProcessGroupAlive(owner.pid);
  return false;
}

export class PluginTaskStore {
  private activeTaskIds?: Set<string>;
  private dedupeIndex?: Map<string, Set<string>>;
  private readonly dedupeKeys = new Map<string, string>();
  constructor(readonly directory = pluginHostPaths().tasks) {}

  private forgetDedupe(taskId: string): void {
    const key = this.dedupeKeys.get(taskId);
    if (!key) return;
    const ids = this.dedupeIndex?.get(key);
    ids?.delete(taskId);
    if (!ids?.size) this.dedupeIndex?.delete(key);
    this.dedupeKeys.delete(taskId);
  }

  private indexDedupe(record: PluginTaskRecord): void {
    if (!this.dedupeIndex) return;
    const { dedupeKey: key, task } = record;
    const keep = key && (!key.startsWith('active:') || isPluginTaskActive(task.state));
    if (keep && this.dedupeKeys.get(task.taskId) === key) return;
    this.forgetDedupe(task.taskId);
    if (!keep) return;
    const ids = this.dedupeIndex.get(key) ?? new Set<string>();
    ids.add(task.taskId);
    this.dedupeIndex.set(key, ids);
    this.dedupeKeys.set(task.taskId, key);
  }

  /** The service owns writes; the index retains identities and reads the current matching record. */
  findDedupe(key: string, activeOnly = false): PluginTaskRecord | undefined {
    if (!this.dedupeIndex) {
      this.dedupeIndex = new Map();
      for (const record of this.list()) this.indexDedupe(record);
    }
    for (const taskId of this.dedupeIndex.get(key) ?? []) {
      let record: PluginTaskRecord;
      try {
        record = this.read(taskId);
      } catch (error) {
        if ((error as { code?: string }).code !== 'PLUGIN_TASK_NOT_FOUND') throw error;
        this.forgetDedupe(taskId);
        continue;
      }
      this.indexDedupe(record);
      if (record.dedupeKey === key && (!activeOnly || isPluginTaskActive(record.task.state)))
        return record;
    }
    return undefined;
  }

  private path(taskId: string, file: string): string {
    if (!isPluginTaskId(taskId))
      throw Object.assign(new Error('Invalid plugin task ID'), { code: 'PLUGIN_TASK_INVALID_ID' });
    return join(this.directory, taskId, file);
  }

  read(taskId: string): PluginTaskRecord {
    let record: PluginTaskRecord;
    try {
      record = JSON.parse(readFileSync(this.path(taskId, 'task.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw Object.assign(new Error('Plugin task was not found'), {
          code: 'PLUGIN_TASK_NOT_FOUND',
        });
      throw error;
    }
    if (record?.task?.taskId !== taskId || !Array.isArray(record.events))
      throw new Error('Invalid persistent plugin task record');
    return record;
  }

  write(record: PluginTaskRecord): void {
    writePluginHostFile(this.path(record.task.taskId, 'task.json'), JSON.stringify(record));
    this.indexDedupe(record);
    this.indexActive(record);
  }

  private indexActive(record: PluginTaskRecord): void {
    if (isPluginTaskActive(record.task.state)) this.activeTaskIds?.add(record.task.taskId);
    else this.activeTaskIds?.delete(record.task.taskId);
  }

  /** The service owns writes; only active identities remain indexed in memory. */
  listActive(): PluginTaskRecord[] {
    if (!this.activeTaskIds) {
      this.activeTaskIds = new Set();
      for (const record of this.list()) this.indexActive(record);
    }
    const records: PluginTaskRecord[] = [];
    for (const taskId of this.activeTaskIds) {
      try {
        const record = this.read(taskId);
        this.indexActive(record);
        if (isPluginTaskActive(record.task.state)) records.push(record);
      } catch (error) {
        if ((error as { code?: string }).code !== 'PLUGIN_TASK_NOT_FOUND') throw error;
        this.activeTaskIds.delete(taskId);
      }
    }
    return records;
  }

  update(
    taskId: string,
    update: Partial<PluginTask>,
    type: PluginTaskEvent['type'] = 'state',
    fields: Pick<Partial<PluginTaskRecord>, 'checkpoint' | 'diagnostics'> = {},
  ): PluginTask {
    const record = this.read(taskId);
    Object.assign(record, fields);
    record.task = {
      ...record.task,
      ...update,
      sequence: record.task.sequence + 1,
      updatedAt: Date.now(),
    };
    const event: PluginTaskEvent = {
      sequence: record.task.sequence,
      time: record.task.updatedAt,
      type,
      state: record.task.state,
      ...(type === 'progress' ? { progress: record.task.progress } : {}),
      ...(type === 'checkpoint' ? { checkpoint: record.task.checkpoint } : {}),
    };
    record.events.push(event);
    let bytes = Buffer.byteLength(JSON.stringify(record.events));
    while (record.events.length > 256 || (bytes > MAX_EVENT_BYTES && record.events.length > 1)) {
      bytes -= Buffer.byteLength(JSON.stringify(record.events.shift())) + 1;
    }
    this.write(record);
    return record.task;
  }

  list(): PluginTaskRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return names.filter(isPluginTaskId).map(name => this.read(name));
  }

  diagnosticRecords(taskId?: string): { records: PluginTaskRecord[]; limited: boolean } {
    const records: PluginTaskRecord[] = [];
    let bytes = 0,
      scanned = 0,
      limited = false;
    if (taskId) {
      let size: number;
      try {
        size = statSync(this.path(taskId, 'task.json')).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records, limited };
        throw error;
      }
      if (size > 16 * 1024 * 1024) return { records, limited: true };
      records.push(this.read(taskId));
      bytes += size;
    }
    let directory;
    try {
      directory = opendirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records, limited };
      throw error;
    }
    try {
      let item;
      while ((item = directory.readSync()) !== null) {
        if (++scanned > 2048) {
          limited = true;
          break;
        }
        if (!isPluginTaskId(item.name) || item.name === taskId) continue;
        try {
          const size = statSync(this.path(item.name, 'task.json')).size;
          if (records.length >= 512 || bytes + size > 16 * 1024 * 1024) {
            limited = true;
            break;
          }
          bytes += size;
          records.push(this.read(item.name));
        } catch {
          limited = true;
        }
      }
    } finally {
      directory.closeSync();
    }
    return { records, limited };
  }

  events(taskId: string, cursor: number): PluginTaskEvents {
    const record = this.read(taskId);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > record.task.sequence)
      throw new Error('Invalid plugin task event cursor');
    const first = record.events[0]?.sequence ?? record.task.sequence + 1;
    const events: PluginTaskEvent[] = [];
    let bytes = 0;
    for (const event of record.events) {
      if (event.sequence <= cursor) continue;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > 192 * 1024 && events.length) break;
      events.push(event);
      bytes += size;
    }
    return {
      task: record.task,
      events,
      firstAvailableSequence: first,
      nextCursor: events.at(-1)?.sequence ?? cursor,
      gap: cursor < first - 1,
    };
  }

  saveResult(taskId: string, value: unknown): PluginTask['result'] {
    const bytes = Buffer.from(JSON.stringify({ value }));
    if (bytes.length > MAX_RESULT_BYTES)
      throw Object.assign(new Error('Plugin task result exceeds 64 MiB'), {
        code: 'PLUGIN_TASK_RESULT_TOO_LARGE',
      });
    writePluginHostFile(this.path(taskId, 'result.json'), bytes);
    return {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      chunks: Math.ceil(bytes.length / PLUGIN_TASK_RESULT_CHUNK_BYTES),
    };
  }

  resultChunk(taskId: string, index: number): PluginTaskResultChunk {
    const task = this.read(taskId).task;
    if (task.state !== 'success' || !task.result)
      throw new Error('Plugin task result is not available');
    if (!Number.isSafeInteger(index) || index < 0 || index >= task.result.chunks)
      throw new Error('Invalid plugin task result chunk');
    const file = this.path(taskId, 'result.json');
    if (statSync(file).size !== task.result.bytes)
      throw new Error('Plugin task result size does not match its record');
    const offset = index * PLUGIN_TASK_RESULT_CHUNK_BYTES;
    const buffer = Buffer.alloc(
      Math.min(PLUGIN_TASK_RESULT_CHUNK_BYTES, task.result.bytes - offset),
    );
    const descriptor = openSync(file, 'r');
    try {
      if (readSync(descriptor, buffer, 0, buffer.length, offset) !== buffer.length)
        throw new Error('Plugin task result is incomplete');
    } finally {
      closeSync(descriptor);
    }
    return { taskId, index, data: buffer.toString('base64'), ...task.result };
  }

  recover(epoch: string): void {
    this.activeTaskIds = new Set();
    for (const record of this.list()) {
      this.indexActive(record);
      const { task } = record;
      if (isPluginTaskActive(task.state) && task.host.epoch !== epoch) {
        this.update(task.taskId, {
          state: 'interrupted',
          error: {
            code: 'PLUGIN_TASK_HOST_RESTARTED',
            message:
              'The plugin execution service restarted; external operations may need reconciliation',
          },
        });
      } else if (
        !isPluginTaskActive(task.state) &&
        Date.now() - task.updatedAt > RETENTION_MS &&
        !pluginTaskExecutionUnconfirmed(record)
      ) {
        rmSync(join(this.directory, task.taskId), { recursive: true, force: true });
        this.forgetDedupe(task.taskId);
      }
    }
  }

  prune(now = Date.now()): void {
    for (const record of this.list()) {
      const { task } = record;
      if (
        !isPluginTaskActive(task.state) &&
        now - task.updatedAt > RETENTION_MS &&
        !pluginTaskExecutionUnconfirmed(record)
      ) {
        rmSync(join(this.directory, task.taskId), { recursive: true, force: true });
        this.forgetDedupe(task.taskId);
      }
    }
  }
}
