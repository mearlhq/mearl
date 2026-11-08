import WebSocket, { WebSocket as WebSocketType } from 'ws';
import {
  CloudMessage,
  CloudResponse,
  ConnectorHelloMessage,
  HeartbeatMessage,
  isHeartbeatMessage,
  MAX_BUFFER_SIZE,
  DEFAULT_HEARTBEAT_INTERVAL,
} from '@mearl/cloud-types';
import { resolveActionTimeoutSec } from '@mearl/client/action-timeouts';
import { resolveConnectorIdentity, type ConnectorIdentity } from './identity.js';
import { requireConnectorEndpoint, type ConnectorEndpoint } from './endpoint.js';
import { loadConnectorPlugin, type ConnectorPlugin } from './plugins.js';
import { isWebSocketEndpoint } from './endpoint.js';
import type { CloudConnectorStateChange } from './state.js';

export {
  isConnectorEndpoint,
  parseConnectorEndpoint,
  requireConnectorEndpoint,
  type ConnectorEndpoint,
  type ConnectorEndpointScheme,
  type WebSocketConnectorEndpoint,
} from './endpoint.js';
export type { CloudConnectorRuntimeState, CloudConnectorStateChange } from './state.js';

declare const __CLOUD_CONNECTOR_VERSION__: string;

const CLOUD_CONNECTOR_VERSION: string =
  typeof __CLOUD_CONNECTOR_VERSION__ !== 'undefined' ? __CLOUD_CONNECTOR_VERSION__ : 'unknown';

const DEFAULT_RECONNECT_INTERVAL = 5000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const SLOW_PROBE_INTERVAL_MS = 60000;
const FAST_RECONNECT_ATTEMPTS = 5;
const CONNECTOR_REPLACED_REASON = 'Connector replaced by a newer connection';

export interface CloudConnectorOptions {
  serverUrl: string;
  heartbeatInterval?: number;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  failFast?: boolean;
  connectorId?: string;
  connectorName?: string;
  onInitialConnectionFailed?: (message: string) => void;
  onStateChange?: (change: CloudConnectorStateChange) => void;
  onSuperseded?: () => void;
  /**
   * Fired every time the transport connection is established or re-established.
   */
  onConnected?: (serverUrl: string, identity: ConnectorIdentity) => void;
}

type ResolvedCloudConnectorOptions = Required<
  Omit<
    CloudConnectorOptions,
    | 'connectorId'
    | 'connectorName'
    | 'onInitialConnectionFailed'
    | 'onConnected'
    | 'onStateChange'
    | 'onSuperseded'
  >
> & {
  onInitialConnectionFailed?: (message: string) => void;
  onConnected?: (serverUrl: string, identity: ConnectorIdentity) => void;
  onStateChange?: (change: CloudConnectorStateChange) => void;
  onSuperseded?: () => void;
};

export class CloudConnector {
  private options: ResolvedCloudConnectorOptions;
  private endpoint: ConnectorEndpoint;
  private identity: ConnectorIdentity;
  private plugin: ConnectorPlugin | null = null;
  private pluginLoad: Promise<void> | undefined;
  private ws: WebSocketType | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private messageBuffer = '';
  private isManualClose = false;
  private shouldTryWss = false;
  private wssRetryAttempts = 0;
  private readonly maxWssRetryAttempts = 1;
  private hasConnected = false;
  private lastConnectionError: string | null = null;

  constructor(options: CloudConnectorOptions) {
    this.endpoint = requireConnectorEndpoint(options.serverUrl);
    this.options = {
      serverUrl: this.endpoint.serverUrl,
      heartbeatInterval: options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
      reconnectInterval: options.reconnectInterval ?? DEFAULT_RECONNECT_INTERVAL,
      maxReconnectAttempts: options.maxReconnectAttempts ?? -1,
      failFast: options.failFast ?? false,
      onInitialConnectionFailed: options.onInitialConnectionFailed,
      onConnected: options.onConnected,
      onStateChange: options.onStateChange,
      onSuperseded: options.onSuperseded,
    };
    this.identity = resolveConnectorIdentity(options);
  }

