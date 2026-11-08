# @mearl/daemon-core

[简体中文](README.md) | [English](README.en.md)

Daemon lifecycle primitives shared by Mearl's Node packages: process liveness, JSON registration records, log rotation, and a detached daemon manager.

`cloud-server`, `cloud-connector`, and `native-host` share daemon operations (`isAlive`, atomic registry reads and writes, log rotation, and keyed paths) here so all readers and writers agree on **record locations and formats**.

This Node-only package can be used as a normal dependency or inlined into an execution host bundle.

## API

### Process liveness

```typescript
isAlive(pid: number | undefined | null): boolean
isProcessGroupAlive(group: number): boolean
```

Uses signal-0 to probe liveness. `EPERM` counts as alive: the process exists but belongs to another user. On Linux, `/proc/<pid>/stat` identifies exited, unreaped zombie and dead processes as stopped. If other threads remain after the main thread exits, or status cannot be read, it conservatively treats the process as alive.

POSIX process-group checks include descendants surviving the root process. Linux confirms execution has stopped only when two checks find the same exited members and creation identities. Active descendants, membership changes, permission errors, or read failures leave cleanup unconfirmed. Windows does not use POSIX process-group checks.

### Path derivation (multiple instances)

```typescript
DAEMON_HOME                                 // ~/.mearl
hashKey(key: string): string                // First 16 hexadecimal digits of sha256(key)
keyedDir(subdir: string): string            // ~/.mearl/<subdir>
keyedConfigFile(subdir, key): string        // ~/.mearl/<subdir>/<hash>.json
keyedLogFile(subdir, key): string           // ~/.mearl/<subdir>/<hash>.log
```

Multi-instance subsystems, such as connectors keyed by `serverUrl`, derive per-instance paths with these helpers. **All readers and writers must use them** to agree on record locations.

### Record registry

```typescript
interface DaemonRecord { pid: number; startedAt?: string; [k: string]: unknown }

ensureDir(dir: string): void
writeRecord(file: string, record: DaemonRecord): void   // Cross-process lock; atomic temporary file + rename
claimRecord(file: string, record: DaemonRecord): boolean // Atomically claim only if absent
readRecord<T>(file: string): T | null
removeRecord(file: string): void
removeRecordIfPid(file: string, pid: number): boolean   // Remove only if still owned by this PID
writeRecordIfPid(file: string, pid: number, record: DaemonRecord): boolean
removeInvalidRecord(file: string): boolean              // Clean up unparseable records
listRecordFiles(dir: string): string[]                  // Absolute paths of all *.json files
readLiveRecords<T>(dir: string): T[]                    // Read live records and clean up dead ones
```

### Daemon manager

```typescript
createDaemon(opts: CreateDaemonOptions): Daemon
```

Builds a single-instance daemon manager around `(configFile, logFile)`. `start()` atomically claims a startup lock,
launches the consumer CLI detached with `--foreground`, and immediately writes a `starting` record
with the child PID. The ready child overwrites the record, allowing the parent to confirm startup. Concurrent `start()` calls reuse a starting
or running child. Multi-instance subsystems derive their own `configFile` / `logFile` from the instance key.

```typescript
interface CreateDaemonOptions {
  name: string;            // Log label, e.g. 'CloudServer' / 'CloudConnector'
  scriptPath: string;      // Absolute path to the consumer's bundled cli.js
  configFile: string;      // Instance JSON record written by the foreground child
  logFile: string;         // Instance log file
  foregroundArgs?: string[];   // argv appended after `--foreground`
  readyTimeoutMs?: number;     // Child record timeout, default 15000ms
  formatInfo?: (record: DaemonRecord) => string | null;  // Additional startup information
  startingRecord?: (pid: number, startedAt: string) => DaemonRecord;
}

interface Daemon {
  start(): Promise<void>;
  stop(expectedPid?: number): Promise<void>; // Stop only the matching instance when PID is supplied
  restart(): Promise<void>;
  status(): void;
  logs(lines?: number): void;
  running(): DaemonRecord | null;
}
```

> `scriptPath` must identify the consumer's own `cli.js`. Derive it with `fileURLToPath(import.meta.url)` in a module bundled into the CLI entry. If daemon-core is resolved separately, its `import.meta.url` points to daemon-core, not the CLI.

### Logs

```typescript
rotateLogIfNeeded(logFile: string, maxBytes?: number): void  // Rotate to <log>.1 above limit; default 5MB
tailFile(logFile: string, lines: number): string
```

## Consumers

- **cloud-server** — `createDaemon`, single instance at `~/.mearl/cloud-server.json`.
- **cloud-connector** — `createDaemon`, instances keyed by `serverUrl` at `~/.mearl/connectors/<hash>.json`, listed through `readLiveRecords`.
- **native-host** — Uses primitives such as `isAlive` / `keyedConfigFile` / `readRecord` / `readLiveRecords` to discover, take over, and list connectors through their shared registry.


`NodeCapabilityRegistry` from `@mearl/daemon-core/capabilities` accepts `hooks` in its third constructor argument to load only modules referenced by those bindings. The whole selection is still validated, target module bytes are digest-verified, and commits still check the current selection. Ignored modules do not execute. This partial instance suits hosts needing a few native services, such as the installer CLI; it does not replace full Native Host activation and readiness receipts. Omit `hooks` for full loading.
