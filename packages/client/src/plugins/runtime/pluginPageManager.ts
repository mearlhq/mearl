import type { PluginDiagnosticPage } from '@mearl/browser-core';
import type { PluginStateManager } from './pluginStateManager.js';
import type { PluginInvocationIdentity } from '@mearl/browser-core';
import { diagnosticBinding } from './pluginDiagnostics.js';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyedDir } from '@mearl/daemon-core';
import { capturePluginRevision } from './pluginRevision.js';
import type { PluginRevision } from './pluginRevision.js';
import { findPluginRegistration } from '../sdk/plugin.js';
import type { PluginOptions } from '../sdk/plugin.js';
import { UnifiedClient, decodeBrowserTarget } from '../../unified.js';
import { pluginHostPaths } from './pluginHostPaths.js';
import { serializePluginExecutionError, pluginExecutionError } from './pluginExecutorProtocol.js';
import { isPluginTaskActive } from '@mearl/browser-core';
import {
  isPluginPageInstanceId,
  matchesPluginPageURL,
  isPluginPageInvalidation,
  isPluginPageUnavailable,
  pluginPageUnavailable,
  PLUGIN_PAGE_LEASE_MS,
} from '@mearl/browser-core';
import type {
  PluginPageInstance,
  PluginPageRuntime,
  PluginPageEvent,
  PluginPageEvents,
  PluginPageTarget,
} from '@mearl/browser-core';
import type { PluginTaskBridge, PluginTaskManager } from './pluginTaskManager.js';

interface Delivery {
  sequence: number;
  name: string;
  payload: unknown;
  taskId?: string;
  state: string;
}
interface Execution {
  cwd: string;
  environment: Record<string, string>;
  signal?: AbortSignal;
  revision?: PluginRevision;
  expectedTarget?: PluginPageTarget;
  parentIdentity?: PluginInvocationIdentity;
}
interface Instance {
  value: PluginPageInstance;
  runtime: PluginPageRuntime;
  revision: PluginRevision;
  bridge: PluginTaskBridge;
  options: PluginOptions;
  client?: UnifiedClient;
  release(): void;
  history: PluginPageEvent[];
  deliveries: Delivery[];
  lastReceived: number;
  running: Set<Delivery>;
  ready: boolean;
  lastVerifiedAt: number;
  unavailable: boolean;
  initialized: Promise<void>;
  taskIds: Set<string>;
  execution: { cwd: string; environment: Record<string, string> };
}
function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
function sameTarget(a: PluginPageTarget, b: PluginPageTarget): boolean {
  return (
    a.browserSessionId === b.browserSessionId &&
    a.tabId === b.tabId &&
    a.frameId === b.frameId &&
    a.documentId === b.documentId
  );
}

/** The browser owns document identity; this service owns revisions and event execution. */
export class PluginPageManager {
  private readonly instances = new Map<string, Instance>();
  private readonly changes = new EventEmitter().setMaxListeners(0);
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly reconciling = new Set<string>();
  private closed = false;
  private readonly describing = new Set<{
    controller: AbortController;
    promise: Promise<unknown>;
  }>();

  constructor(
    private readonly tasks: PluginTaskManager,
    private readonly states: PluginStateManager,
    private readonly releaseModels?: (owner: string) => Promise<void>,
  ) {
    this.heartbeat = setInterval(() => {
      void this.reconcile();
    }, 10000);
    this.heartbeat.unref();
  }

  async resolveStateTarget(
    plugin: string,
    instanceId: unknown,
    bridge: PluginTaskBridge,
    options: PluginOptions,
  ) {
    const record = this.own(plugin, instanceId, bridge);
    await this.bind(record, bridge, options);
    await this.validate(record);
    return {
      target: { ...record.value.target },
      assertActive: () => {
        if (
          this.closed ||
          record.value.state !== 'active' ||
          this.instances.get(record.value.instanceId) !== record
        )
          throw failure('PLUGIN_STATE_SCOPE_ENDED', 'Plugin page state scope has ended');
      },
    };
  }

  diagnosticSnapshot(): PluginDiagnosticPage[] {
    return [...this.instances.values()].map(record => ({
      plugin: record.value.plugin,
      installationId: record.value.installationId,
      revision: record.value.revision,
      host: { hostId: record.value.host.hostId, epoch: record.value.host.epoch },
      binding: diagnosticBinding(record.value),
      observation: 'service-snapshot',
      state: record.value.state,
      lastReceived: record.lastReceived,
      queued: record.deliveries.filter(delivery => delivery.state === 'queued').length,
      running: record.running.size,
    }));
  }

