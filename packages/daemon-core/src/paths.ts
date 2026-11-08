import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

/** Root directory for all mearl daemon runtime files (configs / logs). */
export const DAEMON_HOME = join(homedir(), '.mearl');

/**
 * Stable short hash of an arbitrary instance key (e.g. a server URL). Used to
 * derive per-instance file names for multi-instance subsystems. Both the writer
 * (the daemon process) and any reader (another manager) MUST derive the path
 * through these helpers so the two never disagree on where a record lives.
 */
export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Directory holding per-instance files for a subsystem, e.g. `connectors`. */
export function keyedDir(subdir: string): string {
  return join(DAEMON_HOME, subdir);
}

/** Per-instance JSON record path: ~/.mearl/<subdir>/<hash>.json */
export function keyedConfigFile(subdir: string, key: string): string {
  return join(keyedDir(subdir), `${hashKey(key)}.json`);
}

/** Per-instance log path: ~/.mearl/<subdir>/<hash>.log */
export function keyedLogFile(subdir: string, key: string): string {
  return join(keyedDir(subdir), `${hashKey(key)}.log`);
}
