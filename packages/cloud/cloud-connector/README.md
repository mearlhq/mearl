# @mearl/cloud-connector

[简体中文](README.md) | [English](README.en.md)

本地连接器，用于把云端 Agent 的操作转发到本地 native-host。内置传输为 WebSocket；其他协议由已安装的集成提供。Qoder 的凭据、配对和 SSE 实现在可选的 [`@mearl/plugin-qoder`](../../plugin-qoder/README.md) 中。

## 安装

```bash
npm install -g @mearl/cloud-connector
# 或
pnpm add -g @mearl/cloud-connector
```

## 两种管理模式

连接器同时支持两种生命周期管理方式，二者通过同一份共享注册表互通（见[运行时文件](#运行时文件)），不会对同一个 `server-url` 重复建连：

1. **被 native-host 托管** —— 在浏览器插件面板里点击连接时，native-host 会自动以**前台进程**方式拉起连接器并监听其状态。无需手动操作。
2. **自管理（守护进程）** —— 在终端用 `start` / `stop` 等子命令把连接器作为后台守护进程管理，拥有独立日志文件，便于在无插件面板的场景（如远程机器、排查问题）下使用。

## 使用

```bash
mearl-cloud-connector <server-url> [options]            # 前台运行
mearl-cloud-connector <command> [server-url|pid] [options]  # 管理后台守护进程
```

**参数：**

- `server-url` —— `ws://` / `wss://`，或已安装能力声明的 URI。核心不解释插件 URI 的配对参数。

**子命令：**

- `start <server-url>` —— 后台启动守护进程（幂等：已有存活连接器则复用）
- `stop <server-url|pid>` —— 按端点或 `list` / `status` 展示的 PID 停止后台连接器；
  PID 必须与当前连接器注册记录匹配，实例已被替换时不会停止新实例
- `stop --all` —— 停止所有后台连接器
- `restart <server-url>` —— 重启指定连接器
- `status [server-url]` —— 查看连接器健康状态、最近心跳及重试信息；省略
  `server-url` 时汇总全部
- `list` —— 列出所有正在运行的连接器
- `logs <server-url>` —— 打印某连接器日志末尾

**选项：**

- `--foreground` / `-f` —— 前台运行（不守护化）
- `--heartbeat <seconds>` —— 心跳间隔（默认 30 秒）
- `--reconnect <ms>` —— 重连间隔（默认 5000 毫秒）
- `--max-reconnect <n>` —— 最大重连次数，-1 表示无限（默认 -1）
- `--connector-id <id>` —— 覆盖本机稳定的 connector ID
- `--name <name>` —— 设置便于识别的 connector 名称（默认主机名）
- `--fail-fast` —— 首次连接失败即退出（供 native-host 探测启动结果）

**示例：**

```bash
# 后台启动一个自管理连接器，拥有独立日志文件（推荐）
mearl-cloud-connector start "wss://cloud.example.com/ws?token=xxx" --name work-mac

# 可选协议示例；须先安装 @mearl/plugin-qoder，按其 README 生成地址
mearl-cloud-connector start "qoder://pair/pairing-code-1234?created=1786723200000"

# 前台运行，仅用于排障或交给 systemd / PM2 等外部进程管理器
mearl-cloud-connector "ws://localhost:8080/ws?token=xxx"

# 查看状态 / 列表 / 日志
mearl-cloud-connector status
mearl-cloud-connector list
mearl-cloud-connector logs "wss://cloud.example.com/ws?token=xxx"

# 停止
mearl-cloud-connector stop "wss://cloud.example.com/ws?token=xxx"
mearl-cloud-connector stop 12345
mearl-cloud-connector stop --all

# 自定义心跳和重连配置
mearl-cloud-connector start "ws://localhost:8080/ws?token=xxx" --heartbeat 60 --max-reconnect 10
```

`status` 将连接器标记为 `starting`、`healthy`、`reconnecting`、`degraded`、`failed`
或 `unknown`。其中 `healthy` 表示进程存活、传输已连接且 WebSocket 最近收到过有效心跳；
旧版本创建、尚未包含连接状态字段的运行记录显示为 `unknown`，重启该连接器后即可补齐。
输出中的 token 会被隐藏。

`start` 会在连接成功后返回，后台进程继续运行。可选配对协议请按对应插件指引提交输出的
`pair` 工具调用；如果配对工具调用已经结束、取消或过期，需要重新生成配对 URL，旧 URL
不能重复使用。

### 编程方式

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

// 优雅关闭
process.on('SIGINT', () => {
  connector.disconnect();
  process.exit(0);
});
```

## 运行时文件

连接器首次运行时会生成稳定的 connector ID，并保存到
`~/.mearl/cloud-connector-identity.json`。名称默认取主机名，可通过 `--name` 或
`MEARL_CONNECTOR_NAME` 设置；ID 可通过 `--connector-id` 或
`MEARL_CONNECTOR_ID` 设置。相同 ID 的新连接会替换旧连接，适合进程重启和网络重连。

每个连接器实例在 `~/.mearl/connectors/` 下按 `server-url` 哈希生成一对文件：

- `<hash>.json` —— 连接记录（含身份、进程、连接状态、最近心跳和重试信息）。daemon
  manager 在拉起子进程后立即写入 `starting` 占位，连接器进程随后持续更新自己的状态；
  删除记录时会核对 pid，避免退出中的旧进程删除新实例记录。崩溃残留会被读取方按 pid
  存活性自动清理。
- `<hash>.log` —— 守护进程日志（`logs` 子命令读取，或 `tail -f` 跟踪）；超过 5MB 会在下次启动时滚动为 `<hash>.log.1`。

native-host 与守护进程 CLI 都通过这套共享路径（由 [`@mearl/daemon-core`](../../daemon-core/README.md) 派生）读取注册表，因此一方启动的连接器另一方也能发现、复用或停止。

> 前台运行（含 native-host 托管）时日志输出到 stdout/stderr，不写独立日志文件；只有守护进程模式才落盘到 `<hash>.log`。

可选协议的认证与配对方式见对应集成文档；核心不读取其凭据。

## 前置条件

1. **安装并初始化本地 Mearl 环境**

   ```bash
   npx @mearl/setup
   ```

   setup 会同步安装 `@mearl/native-host` 与 `@mearl/client`，并完成 Native Messaging 初始化。

   使用本项目的 monorepo 构建产物时，仍需手动初始化：

   ```bash
   mearl-native-host --init
   ```

2. **确保 Chrome 浏览器正在运行**，且：
   - 已安装 Mearl 浏览器插件，或
   - 已在 `chrome://inspect/#remote-debugging` 启用远程调试（Chrome 145+）

## 架构

```
云端 Agent
  ↓
@mearl/client
  ↓
@mearl/cloud-server
  ↓ (WebSocket)
@mearl/cloud-connector (本进程)
  ↓ (Unix Socket)
@mearl/native-host
  ↓
Chrome Extension / CDP
```

已安装的连接协议使用同一生命周期和状态回调；具体拓扑由插件说明。

## 注意事项

- 连接器需要保持运行才能转发云端请求。被 native-host 托管时，连接器以 `detached` 方式启动，会**在插件重载/更新后继续存活**；自管理时由 `start`/`stop` 子命令掌控生命周期。
- 前台模式若想交给外部进程管理器（systemd / PM2）托管，加 `--foreground` 让其在前台运行并由管理器负责守护重启。
- 支持断线自动重连（可在配置中调整）；瞬时断连期间连接记录会保留，仅在进程退出时清除。
- 云端响应超过单条消息上限时会返回结构化错误并保持连接。截图过大时可指定元素范围，
  或使用 `format: "jpeg"` 和较低的 `quality` 重试。
