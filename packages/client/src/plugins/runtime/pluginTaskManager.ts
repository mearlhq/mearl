import { normalizeModelDiagnostic, diagnosticBinding } from './pluginDiagnostics.js';
import {
  pluginModelCapabilities,
  normalizePluginModel,
  validatePluginModelResult,
} from '../sdk/pluginModelDefinition.js';
import { pluginRecoverySignature } from '../sdk/pluginRecoveryDefinition.js';
import type { PluginModelCatalog } from './pluginModelCatalog.js';
import type { PluginStateManager } from './pluginStateManager.js';
import type { PluginPageManager } from './pluginPageManager.js';
import type { PluginStateDeclaration } from '@mearl/browser-core';
import type {
  PluginTaskCheckpoint,
  PluginTaskRecoveryContext,
  PluginTaskRecoveryDeclaration,
} from '@mearl/browser-core';
import type { PluginModelRequest } from '@mearl/browser-core';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isAbsolute, join, relative, sep } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { localPluginExecutionHost, createPluginInvocationIdentity } from './pluginExecution.js';
import { executeRegisteredPlugin } from './pluginExecutor.js';
import { serializePluginExecutionError, pluginExecutionError } from './pluginExecutorProtocol.js';
import {
  capturePluginRevision,
  prunePluginRevisions,
  restorePluginRevision,
} from './pluginRevision.js';
import { pluginHostPaths } from './pluginHostPaths.js';
import type { PluginRevision } from './pluginRevision.js';
import { PluginTaskStore, pluginTaskExecutionUnconfirmed } from './pluginTaskStore.js';
import { isPluginTaskActive } from '@mearl/browser-core';
import type { PluginTask, PluginTaskStartResult, PluginTaskListResult } from '@mearl/browser-core';
import type {
  PluginTaskScope,
  PluginTaskStartRequest,
  PluginTaskResumeRequest,
} from '../pluginTaskProtocol.js';
import type { PluginInvocationIdentity } from '@mearl/browser-core';
import type { PluginPageTarget } from '@mearl/browser-core';
import type { PluginOptions } from '../sdk/plugin.js';
import { UnifiedClient, decodeBrowserTarget } from '../../unified.js';
import { COMMAND_MAP } from '../../commands.js';
import type { PluginPageBinding } from '@mearl/browser-core';
import type { PluginPageRuntime } from '@mearl/browser-core';

export interface PluginTaskBridge {
  id: string;
  scope: PluginTaskScope;
  invoke(
    action: string,
    payload: Record<string, unknown>,
    options: PluginOptions,
  ): Promise<unknown>;
}

interface PendingTask {
  request: PluginTaskStartRequest;
  revision: PluginRevision;
  bridge: PluginTaskBridge;
  controller: AbortController;
  guard?: () => Promise<void>;
  page?: PluginPageBinding;
  recovery?: PluginTaskRecoveryContext;
  parentIdentity?: PluginInvocationIdentity;
  documentTarget?: PluginPageTarget;
}

export interface PluginTaskManagerOptions {
  store?: PluginTaskStore;
  captureRevision?: typeof capturePluginRevision;
  execute?: typeof executeRegisteredPlugin;
  workerPath?: string;
  concurrency?: number;
  modelConcurrency?: number;
}

export interface PluginTaskServices {
  state: PluginStateManager['call'];
  page: PluginPageManager['call'];
  listModels: PluginModelCatalog['list'];
  model?: (
    owner: string,
    ...args: Parameters<typeof executeRegisteredPlugin>
  ) => ReturnType<typeof executeRegisteredPlugin>;
  releaseModels?: (owner: string) => Promise<void>;
}

function error(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
function digest(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : item,
      ),
    )
    .digest('hex');
}

function revisionEntry(revision: PluginRevision): string {
  return relative(
    realpathSync(join(pluginHostPaths().revisions, revision.installationId, revision.revision)),
    realpathSync(revision.entry),
  )
    .split(sep)
    .join('/');
}

export class PluginTaskManager {
  readonly host = localPluginExecutionHost();
  readonly store: PluginTaskStore;
  private readonly changes = new EventEmitter();
  private readonly queue = new Map<string, PendingTask>();
  private readonly running = new Map<
    string,
    {
      controller: AbortController;
      completed: Promise<void>;
      kind: 'command' | 'model';
      waiting: number;
    }
  >();
  private readonly resuming = new Map<string, () => void>();
  private readonly activeChildren = new Map<string, Set<string>>();
  private closed = false;
  private readonly maintenance: ReturnType<typeof setInterval>;
  private descriptionsRunning = 0;
  private readonly descriptions = new Map<
    string,
    {
      value: {
        pageRuntime?: PluginPageRuntime;
        stateStorage?: PluginStateDeclaration;
        taskRecovery?: PluginTaskRecoveryDeclaration;
      };
      bytes: number;
    }
  >();
  private descriptionBytes = 0;
  private readonly revisionPins = new Map<string, number>();
  private readonly recoveries = new Map<
    string,
    { controller: AbortController; promise: Promise<PluginTaskStartResult>; intent: string }
  >();
  pinRevision(revision: PluginRevision): () => void {
    const key = `${revision.installationId}/${revision.revision}`;
    this.revisionPins.set(key, (this.revisionPins.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.revisionPins.get(key) ?? 0;
      if (count > 1) this.revisionPins.set(key, count - 1);
      else this.revisionPins.delete(key);
    };
  }

  async describeRevision(
    revision: PluginRevision,
    signal: AbortSignal,
    options: { cache?: boolean } = {},
  ): Promise<{
    pageRuntime?: PluginPageRuntime;
    stateStorage?: PluginStateDeclaration;
    taskRecovery?: PluginTaskRecoveryDeclaration;
  }> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('Plugin description budget is exhausted');
    const key = `${revision.installationId}/${revision.revision}`;
    const cached = options.cache ? this.descriptions.get(key) : undefined;
    if (cached) {
      this.descriptions.delete(key);
      this.descriptions.set(key, cached);
      return structuredClone(cached.value);
    }
    if (this.descriptionsRunning >= 8) throw new Error('Plugin description budget is exhausted');
    this.descriptionsRunning++;
    try {
      const value = (await (this.configuration.execute ?? executeRegisteredPlugin)(
        revision.plugin,
        { command: 'describe', input: {} },
        {
          invoke: async () => {
            throw new Error('Plugin declarations cannot invoke host actions');
          },
        },
        {
          describe: true,
          signal,
          source: 'runtime',
          executionTimeoutMs: 10000,
          workerPath: this.configuration.workerPath,
        },
        { registration: revision.registration },
      )) as {
        pageRuntime?: PluginPageRuntime;
        stateStorage?: PluginStateDeclaration;
        taskRecovery?: PluginTaskRecoveryDeclaration;
      };
      signal.throwIfAborted();
      // Page and state readers reuse revision metadata; recovery admission re-executes declarations.
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (options.cache && !this.closed && bytes <= 8 * 1024 * 1024) {
        const previous = this.descriptions.get(key);
        if (previous) {
          this.descriptions.delete(key);
          this.descriptionBytes -= previous.bytes;
        }
        while (this.descriptions.size >= 64 || this.descriptionBytes + bytes > 8 * 1024 * 1024) {
          const oldest = this.descriptions.keys().next().value!;
          this.descriptionBytes -= this.descriptions.get(oldest)!.bytes;
          this.descriptions.delete(oldest);
        }
        this.descriptions.set(key, { value: structuredClone(value), bytes });
        this.descriptionBytes += bytes;
      }
      return value;
    } finally {
      this.descriptionsRunning--;
    }
  }

