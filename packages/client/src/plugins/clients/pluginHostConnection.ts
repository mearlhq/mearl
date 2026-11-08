import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { PLUGIN_TASK_HOST_PATH } from '../../runtimePaths.js';
import {
  claimRecord,
  isProcessOwnerAlive,
  processIdentity,
  readRecord,
  removeInvalidRecord,
  removeRecordIfPid,
  rotateLogIfNeeded,
} from '@mearl/daemon-core';
import { pluginHostPaths } from '../runtime/pluginHostPaths.js';

import { PLUGIN_TASK_PROTOCOL_VERSION } from '@mearl/browser-core';
import type {
  PluginInvocationSource,
  PluginExecutionHost,
} from '@mearl/browser-core';
import type { PluginExecutionContext } from '../sdk/plugin.js';
import type { PluginTaskScope } from '../pluginTaskProtocol.js';
import { readPluginTaskMessages, writePluginTaskMessage } from '../pluginTaskWire.js';
import {
  pluginExecutionError,
  serializePluginExecutionError,
} from '../runtime/pluginExecutorProtocol.js';

export interface PluginHostConnectionOptions {
  source?: PluginInvocationSource;
  plugin?: string;
  access?: 'public' | 'toolbox' | 'runtime';
  invoke?: PluginExecutionContext['invoke'];
  runtimePath?: string;
  socketPath?: string;
  autoStart?: boolean;
  scopeId?: string;
}

export interface PluginHostClientOptions extends PluginHostConnectionOptions {
  /** The creator owns an injected connection; disconnecting a service client leaves it open. */
  connection?: PluginHostConnection;
}

export interface HostStatus {
  protocolVersion: number;
  version?: string;
  buildId?: string;
  host: PluginExecutionHost;
  pid: number;
}
interface TaskConnection {
  socket: Socket;
  request: (method: string, input?: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
  status: HostStatus;
}
const starting = new Map<string, Promise<void>>();

async function ensureHost(runtimePath: string): Promise<void> {
  const paths = pluginHostPaths();
  let work = starting.get(paths.registry);
  if (!work) {
    work = (async () => {
      const lease = readRecord(paths.lease);
      if (lease && isProcessOwnerAlive(lease)) {
        if (lease.protocolVersion !== PLUGIN_TASK_PROTOCOL_VERSION)
          throw new Error(
            'Plugin execution service protocol differs; stop the service before updating',
          );
        return;
      }
      const lock = `${paths.lease}.start`;
      const existing = readRecord(lock);
      if (existing && isProcessOwnerAlive(existing)) return;
      if (existing) removeRecordIfPid(lock, existing.pid);
      else removeInvalidRecord(lock);
      if (!claimRecord(lock, { pid: process.pid, processIdentity: processIdentity(process.pid) }))
        return;
      try {
        const owner = readRecord(paths.lease);
        if (owner && isProcessOwnerAlive(owner)) return;
        mkdirSync(paths.home, { recursive: true, mode: 0o700 });
        rotateLogIfNeeded(paths.log);
        const log = openSync(paths.log, 'a', 0o600);
        try {
          const child = spawn(process.execPath, [runtimePath], {
            detached: true,
            stdio: ['ignore', log, log],
            windowsHide: true,
          });
          await new Promise<void>((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
          });
          child.unref();
        } finally {
          closeSync(log);
        }
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const ready = await new Promise<boolean>(resolve => {
            const probe = createConnection(paths.socket);
            const finish = (value: boolean) => {
              probe.destroy();
              resolve(value);
            };
            probe.once('connect', () => finish(true));
            probe.once('error', () => finish(false));
            probe.setTimeout(200, () => finish(false));
          });
          if (ready) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Plugin execution service startup timed out');
      } finally {
        removeRecordIfPid(lock, process.pid);
      }
    })().finally(() => starting.delete(paths.registry));
    starting.set(paths.registry, work);
  }
  await work;
}

/** One connection owns caller scope, discovery and bridge lifetime. */
export class PluginHostConnection {
  get hasInvocationBridge(): boolean {
    return Boolean(this.configuration.invoke);
  }
  private connection?: Promise<TaskConnection>;
  private socket?: Socket;
  private readonly opening = new Set<Socket>();
  private generation = 0;
  constructor(private readonly configuration: PluginHostConnectionOptions = {}) {}