  connect(): void {
    if (!isWebSocketEndpoint(this.endpoint)) {
      if (this.plugin) { this.plugin.connect(); return; }
      this.isManualClose = false;
      if (this.pluginLoad) return;
      this.pluginLoad = loadConnectorPlugin(this.endpoint.scheme, {
        serverUrl: this.endpoint.serverUrl, identity: this.identity,
        reconnectInterval: this.options.reconnectInterval,
        maxReconnectAttempts: this.options.maxReconnectAttempts,
        failFast: this.options.failFast,
        onConnected: () => {
          this.hasConnected = true;
          this.options.onConnected?.(this.options.serverUrl, this.identity);
        },
        onStateChange: change => this.emitState(change),
        onInitialConnectionFailed: this.options.onInitialConnectionFailed,
      }).then(plugin => {
        if (this.isManualClose) { plugin.disconnect(); return; }
        this.plugin = plugin;
        plugin.connect();
      }).catch(error => {
        if (this.isManualClose) return;
        const message = error instanceof Error ? error.message : String(error);
        this.emitState({ state: 'failed', reason: message });
        this.options.onInitialConnectionFailed?.(message);
      }).finally(() => { this.pluginLoad = undefined; });
      return;
    }

    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      return;
    }

    if (!this.hasConnected && this.reconnectAttempts === 0) {
      this.emitState({ state: 'connecting' });
    }

    let serverUrl = this.endpoint.transportUrl;
    if (this.shouldTryWss && serverUrl.startsWith('ws://')) {
      serverUrl = serverUrl.replace('ws://', 'wss://');
      console.log(`[CloudConnector] Retrying with wss://: ${serverUrl}`);
    }

    this.ws = new WebSocket(serverUrl);

    this.ws.on('open', () => {
      this.hasConnected = true;
      this.lastConnectionError = null;
      this.reconnectAttempts = 0;
      this.shouldTryWss = false;
      this.wssRetryAttempts = 0;
      this.sendConnectorHello();
      this.startHeartbeat();
      this.emitState({ state: 'connected' });
      // Pass the ORIGINAL serverUrl (the registry key), not the wss-upgraded one.
      this.options.onConnected?.(this.options.serverUrl, this.identity);
      console.log(`[CloudConnector] Connected to ${serverUrl}`);
    });