  constructor(
    private readonly configuration: PluginTaskManagerOptions = {},
    private readonly services?: PluginTaskServices,
  ) {
    this.store = configuration.store ?? new PluginTaskStore();
    this.store.recover(this.host.epoch);
    this.changes.setMaxListeners(0);
    const concurrency = configuration.concurrency ?? 4;
    if (
      !Number.isInteger(configuration.modelConcurrency ?? 2) ||
      (configuration.modelConcurrency ?? 2) < 1 ||
      (configuration.modelConcurrency ?? 2) > 8
    )
      throw new Error('Invalid model concurrency');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
      throw new Error('Invalid plugin task concurrency');
    const prune = () => {
      this.store.prune();
      prunePluginRevisions(
        new Set([
          ...this.revisionPins.keys(),
          ...this.store
            .list()
            .map(record => `${record.task.installationId}/${record.task.revision}`),
        ]),
      );
    };
    prune();
    this.maintenance = setInterval(
      () => {
        try {
          prune();
        } catch (error) {
          console.error('Plugin task retention failed:', error);
        }
      },
      60 * 60 * 1000,
    );
    this.maintenance.unref();
  }

  private authorize(taskId: string, scope: PluginTaskScope): PluginTask {
    if (!taskId.startsWith(`pt_${this.host.hostId}_`))
      throw error('PLUGIN_TASK_WRONG_HOST', 'Plugin task belongs to another execution host');
    const record = this.store.read(taskId);
    if (
      (scope.plugin && record.task.plugin !== scope.plugin) ||
      (scope.access === 'toolbox' && record.access === 'public')
    )
      throw error('PLUGIN_TASK_NOT_FOUND', 'Plugin task was not found');
    return record.task;
  }

  get(taskId: string, scope: PluginTaskScope): PluginTask {
    return this.authorize(taskId, scope);
  }

