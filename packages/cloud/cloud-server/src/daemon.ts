import { fileURLToPath } from 'node:url';
import { createDaemon, readRecord, removeRecordIfPid, type DaemonRecord } from '@mearl/daemon-core';
import { CloudServer, CloudServerOptions, ServerInfo } from './index.js';
import { CONFIG_FILE, LOG_FILE } from './paths.js';
import { formatConnectorCommand } from './publicEndpoint.js';

type StoredConfig = DaemonRecord & Partial<ServerInfo> & { server?: string };

/**
 * Absolute path of this CLI script. `daemon.ts` is bundled into `dist/cli.js`,
 * so at runtime `import.meta.url` resolves to `cli.js` — the entry the daemon
 * manager re-spawns with `--foreground`.
 */
const SCRIPT_PATH = fileURLToPath(import.meta.url);

/** Connect hint printed under `start` / `status`, mirroring the old output. */
function formatConnectInfo(record: DaemonRecord): string | null {
  const config = record as StoredConfig;
  const lines: string[] = [];
  if (config.port) lines.push(`  port:       ${config.port}`);

  const command = config.publicUrl
    ? formatConnectorCommand(config.publicUrl)
    : config.connectorCommand;
  if (command) {
    lines.push('');
    lines.push('  Connect from your local machine:');
    lines.push(`    ${command}`);
  }
  return lines.length ? lines.join('\n') : null;
}

function daemon(foregroundArgs: string[]) {
  return createDaemon({
    name: 'CloudServer',
    scriptPath: SCRIPT_PATH,
    configFile: CONFIG_FILE,
    logFile: LOG_FILE,
    foregroundArgs,
    formatInfo: formatConnectInfo,
  });
}

/** Whether a live WebSocket daemon exists, independent from the selected transport mode. */
export function isDaemonRunning(): boolean {
  return daemon([]).running() !== null;
}

/** Spawn the server as a detached background process. */
export function startDaemon(passthroughArgs: string[]): Promise<void> {
  return daemon(passthroughArgs).start();
}

/** Stop a running background server. */
export function stopDaemon(): Promise<void> {
  return daemon([]).stop();
}

/**
 * Restart the background server, preserving the existing (auto-generated) token
 * unless the caller overrides it, so the previously-shared connector command
 * keeps working across a restart.
 */
export function restartDaemon(passthroughArgs: string[]): Promise<void> {
  let args = passthroughArgs;
  if (!passthroughArgs.includes('--token') && !process.env.MEARL_TOKEN) {
    const token = readRecord<StoredConfig>(CONFIG_FILE)?.token;
    if (token) args = [...passthroughArgs, '--token', token];
  }
  return daemon(args).restart();
}

/** Print whether a background server is running and how to connect to it. */
export function statusDaemon(): void {
  daemon([]).status();
}

/** Print the tail of the daemon log file. */
export function printLogs(): void {
  daemon([]).logs();
}

/**
 * Run the server in the current process (no daemonizing). Used internally by
 * the detached child, and available to users via `--foreground`. The server
 * writes its own `ServerInfo` (including `pid`) into the config file once it is
 * listening — that pid is how the daemon manager confirms the child came up.
 */
export async function runForeground(options: CloudServerOptions): Promise<void> {
  const server = new CloudServer(options);
  await server.start();
  console.log('[CloudServer] Press Ctrl+C to stop');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[CloudServer] Received ${signal}, shutting down...`);
    await server.stop();
    removeRecordIfPid(CONFIG_FILE, process.pid);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