    this.ws.on('message', (data: Buffer) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.handleClose(code, reason.toString(), serverUrl);
    });

    this.ws.on('error', (error: Error) => {
      console.error(`[CloudConnector] WebSocket error:`, error.message);
      this.lastConnectionError = error.message;
      if (
        error.message.includes('301') &&
        !this.shouldTryWss &&
        serverUrl.startsWith('ws://') &&
        this.wssRetryAttempts < this.maxWssRetryAttempts
      ) {
        this.shouldTryWss = true;
        this.wssRetryAttempts++;
        this.ws = null;
        console.log(
          `[CloudConnector] Server requires wss://, retrying (${this.wssRetryAttempts}/${this.maxWssRetryAttempts})...`,
        );
        setTimeout(() => this.connect(), 1000);
      }
    });
  }

  disconnect(): void {
    this.isManualClose = true;
    this.plugin?.disconnect();
    this.plugin = null;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private handleMessage(data: Buffer): void {
    this.messageBuffer += data.toString('utf-8');

    if (this.messageBuffer.length > MAX_BUFFER_SIZE) {
      console.error('[CloudConnector] Message buffer exceeds limit, closing connection');
      this.disconnect();
      return;
    }

    let newlineIndex: number;
    while ((newlineIndex = this.messageBuffer.indexOf('\n')) !== -1) {
      const line = this.messageBuffer.slice(0, newlineIndex);
      this.messageBuffer = this.messageBuffer.slice(newlineIndex + 1);

      if (!line.trim()) continue;

      try {
        const message: CloudMessage | HeartbeatMessage = JSON.parse(line);
        this.handleCloudMessage(message);
      } catch (error) {
        console.error(`[CloudConnector] Failed to parse message:`, line, error);
      }
    }
  }

  private handleClose(code: number, reasonText: string, serverUrl: string): void {
    console.log(`[CloudConnector] Disconnected (${code}: ${reasonText})`);
    this.stopHeartbeat();
    this.messageBuffer = '';
    if (this.shouldTryWss && serverUrl.startsWith('ws://')) return;

    if (code === 1000 && reasonText === CONNECTOR_REPLACED_REASON) {
      this.isManualClose = true;
      console.error('[CloudConnector] Superseded by a newer connector; exiting');
      this.options.onSuperseded?.();
      return;
    }

    // fail-fast governs only the INITIAL connection: if we never managed to
    // connect, exit so the spawning native-host learns the start failed. Once
    // we have connected at least once, a drop is treated as a transient
    // network blip and we reconnect with backoff — the connector must outlive
    // momentary cloud-side disconnects.
    if (this.options.failFast && !this.hasConnected) {
      const message = this.lastConnectionError || reasonText || `Connection closed (${code})`;
      this.emitState({ state: 'failed', reason: message });
      this.options.onInitialConnectionFailed?.(message);
      return;
    }
    this.tryReconnect(this.lastConnectionError || reasonText || `Connection closed (${code})`);
  }

  private async handleCloudMessage(message: CloudMessage | HeartbeatMessage): Promise<void> {
    if (isHeartbeatMessage(message)) {
      this.emitState({ state: 'connected', heartbeat: true });
      if (message.type === 'ping') {
        this.sendHeartbeatResponse(message.timestamp);
      }
      return;
    }

    const request = message as CloudMessage;
    const { id, action, data, browser, timeoutSec } = request;

    try {
      const client = await import('@mearl/client/local');
      const result = await client.invoke(action, data, {
        browser,
        timeoutSec: timeoutSec ?? resolveActionTimeoutSec(action, data, 15),
        controlSource: 'remote',
        ...(request.controlSessionId ? { controlSessionId: request.controlSessionId } : {}),
      });
      this.sendResponse({ id, success: true, data: result });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendResponse({ id, success: false, error: errorMessage });
    }
  }

  private sendResponse(response: CloudResponse): void {
    if (this.ws && this.ws.readyState === 1) {
      const message = JSON.stringify(response) + '\n';
      const bytes = Buffer.byteLength(message, 'utf-8');
      if (bytes > MAX_BUFFER_SIZE) {
        console.error(
          `[CloudConnector] Response ${response.id} exceeds message limit (${bytes} > ${MAX_BUFFER_SIZE} bytes)`,
        );
        this.ws.send(
          JSON.stringify({
            id: response.id,
            success: false,
            error:
              `Cloud response exceeds ${MAX_BUFFER_SIZE} byte message limit (${bytes} bytes). ` +
              'Reduce the result size; for screenshots use JPEG quality or a selector.',
          } satisfies CloudResponse) + '\n',
        );
        return;
      }
      this.ws.send(message);
    }
  }

  private sendConnectorHello(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message: ConnectorHelloMessage = {
        type: 'connector_hello',
        connectorId: this.identity.connectorId,
        name: this.identity.name,
        ...(CLOUD_CONNECTOR_VERSION === 'unknown' ? {} : { version: CLOUD_CONNECTOR_VERSION }),
      };
      this.ws.send(JSON.stringify(message) + '\n');
    }
  }

  private sendHeartbeatResponse(_timestamp: number): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(
        JSON.stringify({ type: 'pong', timestamp: Date.now() } satisfies HeartbeatMessage) + '\n',
      );
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ type: 'ping', timestamp: Date.now() } satisfies HeartbeatMessage) + '\n',
        );
      }
    }, this.options.heartbeatInterval * 1000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private tryReconnect(reason?: string): void {
    if (this.isManualClose) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;

    if (
      this.options.maxReconnectAttempts !== -1 &&
      this.reconnectAttempts > this.options.maxReconnectAttempts
    ) {
      console.log(
        `[CloudConnector] Max reconnect attempts (${this.options.maxReconnectAttempts}) reached`,
      );
      this.emitState({
        state: 'failed',
        ...(reason ? { reason } : {}),
        reconnectAttempt: this.reconnectAttempts,
      });
      return;
    }

    const isSlowProbe = this.reconnectAttempts > FAST_RECONNECT_ATTEMPTS;
    const delay = isSlowProbe
      ? SLOW_PROBE_INTERVAL_MS
      : Math.min(BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempts - 1), BACKOFF_MAX_MS);

    if (isSlowProbe) {
      console.log(
        `[CloudConnector] Slow probe reconnect in ${delay / 1000}s (attempt ${this.reconnectAttempts})`,
      );
    } else {
      console.log(
        `[CloudConnector] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${FAST_RECONNECT_ATTEMPTS})`,
      );
    }

    this.emitState({
      state: 'reconnecting',
      ...(reason ? { reason } : {}),
      reconnectAttempt: this.reconnectAttempts,
      retryInMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private emitState(change: CloudConnectorStateChange): void {
    this.options.onStateChange?.(change);
  }
}
