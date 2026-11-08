/**
 * Cloud connector process management — start/stop/list cloud-connector
 * child processes that bridge the local native-host to remote cloud servers.
 *
 * Lifecycle design
 * ----------------
 * cloud-connector processes are spawned `detached` and intentionally OUTLIVE
 * the native-host that started them. The native-host is an ephemeral broker:
 * Chrome kills it whenever the extension reloads / updates (stdin EOF). If a
 * connector were a normal child it would die with that broker, tearing down the
 * cloud bridge on every extension reload.
 *
 * Shared registry & ownership
 * ---------------------------
 * Connectors are also self-manageable from the terminal (`cloud-connector start
 * <url>`), so the host-managed and self-managed modes must not fight over the
 * same connector. They interoperate through a single shared registry under
 * ~/.mearl/connectors/ (one JSON record per serverUrl), with paths
 * derived via @mearl/daemon-core so both sides agree on locations.
 *
 * The daemon manager reserves a record while a connector starts; the connector
 * process then owns its runtime state updates. This native-host reads the
 * registry to adopt/list connectors and removes a record only while its pid still
 * matches the process being stopped or reaped. A freshly started native-host
 * verifies recorded pids and ADOPTS live connectors instead of spawning duplicates.
 * Starting a connector is therefore idempotent: if a healthy one already exists
 * for the serverUrl (started by us, a previous host, or the daemon CLI) we reuse
 * it. Connectors die only when explicitly stopped, when they exit on their own,
 * or when the machine reboots — never merely because the broker restarted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { packageRegistryEnvironment } from '@mearl/setup/npm-registry';
import {
  isAlive,
  npmExecEnvironment,
  keyedDir,
  keyedConfigFile,
  readRecord,
  removeRecordIfPid,
  readLiveRecords,
  type DaemonRecord,
} from '@mearl/daemon-core';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ResolvedCommand {
  command: string;
  argsPrefix: string[];
  displayName: string;
  env?: NodeJS.ProcessEnv;
}

interface CloudConnectorEntry {
  pid: number;
  serverUrl: string;
  connectorId?: string;
  name?: string;
  /** Set only for connectors THIS host spawned (lets us watch their exit). */
  process?: ChildProcess;
}

interface ConnectorRecord extends DaemonRecord {
  serverUrl: string;
  connectorId?: string;
  name?: string;
}

export interface CloudConnectorListItem {
  serverUrl: string;
  pid: number;
  connectorId?: string;
  name?: string;
}

export interface CloudConnectorListResult {
  connectors: CloudConnectorListItem[];
}

// ─── State ────────────────────────────────────────────────────────────────────

/** Connectors known to THIS native-host (spawned or adopted), keyed by serverUrl. */
const processes = new Map<string, CloudConnectorEntry>();

/**
 * Shared registry dir. MUST match @mearl/cloud-connector's
 * CONNECTORS_SUBDIR — both derive per-connector paths through daemon-core's
 * keyed* helpers, so this single literal is the only thing that has to agree.
 */
const CONNECTORS_SUBDIR = 'connectors';
const REGISTRY_DIR = keyedDir(CONNECTORS_SUBDIR);

/** Polling interval to surface connector changes made out-of-band (e.g. via the daemon CLI). */
const STATUS_POLL_MS = 5_000;

function recordFileFor(serverUrl: string): string {
  return keyedConfigFile(CONNECTORS_SUBDIR, serverUrl);
}

/** Injected dependencies — set once via `initCloudConnector`. */
let logFn: (...args: any[]) => void = () => {};
let isDaemon = false;
let sendToExtensionFn: (message: Record<string, any>) => void = () => {};
/** native-host version, used to pin the matching cloud-connector package version. */
let nativeHostVersion = 'unknown';

/** Last connector set pushed to the extension, to suppress redundant notifications. */
let lastPushedKey = '';
/** Background poller handle (non-daemon mode only). */
let statusWatcher: ReturnType<typeof setInterval> | null = null;

/**
 * Initialise module-level dependencies. Must be called before any other export.
 */
