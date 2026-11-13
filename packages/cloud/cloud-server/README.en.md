# @mearl/cloud-server

[简体中文](README.md) | [English](README.en.md)

A cloud WebSocket server routing cloud Agent requests to local connectors.

## Installation

Use setup to install a complete cloud Agent environment: cloud-server, the unified client, and Agent Skill.

```bash
npx @mearl/setup --cloud
```

Installed integrations provide optional connection protocols. See [`@mearl/plugin-qoder`](../../plugin-qoder/README.en.md) for Qoder pairing; the core does not include its pairing implementation.

Install `@mearl/cloud-server` separately when only the server package is needed, such as Docker or custom process management.

## Usage

### Command line

The server **runs as a background daemon by default**, returns immediately after startup, and prints the connection command to run on the local machine.
On POSIX systems, the background process enters its own session and continues after the launching command exits.
Other cloud modes load through installed `cloud.server.<id>` capabilities and fail explicitly if absent.

```bash
mearl-cloud-server [command] [options]
```

**Subcommands:**

- `start` — Start in the background (default when no subcommand is given).
- `stop` — Stop the background server.
- `restart` — Restart the background server.
- `status` — Show status and connection information.
- `logs` — Print the end of the server log.

**Options:**

- `--foreground` / `-f` — Run without daemonizing, suitable for systemd / Docker / PM2.
- `--port <port>` — Server port (default 8080).
- `--path <path>` — WebSocket path (default /ws).
- `--token <token>` — Authentication token (generated if omitted).
- `--heartbeat <seconds>` — Heartbeat timeout (default 90 seconds).
- `--max-connections <n>` — Maximum connections (default 100).

**Examples:**

```bash
# Start in background, generate a token, print the connection command, and return
mearl-cloud-server

# Status and connection information
mearl-cloud-server status

# Stop / restart
mearl-cloud-server stop
mearl-cloud-server restart

# Custom port and authentication
mearl-cloud-server start --port 9000 --token your-secret-token

# Foreground execution for an external process manager
mearl-cloud-server --foreground
```

Background startup prints a connection command for the local machine, for example:

```
[CloudServer] Started in background (pid 12345)
[CloudServer] Logs: ~/.mearl/cloud-server.log

  Connect from your local machine:
    npx @mearl/cloud-connector start "ws://10.0.1.100:8080/ws?token=xxx"
```

Behind a reverse proxy or in a sandbox, set `MEARL_CLOUD_PUBLIC_URL` to the external endpoint, optionally using `{port}`. The deployment host or Preset installer provides the connection address.

Normal connection commands use double-quoted arguments. When an external path contains shell metacharacters such as `$`, output uses POSIX literal quoting. Run these commands in a POSIX-compatible terminal; other terminals must pass the full publicUrl as one literal argument to `start`.

Runtime files live in `~/.mearl/`:

- `cloud-server.json` — Connection configuration, including URL, PID, and port; read automatically by `@mearl/client`.
- `cloud-server-mode.json` — Optional cloud mode marker written by setup; ordinary `--cloud` removes it.
- `cloud-server.log` — Background log, read with `logs` or `tail -f`; rotates to `cloud-server.log.1` on the next startup if over 5MB.

> The shared [`@mearl/daemon-core`](../../daemon-core/README.en.md) supplies lifecycle operations, status, and log rotation, also used by cloud-connector.

**Tokens:**

- A token is generated when `--token` is omitted. `restart` **preserves the current token**, keeping previously printed connection commands valid.
- `stop` followed by `start` is a fresh startup and generates a new token. For a stable connection command, supply `--token` or set `MEARL_TOKEN`.

**Environment variables:**

- `MEARL_TOKEN` — Authentication token, overriding --token.
- `CLOUD_SERVER_HOST` — Public hostname (automatically detected by default).
- `MEARL_CLOUD_PUBLIC_URL` — Explicit external endpoint supporting `{port}`. Explicit paths and query parameters are preserved; a root path uses the `path` option. The server sets the authentication token. HTTP/WS endpoints produce `ws://`; HTTPS/WSS endpoints produce `wss://`.

### Programmatic usage

```typescript
import { CloudServer } from '@mearl/cloud-server';

const server = new CloudServer({
  port: 8080,
  path: '/ws',
  token: 'your-secret-token',
  heartbeatTimeout: 90,
  maxConnections: 100,
  maxMessageSize: 10 * 1024 * 1024,
});

await server.start();

// Get statistics
const stats = server.getStats();
console.log(stats);
// { connections: 2, agents: 1, connectors: 1, pendingRequests: 0 }

// Graceful shutdown
await server.stop();
```

The corresponding integration handles handshakes and forwarding for optional modes.

## Architecture

```
Cloud Agent
  ↓
@mearl/client
  ↓ (WebSocket)
@mearl/cloud-server (this process)
  ↓ (WebSocket)
@mearl/cloud-connector (local)
  ↓ (Unix Socket)
@mearl/native-host
  ↓
Chrome Extension / CDP
```

## Connection types

The server accepts two connection types:

1. **Agent connection** — A cloud client issuing requests.
2. **Connector connection** — A local connector forwarding requests to native-host.

After connecting, clients send `agent_hello` and `connector_hello`, respectively. Connectors register
a stable ID, name, and version; a reconnection with the same ID replaces the previous connection.

With one online Connector, the server selects it automatically. With multiple Connectors, the Agent
first calls `connector_list`, then passes `connector` with requests. Without an explicit target,
the server rejects the request to avoid sending browser operations to the wrong machine.

## Message protocol

### Request format (Agent → Server)

```json
{
  "id": "unique-id",
  "action": "get_requests",
  "data": { "count": 5 },
  "connector": "work-mac",
  "version": "1.30.0"
}
```

`connector` accepts an ID or a uniquely matching name. `connector_list` is
a built-in server command and is not forwarded to the browser.

### Response format (Server → Agent)

```json
{
  "id": "unique-id",
  "success": true,
  "data": { ... },
  "versionWarning": "..."
}
```

### Heartbeat format

```json
{ "type": "ping", "timestamp": 1234567890 }
{ "type": "pong", "timestamp": 1234567890 }
```

## Authentication

When `token` is set, every connection must supply the correct token:

```bash
# Agent connection
ws://server.com/ws?token=your-secret-token

# Connector connection
ws://server.com/ws?token=your-secret-token
```

## Deployment recommendations

> For systemd / Docker / PM2, add `--foreground` and let the external manager supervise and restart the server.

### systemd (Linux)

```ini
[Unit]
Description=Mearl Cloud Server
After=network.target

[Service]
Type=simple
User=your-user
ExecStart=/usr/bin/mearl-cloud-server --foreground --port 8080 --token your-token
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Docker

```dockerfile
FROM node:20-alpine
RUN npm install -g @mearl/cloud-server
EXPOSE 8080
CMD ["mearl-cloud-server", "--foreground", "--token", "your-token"]
```

### PM2

```bash
pm2 start mearl-cloud-server --name mearl-cloud-server -- --foreground --port 8080 --token your-token
```

## Notes

- Use WSS (WebSocket Secure) in production for encrypted transport.
- Use a reverse proxy such as Nginx for WSS upgrades.
- Set an appropriate `maxConnections` limit to bound resource use.
- Enable `token` authentication.
- Sandbox startup automatically detects and uses the platform-assigned public address.
- If the sandbox port-mapping API is unavailable, it falls back to the local IP address.
