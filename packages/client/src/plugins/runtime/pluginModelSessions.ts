import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PLUGIN_MODEL_SESSION_WORKER_PATH } from '../../runtimePaths.js';
import { processIdentity } from '@mearl/daemon-core';
import type { executeRegisteredPlugin } from './pluginExecutor.js';
import type { ModelSessionEvent } from '../../pluginModelSessionWorker.js';
import { pluginExecutionError } from './pluginExecutorProtocol.js';
import { stopPluginProcessTree } from './pluginProcessTree.js';
import { validatePluginModelResult } from '../sdk/pluginModelDefinition.js';

interface Session {
  owner: string;
  child: ChildProcess;
  tail: Promise<unknown>;
  queued: number;
  closed: boolean;
  exited: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
}

/** Opt-in conversations retain a supervised process and thread within one execution owner. */
export class PluginModelSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly closing = new Set<Session>();
  private closed = false;
  constructor(
    private readonly idleMs = 5 * 60_000,
    private readonly limit = 2,
    private readonly workerPath = PLUGIN_MODEL_SESSION_WORKER_PATH,
  ) {}

  execute(owner: string, ...args: Parameters<typeof executeRegisteredPlugin>): Promise<unknown> {
    const [plugin, , context, options = {}] = args;
    const request = options.model!;
    const configuration = Object.fromEntries(
      Object.entries(request)
        .filter(([key]) => !['prompt', 'outputSchema'].includes(key))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          owner,
          plugin,
          context.invocation?.installationId,
          context.invocation?.revision,
          options.cwd,
          Object.entries(options.environment ?? {}).sort(([a], [b]) => a.localeCompare(b)),
          configuration,
        ]),
      )
      .digest('hex');
    options.signal?.throwIfAborted();
    if (this.closed) return Promise.reject(new Error('Model conversations are closed'));
    let session = this.sessions.get(key);
    if (!session || session.closed) {
      if (this.sessions.size >= this.limit) {
        const idle = [...this.sessions.values()].find(value => !value.queued);
        if (!idle) return Promise.reject(new Error('Model conversation limit reached'));
        void this.remove(idle).catch(error =>
          console.error('Model conversation cleanup failed:', error),
        );
      }
      const child = fork(this.workerPath, [], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        serialization: 'advanced',
        execArgv: [],
        detached: process.platform !== 'win32',
        cwd: options.cwd,
        env: options.environment,
      });
      // The supervisor remains responsible for process-tree cleanup if its host disconnects.
      const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
      session = { owner, child, tail: Promise.resolve(), queued: 0, closed: false, exited };
      const current = session;
      child.on('error', () => {
        void this.remove(current).catch(error =>
          console.error('Model conversation cleanup failed:', error),
        );
      });
      child.once('exit', () => {
        void this.remove(current).catch(error =>
          console.error('Model conversation cleanup failed:', error),
        );
      });
      this.sessions.set(key, session);
    }
    this.sessions.delete(key);
    this.sessions.set(key, session);
    clearTimeout(session.timer);
    const current = session;
    current.queued++;
    let started = false;
    const operation = current.tail
      .catch(() => {})
      .then(async () => {
        options.signal?.throwIfAborted();
        if (current.closed) throw new Error('Model conversation has ended');
        started = true;
        return this.run(current, args);
      });
    current.tail = operation.finally(() => {
      current.queued--;
      if (!current.queued && !current.closed) {
        current.timer = setTimeout(() => {
          void this.remove(current).catch(error =>
            console.error('Model conversation cleanup failed:', error),
          );
        }, this.idleMs);
        current.timer.unref();
      }
    });
    void current.tail.catch(() => {});
    if (!options.signal) return operation;
    const signal = options.signal;
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!started)
          reject(
            Object.assign(new Error('Model execution cancelled'), {
              code: 'PLUGIN_EXECUTION_CANCELLED',
            }),
          );
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void operation
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
  }

  private run(
    session: Session,
    args: Parameters<typeof executeRegisteredPlugin>,
  ): Promise<unknown> {
    const options = args[3]!,
      request = options.model!,
      child = session.child;
    return new Promise((resolve, reject) => {
      let finished = false,
        stderr = '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = async (failure?: unknown, result?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        child.removeListener('message', message);
        child.removeListener('error', failed);
        child.removeListener('exit', exited);
        child.stderr?.removeListener('data', capture);
        try {
          if (failure) await this.remove(session);
          options.onExecutorStopped?.();
          if (failure) reject(failure);
          else resolve(result);
        } catch (error) {
          reject(error);
        }
      };
      const failed = (error: Error) => {
        void finish(error);
      };
      const exited = () => failed(new Error(stderr || 'Model conversation executor exited'));
      const abort = () =>
        failed(
          Object.assign(new Error('Model execution cancelled'), {
            code: 'PLUGIN_EXECUTION_CANCELLED',
          }),
        );
      const capture = (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-65536);
      };
      const message = (event: ModelSessionEvent) => {
        if (finished) return;
        try {
          if (event.type === 'result')
            void finish(undefined, validatePluginModelResult(request, event.result));
          else if (event.type === 'error') failed(pluginExecutionError(event.error));
          else if (event.type === 'diagnostic') options.onDiagnostic?.(event.metadata);
          else if (event.type === 'delta')
            options.onProgress?.({
              message: 'model.delta',
              data: { delta: event.delta, index: event.index, ...event.metadata, partial: true },
            });
        } catch (error) {
          void finish(error);
        }
      };
      child.on('message', message);
      child.once('error', failed);
      child.once('exit', exited);
      child.stderr?.on('data', capture);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.executionTimeoutMs)
        timer = setTimeout(
          () =>
            failed(
              Object.assign(new Error('Model execution deadline exceeded'), {
                code: 'PLUGIN_EXECUTION_DEADLINE',
              }),
            ),
          options.executionTimeoutMs,
        );
      try {
        if (options.signal?.aborted) {
          abort();
          return;
        }
        if (child.pid)
          options.onExecutorStarted?.({
            pid: child.pid,
            processIdentity: processIdentity(child.pid),
          });
        child.send({ request }, error => {
          if (error) failed(error);
        });
      } catch (error) {
        void finish(error);
      }
    });
  }

  private remove(session: Session): Promise<void> {
    if (session.closing) return session.closing;
    session.closed = true;
    clearTimeout(session.timer);
    for (const [key, value] of this.sessions) if (value === session) this.sessions.delete(key);
    session.closing = (
      session.child.pid ? stopPluginProcessTree(session.child.pid) : Promise.resolve()
    )
      .then(() => {
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Model conversation did not exit')), 2000);
        });
        return Promise.race([session.exited, timeout]).finally(() => clearTimeout(timer));
      })
      .catch(cause => {
        throw Object.assign(new Error('Unable to confirm model conversation cleanup', { cause }), {
          code: 'PLUGIN_EXECUTOR_CLEANUP_FAILED',
          details: { executionStopped: false },
        });
      });
    this.closing.add(session);
    void session.closing.finally(() => this.closing.delete(session)).catch(() => {});
    return session.closing;
  }
  async release(owner: string): Promise<void> {
    await Promise.all(
      [...new Set([...this.sessions.values(), ...this.closing])]
        .filter(value => value.owner === owner)
        .map(value => this.remove(value)),
    );
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...new Set([...this.sessions.values(), ...this.closing])].map(value => this.remove(value)),
    );
  }
}
