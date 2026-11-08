import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  statSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isAlive } from './process.js';

const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const OWNER_WRITE_GRACE_MS = 1_000;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** Base shape every daemon record shares; subsystems extend it with their own fields. */
export interface DaemonRecord {
  pid: number;
  startedAt?: string;
  [key: string]: unknown;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

interface RecordLockOwner extends DaemonRecord {
  token: string;
}

function pauseForLock(): void {
  Atomics.wait(lockWaitBuffer, 0, 0, LOCK_WAIT_MS);
}

function readRecordUnlocked<T extends DaemonRecord = DaemonRecord>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as T;
    return parsed && typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function removeRecordUnlocked(file: string): void {
  rmSync(file, { force: true });
}

function writeRecordUnlocked(file: string, record: DaemonRecord): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }
}

function removeStaleLock(lockDir: string): boolean {
  const ownerFile = join(lockDir, 'owner.json');
  const owner = readRecordUnlocked<RecordLockOwner>(ownerFile);
  if (owner) {
    if (isAlive(owner.pid)) return false;
  } else {
    try {
      if (Date.now() - statSync(lockDir).mtimeMs < OWNER_WRITE_GRACE_MS) return false;
    } catch {
      return true;
    }
  }

  try {
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Serialize record ownership changes across processes sharing the registry. */
export function withRecordLock<T>(file: string, operation: () => T): T {
  ensureDir(dirname(file));
  const lockDir = `${file}.registry.lock`;
  const ownerFile = join(lockDir, 'owner.json');
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!removeStaleLock(lockDir)) {
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for registry lock: ${file}`, { cause: error });
        }
        pauseForLock();
      }
      continue;
    }

    let ownerFd: number | null = null;
    try {
      ownerFd = openSync(ownerFile, 'wx', 0o600);
      writeFileSync(ownerFd, JSON.stringify({ pid: process.pid, token } satisfies RecordLockOwner));
    } catch (error) {
      if (ownerFd !== null) closeSync(ownerFd);
      ownerFd = null;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring registry lock: ${file}`, { cause: error });
        }
        pauseForLock();
        continue;
      }
      throw error;
    } finally {
      if (ownerFd !== null) closeSync(ownerFd);
    }

    try {
      return operation();
    } finally {
      const owner = readRecordUnlocked<RecordLockOwner>(ownerFile);
      if (owner?.token === token) rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

/**
 * Atomically write a record: serialise to a temp file then rename over the
 * target, so a concurrent reader never observes a half-written file. Temp file
 * names include a random token so independent writes cannot collide.
 */
export function writeRecord(file: string, record: DaemonRecord): void {
  withRecordLock(file, () => writeRecordUnlocked(file, record));
}

/** Atomically create a record only when the target does not already exist. */
export function claimRecord(file: string, record: DaemonRecord): boolean {
  return withRecordLock(file, () => {
    const candidate = `${file}.${process.pid}.${randomUUID()}.claim`;
    try {
      writeFileSync(candidate, JSON.stringify(record), { mode: 0o600 });
      linkSync(candidate, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      rmSync(candidate, { force: true });
    }
  });
}

export function readRecord<T extends DaemonRecord = DaemonRecord>(file: string): T | null {
  return readRecordUnlocked<T>(file);
}

export function removeRecord(file: string): void {
  try {
    withRecordLock(file, () => removeRecordUnlocked(file));
  } catch {
    // ignore
  }
}

/** Remove a record only while it still belongs to the expected process. */
export function removeRecordIfPid(file: string, pid: number): boolean {
  try {
    return withRecordLock(file, () => {
      const record = readRecordUnlocked(file);
      if (record?.pid !== pid) return false;
      removeRecordUnlocked(file);
      return true;
    });
  } catch {
    return false;
  }
}

/** Replace a record only while it is still owned by the expected process. */
export function writeRecordIfPid(file: string, pid: number, record: DaemonRecord): boolean {
  return withRecordLock(file, () => {
    const current = readRecordUnlocked(file);
    if (current?.pid !== pid) return false;
    writeRecordUnlocked(file, record);
    return true;
  });
}

/** Remove an existing record whose contents are not a valid daemon record. */
export function removeInvalidRecord(file: string): boolean {
  try {
    return withRecordLock(file, () => {
      if (!existsSync(file) || readRecordUnlocked(file)) return false;
      removeRecordUnlocked(file);
      return true;
    });
  } catch {
    return false;
  }
}

/** Absolute paths of every `*.json` record file in a directory. */
export function listRecordFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .map(name => join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Read every record in a directory whose process is still alive, pruning files
 * whose pid is dead (or whose contents are corrupt) as a side effect. This is
 * the canonical way to list a multi-instance subsystem's live records.
 */
export function readLiveRecords<T extends DaemonRecord = DaemonRecord>(dir: string): T[] {
  const out: T[] = [];
  for (const file of listRecordFiles(dir)) {
    const rec = readRecord<T>(file);
    if (rec && isAlive(rec.pid)) {
      out.push(rec);
    } else if (rec) {
      removeRecordIfPid(file, rec.pid);
    } else {
      removeInvalidRecord(file);
    }
  }
  return out;
}