  private async connect(generation: number): Promise<TaskConnection> {
    const check = () => {
      if (generation !== this.generation)
        throw Object.assign(new Error('Plugin task client was disconnected'), {
          code: 'PLUGIN_TASK_CLIENT_DISCONNECTED',
        });
    };
    const connectOnce = () => {
      check();
      return this.open(this.configuration.socketPath ?? pluginHostPaths().socket, generation);
    };
    try {
      return await connectOnce();
    } catch (error) {
      check();
      if (this.configuration.autoStart === false || this.configuration.socketPath) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!['ENOENT', 'ECONNREFUSED', 'PLUGIN_TASK_CONNECTION_LOST'].includes(code ?? ''))
        throw error;
    }
    await ensureHost(this.configuration.runtimePath ?? PLUGIN_TASK_HOST_PATH);
    const deadline = Date.now() + 10000;
    let failure: unknown;
    do {
      check();
      try {
        return await connectOnce();
      } catch (error) {
        failure = error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } while (Date.now() < deadline);
    throw new Error('Plugin execution service did not become ready; inspect its service.log', {
      cause: failure,
    });
  }

  private async open(socketPath: string, generation: number): Promise<TaskConnection> {
    const socket = createConnection(socketPath);
    this.opening.add(socket);
    const pending = new Map<
      number,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let sequence = 0;
    const fail = (error: Error) => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
    };
    socket.on('error', fail);
    socket.once('close', () => {
      fail(
        Object.assign(new Error('Plugin execution service connection was lost'), {
          code: 'PLUGIN_TASK_CONNECTION_LOST',
        }),
      );
      if (this.socket === socket) {
        this.connection = undefined;
        this.socket = undefined;
      }
    });
    const request: TaskConnection['request'] = (method, input = {}, timeoutMs = 15000) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            Object.assign(
              new Error('Plugin task request timed out; the task may still be running'),
              { code: 'PLUGIN_TASK_REQUEST_TIMEOUT' },
            ),
          );
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        void writePluginTaskMessage(socket, { type: 'request', id, method, input }).catch(error => {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        });
      });
    readPluginTaskMessages(socket, message => {
      if (message.type === 'response') {
        const call = pending.get(message.id);
        if (!call) return;
        clearTimeout(call.timer);
        pending.delete(message.id);
        if (message.error) call.reject(pluginExecutionError(message.error));
        else call.resolve(message.result);
      } else if (message.type === 'invoke') {
        void Promise.resolve()
          .then(() => {
            if (!this.configuration.invoke)
              throw new Error('Plugin task client has no invocation bridge');
            return this.configuration.invoke(message.action, message.payload, message.options);
          })
          .then(
            result =>
              writePluginTaskMessage(socket, { type: 'invoke-result', id: message.id, result }),
            error =>
              writePluginTaskMessage(socket, {
                type: 'invoke-result',
                id: message.id,
                error: serializePluginExecutionError(error),
              }),
          )
          .catch(() => {});
      } else socket.destroy(new Error('Invalid plugin task response direction'));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('Plugin task connection timed out'));
        }, 2000);
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', error => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const scope: PluginTaskScope = {
        access: this.configuration.access ?? 'public',
        source: this.configuration.source ?? 'sdk',
        bridge: this.configuration.invoke ? 'caller' : 'service',
        ...(this.configuration.plugin ? { plugin: this.configuration.plugin } : {}),
        ...(this.configuration.scopeId ? { scopeId: this.configuration.scopeId } : {}),
      };
      const status: HostStatus = await request('hello', {
        ...scope,
        protocolVersion: PLUGIN_TASK_PROTOCOL_VERSION,
      });
      if (status.protocolVersion !== PLUGIN_TASK_PROTOCOL_VERSION)
        throw new Error('Plugin task protocol version mismatch');
      if (generation !== this.generation || socket.destroyed)
        throw new Error('Plugin task client was disconnected');
      this.socket = socket;
      return { socket, request, status };
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      this.opening.delete(socket);
    }
  }

  async request(
    method: string,
    input: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<any> {
    if (!this.connection) {
      const attempt = this.connect(this.generation);
      this.connection = attempt;
      void attempt.catch(() => {
        if (this.connection === attempt) this.connection = undefined;
      });
    }
    const connection = await this.connection;
    // The handshake protocol defines compatibility; build identity is diagnostic metadata.
    return connection.request(method, input, timeoutMs);
  }

  disconnect(): void {
    this.generation++;
    this.socket?.destroy();
    for (const socket of this.opening) socket.destroy();
    this.socket = undefined;
    this.connection = undefined;
  }
}
