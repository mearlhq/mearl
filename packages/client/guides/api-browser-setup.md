# Mearl API 场景：浏览器初始化与管理

需要管理控制会话、选择远端 connector、在同一 connector 下选择浏览器，或列出、启动、关闭、释放普通及 Provider 托管浏览器实例时读取本文件。设备、时区和 Cookie 操作见 [页面测试环境准备](./api-page-environment.md)。

## 目录

- [浏览器实例](#browser-instances)
- [Electron 桌面应用](#electron-cdp)
- [控制会话与人工交接](#control-sessions)
- [目标宿主与高级路由参数](#cloud-connectors)
- [可选浏览器 Provider](#browser-providers)

<a id="browser-instances"></a>

## 浏览器实例

`browser_list` 返回普通浏览器和 Provider 托管浏览器。顶层包含 `count`、`connectedCount`、`defaultBrowserId`、`browsers`，部分来源发现失败时还会返回 `warnings`。公共字段包括 `browserId`、`name`、`type` 和 `status`：

- `type` 为 `regular` 或 `managed`。
- `status` 为 `connected`、`pairing`、`running_disconnected` 或 `stopped`；只有 `connected` 可作为页面操作目标。
- Provider 实例还会返回 `provider`、`ownership`、`persistence`、`operations`、`references`、`details` 和可选的 `pairing`。用 `operations` 判断当前可执行的生命周期操作。

`browser_manage` 的 `launch` 默认启动本地独立 Chrome。Provider 使用以下通用结构。外部 Provider 的参数可通过 `mearl <providerId>` 查询。

```bash
mearl browser_manage --payload '{"operation":"launch","provider":"<providerId>","providerOptions":{}}'
```

本机与远端 connector 同时存在时，用 `--local`、`--connector <id|name>`，或用 `--browser <global-id>` 同时指定宿主和 Cookie/UA 的来源浏览器。启动响应中的全局 `browserId` 用于首次操作和交付；建立控制会话后，后续操作由 `--session` 固定目标，无会话时继续传选定的 `--browser`。

`browser_manage close` 关闭托管实例；`deleteProfile: true` 表示同时删除 Provider 持久化数据。是否支持关闭、删除、启动、同步 Cookie、detach 或访问入口，以实例的 `operations` 和 Provider 命令帮助为准。

`browser_manage` 的 `release` 通过 `--browser <id|名称>` 选择浏览器，只在用户明确要求结束调试、退出接管或清理环境时调用。它会释放 debugger/CDP 控制，清理依赖当前调试连接的 Mock、设备/时区模拟与持续采集，保留浏览器、标签页和原有接入。存在活动控制会话时拒绝浏览器级释放。会话任务的收尾见[控制会话](#control-sessions)。外部 Provider 的收尾方式见 `mearl <providerId>`。

浏览器访问入口不会出现在 `browser_list` 中。只有用户明确需要时才运行 `mearl check --browser <id|名称>`，并把返回的 `browserAccess.url` 按敏感信息处理，不写入日志或转发给无关方。

<a id="electron-cdp"></a>

## 接入已有 Chrome 或 Electron

CDP Provider 可接入已启用远程调试的 Chrome 或 Electron，并使用已有页面和登录态。Chrome 可在 `chrome://inspect/#remote-debugging` 开启调试，有授权提示时在浏览器中允许连接。

本机没有已连接的扩展或已接入的 CDP 实例时，`browser_list` 会通过 CDP Provider 发现默认 Chrome。脚本直接执行 `tab_list` 等浏览器命令时，如果没有可用目标，也会尝试发现。默认接入读取 Chrome 默认 Profile 的 `DevToolsActivePort`，并在需要时探测本机 9222 端口。可以用下列命令显式接入。

```bash
mearl browser_manage --local --payload '{"operation":"attach","provider":"cdp","providerOptions":{}}'
```

连接 Electron 时，传入已启用的渲染页面调试端口。若需为应用启用调试，可在启动时传入 `--remote-debugging-port=9223`。参见 [Electron 调试开关](https://www.electronjs.org/docs/latest/api/command-line-switches#--remote-debugging-portport)。

```bash
mearl browser_manage --local --payload '{"operation":"attach","provider":"cdp","providerOptions":{"name":"Electron App","port":9223}}'
```

使用响应里的 `browserId`，也可在 `browser_list` 中查找：

```bash
mearl check --browser '<browserId>'
mearl tab_list --browser '<browserId>'
mearl page_snapshot --browser '<browserId>' --payload '{"tabId":12345,"mode":"viewport"}'
```

`tabId` 使用 `tab_list` 返回的真实值。Electron 的操作范围是渲染页面。结束接管时运行 `mearl browser_manage --browser '<browserId>' --payload '{"operation":"detach"}'`，浏览器和标签页继续运行。

<a id="control-sessions"></a>

## 控制会话与人工交接

扩展免打扰默认开启；`tab_open active:true` 为 HTTP(S) 页面启用后台焦点模拟，新页在首次导航前生效，不切换标签页或窗口。关闭免打扰后，`active:true` 才会真实激活并恢复最小化窗口。普通页面操作不会自动启用模拟。`activation.mode` 区分 `background` / `foreground`；模拟后的 `document.visibilityState` 可为 `visible`，不能据此判断窗口在前台。交给用户、释放控制或扩展连接断开时恢复，`preserveEnvironment` 不保留此临时状态；交还后按需用 `reuse:"require", active:true` 再次激活。未带会话时通过 `browser_manage release` 清理。纯 CDP 和外部 Provider 沿用各自激活能力。

用 `session_list` 列出当前会话。用 `session_manage` 的 `new` 和 `--browser` 显式创建空会话，或在首次 `tab_open` / `page_snapshot` / `page_screenshot` 传 `--session new`，后续命令传 `--session <sessionId>`，使用响应的完整 `session.sessionId`。会话绑定浏览器与传输，页面操作同时指定 `tabId`；仅支持视觉感知的 Provider 可从截图建立会话。

扩展新建的后台页面默认进入折叠的 `Mearl` 标签组，前台新页进入展开的 `Mearl · 待操作` 组；两个管理组复用同一个已有窗口，页面打开的后续标签继承源组状态。复用用户的普通页面保留原窗口和分组，`tab_open.group` 可指定其他分组。接管时会话内的管理页移入待操作组，交还后收回 `Mearl` 组；用户正在查看组内其他页面或窗口没有其他页面时保留展开状态。纯 CDP 和外部 Provider 沿用各自的页面组织方式。

常规响应的 session 只包含 ID、浏览器、传输、状态、代次和可选 reason，不重复标签页清单。页面列表用 tab_list 查询；session_manage 的交接结果还包含会话页面的 tabs。CLI、SDK、MCP 使用同一结构。

会话自动记录新建与复用页面，串行执行同页面操作，并阻止其他会话或无会话调用占用其页面。不同任务使用独立会话；会话不隔离 Cookie 与存储，账号或浏览器共享资源冲突时使用独立浏览器。Extension、CDP 和采用 Mearl 控制的 Provider 共用这些规则；声明外部控制的 Provider（如 Ego）拒绝 Mearl 会话，交接和收尾沿用原工具。

`session_manage` 的 `operation:"handoff"` 将控制权交给用户，用 `--session` 或 `sessionId` 指定会话，`reason` 说明需要用户处理的事项。用户在 Mearl Popup 浏览器管理页接管和交还；无扩展 UI 的环境，在用户明确确认交还后调用 `operation:"resume"`。

- `CONTROL_SESSION_PAUSED`：停止派发动作，交还后重新快照或截图，根据当前状态继续，不重放未完成批次；已派发的操作可能仍然生效。
- `CONTROL_SESSION_NOT_FOUND`：会话不存在或已失效，在原浏览器以普通调用执行 `tab_list`，获取当前 `tabId` 并检查操作结果，再按任务需要建立新会话，避免重复写操作。

任务结束调用 `session_manage --session <sessionId> --payload '{"operation":"end"}'`，释放该会话的控制归属并清理临时文件，默认保留页面、Mock 与模拟环境。payload 支持以下保留与清理选项：

| 参数 | 行为 |
| --- | --- |
| `closeCreatedTabs:true` | 关闭确认不再需要的会话新建页；复用的用户页面始终保留 |
| `keepTabIds` | 配合关闭新建页时保留结果页面 |
| `preserveEnvironment:false` | 清理会话页面的 Mock 与模拟环境 |
| `keepArtifactIds` | 保留指定浏览器文件产物，其他会话临时文件清理 |

会话释放保留 Provider 实例；关闭、退出接管和同步 Cookie 使用原有实例操作，存在活动控制会话时先释放所属会话。

<a id="cloud-connectors"></a>

## 目标宿主与高级路由参数

默认不传宿主、连接或传输覆盖参数。`browser_list` 会同时查询当前机器和全部远端 connector，结果名称带机器前缀，`source` 包含远端机器的 `connectorId` 和 `connectorName`，全局 `browserId` 可跨 CLI 调用并自动选择本地或远端传输。需要指定目标时优先传这个全局 ID；完整实例名称跨来源唯一时也可由客户端解析。建立控制会话后，后续 action 只需传 `--session <sessionId>` 和页面参数。不要依赖名称片段的模糊匹配。

| 参数 | 作用 | 使用时机 |
| --- | --- | --- |
| `--local` | 只使用当前机器 | 限定本机清单、检查，或在本机执行 `browser_manage` |
| `--connector <id\|name>` | 只使用一台远端 connector | 限定远端清单、检查或启动宿主；名称或 ID 片段必须唯一 |
| `--server <url>` | 覆盖当前调用使用的 cloud-server URL | 自动配置不可用或临时排障时 |

`--local` 不能与 `--connector` 同时使用。全局远端 `browserId` 已包含 connector，普通页面 action 不重复传 `--connector`。`--server` 的解析顺序见 `mearl check --help`，连接排障见[环境安装与连接排查](./troubleshooting.md#cloud-agent)。高级诊断命令 `mearl connector_list` 只用于查看没有可列出浏览器的 connector，普通浏览器操作无需先调用它。

<a id="browser-providers"></a>

## 可选浏览器 Provider

Provider 的参数、配置和生命周期随独立包演进，Skill 只保留能力与安装入口。安装后必须读取 Provider 自带的当前帮助，不从本文件推断字段。

支持的平台和设备来源以已安装 Provider 的能力声明及配套 Skill 为准。

只询问能力或配置时不创建实例。执行任务前先运行 `mearl browser_list`：已有符合目标且 `status: "connected"` 的实例时直接复用；需要创建、配对、接入或收尾时，遵循对应 Provider 命令帮助。实例返回的全局 `browserId` 用于选择目标，无会话时后续统一页面 action 继续使用该 ID。

用户只要求移动视口、移动 UA、触摸事件或机型样式时使用设备模拟，无需创建外部 Provider 实例。通过 connector 接入远端浏览器属于控制链路，平台实例由对应 Provider 管理。

已有 Ego 任务的接入、只读候选查询及页面目标映射见[与其他浏览器工具协作](./browser-tool-cooperation.md)。该流程仅查询明确选择的本机 Provider，不广播查询全部来源。
