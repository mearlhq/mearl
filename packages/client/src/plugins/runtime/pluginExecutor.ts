import type { PluginModelDiagnostic, PluginModelRequest } from '@mearl/browser-core';
import { fork } from 'node:child_process';
import { PLUGIN_WORKER_PATH } from '../../runtimePaths.js';
import { findPluginRegistration, PluginError, type PluginRegistration } from '../pluginRegistry.js';
import { pluginFileVersion } from '../pluginSource.js';
import { createPluginInvocationIdentity } from './pluginExecution.js';
import { pluginExecutionError, serializePluginExecutionError } from './pluginExecutorProtocol.js';
import type { PluginWorkerEvent, PluginWorkerRequest } from './pluginExecutorProtocol.js';
import type {
  PluginExecutionContext,
  PluginInvocation,
  PluginInvokeOptions,
} from '../sdk/plugin.js';
import { stopPluginProcessTree } from './pluginProcessTree.js';
import { processIdentity } from '@mearl/daemon-core';

export interface PluginExecutorDependencies {
  stopProcessTree?: (pid: number) => Promise<void>;
  registration?: PluginRegistration;
}

export interface PluginExecutorOptions extends PluginInvokeOptions {
  help?: { namespace: string; command?: string };
  onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
  describe?: boolean;
  model?: PluginModelRequest;
  recovery?: boolean;
  migration?: boolean;
  expectedRecovery?: string;
  onDiagnostic?: (metadata: PluginModelDiagnostic) => void;
  onExecutorStopped?: () => void;
  onExecutorStarted?: (owner: { pid: number; processIdentity?: string }) => void;
  access?: 'public' | 'toolbox' | 'runtime';
  /** Execution deadline, independent of transport and caller wait timeouts. */
  executionTimeoutMs?: number;
  cancellationGraceMs?: number;
  workerPath?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
}

