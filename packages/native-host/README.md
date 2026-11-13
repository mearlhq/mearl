# @mearl/native-host

[简体中文](README.md) | [English](README.en.md)

Mearl 的 Native Messaging Host —— 桥接 Chrome 扩展与本地 socket 服务。

浏览器扩展通过 `chrome.runtime.connectNative()` 启动本进程。宿主通过扩展或 CDP 与浏览器交互，通过本地 IPC 连接 `@mearl/client` 等调用方：macOS/Linux 使用 Unix socket，Windows 使用命名管道。Cloud Connector 使用同一宿主连接。

## 动态能力

独立浏览器 Provider 可通过 `@mearl/native-host/external-page-host` 的 `createExternalPageHost` 复用页面操作、设备外壳、根 WebView 与已安装 App 宿主服务。调用方提供已关联目标的扁平 CDP session ID、`CdpTransport` 和控制权检查；模块不发现浏览器、不认领标签页、不启动 Native Messaging。`invoke` 仅执行允许的页面动作。失去控制权时调用 `suspend()`，中止当前宿主授权租约；控制权恢复且检查通过后，下次调用建立新租约。`dispose()` 取消宿主请求并释放连接；需要恢复普通页面时先通过 `invoke` 清除 App 和设备模拟。传输必须在每次发送时执行浏览器原生控制校验。真实授权使用已安装能力的控制器，仍需用户批准。

宿主提供浏览器控制、设备模拟、插件执行和默认埋点解析。Node 能力包通过声明的 hook 提供处理器，资源、激活与回滚合同见 [Node 能力包](../../docs/node-capabilities.md)。Setup 与网页安装桥共用 [安装宿主](../../docs/preset-installation.md) 的协调流程。

## 安装与注册

核心构建完成后，可在仓库根目录运行 `node scripts/verify-extension-agent-coordination.mjs`，在临时 HOME 与 socket 目录验证真实 Native Messaging 握手、过期确认拒绝、浏览器配置隔离及关闭后的焦点事件。脚本不连接用户浏览器，结束后清理临时进程与文件。Provider 的原生应用匹配、事件合并与故障关闭另由单元测试覆盖。

注册 Native Messaging Host manifest（让浏览器能够拉起本进程）：

```bash
# 同时注册 Skills 与 MCP 两种集成模式（默认）
mearl-native-host --init

# 仅注册某一种模式
mearl-native-host --init --mode skills
mearl-native-host --init --mode mcp

# 指定自定义扩展 ID（开发版）
mearl-native-host --init --extension-id <your-extension-id>
```

> Skills 与 MCP 两个 host 运行同一份二进制、共享同一个 Unix socket，因此可同时启用。

也可在代码中调用安装入口：

```typescript
import { installNativeHost } from '@mearl/native-host';

await installNativeHost(); // 默认注册两种模式
```

运行时入口（被浏览器拉起、或手动启动）通过子路径导出：

```typescript
import '@mearl/native-host/runtime';
```

## CLI 选项

```bash
mearl-native-host [options]

  --init [--mode <skills|mcp|both>] [--extension-id <id>]   注册 host manifest
  --daemon                                                   独立 CDP daemon
  --cdp-port <port>                                          指定 CDP 端口
  --cdp-user-data-dir <dir>                                  指定 Chrome Profile
  --cdp-endpoint-file <path>                                 从文件读取私有远端 CDP WebSocket URL
  --skip-browser-registration                                不把 Provider 私有 CDP 运行时注册为独立浏览器
  --browser-id <id>                                          指定浏览器注册 ID
  --browser-name <name>                                      指定浏览器显示名称
  --version, -v                                             查看版本
  --help, -h                                               查看帮助
```

daemon 参数只对当前进程生效。用户可通过内置 CDP Provider 接入已有 Chrome 或 Electron。默认接入读取 Chrome 默认 Profile 的 `DevToolsActivePort`，并在需要时探测本机 9222 端口。Electron 使用 `providerOptions.port` 指定渲染页面的调试端口。接入步骤见 `mearl guide browsers`。

通过 `chrome://inspect/#remote-debugging` 开启的 Chrome 授权模式会关闭 HTTP 发现接口。若 `DevToolsActivePort` 缺失或无法读取，且 `/json/version` 返回 404，Mearl 会连接同一端口的 `/devtools/browser` WebSocket，并等待 Chrome 的连接授权。请在 Chrome 提示时允许连接；该路径不读取浏览器 Profile 文件。连接失败时会保留发现文件的读取错误，便于区分文件权限、端口和连接授权问题。

## 架构

