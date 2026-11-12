import { spawn } from 'node:child_process';
import { isBrowserCommandAction } from '@mearl/browser-core/browserActionProtocol';
import { exportArtifact } from './artifacts.js';
import { UnifiedClient, type UnifiedInvokeOptions } from './unified.js';
import { loadCloudServerConfig } from './unifiedConfig.js';
import { stopPluginProcessTree } from './plugins/runtime/pluginProcessTree.js';
import { SCRIPT_WORKER_PATH } from './runtimePaths.js';
import {
  SDK_METHOD_ACTIONS as METHOD_ACTIONS,
  SDK_OPTIONS_ONLY_METHODS as OPTIONS_ONLY,
} from './sdkMethods.js';
import { getCommandHelp } from './commandHelp.js';
import { executeRegisteredPlugin } from './plugins/runtime/pluginExecutor.js';
import { findPluginRegistration } from './plugins/pluginRegistry.js';
import { findOfficialPlugin } from './plugins/officialPluginCatalog.js';
import { ensureOfficialPluginRegistered } from './plugins/officialPluginInstaller.js';
import { serializeScriptError as serializeError } from './scriptErrors.js';

export interface ScriptExecutionOptions extends UnifiedInvokeOptions {
  serverUrl?: string;
  /** Overall deadline, independent of individual action timeouts. Default: 60 seconds. */
  executionTimeoutSec?: number;
  /** Combined stdout/stderr limit in bytes. Default: 256 KiB; maximum: 1 MiB. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  source?: 'cli' | 'mcp' | 'sdk';
}

export interface ScriptExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  session?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    stack?: string;
    details?: unknown;
    stage?: string;
    attempt?: unknown;
  };
  executionStopped: boolean;
  /** Dispatched browser/plugin calls can finish after the script has stopped. */
  mayHaveLateEffects: boolean;
  pendingActions: string[];
}

const METHODS = [...METHOD_ACTIONS.keys(), 'invoke', 'invokePlugin', 'saveArtifact', 'help'];
const MAX_SCRIPT_BYTES = 1024 * 1024;

