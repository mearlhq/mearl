import { fileURLToPath } from 'node:url';
import {
  claimRecord,
  createDaemon,
  isAlive,
  readRecord,
  readLiveRecords,
  removeRecordIfPid,
  writeRecordIfPid,
  type DaemonRecord,
} from '@mearl/daemon-core';
import {
  CloudConnector,
  type CloudConnectorOptions,
  type CloudConnectorRuntimeState,
  type CloudConnectorStateChange,
} from './index.js';
import { resolveConnectorIdentity } from './identity.js';
import { CONNECTORS_DIR, configFileFor, logFileFor } from './paths.js';

/**
 * Absolute path of this CLI script. `daemon.ts` is bundled into `dist/cli.js`,
 * so at runtime `import.meta.url` resolves to `cli.js` — the entry the daemon
 * manager re-spawns with `--foreground`.
 */
const SCRIPT_PATH = fileURLToPath(import.meta.url);

/** Connecting to a remote cloud server can be slow; allow a generous startup window. */
const CONNECT_TIMEOUT_MS = 60_000;

export interface ConnectorRecord extends DaemonRecord {
  serverUrl: string;
  connectorId?: string;
  name?: string;
  connectionState?: CloudConnectorRuntimeState;
  stateUpdatedAt?: string;
  connectedAt?: string;
  lastHeartbeatAt?: string;
  lastDisconnectedAt?: string;
  lastError?: string;
  reconnectAttempt?: number;
  nextRetryAt?: string;
  heartbeatIntervalSec?: number;
}

export type ConnectorHealth =
  | 'starting'
  | 'healthy'
  | 'reconnecting'
  | 'degraded'
  | 'failed'
  | 'unknown';

const DEFAULT_HEARTBEAT_INTERVAL_SEC = 30;

function redactedServerUrl(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl);
    for (const key of parsed.searchParams.keys()) {
      if (/token/i.test(key)) parsed.searchParams.set(key, 'redacted');
    }
    return parsed.toString();
  } catch {
    return serverUrl.replace(/([?&][^=&\s]*token[^=&\s]*=)[^&\s]*/gi, '$1redacted');
  }
}

export function resolveConnectorHealth(record: ConnectorRecord, now = Date.now()): ConnectorHealth {
  switch (record.connectionState) {
    case 'connecting':
      return 'starting';
    case 'reconnecting':
      return 'reconnecting';
    case 'failed':
      return 'failed';
    case 'connected': {
      if (!/^wss?:/i.test(record.serverUrl)) return 'healthy';
      const freshness = record.lastHeartbeatAt ?? record.connectedAt;
      if (!freshness) return 'degraded';
      const timestamp = Date.parse(freshness);
      const staleAfterMs =
        Math.max(record.heartbeatIntervalSec ?? DEFAULT_HEARTBEAT_INTERVAL_SEC, 1) * 3_000;
      return Number.isFinite(timestamp) && now - timestamp <= staleAfterMs ? 'healthy' : 'degraded';
    }
    default:
      return record.daemonState === 'starting' ? 'starting' : 'unknown';
  }
}

export function formatConnectorStatus(record: ConnectorRecord, now = Date.now()): string[] {
  const health = resolveConnectorHealth(record, now);
  const lines = [
    `  status:     ${health}`,
    `  pid:        ${record.pid}`,
    `  server:     ${redactedServerUrl(record.serverUrl)}`,
  ];
  if (health === 'unknown') lines.push('  note:       restart to enable health reporting');
  if (record.startedAt) lines.push(`  started at: ${record.startedAt}`);
  if (record.connectedAt) lines.push(`  connected:  ${record.connectedAt}`);
  if (record.lastHeartbeatAt) lines.push(`  heartbeat:  ${record.lastHeartbeatAt}`);
  if (record.lastDisconnectedAt) lines.push(`  disconnected: ${record.lastDisconnectedAt}`);
  if (record.lastError) lines.push(`  last error: ${record.lastError}`);
  if (record.reconnectAttempt !== undefined) {
    lines.push(`  retry:      attempt ${record.reconnectAttempt}`);
  }
  if (record.nextRetryAt) lines.push(`  next retry: ${record.nextRetryAt}`);
  if (
    /^wss?:/i.test(record.serverUrl) &&
    (health === 'reconnecting' || health === 'failed' || health === 'degraded')
  ) {
    lines.push(
      '  next step:  on the Agent machine, run mearl-cloud-server status; verify the current connection URL/token and that its port is reachable from this machine.',
    );
  }
  return lines;
}