macOS 的扩展连接会优先读取 Native Messaging 宿主直接父应用的 bundle ID，区分 EgoLite、Chrome 和 Edge（含列出的 Chrome/Edge 测试通道）；识别结果在宿主进程内缓存。不会按页面 UA、应用目录名称或浏览器版本猜测，因此页面切换设备/App 模拟不影响浏览器名称。其他系统、未知应用或读取失败时保留扩展上报的名称。该名称用于展示和选择，不代替页面关联、控制归属或域授权检查。

```
Chrome Extension
  ↓ (Native Messaging)
@mearl/native-host  ← CDP →  Chrome
  ↓ (Unix Socket)
@mearl/client  /  @mearl/cloud-connector
```

`browser_launch` 会为每个托管 Chrome 启动一个带独立 CDP 配置的 native-host 子进程，使多个 headless/Profile 实例可以同时被现有浏览器注册表寻址。外部 Provider 也可使用私有远端 CDP 模式复用同一套通用页面 action；远端服务的凭据、生命周期和文件中转仍由 Provider 自己负责。

## 侧边栏 Agent Chat

扩展侧边栏通过 Native Messaging 调用 native-host，再按用户选择启动持久的 Codex app-server 或已安装 Agent 能力的进程。Provider 支持流式消息、思考与工具进度、中断和审批，并复用各自 CLI 已保存的本地登录态。

需要安装并登录支持 `app-server` 的独立 Codex CLI 或 Codex App。native-host 会查找安装时的 Node 可执行文件目录、常见全局安装目录、版本管理器、`PATH` 和 Codex App 内置运行时，并发验证兼容性后选择语义版本最新的一项。自动选择结果会在当前 native-host 进程中缓存；显式指定的路径始终优先：

```bash
MEARL_CODEX_PATH=/absolute/path/to/codex
```

Agent 对话的安装页通过 npm 将缺失的 Codex 或 Qoder 组件安装到 `~/.mearl/agent-programs`。Qoder 的本地 Agent 适配器由 [`@mearl/plugin-qoder`](../plugin-qoder/README.md) 提供，当前预设提供的 Qoder 适配器优先。菜单安装只启用本地 Agent，保留现有预设。

## 插件宿主能力实施方案

插件宿主统一管理命令执行、任务、页面实例、事件、模型执行和状态。工具箱、CLI、SDK、MCP 与 Agent 是调用入口；工具页面的存活不决定后台能力的存活。协议与已有工具一起更新，不提供旧接口适配层。

### 所有权和身份

- 执行环境使用持久 `hostId`；每次宿主进程启动产生独立 `epoch`。`hostId` 保存在插件注册目录，身份只描述执行环境，不授予权限。
- 最终由每个执行环境的用户级执行服务持有任务和执行器；浏览器 Native Host 负责连接与目标适配。浏览器目标与模型执行位置独立选择，启动后固定，不随默认浏览器变化。
- 每次命令拥有 `invocationId`、来源、插件及可选父调用。可信入口构造上下文，业务 input 无法替换。嵌套插件调用继承宿主和来源，产生新的调用 ID。
- 注册安装 ID、逻辑名称与不可变代码 revision 分开。任务和页面实例固定 revision；更新仅影响新执行，活动执行按完成、排空或停止策略处理。完整源码快照需要覆盖本地依赖，入口文件元数据不能代替代码 revision。

### 命令执行器

命令 handler 接收 `(input, context)`。上下文提供 `identity`、`signal`、`invoke` 与 `progress`，在该次执行结束后失效。JS 插件是可信本机代码，执行器隔离保障宿主可调度和可终止，不构成操作系统权限沙箱。

`executeRegisteredPlugin` 为每次调用建立监督进程与业务子进程，Python 入口通过业务执行器转接到 Python 子进程。监督进程独立观察宿主连接，业务代码阻塞也不影响拥有者断线清理。浏览器与 Agent 调用由父宿主处理，工作目录和环境继承当前执行宿主。公开调用与工具页面命令白名单分别校验，来源标签不参与授权。Python 注册信息和执行终态均须经宿主 ACK 后才退出，宿主按进程 exit 结算并释放父端管道，后代继承 stdio 不阻塞完成；已确认终态后仍未退出的 Python 进程有 1 秒退出宽限，随后强制停止，最终仍须监督进程确认全树清理。

```typescript
await executeRegisteredPlugin('example', { command: 'read', input }, hostContext, {
  signal: controller.signal,
  executionTimeoutMs: 120000,
  onProgress: progress => updateProgress(progress),
});
```

等待超时、执行期限、调用方断线和取消分别处理。取消先通知执行器，宽限期后终止；执行器退出确认后才报告停止。已收到的成功结果先于后续取消生效。停止时返回仍待完成的宿主 action 名称，以便调用方核对外部操作；命令未等待宿主调用就返回时明确失败。

