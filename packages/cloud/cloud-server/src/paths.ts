import { join } from 'node:path';
import { DAEMON_HOME } from '@mearl/daemon-core';

/**
 * Directory holding cloud-server runtime files (config / log). Shares the single
 * `~/.mearl` root (resolved cross-platform via `homedir()`) that
 * daemon-core derives every other daemon path from.
 */
export const CONFIG_DIR = DAEMON_HOME;

/**
 * Connection config written by the running server and read by @mearl/client.
 * Daemon lifecycle commands additionally read `pid` / `port` / `startedAt`.
 */
export const CONFIG_FILE = join(CONFIG_DIR, 'cloud-server.json');

/** Persistent transport mode selected by setup; independent from daemon liveness. */
export const MODE_FILE = join(CONFIG_DIR, 'cloud-server-mode.json');

/** Daemon stdout/stderr log file. */
export const LOG_FILE = join(CONFIG_DIR, 'cloud-server.log');