export function initCloudConnector(deps: {
  log: (...args: any[]) => void;
  isDaemonMode: boolean;
  sendToExtension: (message: Record<string, any>) => void;
  version: string;
}): void {
  logFn = deps.log;
  isDaemon = deps.isDaemonMode;
  sendToExtensionFn = deps.sendToExtension;
  nativeHostVersion = deps.version;
  startStatusWatcher();
}

// ─── Registry helpers ───────────────────────────────────────────────────────────

/** Live connector records from the shared registry (prunes dead records). */
function liveRecords(): ConnectorRecord[] {
  return readLiveRecords<ConnectorRecord>(REGISTRY_DIR);
}

// ─── Status reconciliation ──────────────────────────────────────────────────────

/**
 * Reconcile in-memory + on-disk state against actual process liveness, pruning
 * dead entries. Returns the live connector list. The connector process owns its
 * registry record, so we only READ it here; in-memory entries cover the brief
 * window between spawning a connector and it writing its first record.
 */
function reconcile(): CloudConnectorListItem[] {
  const live = new Map<string, CloudConnectorListItem>();
  for (const record of liveRecords()) {
    live.set(record.serverUrl, {
      serverUrl: record.serverUrl,
      pid: record.pid,
      ...(record.connectorId ? { connectorId: record.connectorId } : {}),
      ...(record.name ? { name: record.name } : {}),
    });
  }

  for (const [serverUrl, entry] of processes) {
    if (isAlive(entry.pid)) {
      if (!live.has(serverUrl)) {
        live.set(serverUrl, {
          serverUrl,
          pid: entry.pid,
          ...(entry.connectorId ? { connectorId: entry.connectorId } : {}),
          ...(entry.name ? { name: entry.name } : {}),
        });
      }
    } else {
      processes.delete(serverUrl);
    }
  }

  return Array.from(live.values());
}

function connectorsKey(connectors: CloudConnectorListItem[]): string {
  return connectors
    .map(c => `${c.serverUrl}@${c.pid}@${c.connectorId ?? ''}@${c.name ?? ''}`)
    .sort()
    .join('|');
}

function pushStatus(connectors: CloudConnectorListItem[]): void {
  if (isDaemon) return;
  lastPushedKey = connectorsKey(connectors);
  sendToExtensionFn({
    type: 'cloud_connector_status_changed',
    data: { connectors },
  });
}

/** Recompute current state and push it to the extension unconditionally. */
function notifyStatusChanged(): void {
  pushStatus(reconcile());
}

/** Recompute state and push only if it differs from the last pushed state. */
function pushIfChanged(): CloudConnectorListItem[] {
  const connectors = reconcile();
  if (connectorsKey(connectors) !== lastPushedKey) pushStatus(connectors);
  return connectors;
}

/**
 * Poll the shared registry so connectors started/stopped out-of-band (e.g. by
 * the `cloud-connector` daemon CLI, or one that exited after we adopted it
 * without a child handle) are reflected in the panel, which only listens for
 * pushes and does not poll itself.
 */
function startStatusWatcher(): void {
  if (isDaemon || statusWatcher) return;
  statusWatcher = setInterval(() => {
    try {
      pushIfChanged();
    } catch {
      // ignore — best effort
    }
  }, STATUS_POLL_MS);
  statusWatcher.unref?.();
}

/** Register (or adopt) a connector for a serverUrl and notify listeners. */
function registerConnector(
  serverUrl: string,
  pid: number,
  child?: ChildProcess,
): CloudConnectorEntry {
  // Registry state is owned by the daemon manager and connector process. The
  // native-host only tracks the optional child handle for exit watching.
  const record = readRecord<ConnectorRecord>(recordFileFor(serverUrl));
  const entry: CloudConnectorEntry = {
    pid,
    serverUrl,
    ...(record?.connectorId ? { connectorId: record.connectorId } : {}),
    ...(record?.name ? { name: record.name } : {}),
    ...(child ? { process: child } : {}),
  };
  processes.set(serverUrl, entry);
  notifyStatusChanged();
  return entry;
}