执行器提交结果后保持进程归属，父宿主接收结果后统一清理：POSIX 收割进程组，Windows 在监督进程仍存活时执行 `taskkill /T`。拥有者断线由独立监督进程处理，清理无法确认时报告 `PLUGIN_EXECUTOR_CLEANUP_FAILED`。外部服务已提交的操作无法被本机终止撤销。

结果经独立 JSON 通道完整提交，当前执行器上限 64 MiB，超限明确失败。诊断可裁剪，最终业务结果不能从裁剪后的事件重建。任务结果保存为独立 JSON 资源，Native Messaging 每次传输最多 192 KiB 原始数据的 Base64 分块，读取方校验总长度和 SHA-256。

### 任务和模型执行

任务服务提供 `start/get/list/events/subscribe/wait/cancel/result`，统一执行状态与递增事件序号。状态区分排队、运行、取消中、成功、失败、已取消和中断。记录和终态持久化，进度有界保留；重启后原执行代次未结束的任务标为中断，不自动重做外部操作。父子模型任务共享取消和终态清理；命令可声明检查点和显式恢复入口。

用户级服务使用独占所有权及执行租约；多个浏览器进程不直接并发写同一任务库。任务检查点由任务服务持有，插件声明恢复入口和 revision 迁移条件。长结果保存为带归属、校验和保留期的资源，读取无损分块。

当前服务按插件注册目录分区，监听本机 Unix socket / Windows named pipe；socket 和数据文件限制为当前用户访问。lease 记录 PID、OS 进程创建身份、协议版本、hostId 和 epoch。启动锁避免多个调用入口同时拉起服务；停止接口等待执行器清理与 lease 释放。协议不匹配要求先停止旧服务，不静默连接错误版本。

接受任务时固定工作目录、环境、安装 ID、源码 revision 和浏览器路由。环境只用于子进程，不写进任务记录。源码与相对资源以内容 hash 保存为只读快照；静态 JS import/require 必须是 Node 内置模块或快照内相对文件，外部包需先打包，越界和缺失依赖在接受前拒绝。快照不复制 node_modules，也不冻结系统程序、Python 包环境和运行时计算的外部依赖；按名字调用其他插件属于宿主依赖，仍按调用时注册解析。安装换源或卸载后重装产生新的安装 ID。

默认并发 4，排队上限 128；业务 input 上限 256 KiB，单次进度上限 64 KiB，历史最多 256 条且不超过 512 KiB。事件接口提供游标、缺口标记和最新任务快照。列表按页和字节数限制响应，返回 nextCursor；终态任务与结果保留 7 天，常驻期间每小时清理，并回收无任务引用的 revision。

CLI/SDK/MCP 可以查询本机任务；工具页面限于自己插件的 toolbox/runtime 任务，公开入口创建的任务不向工具箱查询开放。工具箱的浏览器调用各自绑定原 Native Host 连接，页面关闭不影响连接；浏览器连接丢失后的浏览器调用明确中断，不切换到其他窗口。纯本机任务不依赖该连接。公开后台浏览器任务必须显式选择目标，名称在接受前解析为稳定 browserId，执行中禁止覆盖 browser/connector/session/transport/local。

显式 idempotencyKey 在安装与入口范围内去重，输入、revision、路由、环境或执行期限改变时报告冲突。工具箱自动合并同一 Native Host 的相同活动请求；任务完成后用户再次操作会创建新任务。等待超时与取消订阅只结束等待，取消执行须显式调用 cancel。

```typescript
const tasks = new PluginTaskClient();
try {
  const task = await tasks.start('example', { command: 'read', input: { path: 'document.txt' } }, { executionTimeoutMs: 120000 });
  const result = await tasks.wait(task.taskId, { timeoutMs: 30000 });
} finally { tasks.disconnect(); }
```

任务执行位置是调用入口所在的本机服务，任务 ID 带 hostId；异地 ID 明确拒绝，不广播查询。对外由插件提供业务命令及所需的进度、取消或恢复操作。CLI 和 MCP 通过插件业务入口调用，不公开通用任务、模型、状态、页面实例或宿主诊断工具。

模型作为 `kind: model` 的持久任务，复用事件、取消、无损结果与保留期。命令默认并发 4，模型默认并发 2，分别最多排队 128 个，避免命令等待子模型时阻塞模型调度。`app.model(request)` / `context.model(request)` 创建关联当前任务的模型子任务，父任务取消或结束时先清理子任务；同步入口也把调用信号传给模型执行。模型默认期限 120 秒，执行器拥有独立 Provider 进程，取消后确认进程树停止才报告终态。

