/**
 * Browser registry — advertises this native-host's connection in a shared,
 * on-disk registry so clients can discover and address multiple browsers at
 * once (multiple Chrome profiles / Chromium-based browsers, each with the
 * extension, each launching its own native-host).
 *
 * Why a registry instead of the old single well-known socket
 * ----------------------------------------------------------
 * Historically every native-host fought over one fixed socket; the last one to
 * start kicked the others off, so at most one browser was reachable and the two
 * flapped on every reconnect. Here each native-host listens on its own unique
 * per-process socket and publishes a record; the client reads the registry and
 * connects to the socket of whichever browser it wants (default: most-recently
 * focused). No contention, N browsers reachable simultaneously.
 *
 * Ownership
 * ---------
 * The record is keyed by the browser's stable installation id, so a browser
 * that reconnects (extension reload → new native-host pid → new socket) simply
 * overwrites its own record. To avoid a briefly-overlapping predecessor wiping
 * the successor's record during a reload, every mutation first checks that the
 * on-disk record still belongs to this process (or is stale) before writing.
 */

import {
  keyedConfigFile,
  keyedDir,
  listRecordFiles,
  readRecord,
  removeRecordIfPid,
  removeInvalidRecord,
  claimRecord,
  writeRecordIfPid,
  isAlive,
  type DaemonRecord,
} from '@mearl/daemon-core';
import type {
  BrowserCapabilities,
  BrowserDetails,
  BrowserPairingInfo,
  BrowserProviderOperation,
  BrowserProviderIdentity,
  BrowserReference,
  BrowserTransport,
} from '@mearl/browser-core';

const BROWSERS_SUBDIR = 'browsers';

/**
 * How long a dead-pid record is kept before it counts as abandoned crash
 * residue. Within this window the same browser reconnecting can inherit its own
 * last-focus time; past it the record is reaped at the next native-host startup.
 */
const STALE_RECORD_TTL_MS = 5 * 60_000;

/** Coalesce bursts of window-focus changes into at most one disk write per interval. */
const FOCUS_WRITE_THROTTLE_MS = 1000;

export interface BrowserRecord extends DaemonRecord {
  /** native-host pid — used for liveness pruning. */
  pid: number;
  /** Stable per-installation id reported by the extension (or 'cdp' for daemon mode). */
  browserId: string;
  /** Absolute path of the per-process socket this native-host listens on. */
  socketPath: string;
  /** Human-readable browser name, e.g. "Chrome", "Edge". */
  browserName: string;
  extensionVersion?: string;
  nativeHostVersion?: string;
  transport: BrowserTransport;
  providerBrowserId?: string;
  provider?: BrowserProviderIdentity;
  capabilities?: BrowserCapabilities;
  status?: 'connected' | 'pairing' | 'running_disconnected' | 'stopped';
  ownership?: 'owned' | 'attached';
  persistence?: 'ephemeral' | 'persistent';
  operations?: BrowserProviderOperation[];
  references?: BrowserReference[];
  details?: BrowserDetails;
  pairing?: BrowserPairingInfo;
  /** Epoch ms when this browser window last gained focus; drives default target selection. */
  lastFocusedAt?: number;
  startedAt: string;
  /** Epoch ms of the last record write; latest-wins tiebreak. */
  updatedAt: number;
}

/** The connection identity fixed at register time. */
interface Identity {
  browserId: string;
  socketPath: string;
  browserName: string;
  nativeHostVersion: string;
  transport: 'extension' | 'cdp';
  startedAt: string;
}

export function browserConnectionIdentity(
  browser: Pick<BrowserRecord, 'pid' | 'startedAt' | 'socketPath'>,
): string {
  return JSON.stringify([browser.pid, browser.startedAt, browser.socketPath]);
}

let identity: Identity | null = null;
let logFn: (...args: any[]) => void = () => {};

export function initBrowserRegistry(deps: { log: (...args: any[]) => void }): void {
  logFn = deps.log;
}

function recordFileFor(browserId: string): string {
  return keyedConfigFile(BROWSERS_SUBDIR, browserId);
}

function persist(patch: Partial<BrowserRecord>): boolean {
  if (!identity) return false;
  const file = recordFileFor(identity.browserId);
  const previous = readRecord<BrowserRecord>(file);
  if (previous && previous.pid !== process.pid && isAlive(previous.pid)) return false;
  const record: BrowserRecord = {
    pid: process.pid,
    browserId: identity.browserId,
    socketPath: identity.socketPath,
    browserName: identity.browserName,
    nativeHostVersion: identity.nativeHostVersion,
    transport: identity.transport,
    startedAt: identity.startedAt,
    lastFocusedAt: previous?.lastFocusedAt,
    extensionVersion: previous?.extensionVersion,
    ...patch,
    updatedAt: Date.now(),
  };
  try {
    if (previous?.pid === process.pid) return writeRecordIfPid(file, process.pid, record);
    if (previous && !removeRecordIfPid(file, previous.pid)) return false;
    return claimRecord(file, record);
  } catch (error) {
    logFn('browser-registry: failed to write record:', String(error));
    return false;
  }
}