/** Runs trusted agent code in a short-lived Node process, with one shared SDK client. */
export async function executeScript(
  code: string,
  options: ScriptExecutionOptions = {},
): Promise<ScriptExecutionResult> {
  if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > MAX_SCRIPT_BYTES)
    throw new Error('Script must be non-empty JavaScript of at most 1 MiB');
  const {
    serverUrl,
    executionTimeoutSec = 60,
    maxOutputBytes = 256 * 1024,
    signal,
    source = 'sdk',
    ...defaults
  } = options;
  if (
    !Number.isFinite(executionTimeoutSec) ||
    executionTimeoutSec <= 0 ||
    executionTimeoutSec * 1000 > 2_147_483_647
  )
    throw new Error('executionTimeoutSec must be positive and within the timer range');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 * 1024)
    throw new Error('maxOutputBytes must be an integer between 1 and 1048576');

  const executionDeadline = Date.now() + Math.ceil(executionTimeoutSec * 1000);
  const client = new UnifiedClient({
    serverUrl: serverUrl ?? process.env.MEARL_SERVER_URL ?? loadCloudServerConfig()?.server,
    requestDeadline: executionDeadline,
  });
  let session: ScriptExecutionResult['session'] =
    defaults.session && defaults.session !== 'new' ? { sessionId: defaults.session } : undefined;
  let sessionId = defaults.session;
  let uncertainEffects = false;
  const pending = new Map<number, string>();
  const controller = new AbortController();
  const invoke = async (
    action: string,
    payload: Record<string, any>,
    overrides: UnifiedInvokeOptions = {},
  ) => {
    controller.signal.throwIfAborted();
    const result = await client.invoke(action, payload, {
      ...defaults,
      session: sessionId,
      ...overrides,
    });
    if (result?.action?.stage === 'dispatch-uncertain' || result?.stage === 'dispatch-uncertain')
      uncertainEffects = true;
    if (
      result?.session?.sessionId &&
      (!overrides.session || overrides.session === 'new' || overrides.session === sessionId)
    ) {
      session = result.session;
      if (!overrides.session || overrides.session === 'new') sessionId = result.session.sessionId;
    }
    return result;
  };

  try {
    return await new Promise<ScriptExecutionResult>((resolve, reject) => {
      if (signal?.aborted) {
        resolve({
          success: false,
          stdout: '',
          stderr: '',
          ...(session ? { session } : {}),
          error: { code: 'SCRIPT_CANCELLED', message: 'Script execution cancelled' },
          executionStopped: true,
          mayHaveLateEffects: false,
          pendingActions: [],
        });
        return;
      }
      const child = spawn(process.execPath, [SCRIPT_WORKER_PATH], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'advanced',
        detached: process.platform !== 'win32',
      });
      const output: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
      let outputBytes = 0;
      let outcome: ScriptExecutionResult['error'] | true | undefined;
      let cleanup: Promise<void> | undefined;
      let cleanupError: unknown;
      let pendingActions: string[] = [];
      let closed = false;
      const pluginCalls = new Set<Promise<unknown>>();
      const stop = (error?: ScriptExecutionResult['error']) => {
        if (outcome !== undefined || closed) return;
        outcome = error ?? true;
        pendingActions = [...pending.values()];
        controller.abort();
        client.disconnect();
        if (child.pid) {
          cleanup = stopPluginProcessTree(child.pid).catch(error => {
            cleanupError = error;
            child.kill('SIGKILL');
          });
        }
      };
      const abort = () => stop({ code: 'SCRIPT_CANCELLED', message: 'Script execution cancelled' });
      const timeOut = () =>
        stop({ code: 'SCRIPT_TIMEOUT', message: 'Script execution deadline exceeded' });
      const pastDeadline = () => {
        if (Date.now() < executionDeadline) return false;
        timeOut();
        return true;
      };
      const deadline = setTimeout(timeOut, Math.max(0, executionDeadline - Date.now()));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const appendOutput = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const remaining = maxOutputBytes - outputBytes;
        output[stream].push(chunk.subarray(0, Math.max(0, remaining)));
        outputBytes += Math.min(chunk.length, Math.max(0, remaining));
        if (chunk.length > remaining)
          stop({
            code: 'SCRIPT_OUTPUT_LIMIT',
            message: `Script output exceeded ${maxOutputBytes} bytes`,
          });
      };
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream]!.on('data', (chunk: Buffer) => appendOutput(stream, chunk));
      }
      const runPlugin = async (
        name: string,
        invocation: any,
        overrides: any = {},
        help?: { namespace: string; command?: string },
      ) => {
        if (!findPluginRegistration(name) && findOfficialPlugin(name))
          await ensureOfficialPluginRegistered(name);
        controller.signal.throwIfAborted();
        const pluginOptions = { ...defaults, session: sessionId, ...overrides };
        if (pluginOptions.session === 'new' && !help)
          throw new Error(
            'Create the control session with a browser action before calling a Skill command',
          );
        const operation = executeRegisteredPlugin(
          name,
          invocation,
          {
            invoke: (action, payload = {}, options) => invoke(action, payload, options),
          },
          {
            ...pluginOptions,
            source,
            signal: controller.signal,
            cancellationGraceMs: 50,
            onOutput: appendOutput,
            ...(help ? { help } : {}),
          },
        );
        pluginCalls.add(operation);
        try {
          return await operation;
        } finally {
          pluginCalls.delete(operation);
        }
      };
      const send = (message: unknown) => {
        // A transport timer can settle a pending call before the script timer gets its turn.
        if (outcome !== undefined || !child.connected || pastDeadline()) return;
        child.send(message as any, error => {
          if (error) stop(serializeError(error));
        });
      };
      child.on('message', (message: any) => {
        if (outcome !== undefined || !message || typeof message !== 'object' || pastDeadline())
          return;
        if (message.type === 'done' || message.type === 'error') {
          stop(
            message.type === 'error'
              ? serializeError(message.error)
              : pending.size
                ? {
                    code: 'SCRIPT_PENDING_CALLS',
                    message: 'Script finished with unawaited SDK calls',
                  }
                : undefined,
          );
          return;
        }
        if (message.type !== 'call') return;
        const { id, method, args } = message;
        if (
          !Number.isSafeInteger(id) ||
          pending.has(id) ||
          !METHODS.includes(method) ||
          !Array.isArray(args)
        ) {
          stop({ code: 'SCRIPT_PROTOCOL_ERROR', message: 'Invalid script SDK call' });
          return;
        }
        if (method !== 'help' && sessionId === 'new' && pending.size) {
          send({
            type: 'response',
            id,
            error: {
              code: 'SCRIPT_SESSION_INITIALIZING',
              message: 'Await the first session call before starting concurrent calls',
            },
          });
          return;
        }
        pending.set(
          id,
          method === 'invoke' || method === 'invokePlugin' ? String(args[0]) : method,
        );
        void Promise.resolve()
          .then(async () => {
            if (outcome !== undefined) throw new Error('Script execution stopped');
            if (method === 'help') {
              const target = args[0];
              if (target && typeof target === 'object') {
                if (
                  typeof target.plugin !== 'string' ||
                  !target.plugin.trim() ||
                  (target.command !== undefined && typeof target.command !== 'string')
                )
                  throw new Error('Plugin help requires { plugin, command? }');
                return runPlugin(
                  target.plugin,
                  { command: '', input: {} },
                  {},
                  { namespace: `mearl ${target.plugin}`, command: target.command },
                );
              }
              return getCommandHelp(target);
            }
            if (method === 'invoke') {
              if (!isBrowserCommandAction(args[0]) && args[0] !== 'browser_select_browser')
                throw new Error(
                  `Unsupported browser action: ${args[0]}; use invokePlugin for registered Skill commands`,
                );
              return invoke(args[0], args[1] ?? {}, args[2]);
            }
            if (method === 'invokePlugin') {
              return runPlugin(args[0], args[1], args[2]);
            }
            if (method === 'saveArtifact')
              return exportArtifact({ invoke }, args[0], args[1], {
                ...defaults,
                session: sessionId,
                ...args[2],
              });
            const optionsOnly =
              (OPTIONS_ONLY.has(method) &&
                !(
                  method === 'browserList' &&
                  args[0] &&
                  ('provider' in args[0] || 'launchForm' in args[0])
                )) ||
              (method === 'browserRelease' && args.length < 2);
            return invoke(
              METHOD_ACTIONS.get(method)!,
              optionsOnly ? {} : (args[0] ?? {}),
              optionsOnly ? args[0] : args[1],
            );
          })
          .then(
            result => send({ type: 'response', id, result, session }),
            error => send({ type: 'response', id, error: serializeError(error), session }),
          )
          .finally(() => pending.delete(id));
      });
      child.once('error', error => {
        stop(serializeError(error));
      });
      child.once('exit', () => {
        if (outcome === undefined)
          stop({
            code: 'SCRIPT_EXITED',
            message: 'Script process exited before reporting completion',
          });
      });
      child.once('close', () => {
        closed = true;
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        void Promise.allSettled([cleanup, ...pluginCalls])
          .then(outcomes => {
            if (
              outcomes.some(
                result =>
                  result.status === 'rejected' &&
                  (result.reason as any)?.code === 'PLUGIN_EXECUTOR_CLEANUP_FAILED',
              )
            )
              cleanupError = new Error('Unable to confirm Skill process cleanup');
            const error = cleanupError
              ? serializeError(cleanupError, 'SCRIPT_CLEANUP_FAILED')
              : outcome === true
                ? undefined
                : outcome;
            resolve({
              success: !error && outcome === true,
              stdout: Buffer.concat(output.stdout).toString('utf8'),
              stderr: Buffer.concat(output.stderr).toString('utf8'),
              ...(session ? { session } : {}),
              ...(error ? { error } : {}),
              executionStopped: !cleanupError,
              mayHaveLateEffects: pendingActions.length > 0 || uncertainEffects,
              pendingActions,
            });
          })
          .catch(reject);
      });
      send({ type: 'start', code, methods: METHODS, session });
    });
  } finally {
    client.disconnect();
  }
}