function daemonFor(serverUrl: string, foregroundArgs: string[] = []) {
  return createDaemon({
    name: 'CloudConnector',
    scriptPath: SCRIPT_PATH,
    configFile: configFileFor(serverUrl),
    logFile: logFileFor(serverUrl),
    // The foreground child is launched as `cli.js --foreground <serverUrl> [opts]`.
    foregroundArgs: [serverUrl, ...foregroundArgs],
    readyTimeoutMs: CONNECT_TIMEOUT_MS,
    startingRecord: (pid, startedAt) => ({
      pid,
      serverUrl,
      startedAt,
      connectionState: 'connecting',
      stateUpdatedAt: startedAt,
    }),
    formatInfo: rec => formatConnectorStatus(rec as ConnectorRecord).join('\n'),
  });
}

/** Start a background connector for a serverUrl (idempotent — reuses a live one). */
export function startDaemon(serverUrl: string, passthroughArgs: string[]): Promise<void> {
  return daemonFor(serverUrl, passthroughArgs).start();
}

/** Stop the background connector for a serverUrl. */
export function stopDaemon(serverUrl: string): Promise<void> {
  return daemonFor(serverUrl).stop();
}

/** Stop a connector by a pid owned by the shared connector registry. */
export async function stopDaemonByPid(pid: number): Promise<void> {
  const record = liveConnectorRecords().find(candidate => candidate.pid === pid);
  if (!record) {
    console.log(`[CloudConnector] No running connector registered for pid ${pid}`);
    return;
  }
  await daemonFor(record.serverUrl).stop(pid);
}

/** Restart the background connector for a serverUrl. */
export function restartDaemon(serverUrl: string, passthroughArgs: string[]): Promise<void> {
  return daemonFor(serverUrl, passthroughArgs).restart();
}

/** Show status for one connector, or list all running connectors when no url is given. */
export function statusDaemon(serverUrl?: string): void {
  if (serverUrl) {
    const record = daemonFor(serverUrl).running() as ConnectorRecord | null;
    if (!record) {
      console.log('[CloudConnector] Status: stopped');
      return;
    }
    console.log(`[CloudConnector] Status: ${resolveConnectorHealth(record)}`);
    console.log(formatConnectorStatus(record).slice(1).join('\n'));
    return;
  }
  const records = liveConnectorRecords();
  if (records.length === 0) {
    console.log('[CloudConnector] No running connectors');
    return;
  }
  console.log(`[CloudConnector] ${records.length} connector status(es):`);
  records.forEach((record, index) => {
    if (index > 0) console.log('');
    console.log(formatConnectorStatus(record).join('\n'));
  });
}

function liveConnectorRecords(): ConnectorRecord[] {
  return readLiveRecords<ConnectorRecord>(CONNECTORS_DIR).sort((left, right) =>
    left.serverUrl.localeCompare(right.serverUrl),
  );
}

/** Print every running connector (across all serverUrls), pruning dead records. */
export function listDaemons(): void {
  const records = liveConnectorRecords();
  if (records.length === 0) {
    console.log('[CloudConnector] No running connectors');
    return;
  }
  console.log(`[CloudConnector] ${records.length} running connector(s):`);
  for (const record of records) {
    console.log(
      `  [${resolveConnectorHealth(record)}] pid ${record.pid}  ${redactedServerUrl(record.serverUrl)}`,
    );
  }
}

/** Stop every running connector. */
export async function stopAllDaemons(): Promise<void> {
  const records = readLiveRecords<ConnectorRecord>(CONNECTORS_DIR);
  if (records.length === 0) {
    console.log('[CloudConnector] No running connectors');
    return;
  }
  for (const rec of records) {
    await daemonFor(rec.serverUrl).stop();
  }
}

/** Tail the log for a connector. */
export function printLogs(serverUrl: string): void {
  daemonFor(serverUrl).logs();
}

/**
 * Run the connector in the current process. Used by BOTH the detached daemon
 * child (`--foreground`) and a direct `cloud-connector <url>` invocation (e.g.
 * native-host spawns the connector this way).
 *
 * The daemon manager may reserve the registry record during process startup;
 * this foreground process claims or adopts that reservation and then persists
 * transport health on each connection transition. Records remain across
 * transient disconnects and are removed only by their owning pid on shutdown.
 * Readers prune records left behind by crashed processes via liveness checks.
 */
