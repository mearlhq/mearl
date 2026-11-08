export interface CloudMessage {
  controlSessionId?: string;
  id: string;
  action: string;
  data: Record<string, any>;
  /** Target a browser-side cloud connector by id / name. */
  connector?: string;
  /**
   * Target a specific browser on the connector's machine by id / name. Omitted →
   * the connector's default (most-recently-focused) browser.
   */
  browser?: string;
  /** Action execution timeout forwarded to the local socket client. */
  timeoutSec?: number;
}

export interface CloudResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
  versionWarning?: string;
}

export interface HeartbeatMessage {
  type: 'ping' | 'pong';
  timestamp: number;
}

export interface AgentHelloMessage {
  type: 'agent_hello';
}

export interface ConnectorHelloMessage {
  type: 'connector_hello';
  connectorId: string;
  name: string;
  version?: string;
}

export interface CloudConnectorInfo {
  connectorId: string;
  name: string;
  version?: string;
  connectedAt: string;
  lastHeartbeatAt: string;
  pendingRequests: number;
  legacy?: boolean;
}

export interface CloudConnectorListResult {
  count: number;
  connectors: CloudConnectorInfo[];
}

export type CloudConnectorSelectorResult<T> =
  | { status: 'matched'; connector: T }
  | { status: 'ambiguous' }
  | { status: 'not_found' };

export const MAX_BUFFER_SIZE = 10 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT = 60;
export const DEFAULT_HEARTBEAT_INTERVAL = 30;
export const DEFAULT_CONNECT_TIMEOUT = 30;
export const DEFAULT_HEARTBEAT_TIMEOUT = 90;

/** Resolve connector targets with one precedence order shared by routing and diagnostics. */
export function resolveCloudConnectorSelector<
  T extends Pick<ConnectorHelloMessage, 'connectorId' | 'name'>,
>(connectors: readonly T[], selector: string): CloudConnectorSelectorResult<T> {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) return { status: 'not_found' };

  const resolveMatches = (matches: T[]): CloudConnectorSelectorResult<T> | null => {
    if (matches.length === 1) return { status: 'matched', connector: matches[0]! };
    if (matches.length > 1) return { status: 'ambiguous' };
    return null;
  };

  const exactId = resolveMatches(
    connectors.filter(connector => connector.connectorId.toLowerCase() === normalized),
  );
  if (exactId) return exactId;

  const exactName = resolveMatches(
    connectors.filter(connector => connector.name.toLowerCase() === normalized),
  );
  if (exactName) return exactName;

  return (
    resolveMatches(
      connectors.filter(
        connector =>
          connector.connectorId.toLowerCase().includes(normalized) ||
          connector.name.toLowerCase().includes(normalized),
      ),
    ) ?? { status: 'not_found' }
  );
}

export function isHeartbeatMessage(msg: any): msg is HeartbeatMessage {
  return msg && (msg.type === 'ping' || msg.type === 'pong');
}

export function isAgentHelloMessage(msg: any): msg is AgentHelloMessage {
  return msg?.type === 'agent_hello';
}

export function isConnectorHelloMessage(msg: any): msg is ConnectorHelloMessage {
  return (
    msg?.type === 'connector_hello' &&
    typeof msg.connectorId === 'string' &&
    msg.connectorId.length > 0 &&
    msg.connectorId.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(msg.connectorId) &&
    typeof msg.name === 'string' &&
    msg.name.length > 0 &&
    msg.name.length <= 128 &&
    !/\p{Cc}/u.test(msg.name) &&
    (msg.version === undefined || typeof msg.version === 'string')
  );
}

export function isCloudMessage(msg: any): msg is CloudMessage {
  return (
    msg &&
    typeof msg.id === 'string' &&
    typeof msg.action === 'string' &&
    (msg.connector === undefined || typeof msg.connector === 'string') &&
    (msg.browser === undefined || typeof msg.browser === 'string')
  );
}

export function isCloudResponse(msg: any): msg is CloudResponse {
  return msg && typeof msg.id === 'string' && typeof msg.success === 'boolean';
}