/** Forget the expected connector both in memory and on disk, then notify listeners. */
function clearConnector(serverUrl: string, expected: { pid: number; child?: ChildProcess }): void {
  const entry = processes.get(serverUrl);
  if (entry && entry.pid !== expected.pid) return;
  if (expected.child && entry?.process && entry.process !== expected.child) return;
  processes.delete(serverUrl);
  removeRecordIfPid(recordFileFor(serverUrl), expected.pid);
  notifyStatusChanged();
}

/** Find a still-alive connector for a serverUrl (in memory or registry). */
function findLiveConnector(serverUrl: string): number | null {
  const entry = processes.get(serverUrl);
  if (entry && isAlive(entry.pid)) return entry.pid;

  const record = readRecord<ConnectorRecord>(recordFileFor(serverUrl));
  if (record && isAlive(record.pid)) return record.pid;

  // Stale leftovers — clean up so a fresh spawn can proceed.
  if (entry) processes.delete(serverUrl);
  if (record) removeRecordIfPid(recordFileFor(serverUrl), record.pid);
  return null;
}

// ─── Command resolution ─────────────────────────────────────────────────────────

function findBin(bin: string, env: NodeJS.ProcessEnv): string | null {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(lookupCommand, [bin], { encoding: 'utf-8', env });
  if (result.status === 0) {
    return result.stdout.split(/\r?\n/).find(Boolean) || null;
  }
  return null;
}

