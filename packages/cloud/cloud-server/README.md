# @mearl/cloud-server

[简体中文](README.md) | [English](README.en.md)

云端 WebSocket Server，用于中转云端 Agent 请求到本地连接器。

## 安装

推荐通过 setup 安装完整的云端 Agent 环境（cloud-server、统一 client 与 Agent Skill）：

```bash
npx @mearl/setup --cloud
```

可选连接协议由已安装的集成提供。Qoder 配对见 [`@mearl/plugin-qoder`](../../plugin-qoder/README.md)；核心不内置其配对实现。

在 Docker 或自定义进程托管等只需要 Server 包的场景，可单独安装 `@mearl/cloud-server`。

## 使用

### 命令行方式

Server **默认以后台守护进程方式运行**，启动后立即返回，并打印本地机器需要执行的连接命令。
POSIX 环境下后台进程会进入独立 session，可在启动命令结束后继续运行。
其他 cloud mode 通过已安装的 `cloud.server.<id>` 加载，未安装时明确失败。

```bash
mearl-cloud-server [command] [options]
```

**子命令：**

- `start` - 后台启动 server（默认，不写也等价于 `start`）
- `stop` - 停止后台 server
- `restart` - 重启后台 server
- `status` - 查看运行状态及连接信息
- `logs` - 打印 server 日志末尾

**选项：**

- `--foreground` / `-f` - 前台运行（不守护化，适合 systemd / Docker / PM2）
- `--port <port>` - 服务器端口（默认 8080）
- `--path <path>` - WebSocket 路径（默认 /ws）
- `--token <token>` - 鉴权密钥（未指定时自动生成）
- `--heartbeat <seconds>` - 心跳超时时间（默认 90 秒）
- `--max-connections <n>` - 最大连接数（默认 100）

**示例：**

```bash
# 后台启动（自动生成 token），打印连接命令后立即返回
mearl-cloud-server

# 查看状态与连接信息
mearl-cloud-server status

# 停止 / 重启
mearl-cloud-server stop
mearl-cloud-server restart

# 自定义端口和鉴权
mearl-cloud-server start --port 9000 --token your-secret-token

# 前台运行（交给外部进程管理器托管）
mearl-cloud-server --foreground
```

后台启动后会打印供本地机器使用的连接命令，例如：

```
[CloudServer] Started in background (pid 12345)
[CloudServer] Logs: ~/.mearl/cloud-server.log

  Connect from your local machine:
    npx @mearl/cloud-connector start "ws://10.0.1.100:8080/ws?token=xxx"
```

部署在反向代理或沙箱中时，使用 `MEARL_CLOUD_PUBLIC_URL` 指定外部入口，可使用 `{port}` 占位符。连接地址由部署宿主或 Preset 安装器提供。

普通入口的连接命令保持双引号参数形式。外部路径含 `$` 等 shell 元字符时，输出命令使用 POSIX 字面量引用；这类命令在 POSIX 兼容终端执行，其他终端应将完整 publicUrl 作为一个字面量参数传给 `start`。

运行时文件位于 `~/.mearl/`：

- `cloud-server.json` - 连接配置（含 server URL、pid、端口等），统一 `@mearl/client` 自动读取
- `cloud-server-mode.json` - setup 为可选 cloud mode 写入的标识；普通 `--cloud` 会删除它
- `cloud-server.log` - 后台进程日志（`logs` 子命令读取，或 `tail -f` 跟踪）；超过 5MB 会在下次启动时滚动为 `cloud-server.log.1`

> 守护进程的启停、状态、日志滚动等生命周期逻辑由共享包 [`@mearl/daemon-core`](../../daemon-core/README.md) 提供（与 cloud-connector 复用同一套实现）。

**关于 token：**

- 未指定 `--token` 时会自动生成。`restart` 会**沿用当前 token**，因此之前打印的连接命令重启后仍然有效。
- `stop` 后再 `start` 属于全新启动，会重新生成 token；若希望连接命令长期固定，请显式传入 `--token` 或设置 `MEARL_TOKEN`。

**环境变量：**

- `MEARL_TOKEN` - 鉴权密钥（覆盖 --token 选项）
- `CLOUD_SERVER_HOST` - 公网主机名（默认自动获取）
- `MEARL_CLOUD_PUBLIC_URL` - 明确配置的外部入口，支持 `{port}` 占位符；有显式路径和查询参数时保留，根路径使用 `path` 选项，鉴权 token 由 Server 设置。HTTP/WS 入口生成 `ws://`，HTTPS/WSS 入口生成 `wss://`。

### 编程方式

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

// 获取统计信息
const stats = server.getStats();
console.log(stats);
// { connections: 2, agents: 1, connectors: 1, pendingRequests: 0 }

// 优雅关闭
await server.stop();
```

可选模式由对应的集成负责握手和转发。

## 架构

```
云端 Agent
  ↓
@mearl/client
  ↓ (WebSocket)
@mearl/cloud-server (本进程)
  ↓ (WebSocket)
@mearl/cloud-connector (本地)
  ↓ (Unix Socket)
@mearl/native-host
  ↓
Chrome Extension / CDP
```

## 连接类型

Server 接受两种类型的连接：

1. **Agent 连接** - 发起请求的云端客户端
2. **Connector 连接** - 转发请求到 native-host 的本地连接器

两类客户端建连后会分别发送 `agent_hello` 和 `connector_hello`。Connector 会注册
稳定 ID、名称和版本；同一 ID 重连时，新连接会替换旧连接。

只有一个 Connector 在线时，Server 自动选择它。多个 Connector 同时在线时，Agent
先调用 `connector_list` 获取清单，再在请求中传 `connector`；未指定目标时
Server 会拒绝请求，避免把浏览器操作发到错误机器。

## 消息协议

### 请求格式（Agent → Server）

```json
{
  "id": "unique-id",
  "action": "get_requests",
  "data": { "count": 5 },
  "connector": "work-mac",
  "version": "1.30.0"
}
```

`connector` 接受 connector ID 或可唯一匹配的名称。`connector_list` 是
Server 内置命令，不会转发到浏览器侧。

### 响应格式（Server → Agent）

```json
{
  "id": "unique-id",
  "success": true,
  "data": { ... },
  "versionWarning": "..."
}
```

### 心跳格式

```json
{ "type": "ping", "timestamp": 1234567890 }
{ "type": "pong", "timestamp": 1234567890 }
```

## 鉴权

设置 `token` 后，所有连接必须携带正确的 token：

```bash
# Agent 连接
ws://server.com/ws?token=your-secret-token

# Connector 连接
ws://server.com/ws?token=your-secret-token
```

## 部署建议

> 交给外部进程管理器（systemd / Docker / PM2）托管时，请加 `--foreground`，让 server 在前台运行，由管理器负责守护与重启。

### 使用 systemd（Linux）

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

### 使用 Docker

```dockerfile
FROM node:20-alpine
RUN npm install -g @mearl/cloud-server
EXPOSE 8080
CMD ["mearl-cloud-server", "--foreground", "--token", "your-token"]
```

### 使用 PM2

```bash
pm2 start mearl-cloud-server --name mearl-cloud-server -- --foreground --port 8080 --token your-token
```

## 注意事项

- 建议在生产环境使用 WSS（WebSocket Secure）加密传输
- 使用反向代理（如 Nginx）处理 WSS 升级
- 设置合理的 `maxConnections` 限制资源占用
- 启用 `token` 鉴权保护服务安全
- 在沙箱环境中启动时，会自动检测并使用平台分配的公网地址
- 如果沙箱端口映射 API 不可用，会回退到使用本地 IP 地址
