import { PluginHostConnection } from './pluginHostConnection.js';
import type {
  PluginHostClientOptions,
  HostStatus as PluginHostStatus,
} from './pluginHostConnection.js';
import type { PluginTaskCheckpoint } from '@mearl/browser-core';
import type {
  PluginDiagnosticOptions,
  PluginDiagnosticReport,
} from '@mearl/browser-core';
import { createHash } from 'node:crypto';
import { isProcessOwnerAlive, readRecord } from '@mearl/daemon-core';
import { pluginHostPaths } from '../runtime/pluginHostPaths.js';
import { UnifiedClient, decodeBrowserTarget } from '../../unified.js';
import { isPluginTaskActive } from '@mearl/browser-core';
import type {
  PluginTask,
  PluginTaskEvents,
  PluginTaskListResult,
  PluginTaskResultChunk,
  PluginTaskStartResult,
} from '@mearl/browser-core';
import type { PluginInvocation, PluginOptions } from '../sdk/plugin.js';
import { pluginExecutionError } from '../runtime/pluginExecutorProtocol.js';

export type { PluginTask, PluginTaskEvents, PluginTaskListResult, PluginTaskStartResult };

export interface PluginTaskStartOptions extends PluginOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  executionTimeoutMs?: number;
  idempotencyKey?: string;
}

export interface PluginTaskWaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  readResult?: boolean;
  onProgress?: (progress: PluginTask['progress'], task: PluginTask) => void;
}

export type PluginTaskClientOptions = PluginHostClientOptions;

function localWait<T>(promise: Promise<T>, signal?: AbortSignal, timeoutMs = Infinity): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('Plugin task wait aborted'));
    };
    const timer = Number.isFinite(timeoutMs)
      ? setTimeout(
          () => {
            cleanup();
            reject(
              Object.assign(
                new Error('Waiting for the plugin task timed out; execution continues'),
                { code: 'PLUGIN_TASK_WAIT_TIMEOUT' },
              ),
            );
          },
          Math.max(0, timeoutMs),
        )
      : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
    if (signal?.aborted) abort();
  });
}