/** Retire a CDP record whose process remains alive but its instance socket no longer accepts connections. */
export async function retireUnreachableBrowserRecord(
  browserId: string,
  canConnect: (socketPath: string) => Promise<boolean>,
): Promise<boolean> {
  const file = recordFileFor(browserId);
  const existing = readRecord<BrowserRecord>(file);
  if (!existing || existing.pid === process.pid || !isAlive(existing.pid)) return false;
  if (await canConnect(existing.socketPath)) return false;
  return removeRecordIfPid(file, existing.pid);
}

/**
 * Publish (or refresh) this native-host's registry record. Called once the
 * browser identity is known — from the extension handshake, or immediately with
 * a synthetic identity in CDP daemon mode.
 */
export function registerBrowser(info: {
  browserId: string;
  socketPath: string;
  browserName: string;
  nativeHostVersion: string;
  transport: 'extension' | 'cdp';
  provider?: BrowserProviderIdentity;
  ownership?: BrowserRecord['ownership'];
  persistence?: BrowserRecord['persistence'];
  operations?: BrowserProviderOperation[];
  details?: BrowserDetails;
  extensionVersion?: string;
  /** Initial focus rank. Managed headless browsers use 0 so they do not steal the default target. */
  lastFocusedAt?: number;
  /** Keep a previous focus rank when this browser reconnects. */
  preserveFocus?: boolean;
}): boolean {
  const startedAt = identity?.startedAt ?? new Date().toISOString();
  identity = {
    browserId: info.browserId,
    socketPath: info.socketPath,
    browserName: info.browserName,
    nativeHostVersion: info.nativeHostVersion,
    transport: info.transport,
    startedAt,
  };
  const previous = readRecord<BrowserRecord>(recordFileFor(info.browserId));
  const registered = persist({
    // Browsers with focus events retain their rank across reconnects. Discovery
    // runtimes provide a fixed low rank because they cannot observe window focus.
    lastFocusedAt:
      info.preserveFocus === false
        ? (info.lastFocusedAt ?? 0)
        : (previous?.lastFocusedAt ?? info.lastFocusedAt ?? Date.now()),
    extensionVersion: info.extensionVersion,
    ...(info.provider
      ? {
          provider: info.provider,
          ownership: info.ownership,
          persistence: info.persistence,
          operations: info.operations,
          details: info.details,
        }
      : {}),
  });
  logFn(
    `browser-registry: ${registered ? 'registered' : 'registration skipped'} ${info.browserName} (${info.browserId})`,
  );
  return registered;
}

let lastFocusWriteAt = 0;
let focusFlushTimer: ReturnType<typeof setTimeout> | null = null;

function writeFocusNow(): void {
  lastFocusWriteAt = Date.now();
  persist({ lastFocusedAt: lastFocusWriteAt });
}

/**
 * Mark this browser as most-recently focused, so it becomes the default target.
 * Focus can change in rapid bursts (fast window switching), so writes are
 * throttled: the first change in an interval writes immediately, further changes
 * schedule a single trailing write rather than one write each.
 */
export function touchFocus(): void {
  if (!identity) return;
  const elapsed = Date.now() - lastFocusWriteAt;
  if (elapsed >= FOCUS_WRITE_THROTTLE_MS) {
    writeFocusNow();
    return;
  }
  if (focusFlushTimer) return;
  focusFlushTimer = setTimeout(() => {
    focusFlushTimer = null;
    writeFocusNow();
  }, FOCUS_WRITE_THROTTLE_MS - elapsed);
  focusFlushTimer.unref();
}

/** Remove our record on shutdown — but only if it is still ours. */
export function unregisterBrowser(): void {
  if (focusFlushTimer) {
    // Cancel any pending trailing write so it can't resurrect the record we
    // are about to delete.
    clearTimeout(focusFlushTimer);
    focusFlushTimer = null;
  }
  if (!identity) return;
  const file = recordFileFor(identity.browserId);
  removeRecordIfPid(file, process.pid);
}

/**
 * Reap registry records left behind by native-hosts that exited without
 * cleanup (crashes). Live records are kept; a dead record is kept until it is
 * older than STALE_RECORD_TTL_MS so a quickly-reconnecting browser can still
 * inherit its own last-focus time. Meant to run once at startup.
 */
export function pruneDeadBrowsers(): void {
  const now = Date.now();
  for (const file of listRecordFiles(keyedDir(BROWSERS_SUBDIR))) {
    const rec = readRecord<BrowserRecord>(file);
    if (!rec) {
      removeInvalidRecord(file);
      continue;
    }
    if (isAlive(rec.pid)) continue;
    if (now - (rec.updatedAt ?? 0) > STALE_RECORD_TTL_MS) removeRecordIfPid(file, rec.pid);
  }
}

/** Live browser connections, ordered by the same focus rank used for default routing. */
export function listRegisteredBrowsers(): BrowserRecord[] {
  const records: BrowserRecord[] = [];
  for (const file of listRecordFiles(keyedDir(BROWSERS_SUBDIR))) {
    const record = readRecord<BrowserRecord>(file);
    if (record && isAlive(record.pid)) records.push(record);
  }
  return records.sort(
    (a, b) =>
      (b.lastFocusedAt ?? 0) - (a.lastFocusedAt ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
}
