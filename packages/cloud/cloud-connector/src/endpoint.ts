export type ConnectorEndpointScheme = string;
export interface ConnectorEndpoint {
  serverUrl: string;
  transportUrl: string;
  scheme: string;
}
export type WebSocketConnectorEndpoint = ConnectorEndpoint;

/** WebSocket is built in; other schemes require a locally installed capability. */
export function parseConnectorEndpoint(value: string | undefined): ConnectorEndpoint | null {
  if (!value) return null;
  const serverUrl = value.trim();
  try {
    const parsed = new URL(serverUrl);
    if (!parsed.hostname || parsed.hash || parsed.username || parsed.password) return null;
    const scheme = parsed.protocol.slice(0, -1);
    if (!/^[a-z][a-z0-9+-]{0,31}$/.test(scheme) || ['http', 'https', 'file', 'data', 'javascript', 'chrome'].includes(scheme)) return null;
    return { serverUrl, transportUrl: serverUrl, scheme };
  } catch { return null; }
}
export function isConnectorEndpoint(value: string | undefined): value is string { return parseConnectorEndpoint(value) !== null; }
export function requireConnectorEndpoint(value: string): ConnectorEndpoint {
  const endpoint = parseConnectorEndpoint(value);
  if (!endpoint) throw new Error('serverUrl must be a valid connector URL without credentials or a fragment');
  return endpoint;
}
export function isWebSocketEndpoint(endpoint: ConnectorEndpoint): boolean { return endpoint.scheme === 'ws' || endpoint.scheme === 'wss'; }