  private async reconcile(): Promise<void> {
    if (this.closed) return;
    await Promise.all(
      [...this.instances.values()].map(async record => {
        const id = record.value.instanceId;
        if (!record.ready || record.value.state !== 'active' || this.reconciling.has(id)) return;
        this.reconciling.add(id);
        try {
          await this.validate(record);
        } catch (error) {
          if (!isPluginPageUnavailable(error)) await this.invalidate(record, error);
        } finally {
          this.reconciling.delete(id);
        }
      }),
    );
  }

  private bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(failure('PLUGIN_PAGE_TIMEOUT', 'Plugin page browser request timed out')),
        milliseconds,
      );
      promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  private async invoke(
    record: Instance,
    data: Record<string, unknown>,
    timeoutSec?: number,
  ): Promise<any> {
    const payload = {
      ...data,
      tabId: record.value.target.tabId,
      instanceId: record.value.instanceId,
      ...(timeoutSec !== undefined ? { timeoutSec } : {}),
    };
    return record.client
      ? record.client.invoke('page_runtime', payload, {
          ...record.options,
          ...(timeoutSec !== undefined ? { timeoutSec } : {}),
        })
      : record.bridge.invoke('page_runtime', payload, {
          ...record.options,
          ...(timeoutSec !== undefined ? { timeoutSec } : {}),
        });
  }

  private unavailable(record: Instance, error: unknown): unknown {
    if (isPluginPageInvalidation(error)) return error;
    record.unavailable = true;
    if (Date.now() - record.lastVerifiedAt >= PLUGIN_PAGE_LEASE_MS)
      return failure('PLUGIN_PAGE_INVALIDATED', 'Plugin page host recovery lease expired');
    return pluginPageUnavailable(error);
  }

  private async validate(record: Instance): Promise<void> {
    if (this.closed || record.value.state !== 'active')
      throw failure('PLUGIN_PAGE_INVALIDATED', 'Plugin page instance is no longer active');
    const registration = findPluginRegistration(record.value.plugin);
    let installation: { installationId?: string } | undefined;
    try {
      installation = JSON.parse(
        readFileSync(join(pluginHostPaths().installations, `${record.value.plugin}.json`), 'utf8'),
      );
    } catch {
      /* A removed installation invalidates its instances. */
    }
    if (!registration || installation?.installationId !== record.value.installationId)
      throw failure('PLUGIN_PAGE_INVALIDATED', 'Plugin installation was removed or replaced');
    const bridge = record.bridge;
    let current: any;
    try {
      current = await this.bounded(this.invoke(record, { operation: 'get' }), 8000);
    } catch (error) {
      if (
        !record.client &&
        record.bridge !== bridge &&
        !this.closed &&
        record.value.state === 'active'
      )
        return this.validate(record);
      throw this.unavailable(record, error);
    }
    if (this.closed || record.value.state !== 'active')
      throw failure('PLUGIN_PAGE_INVALIDATED', 'Plugin page instance ended during validation');
    if (
      current.state !== 'active' ||
      !sameTarget(current.target, record.value.target) ||
      !matchesPluginPageURL(record.runtime.matches, current.target.url)
    )
      throw failure('PLUGIN_PAGE_INVALIDATED', 'Plugin page document changed');
    record.value.target.url = current.target.url;
    record.lastVerifiedAt = Date.now();
    const recovered = record.unavailable;
    record.unavailable = false;
    if (recovered) queueMicrotask(() => this.drain(record));
  }

  private own(plugin: string, instanceId: unknown, bridge: PluginTaskBridge): Instance {
    if (bridge.scope.plugin && bridge.scope.plugin !== plugin)
      throw failure('PLUGIN_PAGE_NOT_FOUND', 'Plugin page instance was not found');
    if (!isPluginPageInstanceId(instanceId))
      throw failure('PLUGIN_PAGE_NOT_FOUND', 'Invalid plugin page instance ID');
    const record = this.instances.get(instanceId);
    if (!record || record.value.plugin !== plugin)
      throw failure('PLUGIN_PAGE_NOT_FOUND', 'Plugin page instance was not found');
    return record;
  }

  private async bind(
    record: Instance,
    bridge: PluginTaskBridge,
    options: PluginOptions,
  ): Promise<void> {
    if (
      bridge.scope.bridge !== 'caller' ||
      (!record.client && record.bridge.id === bridge.id) ||
      record.value.state !== 'active'
    )
      return;
    let current: any;
    try {
      current = await this.bounded(
        bridge.invoke(
          'page_runtime',
          {
            operation: 'get',
            tabId: record.value.target.tabId,
            instanceId: record.value.instanceId,
          },
          options,
        ),
        8000,
      );
    } catch (error) {
      throw this.unavailable(record, error);
    }
    if (this.closed || record.value.state !== 'active')
      throw failure('PLUGIN_PAGE_INVALIDATED', 'Plugin page instance ended while binding');
    if (!sameTarget(current.target, record.value.target))
      throw failure(
        'PLUGIN_PAGE_TARGET_CHANGED',
        'Plugin page belongs to a different browser document',
      );
    if (record.client) return;
    record.bridge = bridge;
    record.options = options;
  }

  private append(record: Instance, event: Omit<PluginPageEvent, 'sequence' | 'time'>): void {
    record.history.push({ ...event, sequence: ++record.value.sequence, time: Date.now() });
    while (
      record.history.length > 256 ||
      Buffer.byteLength(JSON.stringify(record.history)) > 384 * 1024
    )
      record.history.shift();
    this.changes.emit(record.value.instanceId);
  }

  private async waitForChange(
    record: Instance,
    cursor: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!waitMs || cursor !== record.value.sequence || record.value.state !== 'active') return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason ?? new Error('Plugin page subscription closed'));
      };
      const timer = setTimeout(finish, waitMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.changes.off(record.value.instanceId, finish);
        signal?.removeEventListener('abort', abort);
      };
      this.changes.once(record.value.instanceId, finish);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else if (record.value.sequence !== cursor || record.value.state !== 'active') finish();
    });
  }

  private async invalidate(
    record: Instance,
    error: unknown,
    state: 'detached' | 'invalidated' = 'invalidated',
  ): Promise<void> {
    if (record.value.state !== 'active') return;
    record.value.state = state;
    record.value.error = serializePluginExecutionError(error);
    this.append(record, { type: 'invalidated', error: record.value.error });
    for (const taskId of record.taskIds)
      this.tasks.cancel(taskId, { access: 'public', source: 'runtime', bridge: 'service' });
    for (const delivery of record.deliveries) {
      if (delivery.taskId)
        this.tasks.cancel(delivery.taskId, {
          access: 'public',
          source: 'runtime',
          bridge: 'service',
        });
      if (['queued', 'running'].includes(delivery.state)) delivery.state = 'invalidated';
    }
    try {
      this.states.store.discardScope(
        record.value.installationId,
        `instance:${record.value.instanceId}`,
      );
    } catch (error) {
      console.error('Plugin instance cache cleanup failed:', error);
    }
    record.release();
    try {
      await this.releaseModels?.(record.value.instanceId);
    } finally {
      try {
        await this.bounded(this.invoke(record, { operation: 'detach' }), 2000);
      } catch {
        /* Browser lease expiry disposes unreachable instances. */
      }
      record.client?.disconnect();
    }
  }

  async call(
    plugin: string,
    input: Record<string, unknown>,
    bridge: PluginTaskBridge,
    options: PluginOptions = {},
    execution: Execution = {
      cwd: process.cwd(),
      environment: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    },
  ): Promise<any> {
    if (this.closed) throw failure('PLUGIN_PAGE_HOST_STOPPING', 'Plugin page service is stopping');
    execution.signal?.throwIfAborted();
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Invalid plugin page request');
    if (
      !/^[a-z][a-z0-9_-]*$/.test(plugin) ||
      (bridge.scope.plugin && bridge.scope.plugin !== plugin)
    )
      throw new Error('Invalid plugin page scope');
    const operation = input.operation;
    if (execution.expectedTarget && operation === 'activation' && input.enabled !== undefined)
      throw failure(
        'PLUGIN_PAGE_TARGET_CHANGED',
        'Document-bound calls cannot configure browser activation',
      );
    if (operation === 'attach' || operation === 'activation') {
      if (
        Object.keys(options).some(
          key =>
            !['browser', 'connector', 'session', 'local', 'transport', 'timeoutSec'].includes(key),
        )
      )
        throw new Error('Invalid plugin page routing options');
      if (bridge.scope.bridge === 'service' && !decodeBrowserTarget(options.browser))
        throw new Error('Plugin pages require a stable browser ID');
      if (
        !execution ||
        !isAbsolute(execution.cwd) ||
        !statSync(execution.cwd).isDirectory() ||
        !execution.environment ||
        Buffer.byteLength(JSON.stringify(execution.environment)) > 512 * 1024 ||
        Object.values(execution.environment).some(value => typeof value !== 'string')
      )
        throw new Error('Invalid plugin page execution context');
    }
    if (operation === 'activation' && input.enabled !== true) {
      const client = bridge.scope.bridge === 'service' ? new UnifiedClient() : undefined;
      try {
        return client
          ? await client.invoke('page_runtime', { ...input, plugin }, options)
          : await bridge.invoke('page_runtime', { ...input, plugin }, options);
      } finally {
        client?.disconnect();
      }
    }
    if (operation === 'attach' || operation === 'activation') {
      const revision = execution.revision ?? capturePluginRevision(plugin);
      if (input.installationId !== undefined && input.installationId !== revision.installationId)
        throw failure(
          'PLUGIN_PAGE_INSTALLATION_CHANGED',
          'Page activation belongs to another plugin installation',
        );
      const release = this.tasks.pinRevision(revision);
      let retained = false;
      const client = bridge.scope.bridge === 'service' ? new UnifiedClient() : undefined;
      const invoke = (data: Record<string, unknown>) =>
        client
          ? client.invoke('page_runtime', data, options)
          : bridge.invoke('page_runtime', data, options);
      try {
        const controller = new AbortController();
        const description = {
          controller,
          promise: this.tasks.describeRevision(
            revision,
            execution.signal
              ? AbortSignal.any([controller.signal, execution.signal])
              : controller.signal,
            { cache: true },
          ),
        };
        this.describing.add(description);
        let loaded: { pageRuntime?: PluginPageRuntime };
        try {
          loaded = (await description.promise) as { pageRuntime?: PluginPageRuntime };
        } finally {
          this.describing.delete(description);
        }
        if (this.closed) throw new Error('Plugin page host stopped during attachment');
        const runtime = loaded.pageRuntime;
        if (!runtime)
          throw failure('PLUGIN_PAGE_NOT_DECLARED', 'Plugin has no pageRuntime declaration');
        if (operation === 'activation')
          return await invoke({
            ...input,
            operation: 'activation',
            plugin,
            installationId: revision.installationId,
            allowedMatches: runtime.matches,
          });
        if (this.instances.size >= 256) {
          for (const [id, item] of this.instances)
            if (item.value.state !== 'active' && !item.running.size) this.instances.delete(id);
          if (this.instances.size >= 256) throw new Error('Too many plugin page instances');
        }
        const target = await invoke({
          operation: 'resolve',
          tabId: input.tabId,
          frame: input.frame,
          expectedDocumentId: input.documentId,
        });
        if (this.closed)
          throw failure('PLUGIN_PAGE_HOST_STOPPING', 'Plugin page service is stopping');
        execution.signal?.throwIfAborted();
        if (execution.expectedTarget && !sameTarget(target, execution.expectedTarget))
          throw failure(
            'PLUGIN_PAGE_TARGET_CHANGED',
            'Nested plugin must use the inherited document',
          );
        if (!matchesPluginPageURL(runtime.matches, target.url))
          throw failure(
            'PLUGIN_PAGE_URL_NOT_ALLOWED',
            'Plugin page URL is outside its declared matches',
          );
        if (target.url.startsWith('file:')) {
          const file = fileURLToPath(target.url);
          const directory = keyedDir(join('plugin-previews', plugin));
          if (
            dirname(file) !== directory ||
            !lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() ||
            !lstatSync(file, { throwIfNoEntry: false })?.isFile()
          )
            throw failure('PLUGIN_PAGE_URL_NOT_ALLOWED', 'Local preview must be a regular file in the plugin preview directory');
        }
        const existing = [...this.instances.values()].find(
          item =>
            item.value.state === 'active' &&
            item.value.plugin === plugin &&
            sameTarget(item.value.target, target),
        );
        if (
          existing &&
          execution.revision &&
          existing.value.revision !== revision.revision &&
          input.replace !== true
        )
          throw failure(
            'PLUGIN_PAGE_REVISION_CHANGED',
            'Existing page instance uses another plugin revision',
          );
        if (existing && input.replace !== true) {
          try {
            await existing.initialized;
            await this.bind(existing, bridge, options);
            await this.validate(existing);
            if (input.activationGeneration === undefined)
              await invoke({
                operation: 'get',
                instanceId: existing.value.instanceId,
                tabId: target.tabId,
                retainManual: true,
              });
            return existing.value;
          } catch (error) {
            if (isPluginPageUnavailable(error)) throw error;
            await this.invalidate(existing, error);
          }
        }
        if (existing)
          await this.invalidate(existing, new Error('Plugin page instance replaced'), 'detached');
        const value: PluginPageInstance = {
          instanceId: `pi_${randomUUID()}`,
          plugin,
          installationId: revision.installationId,
          revision: revision.revision,
          host: this.tasks.host,
          target,
          state: 'active',
          sequence: 0,
          createdAt: Date.now(),
        };
        let initialized!: () => void;
        let initializationFailed!: (error: unknown) => void;
        const initialization = new Promise<void>((resolve, reject) => {
          initialized = resolve;
          initializationFailed = reject;
        });
        void initialization.catch(() => {});
        const record: Instance = {
          initialized: initialization,
          value,
          runtime,
          revision,
          release,
          bridge,
          options: { ...options },
          client,
          ready: false,
          lastVerifiedAt: Date.now(),
          unavailable: false,
          taskIds: new Set(),
          execution: { cwd: execution.cwd, environment: { ...execution.environment } },
          history: [],
          deliveries: [],
          lastReceived: 0,
          running: new Set(),
        };
        this.instances.set(value.instanceId, record);
        try {
          const attached = await invoke({
            operation: 'attach',
            instance: value,
            runtime,
            input: input.input ?? {},
            frame: input.frame ?? 'business',
            activationGeneration: input.activationGeneration,
          });
          if (!sameTarget(attached.target, target))
            throw failure(
              'PLUGIN_PAGE_TARGET_CHANGED',
              'Document changed while attaching plugin page',
            );
          await this.validate(record);
          execution.signal?.throwIfAborted();
          if (runtime.initialize) {
            const parent = execution.parentIdentity;
            if (parent?.taskId) this.tasks.assertChildBudget(parent.taskId);
            const { taskId } = this.start(
              record,
              runtime.initialize,
              { input: input.input ?? {} },
              `initialize:${value.instanceId}`,
              parent,
            );
            const scope = {
              access: 'public' as const,
              source: 'runtime' as const,
              bridge: 'service' as const,
            };
            const cancel = () => this.tasks.cancel(taskId, scope);
            execution.signal?.addEventListener('abort', cancel, { once: true });
            if (execution.signal?.aborted) cancel();
            try {
              if (parent?.taskId && execution.signal)
                await this.tasks.awaitChild(parent.taskId, taskId, scope, execution.signal);
              else await this.wait(record, taskId);
            } finally {
              execution.signal?.removeEventListener('abort', cancel);
              record.taskIds.delete(taskId);
            }
          }
          execution.signal?.throwIfAborted();
          await this.validate(record);
          execution.signal?.throwIfAborted();
          record.ready = true;
          initialized();
          this.drain(record);
          retained = true;
          return value;
        } catch (error) {
          initializationFailed(error);
          await this.invalidate(record, error);
          throw error;
        }
      } finally {
        if (!retained) {
          release();
          client?.disconnect();
        }
      }
    }
    if (operation === 'list')
      return {
        instances: [...this.instances.values()]
          .filter(
            item =>
              item.value.plugin === plugin &&
              (!execution.expectedTarget ||
                sameTarget(item.value.target, execution.expectedTarget)),
          )
          .map(item => item.value),
      };
    const record = this.own(plugin, input.instanceId, bridge);
    if (execution.expectedTarget && !sameTarget(record.value.target, execution.expectedTarget))
      throw failure('PLUGIN_PAGE_TARGET_CHANGED', 'Nested plugin must use the inherited document');
    if (execution.revision && record.value.revision !== execution.revision.revision)
      throw failure('PLUGIN_PAGE_REVISION_CHANGED', 'Page instance uses another plugin revision');
    await this.bind(record, bridge, options);
    if (operation === 'detach') {
      await this.invalidate(record, new Error('Plugin page instance detached'), 'detached');
      return record.value;
    }
    try {
      if (record.value.state === 'active') await this.validate(record);
    } catch (error) {
      if (isPluginPageUnavailable(error)) throw error;
      await this.invalidate(record, error);
    }
    if (operation === 'get') return record.value;
    if (operation === 'events') {
      const cursor = input.cursor ?? 0;
      const waitMs = input.waitMs ?? 0;
      if (
        !Number.isSafeInteger(cursor) ||
        Number(cursor) < 0 ||
        Number(cursor) > record.value.sequence
      )
        throw new Error('Invalid plugin page event cursor');
      if (!Number.isSafeInteger(waitMs) || Number(waitMs) < 0 || Number(waitMs) > 25000)
        throw new Error('Invalid plugin page event wait');
      await this.waitForChange(record, Number(cursor), Number(waitMs), execution.signal);
      execution.signal?.throwIfAborted();
      const first = record.history[0]?.sequence ?? record.value.sequence + 1;
      const events: PluginPageEvent[] = [];
      let bytes = 0;
      for (const event of record.history)
        if (event.sequence > Number(cursor)) {
          const size = Buffer.byteLength(JSON.stringify(event));
          if (events.length && bytes + size > 192 * 1024) break;
          events.push(event);
          bytes += size;
        }
      return {
        instance: record.value,
        events,
        nextCursor: events.at(-1)?.sequence ?? Number(cursor),
        firstAvailableSequence: first,
        gap: Number(cursor) < first - 1,
      } satisfies PluginPageEvents;
    }
    if (operation !== 'send') throw new Error('Unknown plugin page operation');
    const timeoutSec = input.timeoutSec as number | undefined;
    if (
      timeoutSec !== undefined &&
      (typeof timeoutSec !== 'number' ||
        !Number.isFinite(timeoutSec) ||
        timeoutSec <= 0 ||
        timeoutSec > 300)
    )
      throw new Error('Page request timeoutSec must be between 0 and 300');
    await this.validate(record);
    execution.signal?.throwIfAborted();
    const json = Buffer.from(JSON.stringify(input.message ?? null));
    if (json.length > 24 * 1024 * 1024) throw new Error('Plugin page message exceeds 24 MiB');
    const requestId = randomUUID();
    const cancel = () => {
      void this.invoke(record, { operation: 'cancel', requestId }).catch(() => {});
    };
    execution.signal?.addEventListener('abort', cancel, { once: true });
    try {
      let result: unknown;
      if (json.length <= 192 * 1024)
        result = await this.invoke(
          record,
          {
            operation: 'send',
            message: input.message,
            requestId,
          },
          timeoutSec,
        );
      else {
        const transferId = randomUUID();
        try {
          await this.invoke(record, {
            operation: 'message_begin',
            transferId,
            bytes: json.length,
            sha256: createHash('sha256').update(json).digest('hex'),
          });
          for (let offset = 0, index = 0; offset < json.length; offset += 192 * 1024, index++) {
            await this.validate(record);
            execution.signal?.throwIfAborted();
            await this.invoke(record, {
              operation: 'message_chunk',
              transferId,
              index,
              data: json.subarray(offset, offset + 192 * 1024).toString('base64'),
            });
          }
          await this.validate(record);
          execution.signal?.throwIfAborted();
          result = await this.invoke(
            record,
            {
              operation: 'message_commit',
              transferId,
              requestId,
            },
            timeoutSec,
          );
        } finally {
          await this.invoke(record, { operation: 'message_abort', transferId }).catch(() => {});
        }
      }
      execution.signal?.throwIfAborted();
      await this.validate(record);
      const reply = result as any;
      if (reply?.kind === 'value') return reply.value;
      if (
        reply?.kind !== 'resource' ||
        !Number.isSafeInteger(reply.bytes) ||
        reply.bytes < 1 ||
        reply.bytes > 24 * 1024 * 1024 ||
        reply.chunks !== Math.ceil(reply.bytes / (192 * 1024))
      )
        throw new Error('Invalid page response resource');
      try {
        const parts: Buffer[] = [];
        for (let index = 0; index < reply.chunks; index++) {
          await this.validate(record);
          const chunk = await this.invoke(record, {
            operation: 'result_chunk',
            resultId: reply.resultId,
            index,
          });
          if (
            chunk.resultId !== reply.resultId ||
            chunk.index !== index ||
            chunk.bytes !== reply.bytes ||
            chunk.sha256 !== reply.sha256 ||
            chunk.chunks !== reply.chunks
          )
            throw new Error('Page response chunk identity mismatch');
          parts.push(Buffer.from(chunk.data, 'base64'));
        }
        const bytes = Buffer.concat(parts);
        if (
          bytes.length !== reply.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== reply.sha256
        )
          throw new Error('Page response integrity check failed');
        await this.validate(record);
        return JSON.parse(bytes.toString('utf8'));
      } finally {
        await this.invoke(record, { operation: 'result_release', resultId: reply.resultId }).catch(
          () => {},
        );
      }
    } catch (error) {
      cancel();
      throw error;
    } finally {
      execution.signal?.removeEventListener('abort', cancel);
    }
  }

  async receive(
    plugin: string,
    input: Record<string, unknown>,
    bridge: PluginTaskBridge,
    options: PluginOptions = {},
  ): Promise<unknown> {
    if (input.kind === 'sync') {
      if (
        this.closed ||
        !/^[a-z][a-z0-9_-]*$/.test(plugin) ||
        (bridge.scope.plugin && bridge.scope.plugin !== plugin) ||
        !Array.isArray(input.instances) ||
        input.instances.length > 32
      )
        throw new Error('Invalid page reconciliation request');
      const session = (await this.bounded(
        bridge.invoke('page_runtime', { operation: 'session' }, options),
        8000,
      )) as any;
      if (
        typeof input.browserSessionId !== 'string' ||
        session.browserSessionId !== input.browserSessionId
      )
        throw failure(
          'PLUGIN_PAGE_TARGET_CHANGED',
          'Page reconciliation came from another browser session',
        );
      const instances = [];
      for (const value of input.instances) {
        const proposed = value as PluginPageInstance;
        const record = this.instances.get(proposed?.instanceId);
        if (
          !record ||
          record.value.plugin !== plugin ||
          record.value.state !== 'active' ||
          !proposed.host ||
          proposed.host.hostId !== this.tasks.host.hostId ||
          proposed.host.epoch !== this.tasks.host.epoch ||
          proposed.installationId !== record.value.installationId ||
          proposed.revision !== record.value.revision ||
          !proposed.target ||
          !sameTarget(proposed.target, record.value.target) ||
          record.value.target.browserSessionId !== session.browserSessionId
        )
          continue;
        try {
          await this.bind(record, bridge, options);
          await this.validate(record);
          instances.push({ instance: record.value, lastReceived: record.lastReceived });
        } catch (error) {
          if (isPluginPageUnavailable(error)) throw error;
          await this.invalidate(record, error);
        }
      }
      return { host: this.tasks.host, instances };
    }
    const record = this.own(plugin, input.instanceId, bridge);
    const session = (await this.bounded(
      bridge.invoke('page_runtime', { operation: 'session' }, options),
      8000,
    )) as any;
    if (session.browserSessionId !== record.value.target.browserSessionId)
      throw failure('PLUGIN_PAGE_TARGET_CHANGED', 'Page event came from another browser');
    if (input.kind === 'invalidated') {
      if (!input.target || !sameTarget(input.target as PluginPageTarget, record.value.target))
        throw failure('PLUGIN_PAGE_TARGET_CHANGED', 'Invalid document invalidation source');
      await this.invalidate(record, new Error('Browser invalidated the document'));
      return { accepted: true };
    }
    const source = (await this.bounded(
      bridge.invoke(
        'page_runtime',
        { operation: 'get', tabId: record.value.target.tabId, instanceId: record.value.instanceId },
        options,
      ),
      8000,
    )) as any;
    if (!sameTarget(source.target, record.value.target))
      throw failure('PLUGIN_PAGE_TARGET_CHANGED', 'Page event came from another document');
    await this.bind(record, bridge, options);
    await this.validate(record);
    if (input.kind === 'navigation') {
      this.append(record, { type: 'navigation', payload: { url: record.value.target.url } });
      return { accepted: true };
    }
    const sequence = input.eventSequence;
    if (!Number.isSafeInteger(sequence) || Number(sequence) < 1)
      throw new Error('Invalid page event sequence');
    const duplicate = record.deliveries.find(item => item.sequence === sequence);
    if (Number(sequence) <= record.lastReceived)
      return { accepted: true, duplicate: true, taskId: duplicate?.taskId, gap: !duplicate };
    if (Number(sequence) !== record.lastReceived + 1)
      throw failure('PLUGIN_PAGE_EVENT_GAP', 'Page event stream has a gap; reattach the instance');
    const name = typeof input.name === 'string' ? input.name : '';
    const binding = record.runtime.events?.[name];
    if (!binding || Buffer.byteLength(JSON.stringify(input.payload ?? null)) > 32 * 1024)
      throw new Error('Page event is not declared or exceeds 32 KiB');
    const waiting = record.deliveries.filter(item => item.name === name && item.state === 'queued');
    if (binding.policy === 'latest') {
      for (const previous of waiting) {
        previous.state = 'superseded';
        this.append(record, { type: 'superseded', eventSequence: previous.sequence, name });
      }
    } else if (waiting.length >= (binding.maxPending ?? 32))
      throw failure('PLUGIN_PAGE_QUEUE_FULL', 'Page event queue is full');
    if (record.deliveries.filter(item => ['queued', 'running'].includes(item.state)).length >= 128)
      throw failure('PLUGIN_PAGE_QUEUE_FULL', 'Page event queue is full');
    const delivery: Delivery = {
      sequence: Number(sequence),
      name,
      payload: input.payload,
      state: 'queued',
    };
    record.lastReceived = Number(sequence);
    record.deliveries.push(delivery);
    while (record.deliveries.length > 256) {
      const index = record.deliveries.findIndex(
        item => !['queued', 'running'].includes(item.state),
      );
      if (index < 0) break;
      record.deliveries.splice(index, 1);
    }
    this.append(record, {
      type: 'received',
      eventSequence: delivery.sequence,
      name,
      payload: input.payload,
    });
    this.drain(record);
    return { accepted: true, eventSequence: delivery.sequence, taskId: delivery.taskId };
  }

  private drain(record: Instance): void {
    if (this.closed || !record.ready || record.unavailable || record.value.state !== 'active')
      return;
    for (const delivery of record.deliveries) {
      if (delivery.state !== 'queued') continue;
      const binding = record.runtime.events![delivery.name];
      const running = [...record.running].filter(item => item.name === delivery.name).length;
      if (running >= (binding.policy === 'parallel' ? (binding.concurrency ?? 2) : 1)) continue;
      delivery.state = 'running';
      record.running.add(delivery);
      void this.execute(record, delivery).finally(() => {
        record.running.delete(delivery);
        this.drain(record);
      });
    }
  }

  private async execute(record: Instance, delivery: Delivery): Promise<void> {
    try {
      await this.validate(record);
      const binding = record.runtime.events![delivery.name];
      const started = this.start(
        record,
        binding.command,
        { event: { name: delivery.name, payload: delivery.payload, sequence: delivery.sequence } },
        `page:${record.value.instanceId}:${delivery.sequence}`,
        undefined,
        binding.executionTimeoutMs,
      );
      delivery.taskId = started.taskId;
      this.append(record, {
        type: 'running',
        name: delivery.name,
        eventSequence: delivery.sequence,
        taskId: started.taskId,
      });
      await this.wait(record, started.taskId);
      delivery.state = 'success';
      this.append(record, {
        type: 'success',
        name: delivery.name,
        eventSequence: delivery.sequence,
        taskId: started.taskId,
      });
    } catch (error) {
      // Only deliveries that have not started a task can be resumed without replaying side effects.
      if (isPluginPageUnavailable(error) && !delivery.taskId && record.value.state === 'active') {
        delivery.state = 'queued';
        return;
      }
      delivery.state = 'error';
      this.append(record, {
        type: 'error',
        name: delivery.name,
        eventSequence: delivery.sequence,
        error: serializePluginExecutionError(error),
      });
    }
  }

  private start(
    record: Instance,
    command: string,
    input: Record<string, unknown>,
    key: string,
    parentIdentity?: PluginInvocationIdentity,
    executionTimeoutMs?: number,
  ) {
    // The runtime delegates through the instance's current connection. Its identity follows
    // that connection so binding cannot replace the connection with this forwarding proxy.
    const bridge: PluginTaskBridge = {
      get id() {
        return record.bridge.id;
      },
      scope: {
        ...record.bridge.scope,
        plugin: record.value.plugin,
        access: 'runtime',
        source: 'runtime',
      },
      invoke: (action, payload, options) =>
        record.client
          ? record.client.invoke(action, payload, options)
          : record.bridge.invoke(action, payload, options),
    };
    const started = this.tasks.start(
      {
        plugin: record.value.plugin,
        command,
        input,
        cwd: record.execution.cwd,
        environment: record.execution.environment,
        options: record.options,
        idempotencyKey: key,
        executionTimeoutMs,
      },
      bridge,
      {
        ...(parentIdentity?.taskId ? { parentTaskId: parentIdentity.taskId, parentIdentity } : {}),
        revision: record.revision,
        guard: () => this.validate(record),
        page: { instanceId: record.value.instanceId, target: { ...record.value.target } },
      },
    );
    record.taskIds.add(started.taskId);
    return started;
  }
  private async wait(record: Instance, taskId: string): Promise<void> {
    let cursor = 0;
    while (true) {
      const page = await this.tasks.events(
        taskId,
        { access: 'public', source: 'runtime', bridge: 'service' },
        cursor,
        25000,
      );
      cursor = page.nextCursor;
      if (!isPluginTaskActive(page.task.state)) {
        record.taskIds.delete(taskId);
        if (page.task.state !== 'success')
          throw Object.assign(
            pluginExecutionError(page.task.error ?? { message: 'Page handler failed' }),
            { childTaskId: taskId },
          );
        return;
      }
      if (record.value.state !== 'active')
        this.tasks.cancel(taskId, { access: 'public', source: 'runtime', bridge: 'service' });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const item of this.describing) item.controller.abort();
    await Promise.allSettled([...this.describing].map(item => item.promise));
    await Promise.allSettled(
      [...this.instances.values()].map(record =>
        this.invalidate(record, new Error('Plugin page host stopped')),
      ),
    );
  }
}
