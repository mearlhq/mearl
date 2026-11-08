import { CLIENT_VERSION } from '../../runtimePaths.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { chmodSync, rmSync } from 'node:fs';
import {
  claimRecord,
  isProcessOwnerAlive,
  processIdentity,
  readRecord,
  removeInvalidRecord,
  removeRecordIfPid,
  writeRecordIfPid,
} from '@mearl/daemon-core';
import { PLUGIN_TASK_PROTOCOL_VERSION } from '@mearl/browser-core';
import { pluginHostPaths } from './pluginHostPaths.js';
import { PluginHost } from './pluginHost.js';
import type { PluginTaskManagerOptions, PluginTaskBridge } from './pluginTaskManager.js';
import type {
  PluginTaskScope,
  PluginTaskStartRequest,
  PluginTaskResumeRequest,
} from '../pluginTaskProtocol.js';
import type { PluginDiagnosticOptions } from '@mearl/browser-core';
import { readPluginTaskMessages, writePluginTaskMessage } from '../pluginTaskWire.js';
import { pluginExecutionError, serializePluginExecutionError } from './pluginExecutorProtocol.js';

export async function startPluginHostServer(configuration: PluginTaskManagerOptions = {}) {
  const paths = pluginHostPaths();
  const existing = readRecord(paths.lease);
  if (existing && !isProcessOwnerAlive(existing)) removeRecordIfPid(paths.lease, existing.pid);
  else if (!existing) removeInvalidRecord(paths.lease);
  const owner = {
    pid: process.pid,
    protocolVersion: PLUGIN_TASK_PROTOCOL_VERSION,
    version: CLIENT_VERSION,
    processIdentity: processIdentity(process.pid),
  };
  if (!claimRecord(paths.lease, owner))
    throw Object.assign(new Error('Plugin execution service already has an owner'), {
      code: 'PLUGIN_TASK_HOST_OWNED',
    });
  let host: PluginHost;
  try {
    host = new PluginHost(configuration);
  } catch (error) {
    removeRecordIfPid(paths.lease, process.pid);
    throw error;
  }
  const { tasks: manager, pages, state, models } = host;
  if (
    !writeRecordIfPid(paths.lease, process.pid, {
      ...owner,
      ...manager.host,
      socketPath: paths.socket,
      startedAt: new Date().toISOString(),
    })
  )
    throw new Error('Plugin host lease ownership was lost');
  const sessions = new Set<Socket>();
  let closing: Promise<void> | undefined;
  const server = createServer(socket => {
    sessions.add(socket);
    const disconnected = new AbortController();
    let scope: PluginTaskScope | undefined;
    let sequence = 0;
    let requests = 0;
    const pending = new Map<
      number,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const bridge: PluginTaskBridge = {
      id: randomUUID(),
      get scope() {
        if (!scope) throw new Error('Plugin task connection is not initialized');
        return scope;
      },
      invoke(action, payload, options) {
        if (socket.destroyed)
          return Promise.reject(
            Object.assign(new Error('The browser invocation bridge is unavailable'), {
              code: 'PLUGIN_TASK_BRIDGE_UNAVAILABLE',
            }),
          );
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => {
              pending.delete(id);
              reject(
                Object.assign(
                  new Error(
                    'The browser invocation bridge timed out; external operation status is unknown',
                  ),
                  { code: 'PLUGIN_TASK_BRIDGE_UNAVAILABLE', details: { action } },
                ),
              );
            },
            Math.min(Math.max(options.timeoutSec ?? 180, 1), 3600) * 1000,
          );
          pending.set(id, { resolve, reject, timer });
          void writePluginTaskMessage(socket, {
            type: 'invoke',
            id,
            action,
            payload,
            options,
          }).catch(error => {
            pending.delete(id);
            clearTimeout(timer);
            reject(error);
          });
        });
      },
    };

    const handle = async (method: string, input: Record<string, unknown>): Promise<unknown> => {
      if (method === 'hello') {
        if (scope || input.protocolVersion !== PLUGIN_TASK_PROTOCOL_VERSION)
          throw new Error('Plugin task protocol version mismatch');
        if (
          !['public', 'toolbox', 'runtime'].includes(String(input.access)) ||
          !['service', 'caller'].includes(String(input.bridge)) ||
          !['cli', 'sdk', 'mcp', 'toolbox', 'runtime'].includes(String(input.source)) ||
          (input.plugin !== undefined &&
            (typeof input.plugin !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(input.plugin))) ||
          (input.scopeId !== undefined &&
            (typeof input.scopeId !== 'string' || input.scopeId.length > 256)) ||
          (input.access !== 'public' && (!input.plugin || input.bridge !== 'caller'))
        )
          throw new Error('Invalid plugin task caller scope');
        scope = {
          access: input.access as PluginTaskScope['access'],
          bridge: input.bridge as PluginTaskScope['bridge'],
          source: input.source as PluginTaskScope['source'],
          ...(input.plugin ? { plugin: String(input.plugin) } : {}),
          ...(input.scopeId ? { scopeId: String(input.scopeId) } : {}),
        };
        return {
          protocolVersion: PLUGIN_TASK_PROTOCOL_VERSION,
          version: CLIENT_VERSION,
                host: manager.host,
          pid: process.pid,
        };
      }
      if (!scope) throw new Error('Plugin task connection requires a handshake');
      if (method === 'status')
        return {
          protocolVersion: PLUGIN_TASK_PROTOCOL_VERSION,
          version: CLIENT_VERSION,
                host: manager.host,
          pid: process.pid,
        };
      if (method === 'diagnose') return host.diagnose(input as PluginDiagnosticOptions, scope);
      if (method === 'state.call')
        return state.call(
          String(input.plugin),
          input.input as Record<string, unknown>,
          bridge,
          input.options as Record<string, unknown>,
        );
      if (method === 'model.list') return models.list(input.provider);
      if (method === 'model.capabilities')
        return (await import('../sdk/pluginModelDefinition.js')).pluginModelCapabilities();
      if (method === 'page.call') {
        const execution = input.execution as
          | { cwd: string; environment: Record<string, string> }
          | undefined;
        return pages.call(
          String(input.plugin),
          input.input as Record<string, unknown>,
          bridge,
          input.options as Record<string, unknown>,
          execution
            ? {
                cwd: execution.cwd,
                environment: execution.environment,
                signal: disconnected.signal,
              }
            : undefined,
        );
      }
      if (method === 'page.event') {
        if (scope.access !== 'runtime')
          throw new Error('Page events require the browser runtime bridge');
        return pages.receive(
          String(input.plugin),
          input.input as Record<string, unknown>,
          bridge,
          input.options as Record<string, unknown>,
        );
      }
      if (method === 'start')
        return manager.start(input as unknown as PluginTaskStartRequest, bridge);
      if (method === 'resume')
        return manager.resume(input as unknown as PluginTaskResumeRequest, bridge);
      if (method === 'list')
        return manager.list(
          scope,
          input.activeOnly === true,
          input.cursor as string | undefined,
          input.limit as number | undefined,
        );
      if (method === 'shutdown') {
        if (scope.access !== 'public') throw new Error('Tool pages cannot stop the plugin host');
        return { stopped: true };
      }
      if (typeof input.taskId !== 'string') throw new Error('Plugin task ID is required');
      switch (method) {
        case 'get':
          return manager.get(input.taskId, scope);
        case 'checkpoint':
          return manager.checkpoint(input.taskId, scope);
        case 'cancel':
          return manager.cancel(input.taskId, scope);
        case 'events':
          return manager.events(
            input.taskId,
            scope,
            input.cursor as number,
            input.waitMs as number | undefined,
            disconnected.signal,
          );
        case 'result':
          return manager.resultChunk(input.taskId, scope, input.index as number);
        default:
          throw new Error(`Unknown plugin task method: ${method}`);
      }
    };

    readPluginTaskMessages(socket, message => {
      if (message.type === 'invoke-result') {
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(message.id);
        if (message.error) request.reject(pluginExecutionError(message.error));
        else request.resolve(message.result);
      } else if (message.type === 'request') {
        if (
          ++requests > 64 ||
          !message.input ||
          typeof message.input !== 'object' ||
          Array.isArray(message.input)
        ) {
          socket.destroy(new Error('Invalid or excessive plugin task requests'));
          return;
        }
        void Promise.resolve()
          .then(() => handle(message.method, message.input))
          .then(
            async result => {
              await writePluginTaskMessage(socket, { type: 'response', id: message.id, result });
              if (message.method === 'shutdown')
                setImmediate(() => {
                  void close().catch(() => {});
                });
            },
            error =>
              writePluginTaskMessage(socket, {
                type: 'response',
                id: message.id,
                error: serializePluginExecutionError(error),
              }),
          )
          .catch(() => socket.destroy())
          .finally(() => {
            requests--;
          });
      } else socket.destroy(new Error('Invalid plugin task message direction'));
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      disconnected.abort();
      sessions.delete(socket);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(
          Object.assign(
            new Error(
              'The invocation bridge disconnected; external operation status may need reconciliation',
            ),
            { code: 'PLUGIN_TASK_BRIDGE_UNAVAILABLE' },
          ),
        );
      }
      pending.clear();
    });
  });

  async function close(): Promise<void> {
    closing ??= (async () => {
      const servicesClosed = host.close();
      for (const socket of sessions) socket.destroy();
      await servicesClosed;
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (removeRecordIfPid(paths.lease, process.pid) && process.platform !== 'win32')
        rmSync(paths.socket, { force: true });
    })();
    return closing;
  }

  try {
    if (process.platform !== 'win32') rmSync(paths.socket, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(paths.socket, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') chmodSync(paths.socket, 0o600);
  } catch (error) {
    removeRecordIfPid(paths.lease, process.pid);
    await host.close();
    throw error;
  }
  return { close, host, socketPath: paths.socket };
}
