/** WebSocket CDP client shared by local and remote browser sessions. */

import WebSocket, { type RawData } from 'ws';
import { createHash } from 'node:crypto';

type EventCallback = (params: any) => void;

interface PendingRequest {
  resolve: (r: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId?: string;
}

export class CdpChildSession {
  getDefaultExecutionContexts(): ReadonlyMap<string, number> { return this.parent.getDefaultExecutionContexts(this.sessionId); }
  constructor(
    private readonly parent: CdpClient,
    readonly sessionId: string,
  ) {}

  sendCommand(method: string, params?: Record<string, any>, timeoutMs = 30000): Promise<any> {
    return this.parent.sendCommandInSession(this.sessionId, method, params, timeoutMs);
  }

  on(method: string, callback: EventCallback): () => void {
    return this.parent.onSession(this.sessionId, method, callback);
  }

  createChildSession(sessionId: string): CdpChildSession {
    return this.parent.createChildSession(sessionId);
  }

  get closed(): boolean {
    return this.parent.closed;
  }

  close(): void {
    // The child shares the browser-level connection with its parent.
  }
}

export class CdpClient {
  /** Stable across reconnects to one browser endpoint without exposing its credentials. */
  get identity(): string {
    return createHash('sha256').update(this.socket.url).digest('hex');
  }
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private eventHandlers = new Map<string, Set<EventCallback>>();
  private sessionEventHandlers = new Map<string, Map<string, Set<EventCallback>>>();
  private _closed = false;
  private defaultContexts = new Map<string, Map<string, number>>();

  /** Contexts emitted before a page subsystem starts listening remain available for reconnection. */
  getDefaultExecutionContexts(sessionId = ''): ReadonlyMap<string, number> { return new Map(this.defaultContexts.get(sessionId)); }

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', data => this.consumeMessage(data));
    socket.on('close', () => this.handleClosed());
    socket.on('error', () => this.handleClosed());
  }

  static connect(wsUrl: string, handshakeTimeoutMs = 5000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(wsUrl);
      } catch {
        reject(new Error('Invalid CDP WebSocket URL'));
        return;
      }
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        reject(new Error(`Unsupported CDP WebSocket protocol: ${url.protocol}`));
        return;
      }

      const socket = new WebSocket(url, {
        handshakeTimeout: handshakeTimeoutMs,
        maxPayload: 64 * 1024 * 1024,
        perMessageDeflate: false,
      });
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(error);
      };

      socket.once('open', () => {
        if (settled) return;
        settled = true;
        resolve(new CdpClient(socket));
      });
      socket.once('error', fail);
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        fail(new Error(`CDP WebSocket upgrade failed with status ${response.statusCode ?? 0}`));
      });
    });
  }

  createChildSession(sessionId: string): CdpChildSession {
    return new CdpChildSession(this, sessionId);
  }

  sendCommandInSession(
    sessionId: string,
    method: string,
    params?: Record<string, any>,
    timeoutMs = 30000,
  ): Promise<any> {
    return this.sendRequest(method, params, timeoutMs, sessionId);
  }

  onSession(sessionId: string, method: string, callback: EventCallback): () => void {
    if (!this.sessionEventHandlers.has(sessionId)) {
      this.sessionEventHandlers.set(sessionId, new Map());
    }
    const sessionMap = this.sessionEventHandlers.get(sessionId)!;
    if (!sessionMap.has(method)) sessionMap.set(method, new Set());
    sessionMap.get(method)!.add(callback);
    return () => sessionMap.get(method)?.delete(callback);
  }

  sendCommand(method: string, params?: Record<string, any>, timeoutMs = 30000): Promise<any> {
    return this.sendRequest(method, params, timeoutMs);
  }

  on(method: string, callback: EventCallback): () => void {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, new Set());
    this.eventHandlers.get(method)!.add(callback);
    return () => this.eventHandlers.get(method)?.delete(callback);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.socket.terminate();
    this.defaultContexts.clear();
    this.rejectPending('CDP connection closed');
  }

  get closed(): boolean {
    return this._closed;
  }

  private sendRequest(
    method: string,
    params: Record<string, any> | undefined,
    timeoutMs: number,
    sessionId?: string,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this._closed || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('CDP client is closed'));
        return;
      }

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, sessionId });
      this.socket.send(
        JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }),
        error => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(error);
        },
      );
    });
  }

  private consumeMessage(data: RawData): void {
    try {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data).toString('utf8');
      this.handleMessage(JSON.parse(text));
    } catch {
      // Ignore malformed messages from the remote endpoint.
    }
  }

  private handleMessage(msg: any): void {
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result ?? {});
      }
      return;
    }

    if (!msg.method) return;
    const key = typeof msg.sessionId === 'string' ? msg.sessionId : '';
    if (msg.method === 'Runtime.executionContextsCleared') this.defaultContexts.delete(key);
    else if (msg.method === 'Runtime.executionContextCreated') {
      const context = msg.params?.context;
      if (context?.auxData?.isDefault === true && typeof context.auxData.frameId === 'string' && typeof context.id === 'number') {
        if (!this.defaultContexts.has(key)) this.defaultContexts.set(key, new Map());
        this.defaultContexts.get(key)!.set(context.auxData.frameId, context.id);
      }
    } else if (msg.method === 'Runtime.executionContextDestroyed') {
      for (const [frame, id] of this.defaultContexts.get(key) ?? []) if (id === msg.params?.executionContextId) this.defaultContexts.get(key)!.delete(frame);
    } else if (msg.method === 'Target.detachedFromTarget') this.defaultContexts.delete(msg.params?.sessionId);
    const handlers = msg.sessionId
      ? this.sessionEventHandlers.get(msg.sessionId)?.get(msg.method)
      : this.eventHandlers.get(msg.method);
    if (!handlers) return;
    for (const callback of handlers) {
      try {
        callback(msg.params);
      } catch {
        // Event consumers are isolated from the CDP connection.
      }
    }
  }

  private handleClosed(): void {
    if (this._closed) return;
    this._closed = true;
    this.defaultContexts.clear();
    this.rejectPending('CDP connection closed');
  }

  private rejectPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
  }
}