  list(
    scope: PluginTaskScope,
    activeOnly = false,
    cursor?: string,
    limit = 100,
  ): PluginTaskListResult {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (cursor !== undefined && typeof cursor !== 'string')
    )
      throw new Error('Invalid plugin task list page');
    const candidates = (activeOnly ? this.store.listActive() : this.store.list())
      .filter(record => scope.access !== 'toolbox' || record.access !== 'public')
      .map(record => record.task)
      .filter(
        task =>
          (!scope.plugin || task.plugin === scope.plugin) &&
          (!activeOnly || isPluginTaskActive(task.state)),
      )
      .sort((a, b) => b.createdAt - a.createdAt || b.taskId.localeCompare(a.taskId));
    const match = cursor?.match(/^(\d+):(pt_[0-9a-f-]{36}_[0-9a-f-]{36})$/i);
    if (cursor !== undefined && (!match || !Number.isSafeInteger(Number(match[1]))))
      throw new Error('Invalid plugin task list cursor');
    const remaining = match
      ? candidates.filter(
          task =>
            task.createdAt < Number(match[1]) ||
            (task.createdAt === Number(match[1]) && task.taskId.localeCompare(match[2]) < 0),
        )
      : candidates;
    const tasks: PluginTask[] = [];
    let bytes = 0;
    for (const task of remaining) {
      const size = Buffer.byteLength(JSON.stringify(task));
      if (tasks.length && (tasks.length >= limit || bytes + size > 384 * 1024)) break;
      tasks.push(task);
      bytes += size;
    }
    const last = tasks.at(-1);
    return {
      tasks,
      ...(last && tasks.length < remaining.length
        ? { nextCursor: `${last.createdAt}:${last.taskId}` }
        : {}),
    };
  }

  start(
    request: PluginTaskStartRequest,
    bridge: PluginTaskBridge,
    binding:
      | {
          revision: PluginRevision;
          guard?: () => Promise<void>;
          page?: PluginPageBinding;
          parentTaskId?: string;
          parentIdentity?: PluginInvocationIdentity;
          documentTarget?: PluginPageTarget;
          recovery?: PluginTaskRecoveryContext;
          recoveryRequestHash?: string;
        }
      | undefined = undefined,
  ): PluginTaskStartResult {
    if (this.closed)
      throw error('PLUGIN_TASK_HOST_STOPPING', 'Plugin execution service is stopping');
    if (request.kind !== undefined && !['command', 'model'].includes(request.kind))
      throw new Error('Invalid task kind');
    if (request.kind === 'model') {
      const model = normalizePluginModel(request.input?.request);
      request = {
        ...request,
        command: 'model',
        input: { request: model },
        executionTimeoutMs: request.executionTimeoutMs ?? 120000,
      };
    }
    if (!/^[a-z][a-z0-9_-]*$/.test(request.plugin) || !/^[a-z][a-z0-9-]*$/.test(request.command))
      throw new Error('Invalid plugin task command');
    if (bridge.scope.plugin && request.plugin !== bridge.scope.plugin)
      throw error('PLUGIN_COMMAND_NOT_ALLOWED', 'Plugin task is outside the caller scope');
    if (
      !request.input ||
      typeof request.input !== 'object' ||
      Array.isArray(request.input) ||
      Buffer.byteLength(JSON.stringify(request.input)) > 256 * 1024
    )
      throw new Error('Plugin task input must be an object within 256 KiB');
    if (!isAbsolute(request.cwd) || !statSync(request.cwd).isDirectory())
      throw new Error('Plugin task cwd must be an absolute directory');
    if (
      !request.environment ||
      typeof request.environment !== 'object' ||
      Array.isArray(request.environment) ||
      Object.entries(request.environment).some(
        ([key, value]) =>
          !key ||
          key.includes('=') ||
          typeof value !== 'string' ||
          key.includes('\0') ||
          value.includes('\0'),
      ) ||
      Buffer.byteLength(JSON.stringify(request.environment)) > 512 * 1024
    )
      throw new Error('Invalid plugin task environment');
    if (
      !request.options ||
      typeof request.options !== 'object' ||
      Array.isArray(request.options) ||
      Object.keys(request.options).some(
        key =>
          !['browser', 'session', 'connector', 'local', 'transport', 'timeoutSec'].includes(key),
      )
    )
      throw new Error('Invalid plugin task routing options');
    for (const key of ['browser', 'session', 'connector'] as const)
      if (
        request.options[key] !== undefined &&
        (typeof request.options[key] !== 'string' || !request.options[key])
      )
        throw new Error('Invalid plugin task target');
    if (
      request.options.timeoutSec !== undefined &&
      (!Number.isFinite(request.options.timeoutSec) || request.options.timeoutSec <= 0)
    )
      throw new Error('Invalid plugin task invocation timeout');
    if (request.options.local !== undefined && typeof request.options.local !== 'boolean')
      throw new Error('Invalid plugin task local routing option');
    if (
      bridge.scope.bridge === 'service' &&
      request.options.browser &&
      !decodeBrowserTarget(request.options.browser)
    )
      throw error(
        'PLUGIN_TASK_TARGET_REQUIRED',
        'Background tasks require a stable global browser ID',
      );
    if (
      request.executionTimeoutMs !== undefined &&
      (!Number.isSafeInteger(request.executionTimeoutMs) ||
        request.executionTimeoutMs < 1 ||
        request.executionTimeoutMs > 2_147_483_647)
    )
      throw new Error('Invalid plugin task execution deadline');
    if (
      request.idempotencyKey !== undefined &&
      (typeof request.idempotencyKey !== 'string' ||
        !request.idempotencyKey ||
        request.idempotencyKey.length > 128)
    )
      throw new Error('Invalid plugin task idempotency key');
    const revision =
      binding?.revision ??
      (this.configuration.captureRevision ?? capturePluginRevision)(request.plugin);
    if (bridge.scope.access === 'runtime' && !binding)
      throw new Error('Runtime task requires a document binding');
    if (
      request.kind !== 'model' &&
      bridge.scope.access === 'toolbox' &&
      !revision.registration.toolbox?.page.commands.includes(request.command)
    )
      throw error('PLUGIN_COMMAND_NOT_ALLOWED', 'Tool page cannot invoke this plugin command');
    request = {
      ...request,
      cwd: realpathSync(request.cwd),
      input: JSON.parse(JSON.stringify(request.input)),
    };
    const requestHash =
      binding?.recoveryRequestHash ??
      digest([
        request.kind ?? 'command',
        request.command,
        request.input,
        request.cwd,
        request.options,
        request.executionTimeoutMs,
        revision.revision,
        binding?.recovery,
        Object.entries(request.environment).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ]);
    const dedupeKey = binding?.recovery
      ? `resume:${binding.recovery.fromTaskId}`
      : request.idempotencyKey
        ? `explicit:${revision.installationId}:${bridge.scope.access}:${request.idempotencyKey}`
        : bridge.scope.access === 'toolbox'
          ? `active:${digest(bridge.scope.scopeId ?? bridge.id)}:${revision.installationId}:${requestHash}`
          : undefined;
    if (dedupeKey) {
      const existing = this.store.findDedupe(
        dedupeKey,
        request.idempotencyKey === undefined && binding?.recovery === undefined,
      );
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw error(
            'PLUGIN_TASK_IDEMPOTENCY_CONFLICT',
            'Idempotency key refers to a different plugin task request',
          );
        return {
          taskId: existing.task.taskId,
          state: existing.task.state,
          host: existing.task.host,
          reused: true,
        };
      }
    }
    if (
      [...this.queue.values()].filter(
        item => (item.request.kind ?? 'command') === (request.kind ?? 'command'),
      ).length >= 128
    )
      throw error('PLUGIN_TASK_QUEUE_FULL', 'Plugin task queue is full');
    const now = Date.now();
    const task: PluginTask = {
      taskId: `pt_${this.host.hostId}_${randomUUID()}`,
      host: this.host,
      plugin: request.plugin,
      installationId: revision.installationId,
      revision: revision.revision,
      command: request.command,
      kind: request.kind ?? 'command',
      ...(binding?.parentTaskId ? { parentTaskId: binding.parentTaskId } : {}),
      ...(binding?.recovery
        ? {
            resumedFrom: {
              taskId: binding.recovery.fromTaskId,
              revision: binding.recovery.fromRevision,
              checkpointSequence: binding.recovery.sourceCheckpoint.sequence,
              checkpointVersion: binding.recovery.sourceCheckpoint.version,
            },
            checkpoint: {
              sequence: 0,
              version: binding.recovery.checkpoint.version,
              schemaHash: binding.recovery.checkpoint.schemaHash,
              updatedAt: now,
            },
          }
        : {}),
      input: request.input,
      source: bridge.scope.source,
      cwd: request.cwd,
      state: 'queued',
      sequence: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.write({
      task,
      events: [],
      diagnostics: {
        executorAttempted: false,
        ...(binding?.page
          ? {
              page: diagnosticBinding({
                instanceId: binding.page.instanceId,
                target: binding.page.target,
              }),
            }
          : {}),
      },
      access: bridge.scope.access,
      ...(dedupeKey ? { dedupeKey } : {}),
      requestHash,
      execution: {
        entry: revisionEntry(revision),
        options: JSON.parse(JSON.stringify(request.options)),
        bridge: bridge.scope.bridge,
        executionTimeoutMs: request.executionTimeoutMs,
      },
      ...(binding?.recovery
        ? {
            checkpoint: {
              ...structuredClone(binding.recovery.checkpoint),
              sequence: 0,
              updatedAt: now,
            },
          }
        : {}),
    });
    this.update(task.taskId, { state: 'queued' });
    if (task.parentTaskId) {
      const children = this.activeChildren.get(task.parentTaskId) ?? new Set<string>();
      children.add(task.taskId);
      this.activeChildren.set(task.parentTaskId, children);
    }
    this.queue.set(task.taskId, {
      request,
      revision,
      bridge,
      controller: new AbortController(),
      guard: binding?.guard,
      page: binding?.page,
      recovery: binding?.recovery,
      parentIdentity: binding?.parentIdentity,
      documentTarget: binding?.documentTarget,
    });
    queueMicrotask(() => this.drain());
    return { taskId: task.taskId, state: 'queued', host: this.host };
  }

  checkpoint(taskId: string, scope: PluginTaskScope): PluginTaskCheckpoint | null {
    this.authorize(taskId, scope);
    return this.store.read(taskId).checkpoint ?? null;
  }

  resume(
    request: PluginTaskResumeRequest,
    bridge: PluginTaskBridge,
  ): Promise<PluginTaskStartResult> {
    try {
      if (this.closed)
        throw error('PLUGIN_TASK_HOST_STOPPING', 'Plugin execution service is stopping');
      this.authorize(request.taskId, bridge.scope);
      if (bridge.scope.access !== 'public' || bridge.scope.bridge !== 'service')
        throw error(
          'PLUGIN_TASK_RECOVERY_UNAVAILABLE',
          'Recovery requires public service-owned routing',
        );
      if (request.revision !== undefined && !['original', 'current'].includes(request.revision))
        throw new Error('Recovery revision must be original or current');
      if (
        !request.environment ||
        typeof request.environment !== 'object' ||
        Array.isArray(request.environment) ||
        Object.entries(request.environment).some(
          ([key, value]) =>
            !key ||
            key.includes('=') ||
            typeof value !== 'string' ||
            key.includes('\0') ||
            value.includes('\0'),
        ) ||
        Buffer.byteLength(JSON.stringify(request.environment)) > 512 * 1024
      )
        throw new Error('Invalid plugin task environment');
      const intent = digest([request.revision ?? 'original', request.environment]);
      const existing = this.recoveries.get(request.taskId);
      if (existing) {
        if (existing.intent !== intent)
          throw error(
            'PLUGIN_TASK_IDEMPOTENCY_CONFLICT',
            'A different recovery request is already in progress',
          );
        return existing.promise.then(result => ({ ...result, reused: true }));
      }
      const controller = new AbortController();
      const operation = {
        controller,
        intent,
        promise: this.resumeAttempt(request, bridge, controller.signal),
      };
      this.recoveries.set(request.taskId, operation);
      void operation.promise.finally(() => this.recoveries.delete(request.taskId)).catch(() => {});
      return operation.promise;
    } catch (cause) {
      return Promise.reject(cause);
    }
  }

  private async resumeAttempt(
    request: PluginTaskResumeRequest,
    bridge: PluginTaskBridge,
    signal: AbortSignal,
  ): Promise<PluginTaskStartResult> {
    const task = this.authorize(request.taskId, bridge.scope);
    const record = this.store.read(task.taskId);
    if (
      !['error', 'cancelled', 'interrupted'].includes(task.state) ||
      task.kind === 'model' ||
      task.parentTaskId ||
      record.access !== 'public' ||
      record.execution?.bridge !== 'service' ||
      !record.checkpoint
    )
      throw error(
        'PLUGIN_TASK_RECOVERY_UNAVAILABLE',
        'Recovery requires a terminal root command with a checkpoint and service-owned routing',
      );
    this.assertExecutionTreeStopped(task.taskId);
    const source = restorePluginRevision(
      task.plugin,
      task.installationId,
      task.revision,
      record.execution.entry,
    );
    const revision =
      request.revision === 'current'
        ? (this.configuration.captureRevision ?? capturePluginRevision)(task.plugin)
        : source;
    if (revision.installationId !== task.installationId)
      throw error(
        'PLUGIN_TASK_INSTALLATION_CHANGED',
        'Recovery cannot change the plugin installation',
      );
    restorePluginRevision(
      task.plugin,
      task.installationId,
      revision.revision,
      revisionEntry(revision),
    );
    const releaseSource = this.pinRevision(source),
      releaseTarget = this.pinRevision(revision);
    try {
      const requestHash = digest([
        request.revision ?? 'original',
        task,
        record.checkpoint,
        record.execution,
        revision.revision,
        request.environment,
      ]);
      const existing = this.store.findDedupe(`resume:${task.taskId}`);
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw error(
            'PLUGIN_TASK_IDEMPOTENCY_CONFLICT',
            'Source task already has a different recovery attempt',
          );
        return {
          taskId: existing.task.taskId,
          state: existing.task.state,
          host: existing.task.host,
          reused: true,
        };
      }
      const sourceCommands = (await this.describeRevision(source, signal)).taskRecovery?.commands;
      const sourceDefinition =
        sourceCommands && Object.hasOwn(sourceCommands, task.command)
          ? sourceCommands[task.command]
          : undefined;
      signal.throwIfAborted();
      if (
        !sourceDefinition ||
        sourceDefinition.checkpointVersion !== record.checkpoint.version ||
        digest(sourceDefinition.schema) !== record.checkpoint.schemaHash
      )
        throw error(
          'PLUGIN_TASK_RECOVERY_UNAVAILABLE',
          'Checkpoint does not match the retained recovery declaration',
        );
      let checkpoint = structuredClone(record.checkpoint);
      let declarationHash = pluginRecoverySignature(sourceDefinition);
      if (revision.revision !== source.revision) {
        const targetCommands = (await this.describeRevision(revision, signal)).taskRecovery
          ?.commands;
        const target =
          targetCommands && Object.hasOwn(targetCommands, task.command)
            ? targetCommands[task.command]
            : undefined;
        signal.throwIfAborted();
        if (!target)
          throw error(
            'PLUGIN_TASK_RECOVERY_UNAVAILABLE',
            'Target revision does not declare recovery for the original command',
          );
        declarationHash = pluginRecoverySignature(target);
        if (target.checkpointVersion === checkpoint.version) {
          if (digest(target.schema) !== digest(sourceDefinition.schema))
            throw error(
              'PLUGIN_CHECKPOINT_MIGRATION_UNSUPPORTED',
              'Checkpoint schema changed without a version increment',
            );
        } else {
          if (
            !target.migrateFrom?.some(
              from =>
                from.version === checkpoint.version &&
                digest(from.schema) === digest(sourceDefinition.schema),
            )
          )
            throw error(
              'PLUGIN_CHECKPOINT_MIGRATION_UNSUPPORTED',
              'Target revision does not declare this checkpoint format',
            );
          if (this.descriptionsRunning >= 8)
            throw error(
              'PLUGIN_CHECKPOINT_MIGRATION_BUSY',
              'Checkpoint migration budget is exhausted',
            );
          this.descriptionsRunning++;
          let result: unknown;
          try {
            result = await (this.configuration.execute ?? executeRegisteredPlugin)(
              revision.plugin,
              {
                command: task.command,
                input: { checkpoint, fromRevision: source.revision, toRevision: revision.revision },
              },
              {
                invoke: async () => {
                  throw error(
                    'PLUGIN_CHECKPOINT_MIGRATION_HOST_CALL',
                    'Checkpoint migration cannot invoke host actions',
                  );
                },
              },
              {
                migration: true,
                expectedRecovery: declarationHash,
                signal,
                source: 'runtime',
                cwd: task.cwd,
                environment: request.environment,
                executionTimeoutMs: 10000,
                workerPath: this.configuration.workerPath,
              },
              { registration: revision.registration },
            );
          } finally {
            this.descriptionsRunning--;
          }
          signal.throwIfAborted();
          const json = JSON.stringify(result);
          if (json === undefined || Buffer.byteLength(json) > 64 * 1024)
            throw error(
              'PLUGIN_TASK_CHECKPOINT_INVALID',
              'Migrated checkpoint must be JSON within 64 KiB',
            );
          checkpoint = {
            ...checkpoint,
            version: target.checkpointVersion,
            schemaHash: digest(target.schema),
            data: JSON.parse(json),
          };
        }
      }
      signal.throwIfAborted();
      // Admission is synchronous after both immutable snapshots and execution ownership are verified.
      restorePluginRevision(
        task.plugin,
        task.installationId,
        task.revision,
        record.execution.entry,
      );
      restorePluginRevision(
        task.plugin,
        task.installationId,
        revision.revision,
        revisionEntry(revision),
      );
      this.assertExecutionTreeStopped(task.taskId);
      return this.start(
        {
          plugin: task.plugin,
          command: task.command,
          input: task.input,
          cwd: task.cwd,
          environment: request.environment,
          options: record.execution.options,
          executionTimeoutMs: record.execution.executionTimeoutMs,
        },
        bridge,
        {
          revision,
          recoveryRequestHash: requestHash,
          recovery: {
            fromTaskId: task.taskId,
            fromRevision: source.revision,
            declarationHash,
            sourceCheckpoint: {
              sequence: record.checkpoint.sequence,
              version: record.checkpoint.version,
              schemaHash: record.checkpoint.schemaHash,
              updatedAt: record.checkpoint.updatedAt,
            },
            checkpoint,
          },
        },
      );
    } finally {
      releaseTarget();
      releaseSource();
    }
  }

  private assertExecutionTreeStopped(taskId: string): void {
    const records = this.store.list();
    const visited = new Set<string>();
    const pending = [taskId];
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const record = records.find(record => record.task.taskId === id);
      if (!record)
        throw error(
          'PLUGIN_TASK_EXECUTION_STILL_ACTIVE',
          'Previous execution ownership record is unavailable',
        );
      pending.push(
        ...records
          .filter(record => record.task.parentTaskId === id)
          .map(record => record.task.taskId),
      );
      if (isPluginTaskActive(record.task.state) || pluginTaskExecutionUnconfirmed(record))
        throw error(
          'PLUGIN_TASK_EXECUTION_STILL_ACTIVE',
          'Previous execution or descendant cleanup cannot be confirmed',
        );
    }
  }

  cancel(taskId: string, scope: PluginTaskScope): PluginTask {
    const task = this.authorize(taskId, scope);
    if (task.state === 'queued') {
      this.queue.delete(taskId);
      return this.update(taskId, {
        state: 'cancelled',
        error: {
          code: 'PLUGIN_EXECUTION_CANCELLED',
          message: 'Plugin task cancelled before execution',
        },
      });
    }
    if (task.state === 'running') {
      const updated = this.update(taskId, { state: 'cancelling' });
      this.running.get(taskId)?.controller.abort();
      return updated;
    }
    return task;
  }

  async events(
    taskId: string,
    scope: PluginTaskScope,
    cursor: number,
    waitMs = 0,
    signal?: AbortSignal,
  ) {
    const task = this.authorize(taskId, scope);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 25000)
      throw new Error('Invalid plugin task event wait');
    const current = this.store.events(taskId, cursor);
    if (waitMs && cursor === task.sequence && isPluginTaskActive(task.state)) {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal?.reason ?? new Error('Plugin task subscription closed'));
        };
        const timer = setTimeout(finish, waitMs);
        const cleanup = () => {
          clearTimeout(timer);
          this.changes.off(taskId, finish);
          signal?.removeEventListener('abort', abort);
        };
        this.changes.once(taskId, finish);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else if (this.store.read(taskId).task.sequence !== cursor) finish();
      });
      return this.store.events(taskId, cursor);
    }
    return current;
  }

  resultChunk(taskId: string, scope: PluginTaskScope, index: number) {
    this.authorize(taskId, scope);
    return this.store.resultChunk(taskId, index);
  }

  private update(
    taskId: string,
    update: Partial<PluginTask>,
    type: 'state' | 'progress' = 'state',
  ) {
    const task = this.store.update(taskId, update, type);
    if (!isPluginTaskActive(task.state) && task.parentTaskId) {
      const children = this.activeChildren.get(task.parentTaskId);
      children?.delete(taskId);
      if (!children?.size) this.activeChildren.delete(task.parentTaskId);
    }
    this.changes.emit(taskId);
    return task;
  }

  private drain(): void {
    if (this.closed) return;
    for (const [taskId, resume] of this.resuming) {
      const parent = this.running.get(taskId);
      if (!parent) {
        this.resuming.delete(taskId);
        resume();
        continue;
      }
      const limit =
        parent.kind === 'model'
          ? (this.configuration.modelConcurrency ?? 2)
          : (this.configuration.concurrency ?? 4);
      if (
        [...this.running.values()].filter(item => item.kind === parent.kind && !item.waiting)
          .length < limit
      ) {
        this.resuming.delete(taskId);
        resume();
      }
    }
    for (const [taskId, pending] of this.queue) {
      const kind = pending.request.kind ?? 'command';
      const limit =
        kind === 'model'
          ? (this.configuration.modelConcurrency ?? 2)
          : (this.configuration.concurrency ?? 4);
      if (
        [...this.running.values()].filter(item => item.kind === kind && !item.waiting).length >=
        limit
      )
        continue;
      this.queue.delete(taskId);
      this.update(taskId, { state: 'running' });
      const completed = this.execute(taskId, pending).finally(() => {
        this.running.delete(taskId);
        this.drain();
      });
      this.running.set(taskId, { controller: pending.controller, completed, kind, waiting: 0 });
    }
  }

  private async execute(
    taskId: string,
    {
      request,
      revision,
      bridge,
      controller,
      guard,
      page,
      recovery,
      parentIdentity,
      documentTarget,
    }: PendingTask,
  ): Promise<void> {
    const client = bridge.scope.bridge === 'service' ? new UnifiedClient() : undefined;
    try {
      await guard?.();
      const identity = Object.freeze({
        ...createPluginInvocationIdentity(request.plugin, bridge.scope.source, parentIdentity),
        taskId,
        installationId: revision.installationId,
        revision: revision.revision,
        ...(page ? { page } : {}),
        ...(recovery ? { recovery } : {}),
      });
      {
        const record = this.store.read(taskId);
        record.diagnostics = {
          ...record.diagnostics,
          invocationId: identity.invocationId,
          executorAttempted: true,
        };
        this.store.write(record);
      }
      const restrictedTarget = page?.target ?? documentTarget;
      let diagnosticUpdates = 0;
      let recoveryDescription:
        Promise<Awaited<ReturnType<PluginTaskManager['describeRevision']>>> | undefined;
      const modelOwner = page?.instanceId ?? parentIdentity?.taskId;
      const conversation =
        request.kind === 'model' &&
        (request.input.request as unknown as PluginModelRequest).conversation;
      if (conversation && !modelOwner)
        throw error(
          'PLUGIN_MODEL_CONVERSATION_SCOPE',
          'Model conversations require a bound document or calling command',
        );
      const execute =
        this.configuration.execute ??
        (conversation && this.services?.model
          ? this.services.model.bind(this.services, modelOwner!)
          : executeRegisteredPlugin);
      let result = await execute(
        request.plugin,
        { command: request.command, input: request.input },
        {
          invocation: identity,
          source: bridge.scope.source,
          invoke: async (action, payload = {}, options = {}, onProgress) => {
            controller.signal.throwIfAborted();
            await guard?.();
            controller.signal.throwIfAborted();
            if (action === 'plugin_invoke_child') {
              const name = payload.plugin;
              const invocation = payload.invocation;
              if (
                typeof name !== 'string' ||
                !invocation ||
                typeof invocation.command !== 'string' ||
                !invocation.input ||
                typeof invocation.input !== 'object' ||
                Array.isArray(invocation.input)
              )
                throw new Error('Invalid nested plugin invocation');
              this.assertRouting(options, request.options);
              let ancestor: string | undefined = taskId,
                depth = 0;
              while (ancestor) {
                const task: PluginTask = this.store.read(ancestor).task;
                if (task.plugin === name)
                  throw error('PLUGIN_INVOCATION_CYCLE', 'Plugin invocation forms a cycle');
                if (++depth >= 16)
                  throw error('PLUGIN_INVOCATION_DEPTH', 'Plugin invocation depth exceeds 16');
                ancestor = task.parentTaskId;
              }
              this.assertChildBudget(taskId);
              const childRevision = (this.configuration.captureRevision ?? capturePluginRevision)(
                name,
              );
              const childBridge = {
                ...bridge,
                scope: { ...bridge.scope, access: 'public' as const, plugin: name },
              };
              const child = this.start(
                {
                  ...request,
                  plugin: name,
                  kind: 'command',
                  command: invocation.command,
                  input: invocation.input,
                  options: { ...request.options, ...options },
                  idempotencyKey: undefined,
                },
                childBridge,
                {
                  revision: childRevision,
                  guard,
                  parentTaskId: taskId,
                  parentIdentity: identity,
                  documentTarget: restrictedTarget,
                },
              );
              return this.awaitChild(taskId, child.taskId, childBridge.scope, controller.signal);
            }
            // Plugin-owned services need the installation, revision and page guard held by this task.
            if (
              ['plugin_state', 'plugin_model', 'plugin_page', 'plugin_task_checkpoint'].includes(
                action,
              ) &&
              payload.plugin !== request.plugin
            )
              throw error(
                'PLUGIN_CALLER_SCOPE_MISMATCH',
                'Plugin-owned services require the executing plugin identity',
              );
            if (action === 'plugin_task_checkpoint') {
              if (
                request.kind === 'model' ||
                page ||
                bridge.scope.access !== 'public' ||
                bridge.scope.bridge !== 'service'
              )
                throw error(
                  'PLUGIN_TASK_RECOVERY_UNAVAILABLE',
                  'Checkpoints require a command with service-owned routing',
                );
              const json = JSON.stringify(payload.data);
              if (
                !Number.isSafeInteger(payload.expectedSequence) ||
                payload.expectedSequence < 0 ||
                json === undefined ||
                Buffer.byteLength(json) > 64 * 1024
              )
                throw new Error('Checkpoint must have a CAS sequence and fit within 64 KiB');
              const data = JSON.parse(json);
              const commands = (
                await (recoveryDescription ??= this.describeRevision(revision, controller.signal))
              ).taskRecovery?.commands;
              const declaration =
                commands && Object.hasOwn(commands, request.command)
                  ? commands[request.command]
                  : undefined;
              controller.signal.throwIfAborted();
              if (
                declaration &&
                payload.expectedDeclaration !== pluginRecoverySignature(declaration)
              )
                throw error(
                  'PLUGIN_RECOVERY_DECLARATION_CHANGED',
                  'Checkpoint declaration differs from the executing command',
                );
              if (!declaration)
                throw error('PLUGIN_TASK_CHECKPOINT_INVALID', 'Checkpoint is undeclared');
              const current = this.store.read(taskId);
              if (
                current.task.state !== 'running' ||
                payload.expectedSequence !== (current.checkpoint?.sequence ?? 0)
              )
                throw error(
                  'PLUGIN_TASK_CHECKPOINT_CONFLICT',
                  'Checkpoint sequence or execution state changed',
                );
              const checkpoint = {
                data,
                version: declaration.checkpointVersion,
                schemaHash: digest(declaration.schema),
                sequence: payload.expectedSequence + 1,
                updatedAt: Date.now(),
              };
              this.store.update(
                taskId,
                {
                  checkpoint: {
                    sequence: checkpoint.sequence,
                    version: checkpoint.version,
                    schemaHash: checkpoint.schemaHash,
                    updatedAt: checkpoint.updatedAt,
                  },
                },
                'checkpoint',
                { checkpoint },
              );
              this.changes.emit(taskId);
              return checkpoint;
            }
            if (action === 'plugin_state') {
              if (
                page &&
                payload.instanceId !== undefined &&
                payload.instanceId !== page.instanceId
              )
                throw error(
                  'PLUGIN_PAGE_TARGET_CHANGED',
                  'State access cannot change the bound page',
                );
              if (!this.services) throw new Error('Plugin host services are unavailable');
              return this.services.state(
                request.plugin,
                { ...payload, ...(page ? { instanceId: page.instanceId } : {}) },
                bridge,
                request.options,
                { revision, signal: controller.signal, expectedTarget: restrictedTarget },
              );
            }
            if (action === 'plugin_model') {
              if (payload.operation === 'capabilities') return pluginModelCapabilities();
              if (payload.operation === 'list') {
                if (!this.services) throw new Error('Plugin host services are unavailable');
                return this.services.listModels(payload.provider);
              }
              if (payload.operation !== 'run')
                throw new Error(
                  'Plugin commands use model.run; detached model tasks require an explicit task entry',
                );
              this.assertChildBudget(taskId);
              const model = normalizePluginModel(payload.request);
              const started = this.start(
                {
                  ...request,
                  kind: 'model',
                  command: 'model',
                  input: { request: model },
                  idempotencyKey: undefined,
                },
                bridge,
                {
                  revision,
                  guard,
                  page,
                  parentTaskId: taskId,
                  parentIdentity: identity,
                  documentTarget: restrictedTarget,
                },
              );
              return this.awaitChild(
                taskId,
                started.taskId,
                bridge.scope,
                controller.signal,
                onProgress,
              );
            }
            if (action === 'plugin_page') {
              if (!this.services) throw new Error('Plugin host services are unavailable');
              if (
                page &&
                !(payload.operation === 'activation' && payload.enabled === undefined) &&
                (!['send', 'get', 'events'].includes(String(payload.operation)) ||
                  payload.instanceId !== page.instanceId)
              )
                throw error(
                  'PLUGIN_PAGE_TARGET_CHANGED',
                  'Runtime tasks can only access their bound document',
                );
              return this.services.page(request.plugin, payload, bridge, request.options, {
                cwd: request.cwd,
                environment: request.environment,
                signal: controller.signal,
                revision,
                expectedTarget: restrictedTarget,
                parentIdentity: identity,
              });
            }
            if (
              restrictedTarget &&
              !['send_request', 'browser_list', 'connector_list'].includes(action)
            )
              throw error(
                'PLUGIN_PAGE_TARGET_CHANGED',
                'Runtime tasks must access the document through context.page',
              );
            this.assertRouting(options, request.options);
            if (client) {
              if (
                COMMAND_MAP.has(action) &&
                !['browser_list', 'connector_list', 'agent_chat_run'].includes(action) &&
                !request.options.browser
              )
                throw error(
                  'PLUGIN_TASK_TARGET_REQUIRED',
                  'Background browser tasks require an explicit browser target',
                );
              return client.invoke(action, payload, { ...request.options, ...options });
            }
            return bridge.invoke(action, payload, { ...request.options, ...options });
          },
        },
        {
          ...(request.kind === 'model'
            ? { model: request.input.request as unknown as PluginModelRequest }
            : {}),
          recovery: recovery !== undefined,
          onDiagnostic: metadata => {
            const record = this.store.read(taskId);
            if (++diagnosticUpdates > 64) {
              if (!record.diagnostics?.updatesDropped) {
                record.diagnostics = { ...record.diagnostics, updatesDropped: true };
                this.store.write(record);
              }
              return;
            }
            const model = normalizeModelDiagnostic(metadata, record.diagnostics?.model);
            if (JSON.stringify(model) === JSON.stringify(record.diagnostics?.model)) return;
            this.store.update(taskId, {}, 'diagnostic', {
              diagnostics: { ...record.diagnostics, model },
            });
            this.changes.emit(taskId);
          },
          onExecutorStopped: () => {
            const record = this.store.read(taskId);
            record.diagnostics = { ...record.diagnostics, executorStoppedAt: Date.now() };
            this.store.write(record);
          },
          onExecutorStarted: owner => {
            const record = this.store.read(taskId);
            record.executorOwner = owner;
            this.store.write(record);
          },
          ...request.options,
          cwd: request.cwd,
          environment: request.environment,
          signal: controller.signal,
          source: bridge.scope.source,
          access: bridge.scope.access,
          executionTimeoutMs: request.executionTimeoutMs,
          workerPath: this.configuration.workerPath,
          onProgress: progress => {
            if (Buffer.byteLength(JSON.stringify(progress)) > 64 * 1024)
              throw new Error('Plugin task progress exceeds 64 KiB');
            this.update(taskId, { progress }, 'progress');
          },
        },
        { registration: revision.registration },
      );
      await guard?.();
      if (request.kind === 'model')
        result = validatePluginModelResult(
          request.input.request as unknown as PluginModelRequest,
          result,
        );
      await this.stopChildren(taskId);
      if (!page && request.kind !== 'model') await this.services?.releaseModels?.(taskId);
      const reference = this.store.saveResult(taskId, result);
      this.update(taskId, { state: 'success', result: reference });
    } catch (cause) {
      await this.stopChildren(taskId);
      let failureCause = cause;
      if (!page && request.kind !== 'model') {
        try {
          await this.services?.releaseModels?.(taskId);
        } catch (cleanupError) {
          failureCause = cleanupError;
        }
      }
      const failure = serializePluginExecutionError(failureCause);
      const interrupted = this.closed || failure.code === 'PLUGIN_TASK_BRIDGE_UNAVAILABLE';
      this.update(taskId, {
        state: interrupted
          ? 'interrupted'
          : failure.code === 'PLUGIN_EXECUTION_CANCELLED'
            ? 'cancelled'
            : 'error',
        error: failure,
      });
    } finally {
      client?.disconnect();
    }
  }

  private assertRouting(options: PluginOptions, bound: PluginOptions): void {
    if (
      Object.keys(options).some(
        key => !['browser', 'connector', 'session', 'local', 'timeoutSec'].includes(key),
      )
    )
      throw error(
        'PLUGIN_TASK_TARGET_CHANGED',
        'Plugin task cannot override internal routing options',
      );
    for (const key of ['browser', 'connector', 'session', 'local'] as const)
      if (options[key] !== undefined && options[key] !== bound[key])
        throw error(
          'PLUGIN_TASK_TARGET_CHANGED',
          'Plugin task cannot change its bound browser routing',
        );
  }

  assertChildBudget(parent: string): void {
    if (
      !this.running.get(parent)?.waiting &&
      [...this.running.values()].filter(item => item.waiting).length >= 32
    )
      throw error('PLUGIN_TASK_NESTING_BUDGET', 'Too many suspended plugin invocations');
  }

  async awaitChild(
    parent: string,
    child: string,
    scope: PluginTaskScope,
    signal: AbortSignal,
    onProgress?: (progress: NonNullable<PluginTask['progress']>) => void,
  ): Promise<unknown> {
    const running = this.running.get(parent);
    if (running) running.waiting++;
    queueMicrotask(() => this.drain());
    const cancel = () => this.cancel(child, scope);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      return await this.waitResult(child, scope, progress => {
        if (progress !== undefined && !signal.aborted) onProgress?.(progress);
        if (isPluginTaskActive(this.store.read(parent).task.state))
          this.update(parent, { progress }, 'progress');
      });
    } finally {
      signal.removeEventListener('abort', cancel);
      if (running?.waiting === 1 && !signal.aborted && !this.closed) {
        await new Promise<void>(resolve => {
          const resume = () => {
            this.resuming.delete(parent);
            signal.removeEventListener('abort', resume);
            running.waiting--;
            resolve();
          };
          this.resuming.set(parent, resume);
          signal.addEventListener('abort', resume, { once: true });
          this.drain();
        });
      } else if (running) running.waiting--;
    }
  }

  private async stopChildren(taskId: string): Promise<void> {
    const children = [...(this.activeChildren.get(taskId) ?? [])];
    for (const child of children)
      this.cancel(child, { access: 'public', source: 'runtime', bridge: 'service' });
    await Promise.allSettled(children.map(child => this.running.get(child)?.completed));
  }

  private async waitResult(
    taskId: string,
    scope: PluginTaskScope,
    onProgress?: (progress: PluginTask['progress']) => void,
  ): Promise<unknown> {
    let cursor = 0;
    while (true) {
      const page = await this.events(taskId, scope, cursor, 25000);
      cursor = page.nextCursor;
      for (const event of page.events) if (event.type === 'progress') onProgress?.(event.progress);
      if (page.task.state === 'success') {
        const chunks = [];
        for (let index = 0; index < page.task.result!.chunks; index++)
          chunks.push(Buffer.from(this.resultChunk(taskId, scope, index).data, 'base64'));
        const bytes = Buffer.concat(chunks);
        if (
          bytes.length !== page.task.result!.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== page.task.result!.sha256
        )
          throw new Error('Model task result integrity check failed');
        return JSON.parse(bytes.toString('utf8')).value;
      }
      if (!isPluginTaskActive(page.task.state))
        throw Object.assign(
          pluginExecutionError(page.task.error ?? { message: 'Model task failed' }),
          { childTaskId: taskId },
        );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.descriptions.clear();
    this.descriptionBytes = 0;
    for (const resume of [...this.resuming.values()]) resume();
    for (const operation of this.recoveries.values()) operation.controller.abort();
    clearInterval(this.maintenance);
    await Promise.allSettled([...this.recoveries.values()].map(operation => operation.promise));
    for (const taskId of this.queue.keys())
      this.update(taskId, {
        state: 'interrupted',
        error: { code: 'PLUGIN_TASK_HOST_STOPPED', message: 'Plugin execution service stopped' },
      });
    this.queue.clear();
    for (const { controller } of this.running.values()) controller.abort();
    await Promise.allSettled([...[...this.running.values()].map(item => item.completed)]);
  }
}