/** Background execution stays on this host; disconnecting a caller never cancels its tasks. */
export class PluginTaskClient {
  readonly connection: PluginHostConnection;
  constructor(private readonly configuration: PluginTaskClientOptions = {}) {
    this.connection = configuration.connection ?? new PluginHostConnection(configuration);
  }
  private request(
    method: string,
    input: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<any> {
    return this.connection.request(method, input, timeoutMs);
  }
  status(): Promise<PluginHostStatus> {
    return this.request('status');
  }
  diagnose(options: PluginDiagnosticOptions = {}): Promise<PluginDiagnosticReport> {
    return this.request('diagnose', { ...options });
  }
  checkpoint(taskId: string): Promise<PluginTaskCheckpoint | null> {
    return this.request('checkpoint', { taskId });
  }
  resume(
    taskId: string,
    options: { environment?: NodeJS.ProcessEnv; revision?: 'original' | 'current' } = {},
  ): Promise<PluginTaskStartResult> {
    return this.request(
      'resume',
      {
        taskId,
        revision: options.revision,
        environment: Object.fromEntries(
          Object.entries(options.environment ?? process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      },
      45000,
    );
  }
  async start(
    plugin: string,
    invocation: PluginInvocation,
    options: PluginTaskStartOptions = {},
  ): Promise<PluginTaskStartResult> {
    const {
      cwd = process.cwd(),
      environment = process.env,
      executionTimeoutMs,
      idempotencyKey,
      ...routing
    } = options;
    if (
      !this.connection.hasInvocationBridge &&
      routing.browser &&
      !decodeBrowserTarget(routing.browser)
    ) {
      const client = new UnifiedClient();
      try {
        const selection = await client.invoke(
          'browser_select_browser',
          { browser: routing.browser },
          routing,
        );
        if (!selection?.selected?.browserId)
          throw new Error('Cannot resolve plugin task browser target');
        routing.browser = selection.selected.browserId;
      } finally {
        client.disconnect();
      }
    }
    return this.request('start', {
      plugin,
      command: invocation.command,
      input: invocation.input,
      cwd,
      environment: Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      options: routing,
      executionTimeoutMs,
      idempotencyKey,
    });
  }
  get(taskId: string): Promise<PluginTask> {
    return this.request('get', { taskId });
  }
  list(
    activeOnly = false,
    page: { cursor?: string; limit?: number } = {},
  ): Promise<PluginTaskListResult> {
    return this.request('list', { activeOnly, ...page });
  }
  cancel(taskId: string): Promise<PluginTask> {
    return this.request('cancel', { taskId });
  }
  events(taskId: string, cursor = 0, waitMs = 0): Promise<PluginTaskEvents> {
    return this.request('events', { taskId, cursor, waitMs }, waitMs + 15000);
  }
  resultChunk(taskId: string, index: number): Promise<PluginTaskResultChunk> {
    return this.request('result', { taskId, index });
  }

  async result(taskId: string): Promise<unknown> {
    const task = await this.get(taskId);
    if (task.state !== 'success' || !task.result)
      throw new Error('Plugin task has no successful result');
    const parts: Buffer[] = [];
    for (let index = 0; index < task.result.chunks; index++) {
      const chunk = await this.resultChunk(taskId, index);
      if (
        chunk.taskId !== taskId ||
        chunk.index !== index ||
        chunk.sha256 !== task.result.sha256 ||
        chunk.bytes !== task.result.bytes ||
        chunk.chunks !== task.result.chunks
      )
        throw new Error('Plugin task result chunk identity mismatch');
      parts.push(Buffer.from(chunk.data, 'base64'));
    }
    const bytes = Buffer.concat(parts);
    if (
      bytes.length !== task.result.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== task.result.sha256
    )
      throw new Error('Plugin task result integrity check failed');
    return JSON.parse(bytes.toString('utf8')).value;
  }

  async *subscribe(
    taskId: string,
    options: { cursor?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<PluginTaskEvents> {
    let cursor = options.cursor ?? 0;
    while (true) {
      options.signal?.throwIfAborted();
      const page = await localWait(this.events(taskId, cursor, 25000), options.signal);
      options.signal?.throwIfAborted();
      yield page;
      cursor = page.nextCursor;
      if (!isPluginTaskActive(page.task.state) && cursor >= page.task.sequence) return;
    }
  }

  async wait(taskId: string, options: PluginTaskWaitOptions = {}): Promise<unknown> {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    )
      throw new Error('Invalid plugin task wait timeout');
    const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
    let cursor = 0;
    let lastSequence = -1;
    while (true) {
      options.signal?.throwIfAborted();
      if (Date.now() >= deadline)
        throw Object.assign(
          new Error('Waiting for the plugin task timed out; execution continues'),
          { code: 'PLUGIN_TASK_WAIT_TIMEOUT' },
        );
      const page = await localWait(
        this.events(taskId, cursor, Math.min(1000, Math.max(0, deadline - Date.now()))),
        options.signal,
        deadline - Date.now(),
      );
      options.signal?.throwIfAborted();
      cursor = page.nextCursor;
      if (page.task.progress && page.task.sequence !== lastSequence)
        options.onProgress?.(page.task.progress, page.task);
      lastSequence = page.task.sequence;
      if (page.task.state === 'success')
        return options.readResult === false
          ? page.task
          : localWait(this.result(taskId), options.signal, deadline - Date.now());
      if (!isPluginTaskActive(page.task.state))
        throw pluginExecutionError(
          page.task.error ?? { message: `Plugin task ended with ${page.task.state}` },
        );
    }
  }

  async stopHost(): Promise<void> {
    const original = await this.status();
    await this.request('shutdown');
    this.disconnect();
    const deadline = Date.now() + 15000;
    while (true) {
      const lease = readRecord(pluginHostPaths().lease);
      if (!lease || lease.epoch !== original.host.epoch || !isProcessOwnerAlive(lease)) return;
      if (Date.now() >= deadline)
        throw new Error('Plugin execution service did not finish stopping');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  disconnect(): void {
    if (!this.configuration.connection) this.connection.disconnect();
  }
}