export function runForeground(options: CloudConnectorOptions): void {
  const serverUrl = options.serverUrl;
  const configFile = configFileFor(serverUrl);
  const startedAt = new Date().toISOString();
  const identity = resolveConnectorIdentity(options);
  let hasConnected = false;
  let connectedAt: string | undefined;
  let lastHeartbeatAt: string | undefined;
  let lastDisconnectedAt: string | undefined;

  const initialRecord: ConnectorRecord = {
    serverUrl,
    pid: process.pid,
    startedAt,
    connectorId: identity.connectorId,
    name: identity.name,
    connectionState: 'connecting',
    stateUpdatedAt: startedAt,
    daemonState: 'starting',
    heartbeatIntervalSec: options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL_SEC,
  };

  const existing = readRecord<ConnectorRecord>(configFile);
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    console.log(`[CloudConnector] Already running for this server (pid ${existing.pid})`);
    return;
  }
  if (existing && existing.pid !== process.pid) removeRecordIfPid(configFile, existing.pid);
  let ownsRecord = existing?.pid === process.pid;
  for (let attempt = 0; !ownsRecord && attempt < 2; attempt++) {
    if (claimRecord(configFile, initialRecord)) {
      ownsRecord = true;
      break;
    }
    const owner = readRecord<ConnectorRecord>(configFile);
    if (owner?.pid === process.pid) {
      ownsRecord = true;
      break;
    }
    if (owner) {
      if (isAlive(owner.pid)) {
        console.log(`[CloudConnector] Already running for this server (pid ${owner.pid})`);
        return;
      }
      removeRecordIfPid(configFile, owner.pid);
    }
  }
  if (!ownsRecord) {
    const owner = readRecord<ConnectorRecord>(configFile);
    if (owner && owner.pid !== process.pid && isAlive(owner.pid)) {
      console.log(`[CloudConnector] Already running for this server (pid ${owner.pid})`);
    } else {
      console.error('[CloudConnector] Failed to claim connector registry record');
    }
    return;
  }
  if (!writeRecordIfPid(configFile, process.pid, initialRecord)) {
    console.error('[CloudConnector] Connector registry ownership changed during startup');
    return;
  }

  const writeState = (change: CloudConnectorStateChange) => {
    try {
      const now = new Date().toISOString();
      if (change.state === 'connected') {
        hasConnected = true;
        if (change.heartbeat) lastHeartbeatAt = now;
        else {
          connectedAt = now;
          lastHeartbeatAt = undefined;
        }
      } else if (change.state === 'reconnecting' || change.state === 'failed') {
        lastDisconnectedAt = now;
      }

      const record: ConnectorRecord = {
        serverUrl,
        pid: process.pid,
        startedAt,
        connectorId: identity.connectorId,
        name: identity.name,
        connectionState: change.state,
        stateUpdatedAt: now,
        heartbeatIntervalSec: options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL_SEC,
        ...(hasConnected ? {} : { daemonState: 'starting' }),
        ...(connectedAt ? { connectedAt } : {}),
        ...(lastHeartbeatAt ? { lastHeartbeatAt } : {}),
        ...(lastDisconnectedAt ? { lastDisconnectedAt } : {}),
        ...(change.reason ? { lastError: change.reason } : {}),
        ...(change.reconnectAttempt === undefined
          ? {}
          : { reconnectAttempt: change.reconnectAttempt }),
        ...(change.retryInMs === undefined
          ? {}
          : { nextRetryAt: new Date(Date.now() + change.retryInMs).toISOString() }),
      };
      writeRecordIfPid(configFile, process.pid, record);
    } catch (error) {
      console.error(`[CloudConnector] Failed to write registry record: ${String(error)}`);
    }
  };

  const removeOwnRecord = () => {
    removeRecordIfPid(configFile, process.pid);
  };

  const connector = new CloudConnector({
    ...options,
    connectorId: identity.connectorId,
    connectorName: identity.name,
    onConnected: options.onConnected,
    onStateChange: change => {
      writeState(change);
      options.onStateChange?.(change);
    },
    onSuperseded: () => {
      removeOwnRecord();
      options.onSuperseded?.();
      process.exit(0);
    },
    onInitialConnectionFailed: message => {
      console.error(`[CloudConnector] Initial connection failed: ${message}`);
      removeOwnRecord();
      process.exit(1);
    },
  });
  connector.connect();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[CloudConnector] Received ${signal}, shutting down...`);
    connector.disconnect();
    removeOwnRecord();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