`capabilities` 返回 Provider 实际支持的 mode、permissions、结构化输出、流式和取消能力。当前 Codex 只提供显式 `{ provider: 'codex', mode: 'agent', permissions: 'read-only' }`，每次使用临时 app-server 会话，禁用已配置的 MCP、Apps、搜索、插件和相关扩展功能，沙箱禁止写入和网络；人工请求直接失败。它仍有只读 Agent 的本机读取能力，不能承诺完全不调用工具，因此 `mode: 'generate'` 明确拒绝，绝不降级。交互侧边栏保持独立会话生命周期。

请求最多 256 KiB；`outputSchema` 最多 64 KiB，通过 [Codex app-server](https://developers.openai.com/codex/app-server/) 的 `turn/start` 传递。宿主只接受成功 turn 的原始最终消息，并解析 JSON，再生成成功任务；outputSchema 的约束交给模型 Provider，插件负责验证最终数据结构和业务约束；Provider 的 willRetry 错误不提前结束执行，终态错误保留具体原因及稳定错误码。`model.delta` 是可缺失的诊断进度，不能拼接成最终结果。最终文本上限 32 MiB，结构化返回 `{ text, output?, provider, mode, model? }`，模型额外业务约束仍由插件校验。

SDK 使用 `PluginModelClient.capabilities/list/start/run`。工具箱使用 `host.model.capabilities/list/start` 和 `waitTask`。`PluginModelClient.run` 的 signal 会取消执行并等待清理，语义与仅停止观察的任务 `wait` 不同。

### 检查点与显式恢复

命令入口可声明 `taskRecovery` 并注册同名 `app.recoveryCommand()`，后者只在宿主创建的恢复 attempt 中执行，不通过公开命令、工具箱白名单或嵌套调用开放。

```javascript
export const taskRecovery = { version: 1, commands: {
  work: { checkpointVersion: 1, schema: { type: 'object', properties: {
    operationId: { type: 'string' },
  }, required: ['operationId'], additionalProperties: false } },
} };
export default app => {
  app.command('work', async (input, context) => {
    const operationId = await createIdempotentOperation(input);
    await context.checkpoint({ operationId }, 0);
    return waitForOperation(operationId);
  });
  app.recoveryCommand('work', async (input, context) => {
    const { operationId } = context.recovery.checkpoint.data;
    return reconcileOrWaitForOperation(operationId);
  });
};
```

`context.checkpoint(data, expectedSequence)` 仅在 service 路由、未绑定页面实例的活动受管理公开命令中可用；子任务可记录检查点，显式恢复仍只接受合格根任务。负载最多 64 KiB，宿主检查 JSON 和 CAS 序号，分配递增检查点序号；schema 是格式描述与版本身份，插件负责验证检查点数据。数据、版本、宿主计算的 canonical schemaHash、任务快照和 checkpoint 事件写入同一个原子任务记录；并发过期写入明确冲突。检查点不是外部操作的完成证明，与插件 state 事务也不共享提交。外部提交与检查点之间的故障窗口由恢复入口查询操作状态或使用稳定幂等键处理。

SDK 使用 `PluginTaskClient.checkpoint(taskId)` / `resume(taskId, { environment?, revision? })`。resume 只接受失败、取消或中断的根命令，创建新的 taskId 和执行代次，记录 `resumedFrom`，原任务保持终态；相同来源任务只有一个直接后继，重复请求返回已有 attempt，配置不同则冲突。继续恢复失败的新 attempt 时，对新 taskId 调用 resume。

恢复默认 `revision: 'original'`，沿用原安装、代码快照、输入、cwd、路由和执行期限。接受前重新验证安装归属与全部源码 hash，拒绝快照缺失或损坏，不回退到当前代码。原环境不落盘，SDK 默认显式提交调用进程的当前环境，也可传 environment；不使用服务的环境替代。`context.recovery` 包含 fromTaskId、fromRevision、原始 sourceCheckpoint 格式引用和已接受的 checkpoint。新 attempt 继承数据但自己的 checkpoint 序号从 0 开始；resumedFrom 保存原 revision/version/sequence。隐藏恢复入口接收原输入，不要求其满足新版本 CLI 的必填参数，由恢复 handler 处理历史输入。

显式 `resume(taskId, { revision: 'current' })`在首个请求进入时固定当前注册代码快照。同格式版本且 canonical schema 相同时直接接受；同版本修改 schema 拒绝，必须提升 checkpointVersion。跨格式版本只支持目标声明的单步迁移：

```javascript
export const taskRecovery = { version: 1, commands: {
  work: { checkpointVersion: 2, schema: currentSchema,
    migrateFrom: [{ version: 1, schema: historicalSchema }] },
} };
export default app => {
  app.command('work', runWork);
  app.checkpointMigration('work', ({ checkpoint, fromRevision, toRevision }) => {
    return { operationId: checkpoint.data.id };
  });
  app.recoveryCommand('work', recoverWork);
};
```

migrateFrom 最多 16 个不同的旧版本（均低于目标版本），历史 schema 必须与检查点写入时记录的宿主 hash 及保留代码声明一致。即使源码没变，依赖环境等动态声明发生格式漂移也拒绝恢复。迁移和恢复进程调用隐藏 handler 前再次比较目标声明签名，普通 checkpoint 写入也校验执行端声明；Python 每次 run 的 ready ACK 前核对完整加载元数据。迁移返回新检查点的数据，宿主校验 JSON、64 KiB 限制和目标声明身份，再将新数据及来源元信息原子写入唯一后继任务；旧任务和检查点不变。没有迁移声明、格式不匹配、转换失败或清理未确认均不接纳新任务。

同一源任务的并发恢复按 revision 选择与环境指纹合并，不同意图冲突；已提交后继的重试先核验请求指纹，不重复转换。迁移在独立受管理进程执行，10 秒期限，与声明解析共享最多 8 个进程预算，无等待队列，服务关闭会取消并等待清理。转换和原执行树均确认停止，且安装和双端代码快照再次核验后才接纳新任务。迁移没有宿主 API、模型、state、页面或嵌套插件调用权限；JS/Python 仍是可信本机代码，具备直接文件和网络访问能力，不构成 OS 沙箱。迁移必须是可重复的纯 JSON 转换：提交前崩溃可能再次执行，不承诺转换恰好执行一次。

当前恢复限于 public 入口、由 service 持有稳定路由的根命令。工具箱/Native Host caller 路由、页面绑定、模型和子任务明确拒绝恢复；它们的生命周期不能从旧任务推断。接纳前递归核验原任务与所有子孙的监督进程、OS 创建身份及 POSIX 进程组，任何执行未停止或清理未确认都拒绝；未确认的所有权记录不因保留期到期而删除。Windows 服务崩溃后缺少完整进程树停止证明时同样拒绝。模型可由恢复入口显式重新请求，它属于新的执行。

### 页面运行时和事件

页面实例绑定插件 revision、浏览器来源、标签页、frame、文档和实例 ID。业务 frame 选择器用于 attach 时解析，实例随后固定目标；业务 WebView 切换产生旧实例失效和新实例建立。扩展使用原生 documentId；纯 CDP 使用默认执行上下文的 uniqueId 标识文档，隔离世界执行插件代码，通过受校验的 CDP binding 传递事件，支持跨域 iframe。旧版 Chromium 未提供 uniqueId 时使用当前连接生成的文档身份，重连后旧实例失效并由激活规则重建。外部 Provider 须声明 `page_runtime` 能力，未声明时明确失败。

`browser-core` 的 `PluginPageRuntimeHost` 共用实例生命周期、事件确认与重传、激活规则、租约和分块传输，扩展和 CDP 仅实现文档解析、脚本执行、端口与存储适配。CDP 会话存储按浏览器端点身份隔离，宿主重启保留会话身份，浏览器重启清除会话规则并保留持久规则；端点地址仅存储其摘要。CDP 沿用浏览器连接的权限范围，插件声明的 URL 匹配范围仍由公共宿主检查。

CDP 会话层按浏览器端点身份保存 target 与虚拟 tabId 的映射，连接时先恢复映射，再开始页面发现和插件对账。页面存储按 storage key 独立落盘，租约更新只写租约记录；文档解析同时返回所属 target，执行操作只等待该 target。

native-host 被清理或连接短暂中断时，文档实例在最后一次成功校验后的 30 秒租约内保留归属；无法确认文档的操作返回 `PLUGIN_PAGE_UNAVAILABLE`，不执行页面操作，也不把失败的对账响应当成实例缺失。重连后须校验原浏览器、文档和实例身份。已接收但尚未启动任务的事件可以继续排队；已发出的操作不自动重放。明确的导航、卸载、文档失效仍立即清理；长时间失联导致租约到期后清理旧实例，启用的激活规则可在宿主恢复时建立新实例。

CDP 页面会话文件在同一连接标识切换浏览器身份、受控浏览器明确关闭或确认进程已退出时回收，持久激活规则保留。
缺少可验证浏览器归属的旧会话文件保留到完整卸载；`cdp-targets` 的标签 ID 递增计数跨浏览器生命周期保留，避免旧请求误操作新标签。
受控浏览器日志在启动前按 5 MiB 轮转，保留一份备份；无对应浏览器记录的日志保留 7 天，在宿主启动、浏览器查询或启动时清理。

宿主提供 `attach/get/list/send/detach`，独立于 toolbox 声明。工具页关闭只退订 UI；文档刷新按策略重建，SPA 导航通知实例，插件停用时解除事件并清理资源。出队、关键宿主调用和回写前都校验实例有效性。

事件绑定属于运行时声明，指定事件、负载结构、命令和串行、待处理合并或有限并发策略。宿主校验真实来源，控制负载和队列上限。事件按实例及连接代次编号：接收确认与业务完成分开，重发去重与业务重试分开。缓存缺口要求重同步；文档失效后废弃旧事件。不承诺跨故障恰好执行一次。

当前页面实例按插件安装与真实目标文档共享，CLI、工具箱和自动激活的并发 attach 等待同一次初始化；工具箱只能访问自己的插件。`pageRuntime` 独立于工具箱声明，JS 入口导出函数源码与 URL 范围，`app.runtimeCommand()` 注册后台初始化和事件处理器；这些命令不能被公开命令或工具箱命令直接调用。注册代码也在受管理子进程中读取，阻塞注册可终止。

Python 入口也可导出同结构的 `pageRuntime` 字典，`code` 为网页端 JavaScript 函数字符串；`app.runtimeCommand()` 支持直接注册和装饰器。Python 的 `app.page()` 及实例绑定的 `context.page.send/get` 通过同步桥接调用同一页面服务。runtime-only 标记参与描述元数据校验与实际 Python handler 选择，公开命令和工具箱不能直接执行；普通 `app.command` 若同时用于页面事件，则继续保持公开身份。每次 Python run 的 ready ACK 之前核验完整 descriptor，包括页面声明和命令可见性。

```javascript
export const pageRuntime = {
  version: 1,
  matches: ['https://example.com/*'],
  initialize: 'initialize',
  code: `host => ({
    receive(message) { return { title: document.title }; },
    dispose() { /* release listeners and DOM owned by this instance */ },
  })`,
  events: { changed: { command: 'save', policy: 'latest',
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } },
};
export default app => {
  app.runtimeCommand('initialize', (input, context) => context.page.send({ type: 'initialize' }));
  app.runtimeCommand('save', ({ event }, context) => save(event.payload));
  app.command('open', input => app.page('attach', { tabId: input.tabId, frame: 'business' }));
};
```

页面函数的 `host.emit(name, payload)` 返回接收确认；处理结果通过实例事件查询。`context.page.send/get` 始终绑定当前实例，运行时任务的普通页面动作和复合页面入口被拒绝。每次出队、宿主调用和提交结果都重新检查文档。运行时传输保留控制会话归属、暂停与释放检查，并行处理消息和回调；消息顺序由实例与事件策略负责，等待业务消息不会阻塞同文档的校验或取消。页面 `receive(message, { signal, requestId })` 提供每条消息的协作取消信号；任务取消传播到该文档对应请求，插件异步等待后应检查 signal。取消不强制终止页面 JS，已提交的外部操作仍需核对。后台默认每 10 秒并发续租，每实例校验超时 8 秒，浏览器租约 30 秒；续租只更新内存，独立定时器每 5 秒批量保存轻量租约，完整运行时代码与待确认事件只在对应状态变化时持久化。失效时取消排队和运行任务并释放页面资源。

事件 schema 保留为格式描述，后台处理器负责验证负载；宿主检查事件绑定、文档归属、大小和调度约束。事件负载最多 32 KiB，页面待确认队列 64 条；后台每事件默认待处理 32 条（最多 64），每实例活动事件最多 128，有限并发最多 8。历史最多 256 条及 384 KiB，游标缺口明确返回。Native Messaging 的请求与结果各按 192 KiB 分块并校验 SHA-256，单条页面业务消息/结果最多 24 MiB；浏览器与工具箱回复资源各有 32 MiB 总预算及 30 秒过期。

SDK 使用 `PluginPageClient`。工具箱调用 `host.page.*`，或 `window.mearl.subscribe('page', { instanceId, cursor? }, listener)` 观察后台事件；`events` 接受 `cursor` 与 `waitMs`（0–25000），无新事件时可等待变化；工具箱订阅先读取快照，随后使用长轮询，退订只结束观察。内部 `page_runtime` 是文档适配协议，业务插件使用 `app.page()`。设计稿叠加通过页面事件保存素材。

激活通过 `app.page('activation', { enabled: true, matches, persistence: 'session' | 'persistent', frame, input })` 显式配置；实际范围是用户规则与声明范围的交集；自动激活实例在注入、SPA 导航及日常校验时复查该交集，离开范围即失效，手动挂载遵循插件声明范围。关闭规则清理实例，在途挂载由规则代次校验阻止。扩展 worker 重启后先与执行服务握手，核验 hostId、service epoch、安装、revision、browserSessionId、documentId 和 instanceId；同一所有者按服务端已接收位置续传未确认事件，确认位置只前进。连接 epoch 变化不改变业务事件序号。桥接暂时不可用时保留队列等待对账，租约过期后失效。

独立修改匹配范围时，可传 `enabled: true, matchPatch: { add?: string[], remove?: string[] }`，与 `matches` 互斥。宿主原子增删范围，避免并发调用覆盖其他范围；删除最后一个范围会关闭自动激活，保留手动挂载的页面实例。`persistence: 'persistent'` 在浏览器重启后保留，初始化 handler 可读取最新插件偏好，不必将易变配置复制到规则 input。

执行服务 epoch 变化、实例消失或接收位置回退时，旧实例和队列失效，不向新服务重放旧事件。已有激活规则可以创建新实例，手动实例需重新 attach；规则绑定安装 ID，插件卸载或换源后同名新安装不会继承授权。新注入在独立脚本世界内串行交接，等待旧 handler 完成 dispose，再建立新实例，避免旧覆盖层清理影响新 DOM。

### 状态和激活

schema 是格式元数据，宿主不执行 JSON Schema 关键字校验；状态写入、事件负载、检查点及迁移数据由插件验证。插件导出 `stateStorage = { version: 1, collections: { ... } }`，每个集合声明 `scope`（installation/host/browser-session/instance）、`storage`（persistent/cache/memory）、`schemaVersion`、JSON Schema 和可选 `maxEntries/maxBytes/ttlMs`。浏览器会话与实例只接受 cache/memory；memory 只允许这两种作用域，并且只驻留插件执行宿主内存，按需分配，全宿主合计上限 128 MiB / 512 个集合命名空间，宿主重启清空；实例结束释放对应内存。浏览器会话在文档刷新时保留，新的浏览器会话使用独立空间。所有页面作用域都由真实活动页面解析，不能用业务字段伪造。实例结束清理专属缓存；其他缓存默认 TTL 一天，最多七天，读取、定时维护和配额检查会回收过期值。持久配置、缓存、任务记录和二进制资产分别管理。

同一命名空间已有状态时，memory 与磁盘存储之间切换须使用新的集合名或作用域；不支持跨存储介质迁移。

`get/list/transact` 在用户级任务服务串行处理，集合的值、CAS 版本、schema 版本、TTL 与最近 64 次幂等回执一起写入单个原子记录。每个 put/delete 必须携带读取获得的 opaque `expectedVersion`；集合版本单调递增，删除和过期不会重用版本。多键事务最多 128 项、512 KiB，单值最多 256 KiB，默认每集合 1024 项/8 MiB，磁盘状态每插件总量 64 MiB；memory 按前述全宿主上限管理。list 返回有界分页，调用方带 `expectedRevision` 检测翻页期间的变动。

变更 schema 或存储类型需要提升 `schemaVersion`。迁移事务明确带 `migrateFromVersion` 与 `expectedRevision`，插件负责验证和转换全部保留值，宿主核验版本及事务约束后原子提交；旧 revision 禁止回写新 schema。同步 handler 也校验加载时的声明签名，避免代码更新期间误写。更换安装不会继承旧安装命名空间。

命令使用 `app.state(collection, operation, input)`，或通过自动绑定当前页面实例的 `context.state(...)` 调用。SDK `PluginStateClient` 与工具箱 `host.state.*` 使用同一服务。设计稿叠加的素材和设置使用 browser-session memory，素材通过有界分块读写。用户显式导出的图片不属于缓存。

插件声明可用 URL 范围与激活入口，用户规则决定是否启用、匹配范围和跨重启保留。激活维护页面实例，业务命令由显式调用或事件触发。扩展、浏览器和执行服务分别重启时，通过握手对账实例及任务，防止重复恢复。

工具箱后台命令通过 `host.task.*` 执行。普通同步命令在调用进程执行，后台命令使用受管理执行器；长期资源通过状态、文件或资源通道保存。

工具箱用户发起的页面 attach 在解析目标文档缺少站点权限时，复用宿主权限弹窗，批准后仅重试未派发的 resolve。页面心跳、已有实例消息与后台事件不弹窗，也不重放可能已产生效果的操作。扩展重载属于宿主操作，与当前网页的域权限独立。

### 跨插件调用

受管理任务的跨插件 `app.invoke(name, { command, input })` 建立独立子任务，固定子插件自己的 installation/revision，并提供自己的 state/model/page/checkpoint 归属。子调用只可执行公开命令，不继承工具箱或 runtime 隐藏命令权限；循环调用和超过 16 层的调用明确失败。父任务取消、到期或结束时取消并等待整个子执行树。子插件不能换浏览器路由；页面绑定调用继承原文档约束，页面实例需由子插件显式 attach 并遵循自己的 pageRuntime，不能借用父插件实例或控制其他文档。子任务可记录检查点，但显式 resume 仍只支持合格根任务。

### 统一诊断

`PluginTaskClient.diagnose()` 和工具箱 `host.task.diagnose` 读取同一元数据报告。筛选条件 taskId/plugin/instanceId 取交集，先按调用范围过滤，再展开父子与恢复关联；工具箱固定当前插件，不能借关联读取其他插件任务。诊断不启动模型、不发送浏览器请求，不改变页面绑定。

报告关联 hostId/epoch、task/parent/resume、invocation、installation/revision 和 document/instance，模型记录运行时选择、基础配置来源、已观察的认证类型、请求/配置/实际改派的模型，以及 thread/turn 限制获接纳的事实。基础 config/read 不表示线程最终配置；缺少通知或历史记录时保留 unknown/incomplete，不推断账号、凭证或执行结果。可执行文件版本未取得时省略。

默认没有输入、提示词、进度正文、检查点数据、结果正文、完整 URL、环境和凭证。默认错误仅含 code、本地可执行路径只留文件名；显式 includeErrorMessages/includeLocalPaths 可加入有限错误消息和本地路径，始终不加入 error details/metadata/stack。CLI 导出为 0600。报告上限 256 KiB、128 个任务、64 个页面、每任务最近 8 条非进度事件；扫描上限为 2048 个目录项、512 份记录和 16 MiB 记录数据。coverage 分别报告扫描不足与输出省略，history.gap 表示原始保留历史缺口。

执行器状态区分未启动、当前观察存活、正向确认整树停止和未知；终态不自动等于停止。页面 service-snapshot 仅是服务当前记录，historical-binding 是执行时留存的文档身份，两者均不承诺浏览器此刻仍处于该文档。

### 公开接口

| 能力 | SDK | CLI | MCP | 工具箱 |
| --- | --- | --- | --- | --- |
| 持久任务、结果、取消、检查点恢复 | PluginTaskClient | 插件按需提供业务命令 | plugin_invoke | host.task.start/get/list/events/result/cancel（检查点恢复由 SDK 发起） |
| 诊断导出 | tasks.diagnose | — | — | host.task.diagnose |
| 固定文档运行时与激活 | PluginPageClient | 插件业务命令 | plugin_invoke | host.page.* |
| 事务状态 | PluginStateClient | 插件业务命令 | plugin_invoke | host.state.* |
| 受管理模型 | PluginModelClient | 插件业务命令 | plugin_invoke | host.model.* |

插件 JS/Python 使用命令上下文的 state/model/checkpoint 与 app.invoke 组合这些能力。普通同步命令在调用进程执行，受管理任务的跨插件调用使用独立子执行器；不应依赖命令进程承载页面长期资源。等待超时只结束观察，执行期限和 cancel 才终止执行树。调度有独立命令/模型名额；等待子任务的父命令让出名额，继续运行前重新获取，最多 32 个等待中的父执行器。活动父子关系由服务内存索引维护，任务收尾只取消并等待自己的活动子任务，不扫描保留历史；重启恢复仍核验持久化执行树。

## 构建与验证

```bash
pnpm build      # esbuild 打包到 dist/（内联 browser-core / daemon-core）
pnpm typecheck  # 仅类型检查
```

## License

Apache-2.0

模型列表可通过 SDK `PluginModelClient.list()` 或工具箱 `host.model.list` 查询。模型项携带可用时的 `reasoningEfforts` 和 `defaultReasoningEffort`，界面按模型支持范围提供思考级别。宿主合并并发发现请求，已有模型目录立即返回，过期后后台刷新；刷新失败保留可用目录并短暂退避，不创建推理会话。状态批量读取使用 `get-many` 和 `keys`（SDK `getMany`、工具箱 `host.state.getMany`），一次读取同一 revision 的最多 128 个键，含缺失键的 CAS version，结果上限 1 MiB。


插件宿主通过 `PluginHost` 统一组装 `tasks/state/pages/models` 并管理关闭顺序与诊断。任务调度器只管理任务执行、父子调用、取消和恢复，通过注入的服务函数访问状态与页面。模型执行仍作为任务使用独立调度额度，模型目录由宿主共享。页面实例的状态范围解析由宿主显式接线。`PluginHostConnection` 负责共享 RPC 通信；Native Host 按插件、交互渠道和来源分别缓存连接，避免共享连接改变权限申请行为。
