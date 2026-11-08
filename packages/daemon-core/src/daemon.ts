import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAlive } from './process.js';
import {
  claimRecord,
  ensureDir,
  readRecord,
  removeInvalidRecord,
  removeRecordIfPid,
  writeRecord,
  type DaemonRecord,
} from './registry.js';
import { rotateLogIfNeeded, tailFile } from './log.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface CreateDaemonOptions {
  /** Label used in log lines, e.g. `CloudServer` / `CloudConnector`. */
  name: string;
  /**
   * Absolute path to the re-spawnable CLI script (the consumer's bundled
   * `cli.js`). The daemon re-launches it as `node <scriptPath> --foreground …`,
   * so the consumer's CLI must run the instance in-process when it sees
   * `--foreground`. Compute it with `fileURLToPath(import.meta.url)` from a
   * module that is bundled INTO the cli entry.
   */
  scriptPath: string;
  /** Path to this instance's JSON record file. */
  configFile: string;
  /** Path to this instance's log file (the detached child's stdout/stderr). */
  logFile: string;
  /** argv appended after `--foreground` when spawning the detached child. */
  foregroundArgs?: string[];
  /** How long to wait for the child to write its record. Default 15000ms. */
  readyTimeoutMs?: number;
  /** Extra lines to print once the instance is up/queried (e.g. a connect hint). */
  formatInfo?: (record: DaemonRecord) => string | null;
  /** Record persisted immediately after spawn so concurrent starts can reuse the child. */
  startingRecord?: (pid: number, startedAt: string) => DaemonRecord;
}

export interface Daemon {
  start(): Promise<void>;
  stop(expectedPid?: number): Promise<void>;
  restart(): Promise<void>;
  status(): void;
  logs(lines?: number): void;
  /** Current record if a live instance exists, else null. */
  running(): DaemonRecord | null;
}

/**
 * Build a single-instance daemon manager around a `(configFile, logFile)` pair.
 *
 * The model: `start()` atomically reserves startup, spawns the consumer's CLI
 * detached with `--foreground`, and records the child pid as `starting`. The
 * child replaces that marker when ready. Multi-instance subsystems create one
 * manager per instance, deriving `configFile` / `logFile` from the instance key.
 */
