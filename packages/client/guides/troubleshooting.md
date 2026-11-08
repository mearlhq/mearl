# Mearl 环境安装与连接排查

## 目录

- [环境安装、更新与卸载](#environment-management)
- [本机控制](#local)
  - [浏览器扩展安装](#local-extension)
  - [命令不可用或连接失败](#local-check)
  - [EACCES](#eacces)
  - [ENOENT](#enoent)
  - [ECONNREFUSED / 连接关闭](#econnrefused)
- [远程控制](#cloud)
  - [Agent（控制端）](#cloud-agent)
  - [浏览器端](#cloud-browser)
  - [远程控制常见问题](#cloud-issues)
- [通用问题](#common)
  - [请求超时](#timeout)

按 Agent 与浏览器所在机器选择排障流程；命令参数读取对应 CLI 的 `--help`，失败时优先按错误或 `check` 输出的提示处理。

- **本机控制**：Agent 与浏览器在同一台机器，`@mearl/client` 通过 native host socket 通信。
- **远程控制**：Agent 与浏览器不在同一台机器，`@mearl/client` 通过 cloud-server + cloud-connector 中转。

<a id="environment-management"></a>

## 环境安装、更新与卸载

CLI、Native Host、MCP 和云端核心运行包要求 Node.js >= 20.18.0。安装前用 `node --version` 确认版本；
不满足时先升级 Node。环境安装使用 `{{setup}} --yes`，沿用所展示入口的包名、版本或标签及 registry。
出现 `Unknown operation: plugin` 时，用 `{{setup}} --version` 核对安装器版本；
未指定版本时，npm 可能因 Node 不兼容而选择历史版本。

环境管理使用 `{{setup}} <install|update|uninstall>`，具体选项按子命令 `--help` 查询。Agent 执行 install/uninstall 时附加 `--yes` 或 `--non-interactive`，避免等待交互；人工终端可保留交互选择。

主动安装或更新本机环境时，setup 优先使用显式 `--preset <清单 URL 或路径>`，否则保留本机已选 preset；本机未选择时，在运行时初始化后、安装任何 Skill 前检查已连接扩展的受信 preset 并补齐本机组件。首次连接最多等待约一分钟。多个浏览器选择不同、来源不受信或状态不可读时会停止并提示显式选择，不猜测。浏览器未连接时仅安装基础环境，连接后重跑 setup 即可；普通连接和后台自动更新不触发首次本机 preset 安装。

卸载只在用户明确要求一并移除全部 CLI 插件和浏览器 Provider 时传 `--full`；该选项不删除 Chrome 扩展。正常浏览器任务不主动安装或重新初始化，下方排障只在连接失败后使用。

---

<a id="local"></a>

## 本机控制

<a id="local-extension"></a>

### 浏览器扩展安装

优先安装 [Chrome 商店版](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm)，由 Chrome 管理更新。商店不可用或用户明确要求 setup 托管时，执行：

```bash
{{setup}} extension --full --yes
```

该命令同时准备本地环境。人工在终端执行时可省略 `--yes`。

<a id="local-check"></a>

### 命令不可用或连接失败

`mearl` 或 `mearl-native-host` 命令不存在时，在浏览器所在机器安装：

```bash
{{setup}} --local --yes
```

命令存在但连接失败时，先检查当前链路：

```bash
mearl check
```

只需隔离检查当前机器时使用 `mearl check --local`；路由参数与配置优先级见 `mearl check --help`。只有检查结果表明本地组件缺失、过期或初始化不完整时，才更新并重新初始化：

```bash
{{setup}} update --local --yes
```

<a id="eacces"></a>

### EACCES（权限不足）

仅当 native host 初始化写入系统目录时权限不足，才在浏览器所在机器执行：

```bash
sudo mearl-native-host --init
```

Socket 访问被 Agent 沙箱拒绝时，按错误提示配置访问权限，不通过 sudo 或改写 Socket 权限绕过。

<a id="enoent"></a>

### ENOENT（找不到 Socket）

client 会自动拉起 native host 并重试。自动恢复失败时按错误提示检查本机链路；手工启动或开发版扩展初始化的参数见 `mearl-native-host --help`，不要用 `nohup` 手工保活 daemon。

如果重试后仍然失败，可按以下步骤排查：

**使用浏览器插件模式：**

确认 Chrome 已打开并等待扩展建联；仍失败时打开 DevTools 的 Mearl 面板触发连接。开发版扩展使用其实际扩展 ID 初始化 native host，再重新执行命令。

**使用 CDP 模式：**

按 `mearl-native-host --help` 或连接错误提示在 Chrome 开启调试并允许授权，确认有普通网页已打开后重试。默认在 Extension 不可用时回退 CDP；需要单独验证 CDP 链路时使用 `mearl check --cdp`。

<a id="econnrefused"></a>

### ECONNREFUSED / 连接关闭

client 会处理当前用户的 stale socket 并尝试恢复 native host；恢复失败时运行 `mearl check --local`，按诊断处理，避免盲目删除 Socket 或重复初始化。

---

<a id="cloud"></a>

## 远程控制

远程控制需要在 **Agent（控制端）** 和 **浏览器端** 两端分别准备。

<a id="cloud-agent"></a>

### Agent（控制端）

1. 安装 cloud-server、统一 client 与当前 Agent 的全局 mearl skill：

   ```bash
   {{setup}} --cloud --yes
   ```

   setup 会启动 cloud-server 并输出连接命令。把输出的完整命令交给用户在浏览器所在机器执行，不自行拼接地址或 token。

2. 再次获取连接命令使用 `mearl-cloud-server status`；管理与日志命令见 `mearl-cloud-server --help`。

3. client 自动读取连接配置。用户完成本地连接后，在 Agent 侧验证：

   ```bash
   mearl check
   ```

   按诊断定位故障所在机器，再在对应机器修复。默认不逐次传 Server 地址；覆盖参数、配置优先级和检查范围见 `mearl check --help`。连接 URL 可能包含 token，不写入日志或转发给无关方。

<a id="cloud-browser"></a>

### 浏览器端

1. 执行 Agent 侧输出的完整连接命令，把浏览器接入远程控制链路。

2. 浏览器端仍需满足 [本机控制](#local) 的前置条件（native host 已初始化、浏览器插件或 CDP 已建联），否则 connector 无法连到本地 socket。相关报错（EACCES / ENOENT / ECONNREFUSED）参考上文本机排查步骤。

<a id="cloud-issues"></a>

### 远程控制常见问题

- **Agent 侧无法连接 Server**：运行 `mearl check`，按失败项的提示处理。
- **需要确认动作会落到哪台机器**：运行 `mearl browser_list`，首次操作传返回的全局 `--browser <browserId>`；控制会话建立后由 `--session <sessionId>` 固定目标，无会话时继续传选定的 `--browser`。需要限制到某台远端机器时，从 `source` 获取 ID 或名称并传 `--connector <id|name>`。
- **connector 连不上或一直重连**：在浏览器端运行 `mearl-cloud-connector status`，按状态和错误提示处理。
- **connector 已接入但浏览器不可用或请求无响应**：在浏览器端运行 `mearl check --local`；需要检查 connector 版本与心跳时，Agent 端使用 `mearl connector_list`，字段见该命令 `--help`。

### 可选云连接协议

Qoder Cloud Agent 需要在浏览器机器先安装 `@mearl/plugin-qoder` 能力，再按该包 README 和 `docs/cloud-pairing.md` 生成配对信息、配置自定义工具。普通远端 Agent 使用上述 WebSocket 模式。核心未安装对应协议时会报告能力缺失，不会自动安装或读取该协议的凭据。

### 请求超时

超时可能发生在连接、动作执行或结果回传阶段，不能据此判断动作未执行。

- 连接超时：使用 `mearl check` 定位链路故障。
- 点击、提交、上传或写入超时：先读取当前页面或业务状态确认结果，再决定是否重试，避免重复副作用。
- 只读查询超时：按 CLI 提示缩小查询范围、裁剪结果或增加 `--timeout`；默认时间按 action 推导，不统一设为 30 秒。
