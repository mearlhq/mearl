# @mearl/cloud-connector

[简体中文](README.md) | [English](README.en.md)

A local connector forwarding cloud Agent operations to local native-host. WebSocket is built in; other protocols load from installed capability packages. Qoder credentials, pairing, and SSE are provided by the optional [`@mearl/plugin-qoder`](../../plugin-qoder/README.en.md).

## Installation

```bash
npm install -g @mearl/cloud-connector
# Or
pnpm add -g @mearl/cloud-connector
```

## Two management modes

The connector supports two lifecycle modes sharing the same registry (see [runtime files](#runtime-files)), preventing duplicate connections to the same `server-url`:

1. **Managed by native-host** — Clicking Connect in the extension panel automatically launches the connector as a **foreground process** and monitors its status. No manual operation is needed.
2. **Self-managed daemon** — Use terminal subcommands such as `start` / `stop` to manage a background daemon with its own log file, useful without the extension panel, such as on remote machines or during troubleshooting.

## Usage

```bash
mearl-cloud-connector <server-url> [options]            # Run in foreground
mearl-cloud-connector <command> [server-url|pid] [options]  # Manage background daemons
```

**Arguments:**

- `server-url` — `ws://` / `wss://`, or a URI declared by an installed capability. The core does not interpret pairing parameters in plugin URIs.

**Subcommands:**

- `start <server-url>` — Start a daemon in the background (idempotent: reuse an existing live connector).
- `stop <server-url|pid>` — Stop a background connector by endpoint or a PID shown by `list` / `status`;
  the PID must match its current registration record, so a replaced instance is not stopped.
- `stop --all` — Stop all background connectors.
- `restart <server-url>` — Restart a connector.
- `status [server-url]` — Show connector health, recent heartbeats, and retry information;
  omit `server-url` to summarize all connectors.
- `list` — List running connectors.
- `logs <server-url>` — Print the end of a connector's log.

**Options:**

- `--foreground` / `-f` — Run in foreground without daemonizing.
- `--heartbeat <seconds>` — Heartbeat interval (default 30 seconds).
- `--reconnect <ms>` — Reconnection interval (default 5000 milliseconds).
- `--max-reconnect <n>` — Maximum reconnect attempts; -1 means unlimited (default -1).
- `--connector-id <id>` — Override the machine's stable connector ID.
- `--name <name>` — Set a recognizable connector name (default: hostname).
- `--fail-fast` — Exit on the first connection failure (used by native-host to detect startup results).

**Examples:**

```bash
# Start a self-managed background connector with its own log file (recommended)
mearl-cloud-connector start "wss://cloud.example.com/ws?token=xxx" --name work-mac

# Optional protocol: install @mearl/plugin-qoder and generate a URL as described in its README
mearl-cloud-connector start "qoder://pair/pairing-code-1234?created=1786723200000"

# Foreground mode for troubleshooting or external managers such as systemd / PM2
mearl-cloud-connector "ws://localhost:8080/ws?token=xxx"

# Status / list / logs
mearl-cloud-connector status
mearl-cloud-connector list
mearl-cloud-connector logs "wss://cloud.example.com/ws?token=xxx"

# Stop
mearl-cloud-connector stop "wss://cloud.example.com/ws?token=xxx"
mearl-cloud-connector stop 12345
mearl-cloud-connector stop --all

# Custom heartbeat and reconnect settings
mearl-cloud-connector start "ws://localhost:8080/ws?token=xxx" --heartbeat 60 --max-reconnect 10
```

`status` reports `starting`, `healthy`, `reconnecting`, `degraded`, `failed`,
or `unknown`. `healthy` means the process is alive, the transport is connected, and WebSocket has recently received a valid heartbeat.
Records without connection-state fields report `unknown`; restarting the connector fills in those fields.
Tokens are hidden in output.

`start` returns after connecting; the background process continues running. For optional pairing protocols, follow the plugin instructions to submit the generated
`pair` tool call. If the pairing tool call has ended, been cancelled, or expired, generate a new pairing URL;
old URLs cannot be reused.

### Programmatic usage

```typescript
import { CloudConnector } from '@mearl/cloud-connector';

const connector = new CloudConnector({
  serverUrl: 'wss://cloud.example.com/ws?token=xxx',
  connectorName: 'work-mac',
  heartbeatInterval: 30,
  reconnectInterval: 5000,
  maxReconnectAttempts: -1,
  onConnected: url => console.log('connected to', url),
});

connector.connect();

// Graceful shutdown
process.on('SIGINT', () => {
  connector.disconnect();
  process.exit(0);
});
```

## Runtime files

The first run generates a stable connector ID and stores it in
`~/.mearl/cloud-connector-identity.json`. The name defaults to the hostname and can be set with `--name` or
`MEARL_CONNECTOR_NAME`; set the ID with `--connector-id` or
`MEARL_CONNECTOR_ID`. A new connection with the same ID replaces the old one, supporting process restarts and network reconnections.

Each connector instance creates two files under `~/.mearl/connectors/`, keyed by a hash of `server-url`:

- `<hash>.json` — Registration record containing identity, process, connection state, recent heartbeats, and retries. The daemon
  manager writes a `starting` placeholder immediately after spawning the child, which then updates its own status.
  Removal checks the PID so an exiting process cannot delete a replacement's record. Readers automatically clean up crash remnants
  by checking PID liveness.
- `<hash>.log` — Daemon log, read with `logs` or followed with `tail -f`. Logs over 5MB rotate to `<hash>.log.1` on the next start.

native-host and the daemon CLI read this registry through shared paths derived by [`@mearl/daemon-core`](../../daemon-core/README.en.md). Each can discover, reuse, or stop connectors started by the other.

> Foreground execution, including native-host management, logs to stdout/stderr without a separate log file. Only daemon mode writes `<hash>.log`.

See the corresponding capability package documentation for optional protocol authentication and pairing. The core does not read their credentials.

## Prerequisites

1. **Install and initialize the local Mearl environment**

   ```bash
   npx @mearl/setup
   ```

   setup installs `@mearl/native-host` and `@mearl/client` together and initializes Native Messaging.

   Monorepo build outputs still require manual initialization:

   ```bash
   mearl-native-host --init
   ```

2. **Keep Chrome running**, with either:
   - The Mearl browser extension installed, or
   - Remote debugging enabled at `chrome://inspect/#remote-debugging` (Chrome 145+).

## Architecture

```
Cloud Agent
  ↓
@mearl/client
  ↓
@mearl/cloud-server
  ↓ (WebSocket)
@mearl/cloud-connector (this process)
  ↓ (Unix Socket)
@mearl/native-host
  ↓
Chrome Extension / CDP
```

Installed connection protocols share the same lifecycle and status callbacks; their plugins describe the specific topology.

## Notes

- The connector must stay running to forward cloud requests. native-host launches it with `detached`, so it **survives extension reloads and updates**. Self-managed lifecycles use `start`/`stop`.
- When using an external process manager such as systemd / PM2, add `--foreground` and let the manager handle supervision and restarts.
- Automatic reconnection is configurable. Records persist across transient disconnects and are removed only when the process exits.
- Oversized cloud responses return a structured error while keeping the connection open. For large screenshots, select an element region
  or retry with `format: "jpeg"` and a lower `quality`.
