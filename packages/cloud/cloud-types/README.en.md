# @mearl/cloud-types

[简体中文](README.md) | [English](README.en.md)

Shared types and constants for Mearl's cloud communication links.

`@mearl/client`, `cloud-server`, and `cloud-connector` communicate over WebSocket. This package defines their **shared wire protocol**: message structures, heartbeats, buffer limits, and default timeouts, keeping all three participants consistent.

> For internal monorepo use only.

## Exports

### Message types

```typescript
interface CloudMessage {
  id: string;
  action: string;
  data: Record<string, any>;
  connector?: string;
  browser?: string;
  timeoutSec?: number;
}

interface CloudResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
  versionWarning?: string;
}

interface HeartbeatMessage {
  type: 'ping' | 'pong';
  timestamp: number;
}

interface AgentHelloMessage {
  type: 'agent_hello';
}

interface ConnectorHelloMessage {
  type: 'connector_hello';
  connectorId: string;
  name: string;
  version?: string;
}
```

### Type guards

```typescript
isAgentHelloMessage(msg): msg is AgentHelloMessage
isConnectorHelloMessage(msg): msg is ConnectorHelloMessage
isHeartbeatMessage(msg): msg is HeartbeatMessage
isCloudMessage(msg): msg is CloudMessage
isCloudResponse(msg): msg is CloudResponse
```

`resolveCloudConnectorSelector(connectors, selector)` resolves a connector by exact ID, exact name, then unique fuzzy match,
distinguishing a match, ambiguity, and no match.

### Constants

```typescript
MAX_BUFFER_SIZE; // 10 MB, maximum buffer per message
DEFAULT_REQUEST_TIMEOUT; // 60s
DEFAULT_CONNECT_TIMEOUT; // 30s
DEFAULT_HEARTBEAT_INTERVAL; // 30s
DEFAULT_HEARTBEAT_TIMEOUT; // 90s
```

## Usage

```typescript
import { type CloudMessage, isCloudResponse, DEFAULT_REQUEST_TIMEOUT } from '@mearl/cloud-types';
```

## Build

```bash
pnpm build      # Compile with tsc into dist/
pnpm dev        # tsc --watch
pnpm typecheck  # Type checking only
```

## License

Apache-2.0