/** Executes registered trusted code in a process whose lifetime belongs to this invocation. */
export async function executeRegisteredPlugin(
  plugin: string,
  invocation: PluginInvocation,
  context: PluginExecutionContext,
  options: PluginExecutorOptions = {},
  dependencies: PluginExecutorDependencies = {},
): Promise<unknown> {
  const {
    signal,
    onProgress,
    source,
    access = 'public',
    executionTimeoutMs,
    cancellationGraceMs = 1000,
    workerPath,
    cwd,
    environment,
    describe,
    help,
    onOutput,
    model,
    recovery,
    migration,
    expectedRecovery,
    onExecutorStarted,
    onExecutorStopped,
    onDiagnostic,
    ...invokeOptions
  } = options;
  for (const [name, value] of [
    ['executionTimeoutMs', executionTimeoutMs],
    ['cancellationGraceMs', cancellationGraceMs],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647))
      throw new Error(`${name} must be a positive integer within the timer range`);
  }
  signal?.throwIfAborted();
  const registration = dependencies.registration ?? findPluginRegistration(plugin);
  if (!registration) throw new PluginError('PLUGIN_NOT_REGISTERED', `插件未注册: ${plugin}`);
  const identity =
    context.invocation ??
    createPluginInvocationIdentity(
      plugin,
      source ?? context.source ?? 'sdk',
      context.parentInvocation,
    );
  const entryVersion = pluginFileVersion(registration.entry);

  return new Promise((resolve, reject) => {
    const child = fork(workerPath ?? PLUGIN_WORKER_PATH, [], {
      stdio: ['ignore', onOutput ? 'pipe' : 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
      execArgv: [],
      detached: process.platform !== 'win32',
      ...(cwd ? { cwd } : {}),
      ...(environment ? { env: environment } : {}),
    });
    let stderr = '';
    let outcome: { value?: unknown; error?: Error } | undefined;
    let stopping: Error | undefined;
    let cleanupError: Error | undefined;
    let treeStopRequested = false;
    let treeCleanup = Promise.resolve();
    let exited = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const pendingActions = new Map<number, string>();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => {
      stderr = `${stderr}${chunk}`.slice(-65536);
    });
    if (onOutput) {
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream]?.on('data', chunk => {
          try {
            onOutput(stream, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          } catch (error) {
            stop(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
    }
    const send = (message: PluginWorkerRequest) => {
      if (!child.connected || exited) return;
      try {
        child.send(message, error => {
          if (error && !exited) stop(error);
        });
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const kill = () => {
      if (!child.pid || exited || treeStopRequested) return;
      treeStopRequested = true;
      const pid = child.pid;
      treeCleanup = Promise.resolve()
        .then(() => (dependencies.stopProcessTree ?? stopPluginProcessTree)(pid))
        .catch(() => {
          cleanupError = Object.assign(new Error('Unable to confirm plugin process-tree cleanup'), {
            code: 'PLUGIN_EXECUTOR_CLEANUP_FAILED',
            details: { executionStopped: false },
          });
          child.kill('SIGKILL');
        });
    };
    const stop = (error: Error) => {
      if (stopping || outcome || exited) return;
      stopping = error;
      send({ type: 'cancel', error: serializePluginExecutionError(error) });
      graceTimer = setTimeout(kill, cancellationGraceMs);
    };
    const abort = () =>
      stop(
        Object.assign(new Error('Plugin execution cancelled'), {
          code: 'PLUGIN_EXECUTION_CANCELLED',
        }),
      );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (executionTimeoutMs !== undefined)
      deadlineTimer = setTimeout(
        () =>
          stop(
            Object.assign(new Error('Plugin execution deadline exceeded'), {
              code: 'PLUGIN_EXECUTION_DEADLINE',
            }),
          ),
        executionTimeoutMs,
      );

    child.on('message', (raw: PluginWorkerEvent) => {
      if (exited || !raw || typeof raw !== 'object') return;
      if (raw.type === 'result' || raw.type === 'error') {
        if (!outcome && !stopping) {
          try {
            outcome =
              raw.type === 'result'
                ? { value: JSON.parse(raw.json).value }
                : { error: pluginExecutionError(raw.error) };
            if (raw.type === 'result' && pendingActions.size)
              outcome = {
                error: Object.assign(new Error('Plugin returned with pending host calls'), {
                  code: 'PLUGIN_PENDING_HOST_CALLS',
                  details: { pendingActions: [...pendingActions.values()] },
                }),
              };
          } catch (error) {
            stop(error instanceof Error ? error : new Error(String(error)));
          }
        }
        kill();
        return;
      }
      if (stopping || outcome) return;
      if (raw.type === 'diagnostic' && model) {
        try {
          onDiagnostic?.(raw.metadata);
        } catch (error) {
          stop(error instanceof Error ? error : new Error(String(error)));
        }
      } else if (raw.type === 'progress') {
        try {
          onProgress?.(raw.progress);
        } catch (error) {
          stop(error instanceof Error ? error : new Error(String(error)));
        }
      } else if (raw.type === 'invoke') {
        pendingActions.set(raw.id, raw.action);
        void Promise.resolve()
          .then(() => {
            if (stopping || exited) throw stopping ?? new Error('Plugin execution ended');
            const options = { ...invokeOptions, ...raw.options };
            if (!raw.stream) return context.invoke(raw.action, raw.payload, options);
            return context.invoke(raw.action, raw.payload, options, progress => {
              if (!stopping && !outcome && pendingActions.has(raw.id))
                send({ type: 'invoke-progress', id: raw.id, progress });
            });
          })
          .then(
            result => send({ type: 'response', id: raw.id, result }),
            error =>
              send({ type: 'response', id: raw.id, error: serializePluginExecutionError(error) }),
          )
          .finally(() => pendingActions.delete(raw.id));
      }
    });
    const cleanup = () => {
      exited = true;
      signal?.removeEventListener('abort', abort);
      if (graceTimer) clearTimeout(graceTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    };
    child.once('error', error => {
      cleanup();
      reject(error);
    });
    child.once('exit', () => {
      kill();
      child.stderr?.destroy();
    });
    child.once('close', (code, exitSignal) => {
      cleanup();
      void treeCleanup.then(() => {
        if (!cleanupError && treeStopRequested) {
          try {
            onExecutorStopped?.();
          } catch (error) {
            reject(error);
            return;
          }
        }
        if (cleanupError) reject(cleanupError);
        else if (stopping) {
          Object.assign(stopping, {
            details: { pendingActions: [...pendingActions.values()], executionStopped: true },
          });
          reject(stopping);
        } else if (outcome?.error) reject(outcome.error);
        else if (outcome) resolve(outcome.value);
        else
          reject(
            Object.assign(
              new Error(stderr.trim() || `Plugin executor exited (${code ?? exitSignal})`),
              { code: 'PLUGIN_EXECUTOR_EXITED' },
            ),
          );
      });
    });
    try {
      if (child.pid)
        onExecutorStarted?.({ pid: child.pid, processIdentity: processIdentity(child.pid) });
      send({
        type: 'start',
        plugin,
        invocation,
        options: invokeOptions,
        identity,
        entry: registration.entry,
        entryVersion,
        access,
        describe,
        help,
        model,
        recovery,
        migration,
        expectedRecovery,
        ...(dependencies.registration ? { registration } : {}),
      });
    } catch (error) {
      stop(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
