# @mearl/cloud-types

[简体中文](README.md) | [English](README.en.md)

Mearl 云端通信链路的共享类型与常量。

`@mearl/client`、`cloud-server`、`cloud-connector` 三端通过 WebSocket 互通，本包定义它们之间消息的**统一协议**（消息结构、心跳、缓冲区上限、各类超时默认值），确保三端对线上格式始终一致。

> 仅供 monorepo 内部使用。

## 导出

### 消息类型

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

### 类型守卫

```typescript
isAgentHelloMessage(msg): msg is AgentHelloMessage
isConnectorHelloMessage(msg): msg is ConnectorHelloMessage
isHeartbeatMessage(msg): msg is HeartbeatMessage
isCloudMessage(msg): msg is CloudMessage
isCloudResponse(msg): msg is CloudResponse
```

`resolveCloudConnectorSelector(connectors, selector)` 按精确 ID、精确名称、唯一模糊匹配的
顺序解析 connector 目标，并区分匹配、歧义和未找到。

### 常量

```typescript
MAX_BUFFER_SIZE; // 10 MB，单条消息缓冲上限
DEFAULT_REQUEST_TIMEOUT; // 60s
DEFAULT_CONNECT_TIMEOUT; // 30s
DEFAULT_HEARTBEAT_INTERVAL; // 30s
DEFAULT_HEARTBEAT_TIMEOUT; // 90s
```

## 使用

```typescript
import { type CloudMessage, isCloudResponse, DEFAULT_REQUEST_TIMEOUT } from '@mearl/cloud-types';
```

## 构建

```bash
pnpm build      # tsc 编译到 dist/
pnpm dev        # tsc --watch
pnpm typecheck  # 仅类型检查
```

## License

Apache-2.0
