import WebSocket, { WebSocket as WebSocketType, WebSocketServer } from 'ws';
import { createServer as createHttpServer, IncomingMessage } from 'node:http';
import { chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { writeRecord } from '@mearl/daemon-core';
import { CONFIG_DIR, CONFIG_FILE } from './paths.js';
import { formatConnectorCommand, resolveCloudPublicEndpoint } from './publicEndpoint.js';

import {
  AgentHelloMessage,
  CloudMessage,
  CloudConnectorInfo,
  CloudConnectorListResult,
  CloudResponse,
  ConnectorHelloMessage,
  HeartbeatMessage,
  isAgentHelloMessage,
  isConnectorHelloMessage,
  isHeartbeatMessage,
  isCloudMessage,
  isCloudResponse,
  resolveCloudConnectorSelector,
  MAX_BUFFER_SIZE,
  DEFAULT_HEARTBEAT_TIMEOUT,
  DEFAULT_REQUEST_TIMEOUT,
} from '@mearl/cloud-types';
import { resolveActionTimeoutSec } from '@mearl/client/action-timeouts';

export interface CloudServerOptions {
  port?: number;
  /** Loopback-only port for the co-located unified client. Defaults to port + 1. */
  agentPort?: number;
  path?: string;
  token?: string;
  heartbeatTimeout?: number;
  maxConnections?: number;
  maxMessageSize?: number;
  requestTimeout?: number;
  /** Escape hatch: allow agents (command issuers) to connect from the network. Default false. */
  allowRemoteAgent?: boolean;
}

/** Runtime info about a started server, also persisted to the config file. */
export interface ServerInfo {
  pid: number;
  port: number;
  path: string;
  token: string;
  /** URL for @mearl/client running on the same machine (localhost). */
  localUrl: string;
  /** URL for the local connector to dial back into this server. */
  publicUrl: string;
  /** Ready-to-paste command for the local machine. */
  connectorCommand: string;
  /** ISO timestamp of when the server started listening. */
  startedAt: string;
}

const DEFAULT_PORT = 8080;
const DEFAULT_PATH = '/ws';
const DEFAULT_MAX_CONNECTIONS = 100;
const DEFAULT_MAX_MESSAGE_SIZE = 10 * 1024 * 1024;
const RESPONSE_GRACE_MS = 5000;
const LEGACY_CONNECTOR_HELLO_GRACE_MS = 1000;

interface ClientConnection {
  ws: WebSocketType;
  id: string;
  lastHeartbeat: number;
  connectedAt: number;
  role: 'agent' | 'connector' | 'pending';
  connector?: {
    connectorId: string;
    name: string;
    version?: string;
  };
  /** True when the connection arrived on the loopback-only agent listener. */
  fromLocal: boolean;
  messageBuffer: string;
}

export class CloudServer {
  private options: Required<Omit<CloudServerOptions, 'token'>> & { token?: string };
  private connectorWss: WebSocketServer | null = null;
  private agentWss: WebSocketServer | null = null;
  private connectorHttpServer: ReturnType<typeof createHttpServer> | null = null;
  private agentHttpServer: ReturnType<typeof createHttpServer> | null = null;
  private connections = new Map<WebSocketType, ClientConnection>();
  private pendingRequests = new Map<
    string,
    {
      agentRequestId: string;
      agentWs: WebSocketType;
      connectorWs: WebSocketType;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CloudServerOptions = {}) {
    const port = options.port ?? DEFAULT_PORT;
    this.options = {
      port,
      agentPort: options.agentPort ?? port + 1,
      path: options.path ?? DEFAULT_PATH,
      token: options.token,
      heartbeatTimeout: options.heartbeatTimeout ?? DEFAULT_HEARTBEAT_TIMEOUT,
      maxConnections: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      maxMessageSize: options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE,
      requestTimeout: options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
      allowRemoteAgent: options.allowRemoteAgent ?? false,
    };
  }

  getToken(): string {
    if (!this.options.token) {
      this.options.token = this.generateRandomToken();
    }
    return this.options.token;
  }

  private generateRandomToken(): string {
    return randomBytes(24).toString('base64url');
  }

  async start(): Promise<ServerInfo> {
    // Validate deployment configuration before opening either listener.
    const ingressUrl = resolveCloudPublicEndpoint(this.options.port);
    const token = this.getToken();

    // Two listeners with different trust levels, sharing all connection state:
    //  - Agent listener: bound to 127.0.0.1 only. The co-located unified client
    //    dials in here. The kernel drops any non-local packet, so the authority
    //    to ISSUE commands (drive the browser) is physically pinned to this box.
    //  - Connector listener: bound to 0.0.0.0. The remote connector dials in
    //    here to RECEIVE commands. A connection on this listener is never
    //    allowed to act as an agent (see handleRequest).
    await this.createListener(this.options.agentPort, '127.0.0.1', true);
    await this.createListener(this.options.port, '0.0.0.0', false);

    // The co-located agent connects to the loopback agent port.
    const localWsUrl = `ws://localhost:${this.options.agentPort}${this.options.path}?token=${token}`;

    let publicWsUrl: string;
    if (ingressUrl) {
      const parsedUrl = new URL(ingressUrl);
      parsedUrl.protocol = ['http:', 'ws:'].includes(parsedUrl.protocol) ? 'ws:' : 'wss:';
      if (parsedUrl.pathname === '/') parsedUrl.pathname = this.options.path;
      parsedUrl.searchParams.set('token', token);
      publicWsUrl = parsedUrl.toString();
    } else {
      const publicHost = process.env.CLOUD_SERVER_HOST || this.getPublicIP();
      publicWsUrl = `ws://${publicHost}:${this.options.port}${this.options.path}?token=${token}`;
    }

    if (publicWsUrl.startsWith('ws://') && !publicWsUrl.startsWith('ws://localhost')) {
      console.warn(
        '[CloudServer] Connector traffic is using unencrypted ws://. ' +
          'Use a TLS-terminating proxy and wss:// when the connection crosses a trusted network.',
      );
    }

    const connectorCommand = formatConnectorCommand(publicWsUrl);

    console.log(
      `[CloudServer] Connector listener on 0.0.0.0:${this.options.port} (network); ` +
        `agent listener on 127.0.0.1:${this.options.agentPort} (local only)`,
    );
    console.log(`[CloudServer] Connect from local machine:`);
    console.log(`  ${connectorCommand}`);

    this.startHeartbeatCheck();

    const info: ServerInfo = {
      pid: process.pid,
      port: this.options.port,
      path: this.options.path,
      token,
      localUrl: localWsUrl,
      publicUrl: publicWsUrl,
      connectorCommand,
      startedAt: new Date().toISOString(),
    };
    this.writeConfigFile(info);
    return info;
  }

  /**
   * Stand up one HTTP+WebSocket listener. `fromLocal` tags every connection
   * accepted here so handleRequest can pin command-issuing authority to the
   * loopback listener.
   */
  private createListener(port: number, host: string, fromLocal: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const httpServer = createHttpServer((req, res) => {
        console.log(`[CloudServer] HTTP request: ${req.method} ${req.url}`);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found - This is a WebSocket server');
      });

      const wss = new WebSocketServer({
        server: httpServer,
        path: this.options.path,
        maxPayload: this.options.maxMessageSize,
      });

      wss.on('connection', (ws: WebSocketType, req: IncomingMessage) => {
        console.log(
          `[CloudServer] New ${fromLocal ? 'agent' : 'connector'} connection from ` +
            `${req.socket.remoteAddress}, path: ${req.url}`,
        );
        this.handleConnection(ws, req, fromLocal);
      });

      wss.on('error', (error: Error) => {
        console.error('[CloudServer] WebSocket server error:', error.message);
      });

      httpServer.on('error', (error: Error) => {
        console.error('[CloudServer] HTTP server error:', error.message);
        reject(error);
      });

      if (fromLocal) {
        this.agentWss = wss;
        this.agentHttpServer = httpServer;
      } else {
        this.connectorWss = wss;
        this.connectorHttpServer = httpServer;
      }

      httpServer.listen(port, host, () => {
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise(resolve => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }

      for (const [ws] of this.connections) {
        ws.close();
      }
      this.connections.clear();
      for (const pending of this.pendingRequests.values()) {
        clearTimeout(pending.timer);
      }
      this.pendingRequests.clear();

      this.agentWss?.close();
      this.connectorWss?.close();
      this.agentWss = null;
      this.connectorWss = null;

      const servers = [this.agentHttpServer, this.connectorHttpServer].filter(
        (s): s is ReturnType<typeof createHttpServer> => s !== null,
      );
      this.agentHttpServer = null;
      this.connectorHttpServer = null;

      if (servers.length === 0) {
        resolve();
        return;
      }

      let remaining = servers.length;
      for (const s of servers) {
        s.close(() => {
          if (--remaining <= 0) resolve();
        });
      }
    });
  }

  private handleConnection(ws: WebSocketType, req: IncomingMessage, fromLocal: boolean): void {
    if (this.connections.size >= this.options.maxConnections) {
      ws.close(1008, 'Server is full');
      return;
    }

    if (this.options.token) {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');
      if (token !== this.options.token) {
        ws.close(1008, 'Unauthorized');
        return;
      }
    }

    const connId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const connection: ClientConnection = {
      ws,
      id: connId,
      lastHeartbeat: Date.now(),
      connectedAt: Date.now(),
      role: fromLocal ? 'agent' : 'pending',
      fromLocal,
      messageBuffer: '',
    };

    this.connections.set(ws, connection);
    console.log(`[CloudServer] Client connected: ${connId} (total: ${this.connections.size})`);

    ws.on('message', (data: Buffer) => {
      const conn = this.connections.get(ws);
      if (!conn) return;

      conn.messageBuffer += data.toString('utf-8');

      if (conn.messageBuffer.length > MAX_BUFFER_SIZE) {
        console.error(
          `[CloudServer] Message buffer exceeds limit for ${connId}, closing connection`,
        );
        ws.close(1008, 'Message too large');
        return;
      }

      let newlineIndex: number;
      while ((newlineIndex = conn.messageBuffer.indexOf('\n')) !== -1) {
        const line = conn.messageBuffer.slice(0, newlineIndex);
        conn.messageBuffer = conn.messageBuffer.slice(newlineIndex + 1);

        if (!line.trim()) continue;

        try {
          const message:
            | CloudMessage
            | CloudResponse
            | HeartbeatMessage
            | AgentHelloMessage
            | ConnectorHelloMessage = JSON.parse(line);
          this.handleMessage(ws, message);
        } catch (error) {
          console.error(`[CloudServer] Failed to parse message from ${connId}:`, line, error);
        }
      }
    });

    ws.on('close', () => {
      this.connections.delete(ws);
      this.rejectPendingForWs(ws);
      console.log(`[CloudServer] Client disconnected: ${connId} (total: ${this.connections.size})`);
    });

    ws.on('error', (error: Error) => {
      console.error(`[CloudServer] Connection error for ${connId}:`, error.message);
    });
  }

  private handleMessage(
    ws: WebSocket,
    message:
      | CloudMessage
      | CloudResponse
      | HeartbeatMessage
      | AgentHelloMessage
      | ConnectorHelloMessage,
  ): void {
    const conn = this.connections.get(ws);
    if (!conn) return;

    if (isHeartbeatMessage(message)) {
      if (message.type === 'ping') {
        ws.send(
          JSON.stringify({ type: 'pong', timestamp: Date.now() } satisfies HeartbeatMessage) + '\n',
        );
        conn.lastHeartbeat = Date.now();
      } else if (message.type === 'pong') {
        conn.lastHeartbeat = Date.now();
      }
      return;
    }

    if (isAgentHelloMessage(message)) {
      this.handleAgentHello(ws);
      return;
    }

    if (isConnectorHelloMessage(message)) {
      this.handleConnectorHello(ws, message);
      return;
    }

    if (isCloudResponse(message)) {
      this.handleResponse(ws, message);
      return;
    }

    if (isCloudMessage(message)) {
      this.handleRequest(ws, message);
      return;
    }
  }

  private handleAgentHello(ws: WebSocketType): void {
    const conn = this.connections.get(ws);
    if (!conn) return;
    if (!conn.fromLocal && !this.options.allowRemoteAgent) {
      ws.close(1008, 'Agent must be local');
      return;
    }
    conn.role = 'agent';
    delete conn.connector;
  }

  private handleConnectorHello(ws: WebSocketType, message: ConnectorHelloMessage): void {
    const conn = this.connections.get(ws);
    if (!conn || conn.fromLocal) {
      ws.close(1008, 'Connector must use the connector listener');
      return;
    }

    for (const [otherWs, other] of this.connections) {
      if (
        otherWs !== ws &&
        other.role === 'connector' &&
        other.connector?.connectorId === message.connectorId
      ) {
        this.connections.delete(otherWs);
        this.rejectPendingForWs(otherWs);
        otherWs.close(1000, 'Connector replaced by a newer connection');
      }
    }

    conn.role = 'connector';
    conn.connector = {
      connectorId: message.connectorId,
      name: message.name,
      ...(message.version ? { version: message.version } : {}),
    };
    console.log(
      `[CloudServer] Connector registered: ${message.name} (${message.connectorId}, v${message.version ?? 'unknown'})`,
    );
  }

  private handleRequest(ws: WebSocket, message: CloudMessage): void {
    const { id, action, data } = message;
    const conn = this.connections.get(ws);
    if (!conn) return;

    if (conn.role !== 'agent') {
      console.warn(
        `[CloudServer] Rejected agent request from non-local connection ${conn.id} (action: ${action})`,
      );
      ws.send(
        JSON.stringify({
          id,
          success: false,
          error:
            this.options.allowRemoteAgent && !conn.fromLocal
              ? 'Remote agents must identify themselves with an agent_hello message before issuing commands.'
              : 'Agent requests are only accepted on the local interface (127.0.0.1). ' +
                'Run @mearl/client on the same machine as cloud-server, or start the ' +
                'server with --allow-remote-agent to override.',
        }) + '\n',
      );
      return;
    }

    if (action === 'connector_list') {
      const response: CloudResponse = {
        id,
        success: true,
        data: this.getConnectorList(),
      };
      ws.send(JSON.stringify(response) + '\n');
      return;
    }

    const target = this.resolveConnector(message.connector);
    if ('error' in target) {
      ws.send(JSON.stringify({ id, success: false, error: target.error }) + '\n');
      return;
    }

    const routeId = randomBytes(12).toString('base64url');

    const requestedTimeoutSec = Number(message.timeoutSec);
    const timeoutSec =
      Number.isFinite(requestedTimeoutSec) && requestedTimeoutSec > 0
        ? Math.min(requestedTimeoutSec, 3600)
        : resolveActionTimeoutSec(action, data, this.options.requestTimeout);

    const timer = setTimeout(
      () => {
        this.pendingRequests.delete(routeId);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id, success: false, error: 'Request timeout' }) + '\n');
        }
      },
      timeoutSec * 1000 + RESPONSE_GRACE_MS,
    );

    this.pendingRequests.set(routeId, {
      agentRequestId: id,
      agentWs: ws,
      connectorWs: target.ws,
      timer,
    });

    target.ws.send(
      JSON.stringify({
        id: routeId,
        action,
        data,
        browser: message.browser,
        ...(message.controlSessionId ? { controlSessionId: message.controlSessionId } : {}),
        timeoutSec,
      }) + '\n',
    );
  }

  private handleResponse(ws: WebSocket, response: CloudResponse): void {
    const conn = this.connections.get(ws);
    if (!conn) return;

    if (conn.role !== 'connector') return;

    const pending = this.pendingRequests.get(response.id);
    if (!pending || pending.connectorWs !== ws) return;

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timer);

    if (pending.agentWs.readyState === WebSocket.OPEN) {
      pending.agentWs.send(
        JSON.stringify({ ...response, id: pending.agentRequestId } satisfies CloudResponse) + '\n',
      );
    }
  }

  private connectorInfo(ws: WebSocketType, conn: ClientConnection): CloudConnectorInfo {
    const pendingRequests = Array.from(this.pendingRequests.values()).filter(
      pending => pending.connectorWs === ws,
    ).length;
    return {
      connectorId: conn.connector?.connectorId ?? conn.id,
      name: conn.connector?.name ?? `legacy-${conn.id.slice(-8)}`,
      ...(conn.connector?.version ? { version: conn.connector.version } : {}),
      connectedAt: new Date(conn.connectedAt).toISOString(),
      lastHeartbeatAt: new Date(conn.lastHeartbeat).toISOString(),
      pendingRequests,
      ...(!conn.connector ? { legacy: true } : {}),
    };
  }

  private getConnectorConnections(): Array<{
    ws: WebSocketType;
    conn: ClientConnection;
    info: CloudConnectorInfo;
  }> {
    const connectors: Array<{
      ws: WebSocketType;
      conn: ClientConnection;
      info: CloudConnectorInfo;
    }> = [];
    for (const [ws, conn] of this.connections) {
      if (
        conn.role === 'pending' &&
        Date.now() - conn.connectedAt >= LEGACY_CONNECTOR_HELLO_GRACE_MS
      ) {
        // Legacy connectors have no hello frame. A short grace period prevents
        // transient health probes from appearing as browser-side machines.
        conn.role = 'connector';
      }
      if (conn.role !== 'connector' || ws.readyState !== WebSocket.OPEN) continue;
      connectors.push({ ws, conn, info: this.connectorInfo(ws, conn) });
    }
    return connectors.sort((a, b) => a.info.name.localeCompare(b.info.name));
  }

  private getConnectorList(): CloudConnectorListResult {
    const connectors = this.getConnectorConnections().map(({ info }) => info);
    return { count: connectors.length, connectors };
  }

  private resolveConnector(
    selector: string | undefined,
  ): { ws: WebSocketType; info: CloudConnectorInfo } | { error: string } {
    const connectors = this.getConnectorConnections();
    if (connectors.length === 0) return { error: 'No local connector available' };
    const available = connectors.map(({ info }) => `${info.name} [${info.connectorId}]`).join(', ');

    if (!selector) {
      if (connectors.length === 1) {
        return { ws: connectors[0]!.ws, info: connectors[0]!.info };
      }
      return {
        error:
          `Multiple cloud connectors are connected (${connectors.length}). ` +
          `Pass --connector <id|name>. Available: ${available}`,
      };
    }

    const selection = resolveCloudConnectorSelector(
      connectors.map(({ info }) => info),
      selector,
    );
    if (selection.status === 'matched') {
      const matched = connectors.find(({ info }) => info === selection.connector)!;
      return { ws: matched.ws, info: matched.info };
    }

    if (selection.status === 'ambiguous') {
      return {
        error: `Cloud connector selector "${selector}" is ambiguous. Available: ${available}`,
      };
    }
    return {
      error: `No cloud connector matches "${selector}". Available: ${available}`,
    };
  }

  private rejectPendingForWs(ws: WebSocketType): void {
    this.pendingRequests.forEach((pending, id) => {
      if (pending.agentWs !== ws && pending.connectorWs !== ws) return;

      clearTimeout(pending.timer);
      this.pendingRequests.delete(id);

      if (
        pending.connectorWs === ws &&
        pending.agentWs !== ws &&
        pending.agentWs.readyState === WebSocket.OPEN
      ) {
        pending.agentWs.send(
          JSON.stringify({
            id: pending.agentRequestId,
            success: false,
            error: 'Connector connection closed',
          }) + '\n',
        );
      }
    });
  }

  private startHeartbeatCheck(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const timeoutMs = this.options.heartbeatTimeout * 1000;

      for (const [ws, conn] of this.connections) {
        if (now - conn.lastHeartbeat > timeoutMs) {
          console.log(`[CloudServer] Client ${conn.id} heartbeat timeout, closing connection`);
          ws.close(1000, 'Heartbeat timeout');
        }
      }
    }, 30000);
  }

  private getPublicIP(): string {
    const interfaces = networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const iface = interfaces[name];
      if (!iface) continue;
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          return addr.address;
        }
      }
    }
    return 'localhost';
  }

  private writeConfigFile(info: ServerInfo): void {
    try {
      // `server` is the stable field consumed by the unified client; the
      // remaining fields drive the daemon lifecycle commands.
      const config = { server: info.localUrl, ...info };
      writeRecord(CONFIG_FILE, config);
      if (process.platform !== 'win32') {
        chmodSync(CONFIG_DIR, 0o700);
        chmodSync(CONFIG_FILE, 0o600);
      }

      console.log(`[CloudServer] Config written to: ${CONFIG_FILE}`);
    } catch (error) {
      console.error('[CloudServer] Failed to write config file:', error);
    }
  }

  getStats(): { connections: number; agents: number; connectors: number; pendingRequests: number } {
    let agents = 0;
    for (const conn of this.connections.values()) {
      if (conn.role === 'agent') agents++;
    }
    return {
      connections: this.connections.size,
      agents,
      connectors: this.getConnectorConnections().length,
      pendingRequests: this.pendingRequests.size,
    };
  }
}