function getBinVersion(binPath: string): string | null {
  try {
    const result = spawnSync(process.execPath, [binPath, '--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

function makeDirectCommand(connectorPath: string): ResolvedCommand {
  if (process.platform !== 'win32') {
    return {
      command: process.execPath,
      argsPrefix: [connectorPath],
      displayName: `${process.execPath} ${connectorPath}`,
    };
  }
  return {
    command: connectorPath,
    argsPrefix: [],
    displayName: connectorPath,
  };
}

function resolveCloudConnectorCommand(): ResolvedCommand {
  const connectorBin =
    process.platform === 'win32' ? 'mearl-cloud-connector.cmd' : 'mearl-cloud-connector';
  const pathDelimiter = process.platform === 'win32' ? ';' : ':';
  const nodeDir = path.dirname(process.execPath);
  const enrichedPath = [nodeDir, process.env.PATH].filter(Boolean).join(pathDelimiter);
  const enrichedEnv = { ...process.env, PATH: enrichedPath };

  const connectorPath = findBin(connectorBin, enrichedEnv);

  if (connectorPath) {
    const installedVersion = getBinVersion(connectorPath);
    if (installedVersion === nativeHostVersion) {
      logFn(`Cloud connector ${installedVersion} found at ${connectorPath}`);
      return makeDirectCommand(connectorPath);
    }
    logFn(
      `Cloud connector version mismatch: installed=${installedVersion}, expected=${nativeHostVersion}`,
    );
  }

  // Not installed or version mismatch — try global install.
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmPath = path.join(nodeDir, npmBin);
  const npmCommand = fs.existsSync(npmPath) ? npmPath : npmBin;
  const targetPackage = `@mearl/cloud-connector@${nativeHostVersion}`;
  const installEnv = packageRegistryEnvironment('@mearl/cloud-connector', enrichedEnv);

  logFn(`Installing ${targetPackage} globally via ${npmCommand}...`);
  const install = spawnSync(npmCommand, ['install', '-g', targetPackage, '--prefer-offline'], {
    encoding: 'utf-8',
    env: installEnv,
    timeout: 30_000,
  });

  if (install.status === 0) {
    const newPath = findBin(connectorBin, enrichedEnv);
    if (newPath) {
      logFn(`Global install succeeded: ${newPath}`);
      return makeDirectCommand(newPath);
    }
  }
  logFn(`Global install failed (status=${install.status}), falling back to npx`);
  if (install.stderr) logFn(install.stderr.trim());

  // Fallback: npx (slow but always works).
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const npxPath = path.join(nodeDir, npxBin);
  const npxCommand = fs.existsSync(npxPath) ? npxPath : npxBin;
  return {
    command: npxCommand,
    argsPrefix: [`@mearl/cloud-connector@${nativeHostVersion}`],
    displayName: `${npxCommand} @mearl/cloud-connector@${nativeHostVersion}`,
    env: npmExecEnvironment(installEnv),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startCloudConnector(serverUrl: string): Promise<{
  success: boolean;
  pid?: number;
  connectorId?: string;
  name?: string;
  reused?: boolean;
  error?: string;
}> {
  return new Promise(resolve => {
    // Idempotent: reuse a healthy connector left behind by a previous native-host,
    // this one, or the daemon CLI instead of spawning a duplicate.
    const existingPid = findLiveConnector(serverUrl);
    if (existingPid) {
      logFn(`Reusing existing cloud connector for ${serverUrl} (pid=${existingPid})`);
      const entry = registerConnector(serverUrl, existingPid);
      resolve({
        success: true,
        pid: existingPid,
        ...(entry.connectorId ? { connectorId: entry.connectorId } : {}),
        ...(entry.name ? { name: entry.name } : {}),
        reused: true,
      });
      return;
    }

    const connectorCommand = resolveCloudConnectorCommand();
    logFn(`Starting cloud connector via ${connectorCommand.displayName}`);
    const child = spawn(
      connectorCommand.command,
      [...connectorCommand.argsPrefix, serverUrl, '--fail-fast'],
      {
        detached: true,
        env: connectorCommand.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    let settled = false;
    let outputBuffer = '';
    const startupTimer = setTimeout(() => {
      finish(false, { error: 'Cloud connector startup timeout' });
      child.kill();
    }, 60_000);

    const finish = (ok: boolean, result: { error?: string } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      if (ok && child.pid) {
        const entry = registerConnector(serverUrl, child.pid, child);
        resolve({
          success: true,
          pid: child.pid,
          ...(entry.connectorId ? { connectorId: entry.connectorId } : {}),
          ...(entry.name ? { name: entry.name } : {}),
        });
      } else {
        resolve({ success: false, error: result.error || 'Failed to spawn cloud connector' });
      }
    };

    child.once('error', (error: Error) => {
      logFn(`Failed to spawn cloud connector: ${error.message}`);
      finish(false, { error: error.message });
    });

    const handleOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      outputBuffer = (outputBuffer + text).slice(-2000);
      logFn(`[CloudConnector] ${text.trim()}`);
      if (text.includes('[CloudConnector] Connected to')) {
        finish(true);
      }
    };

    child.stdout?.on('data', handleOutput);
    child.stderr?.on('data', handleOutput);

    child.once('spawn', () => {
      child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        if (child.pid) clearConnector(serverUrl, { pid: child.pid, child });
        logFn(
          `Cloud connector exited for ${serverUrl}: code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        );
        if (!settled) {
          finish(false, {
            error:
              outputBuffer.trim() ||
              `Cloud connector exited before connected: code=${code ?? 'null'} signal=${signal ?? 'null'}`,
          });
        }
      });
      // Detach from the parent's lifecycle so the connector survives broker restarts.
      child.unref();
    });
  });
}

export function stopCloudConnector(serverUrl: string): { success: boolean; error?: string } {
  const pid =
    processes.get(serverUrl)?.pid ?? readRecord<ConnectorRecord>(recordFileFor(serverUrl))?.pid;
  if (!pid) {
    return { success: false, error: 'Cloud connector not found' };
  }

  try {
    if (isAlive(pid)) {
      process.kill(pid); // SIGTERM — the connector shuts down gracefully.
    }
    clearConnector(serverUrl, { pid });
    logFn(`Stopped cloud connector for ${serverUrl} (pid=${pid})`);
    return { success: true };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ESRCH') {
      // Already gone — converge state and report success.
      clearConnector(serverUrl, { pid });
      return { success: true };
    }
    logFn(`Failed to stop cloud connector: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export function listCloudConnectors(): CloudConnectorListResult {
  // Surface any out-of-band changes discovered during this poll to the panel.
  return { connectors: pushIfChanged() };
}