export function createDaemon(opts: CreateDaemonOptions): Daemon {
  const {
    name,
    scriptPath,
    configFile,
    logFile,
    foregroundArgs = [],
    readyTimeoutMs = 15_000,
    formatInfo,
    startingRecord,
  } = opts;
  const tag = `[${name}]`;
  const startLockFile = `${configFile}.start.lock`;

  function running(): DaemonRecord | null {
    const rec = readRecord(configFile);
    return rec && isAlive(rec.pid) ? rec : null;
  }

  function printInfo(rec: DaemonRecord): void {
    const extra = formatInfo?.(rec);
    if (extra) console.log(extra);
  }

  async function start(): Promise<void> {
    const live = running();
    if (live) {
      const state = live.daemonState === 'starting' ? 'starting' : 'running';
      console.log(`${tag} Already ${state} (pid ${live.pid})`);
      printInfo(live);
      return;
    }

    const existingLock = readRecord(startLockFile);
    if (existingLock && isAlive(existingLock.pid)) {
      console.log(`${tag} Start already in progress (pid ${existingLock.pid})`);
      return;
    }
    if (existingLock) removeRecordIfPid(startLockFile, existingLock.pid);
    else removeInvalidRecord(startLockFile);

    const lockPid = process.pid;
    if (!claimRecord(startLockFile, { pid: lockPid, startedAt: new Date().toISOString() })) {
      const competingLock = readRecord(startLockFile);
      if (competingLock && isAlive(competingLock.pid)) {
        console.log(`${tag} Start already in progress (pid ${competingLock.pid})`);
        return;
      }
      if (competingLock) removeRecordIfPid(startLockFile, competingLock.pid);
      else removeInvalidRecord(startLockFile);
      if (!claimRecord(startLockFile, { pid: lockPid, startedAt: new Date().toISOString() })) {
        const currentLock = readRecord(startLockFile);
        if (currentLock && isAlive(currentLock.pid)) {
          console.log(`${tag} Start already in progress (pid ${currentLock.pid})`);
          return;
        }
        console.error(`${tag} Failed to acquire startup lock: ${startLockFile}`);
        process.exitCode = 1;
        return;
      }
    }

    // Clear any stale record left by a crashed run after taking the startup lock.
    const stale = readRecord(configFile);
    if (stale && !isAlive(stale.pid)) removeRecordIfPid(configFile, stale.pid);
    else if (!stale) removeInvalidRecord(configFile);

    ensureDir(dirname(configFile));
    ensureDir(dirname(logFile));
    rotateLogIfNeeded(logFile);

    const startedAt = new Date().toISOString();
    const logFd = openSync(logFile, 'a');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [scriptPath, '--foreground', ...foregroundArgs], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: process.env,
        windowsHide: true,
      });
    } catch (error) {
      removeRecordIfPid(startLockFile, lockPid);
      throw error;
    } finally {
      closeSync(logFd);
    }
    child.unref();

    const childPid = child.pid;
    if (!childPid) {
      removeRecordIfPid(startLockFile, lockPid);
      console.error(`${tag} Failed to start: spawned process has no pid`);
      process.exitCode = 1;
      return;
    }

    writeRecord(startLockFile, { pid: childPid, startedAt });
    claimRecord(configFile, {
      ...(startingRecord?.(childPid, startedAt) ?? { pid: childPid, startedAt }),
      daemonState: 'starting',
    });
    removeRecordIfPid(startLockFile, childPid);

    // Wait until the child writes its own pid into the record (i.e. it is ready),
    // or until it dies / we time out.
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(childPid)) {
        removeRecordIfPid(configFile, childPid);
        console.error(`${tag} Failed to start. Recent log:`);
        const log = tailFile(logFile, 20);
        if (log) console.error(log);
        console.error(`(full log: ${logFile})`);
        process.exitCode = 1;
        return;
      }
      const rec = readRecord(configFile);
      if (rec && rec.pid === childPid && rec.daemonState !== 'starting') {
        console.log(`${tag} Started in background (pid ${childPid})`);
        console.log(`${tag} Logs: ${logFile}`);
        printInfo(rec);
        return;
      }
      await sleep(200);
    }

    console.error(
      `${tag} Start timed out after ${Math.round(readyTimeoutMs / 1000)}s. Check the log: ${logFile}`,
    );
    process.exitCode = 1;
  }

  async function stop(expectedPid?: number): Promise<void> {
    const rec = readRecord(configFile);
    if (expectedPid !== undefined && rec?.pid !== expectedPid) {
      console.log(`${tag} Registered pid ${expectedPid} is no longer the current instance`);
      return;
    }
    if (!rec || !isAlive(rec.pid)) {
      console.log(`${tag} Not running`);
      if (rec) removeRecordIfPid(configFile, rec.pid);
      else removeInvalidRecord(configFile);
      return;
    }

    const pid = rec.pid;
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      console.error(`${tag} Failed to stop pid ${pid}:`, (error as Error).message);
      process.exitCode = 1;
      return;
    }

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && isAlive(pid)) {
      await sleep(150);
    }
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }

    removeRecordIfPid(configFile, pid);
    console.log(`${tag} Stopped (pid ${pid})`);
  }

  async function restart(): Promise<void> {
    await stop();
    await start();
  }

  function status(): void {
    const rec = running();
    if (!rec) {
      console.log(`${tag} Status: stopped`);
      return;
    }
    console.log(`${tag} Status: ${rec.daemonState === 'starting' ? 'starting' : 'running'}`);
    console.log(`  pid:        ${rec.pid}`);
    if (rec.startedAt) console.log(`  started at: ${rec.startedAt}`);
    console.log(`  log:        ${logFile}`);
    printInfo(rec);
  }

  function logs(lines = 50): void {
    const log = tailFile(logFile, lines);
    if (log) console.log(log);
    console.log(`\n(log file: ${logFile} — follow with: tail -f "${logFile}")`);
  }

  return { start, stop, restart, status, logs, running };
}
