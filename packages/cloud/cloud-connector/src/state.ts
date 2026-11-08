export type CloudConnectorRuntimeState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface CloudConnectorStateChange {
  state: CloudConnectorRuntimeState;
  heartbeat?: boolean;
  reason?: string;
  reconnectAttempt?: number;
  retryInMs?: number;
}
