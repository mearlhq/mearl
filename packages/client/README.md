# @mearl/client

[简体中文](README.md) | [English](README.en.md)

在终端使用 `mearl`，或在 TypeScript 中使用 `@mearl/client`，控制浏览器、查看请求和日志，或执行 Skill 命令。CLI、SDK 和脚本运行器共用浏览器路由与插件运行时，安装和连接由 `@mearl/setup` 管理。

首次使用当前版本可运行 `mearl guide`，默认只读取核心工作流。`mearl guide --list` 列出专题；例如 `mearl guide run` 读取 SDK 组合调用，`mearl guide environment` 读取设备与 App 指引。指南只读 npm 包内资源，不连接浏览器、加载插件、安装环境或触发自动更新。动作参数继续使用 `mearl <action> --help`，目标的已安装能力继续按现有目录查询。

指南正文唯一维护在本包的 `guides/`，构建时复制到 `dist/guides/`，`pnpm check:skills` 校验一致性。CLI 输出将本地文档链接转换为下一条指南命令。`skills/mearl/` 只分发精简的 `SKILL.md`，不附带正文副本；仅使用 MCP、无法执行 CLI 时，直接使用当前工具说明与 schema。

统一浏览器 SDK 与 CLI。它会发现当前机器及已配置 cloud-server 下所有 connector 的浏览器，并根据 `browser_list` 返回的全局 `browserId` 自动选择本地 Socket 或云端 WebSocket 链路。

提供两种用法：类型安全的具名方法（`getRequests`、`sendRequest` 等），以及灵活的底层 `invoke(action, payload)`。

## 安装

```bash
npm install @mearl/client
# 或
pnpm add @mearl/client
```

## SDK 使用

```typescript
import * as client from '@mearl/client';

// 具名方法（类型安全）
const requests = await client.getRequests({ tabId: 12345, count: 5 });
const result = await client.sendRequest({
  url: 'https://api.example.com',
  method: 'GET',
  withCookies: true,
});

// 底层通用方法（灵活扩展）
const data = await client.invoke('send_request', { url: '...' });

// browser_list 默认聚合本机和所有远端 connector
const browsers = await client.browserList();
await client.getLogs({ tabId: 12345 }, { browser: browsers.browsers[0].browserId });
```

## CLI 使用

安装后提供 `mearl` 命令：

```bash
# 获取最近 5 个请求
mearl get_requests --payload '{"tabId":12345,"count":5}'

# 代理一个 HTTP 请求
mearl send_request --payload '{"url":"https://api.example.com","method":"GET"}'

# 以 multipart/form-data 上传本地文件
mearl send_request --payload '{"url":"https://api.example.com/upload","method":"POST","formData":{"folder":"assets"},"files":[{"fieldName":"file","filePath":"/absolute/path/image.png"}]}'

# 截图并保存（tabId 来自 tab_open 或 tab_list）
mearl page_screenshot --payload '{"tabId":12345}' --output ./screenshot.png

# 从文件读取大体积参数（mock-data.json 需包含 tabId）
mearl set_mock --payload-file ./mock-data.json

# 环境自检
mearl check
mearl check --local --json

# 更新本地环境
npx @mearl/setup update --local

# 查看某个 action 的帮助
mearl <action> --help

# 启动两个隔离的 headless Chrome
mearl browser_launch --payload '{"name":"browser-a","url":"https://example.com"}'
mearl browser_launch --payload '{"name":"browser-b","persistent":true}'
mearl browser_launch --payload '{"name":"cookie-copy","copyCookieDomains":["example.com"]}'
mearl browser_launch --payload '{"name":"figma","userAgentMode":"desktop","copyCookieDomains":["figma.com"]}'
mearl browser_list
mearl browser_release
```

### Agent 脚本

`mearl run` 从 stdin 或 `--file <path>` 读取 JavaScript，预注入 `mearl` SDK，支持顶层 `await`、条件、循环和数据处理，无需在任务目录安装依赖：

```bash
mearl run --session new <<'JS'
const tab = await mearl.tabOpen({ url: 'https://example.com', reuse: 'prefer' });
console.log({ tabId: tab.tabId, session: mearl.session });
console.log(await mearl.pageSnapshot({ tabId: tab.tabId, mode: 'viewport' }));
JS

mearl run --session '<sessionId>' --file /absolute/path/next-step.mjs
```

方法名与 SDK 一致，例如 `mearl.pageClick(params, options?)`、`mearl.getRequests(params, options?)`、
`mearl.tabList(options?)`，通用调用使用 `mearl.invoke(action, payload, options?)`。
参数和返回值沿用普通 action，可查 `mearl <action> --help`；动作失败仍以 `action.success`、
`stage` 和 `attempt` 表达，由脚本判断后续逻辑。`console.log` 输出必要结果，`console.error` 输出诊断；
返回数据不会自动打印。`run_actions` 适合无需判断的紧密序列；脚本适合结果可由代码判断的组合流程。
需要模型理解页面时，输出最小观察并在下一轮继续。

脚本用 `help` 查询现有命令定义，返回文本由调用方按需输出；CLI `--help` 与脚本共用同一份参数、结果说明、约束和示例。

```javascript
console.log(await mearl.help()); // 方法与已注册插件清单
console.log(await mearl.help('pageClick')); // 也接受 page_click
console.log(await mearl.help({ plugin: 'notes', command: 'search' }));

const result = await mearl.invokePlugin('notes', { command: 'search', input: { query: 'project' } });
console.log(mearl.structure(result));
```

`structure(value, options?)` 同步提取已取得结果的结构，叶子值替换为类型；默认深度 5、每对象 50 个字段、
每数组 1 个样本、总计 2000 个节点，可通过 `maxDepth`、`maxKeys`、`arraySamples`、`maxNodes` 调整。
输出包含数组总长度与样本，遇到循环引用、访问器或资源限制会标记；样本不保证覆盖所有可选字段或不同数组元素，
业务含义以命令帮助为准。普通 SDK 同样导出 `structure`，它与请求 `keysOnly` 使用相同的提取逻辑；
`keysOnly` 也遵循上述默认字段和节点上限，超出部分会标记截断。
插件帮助在隔离进程中加载注册信息，不执行所查询的业务命令。

已注册 Skill 命令也可直接组合，命令名和输入来自该插件的 `--help`：

```javascript
const result = await mearl.invokePlugin('notes', {
  command: 'search',
  input: { query: 'project' },
});
console.log(result);
```

脚本的 `--browser`、`--session`、`--connector`、`--local`、`--cdp` 由浏览器 API 和插件调用继承；
单次调用的 `options` 可覆盖。`--server` 指定 cloud-server。`--session new` 成功建立会话后，
后续调用自动使用返回的 ID，`mearl.session` 和 CLI stderr 同时提供会话信息。
先 await 建立会话的浏览器调用，再执行并发或 Skill 命令。脚本结束断开 SDK 连接，控制会话保留；
按任务生命周期显式调用 `mearl.browserRelease`。每轮重建 JS 变量，使用已返回的 `sessionId` 和 `tabId` 继续任务。

每次脚本在独立 Node.js 进程运行，继承调用方的工作目录和环境，拥有该宿主的 Node.js 权限；
它不是安全沙箱。用 `await import('node:fs/promises')` 等动态 import 加载模块；
`--file` 的内容也作为脚本函数执行，不支持静态 `import` / `export`。本地模块建议使用绝对文件 URL。
`window` / `document` 仅在 `mearl.pageEval` 的页面表达式中可用。插件 registry、本地文件和身份认证均属于运行 CLI 的宿主。

`--timeout <seconds>` 限制整个脚本，默认 60 秒；单次 API 的 `options.timeoutSec` 限制该调用。
stdout 与 stderr 合计最多 256 KiB，源码最多 1 MiB。await 所有 SDK 调用；漏写 await、超时、取消或脚本异常以退出码 1 结束，
输入错误以 2 结束。取消和超时停止脚本及其进程组，并向仍在等待的 Skill 调用传递取消信号；已派发的浏览器或业务操作可能继续生效，
错误中的 `pendingActions` / `mayHaveLateEffects` 用于判断是否需要核验现场，不能直接重跑整段脚本。
Skill 命令使用既有隔离执行器，stdout/stderr 计入脚本输出上限；异常诊断也会按大小裁剪。
执行结果的 `success` 仅表示脚本正常完成，动作结果与业务成功仍需由代码检查。

SDK 宿主可从 `@mearl/client/script` 导入 `executeScript(code, options)`，得到
`{ success, stdout, stderr, session?, error?, executionStopped, mayHaveLateEffects, pendingActions }`。
它支持 `signal` 取消和 `executionTimeoutSec`，与 CLI、MCP 共用执行器。

### 控制会话与文件

接管和交还统一使用 `mearl browser_control --browser '<browserId>' --payload '{"operation":"handoff"}'`（交还为 `resume`）。普通浏览器自动选择唯一的未结束会话；存在多个会话时，用 `tabId` 或 `--session` 明确目标，无匹配会话时返回错误。Ego 的任务由其 Space 管理，无需额外会话参数。

多步骤任务首次 `tab_open` 或 `page_snapshot` 使用 `--session new`，响应在原结果旁附带 `session`，后续用其 `sessionId` 自动路由，无需额外创建/查询 action。Session 绑定一个浏览器与传输；页面首次使用自动关联，复用页面与新建页面分别记录。同一页面只允许一个会话控制，旧调用不能绕过占用；Session 不隔离 Cookie 或存储。

`sessionId` 是形如 `s_aB3d_E-f` 的短 ID。会话及其浏览器、传输映射保存在常驻控制宿主的内存中；新的 CLI 进程会内部查询本机和远端宿主完成路由，无需调用方保存或传递路由信息，也不写入会话映射文件。控制宿主退出后会话失效。

旧调用不必传 `--session`，现有动作、`run_actions` 批次和上传 `filePaths` 参数继续可用。活动会话存在时，旧调用不能操作其占用页面、执行浏览器级释放/关闭或修改共享设置；旧批次中的开页/关闭浏览器需改为独立调用。CDP Mock 按标签页生效，跨页使用同一 Mock 时需分别配置。

```bash
mearl tab_open --session new --payload '{"url":"https://example.com"}'
mearl page_snapshot --session '<sessionId>' --payload '{"tabId":12345}'
mearl browser_control --session '<sessionId>' --payload '{"operation":"handoff","reason":"请完成扫码"}'
mearl page_download --session '<sessionId>' --payload '{"tabId":12345,"trigger":{"selector":"#export"}}' --output /absolute/path/report.csv
mearl page_upload --session '<sessionId>' --payload '{"tabId":12345,"selector":"input[type=file]","files":[{"filePath":"/absolute/path/report.csv"}]}'
mearl browser_release --session '<sessionId>' --payload '{"closeCreatedTabs":true,"keepTabIds":[12345]}'
```

用户在 Popup 的浏览器管理页接管、交还或结束会话。交接后排队旧请求和批次后续步骤停止；已派发动作可能仍然生效。交还后重新取快照。CDP-only 环境可在用户明确确认后用同一 `browser_control` 的 `operation:"resume"` 交还，无需额外 action。会话跨 CLI 连接保留，宿主进程退出后失效；不会根据空闲时间清理用户正在操作的会话。

扩展中新开的后台页面默认加入折叠的 `Mearl` 标签组，前台新页进入展开的 `Mearl · 待操作` 组。两个管理组统一复用同一个已有窗口，同名管理组会合并；页面打开的后续标签也收进该窗口，并继承源组的展开状态。工作窗口关闭后重新选择已有窗口，不额外创建窗口。显式传入 `tab_open.group` 时使用指定分组；复用普通页面时保留原窗口和分组。接管会话只把管理组内的会话页面移入待操作组；交还后，仍在待操作组内的会话页面收回 `Mearl` 组。用户正在查看组内其他页面，或窗口没有其他可显示页面时，保留展开状态。

带 Session 的释放只影响该会话，默认保留页面及环境；`closeCreatedTabs` 只关闭新建页，`keepTabIds` 保留结果页，复用的用户页面始终保留。`preserveEnvironment:false` 清理这些页面的环境。活动会话存在时，浏览器级释放与关闭会被拒绝。

`page_download` 先监听再点击，返回浏览器文件产物；CLI `--output` 或 SDK `saveArtifact(artifact, absolutePath, { session })` 以 256 KiB 分块导出到调用方。`page_upload.files` 接受调用方绝对路径 `{filePath}` 或浏览器 `{artifactId}`，`filePaths` 仍指浏览器宿主路径。单文件最多 256 MiB；保存到调用方的结果独立于临时产物。会话释放清理临时产物，`keepArtifactIds` 可保留指定产物；无会话产物空闲一小时回收，宿主退出清理暂存。

扩展捕获下载需要匹配来源页 referrer 或明确的预期 `url`，无法归属时不会认领最近下载。CDP 只在托管浏览器中使用临时下载目录，共享浏览器保持默认目录，Chrome 未返回完成文件路径时明确报错。下载超时可能已经触发，需检查现场再决定下一步。当前会话与下载适配 Extension/CDP；直接处理页面动作的外部 Provider 对不支持的能力明确报错。

### 外部浏览器 Provider

Provider 浏览器与扩展、CDP 浏览器一起出现在 `browser_list` 中，并使用同一个
全局 `browserId` 参与路由。Provider 的安装、更新和卸载由 `@mearl/setup` 管理：

```bash
npx @mearl/setup provider install @example/mearl-provider-device

# 查看 Provider 当前版本的能力、参数与使用流程
mearl example-device --help

# Provider 启动参数统一放在 providerOptions
mearl browser_launch --payload '{"provider":"example-device","providerOptions":{}}'
mearl browser_list

# 后续操作使用 browser_list 返回的全局 Browser ID
mearl tab_list --browser '<browserId>'
mearl page_snapshot --payload '{"tabId":12345}' --browser '<browserId>'

npx @mearl/setup provider update example-device
npx @mearl/setup provider uninstall example-device
```

`browser_launch` 创建 `pairing` 实例时会直接返回 `pairing.url` 和可选的配对码；Agent 应把 URL 直接渲染为
二维码交给用户，扫码后确认同一 Browser ID 变为 `connected`，再开始页面操作。在设备连入前
该实例不会成为默认操作目标；可用 `browser_close` 删除对应 Provider 实例。每个 Provider
只接收它为该浏览器显式声明支持的 actions，截图能力同时标明为原生截图、重建画面或不支持。

输入不存在或拼写有误的 action 时，CLI 会基于可用命令和常见别名直接返回最多三个候选及调用示例，
不连接浏览器，也不会自动执行推荐命令。例如 `mearl tab new` 会优先推荐 `mearl tab_open`。

**常用选项：**

| 选项                     | 说明                     |
| ------------------------ | ------------------------ |
| `--payload <json>`       | 直接传入 JSON 参数       |
| `--payload-file <path>`  | 从文件读取 JSON 参数     |
| `--timeout <seconds>`    | 请求超时时间             |
| `--compact`              | 强制 stdout 紧凑输出     |
| `--output <path>`        | 将结果写入文件（如截图） |
| `--browser <id\|名称>`   | 指定目标浏览器           |

CLI、SDK、MCP 使用同一返回结构。快照中的 `@eN` 可直接用于操作，内部节点映射只保存在运行时。
常规响应的 `session` 包含会话 ID、浏览器、传输、状态和代次；标签页清单通过 `tab_list` 查询，
`browser_control` 的普通会话交接结果包含会话页面的 `tabs`。外部 Provider 不传 `session`，返回 `{ controlSessionMode: "external", operation, control }`；支持的 Provider 可用 `operation: "finish"` 和 `keepTabIds` 完成任务并保留结果页。`run_actions` 的步骤使用各 action 的返回结构。
stdout 在管道或重定向时默认输出紧凑 JSON，在交互终端默认美化；`--compact` 可强制紧凑排版，不改变返回字段和值。快照会折叠无名称、无 ref 且无状态的分组，控件状态与文本内容完整保留。

`get_requests` 指定非空 `fields` 时默认省略请求体和响应体，只返回提取字段及请求元数据；
需要同时读取全文时显式传 `includeBody:true`。省略正文时不返回 `postData` / `responseBody` 字段；
未指定字段时默认返回正文。

`send_request` 默认携带所选浏览器中匹配完整目标 URL 的普通 Cookie，以及目标 URL 第一方站点对应的 CHIPS Cookie。例如 `https://app.example.com/` 使用 `https://example.com` 分区，不依赖已打开页面。站点按协议和公共后缀列表（含私有后缀）确定；排除其他站点、其他协议、跨站祖先及不透明分区。保留不同路径下的同名 Cookie，不额外拼入父站点的 host-only Cookie。嵌入其他站点的第三方分区、页面签名或完整页面身份仍需使用目标页面中的 `page_eval` 请求。
响应中的 `Set-Cookie` 会更新原浏览器，后续调用可以使用刷新后的登录态；`withCookies:false` 同时关闭自动携带与响应回写。扩展由 Chrome 处理响应 Cookie；CDP 的 Node 请求在返回前通过原页面的浏览器连接回写，支持 HttpOnly、默认路径、过期时间和删除。CDP 响应存在 `Set-Cookie` 时附带 `cookieSync: { updatedCount, rejectedCount, failedCount }`，不返回 Cookie 值；无法确定分区的 Partitioned 响应 Cookie 计入拒绝数。同步失败不撤销已完成的 HTTP 操作，应检查状态而非直接重发业务请求。Protocol 普通请求及流式请求使用相同的响应刷新机制。
扩展的临时凭据注入仅匹配原始完整请求 URL，重定向由 Chrome 按新 URL 选择 Cookie。CDP 的 Node 请求（含 Protocol 流式请求）不自动跟随重定向，避免将原 URL 的 Cookie 或签名传到其他地址。

Mearl 默认聚合当前机器和已配置 cloud-server 下的浏览器，并通过 `browser_list` 返回的全局
`browserId` 自动路由。以下覆盖参数仅在限定宿主或连接、传输排障时使用，因此不出现在默认 help：

| 选项                     | 说明                                  |
| ------------------------ | ------------------------------------- |
| `--connector <id\|名称>` | 限制到一台远端机器                    |
| `--local`                | 只使用当前机器                        |
| `--cdp`                  | 当前机器强制使用 CDP；清单只列 CDP 浏览器，并隐含 `--local` |
| `--server <url>`         | 覆盖自动读取的 cloud-server 地址      |

`browser_list --help` 和 `browser_launch --help` 会按场景展示宿主选择参数；连接或传输排障运行
`mearl check --help`。`mearl check` 检查连接与浏览器状态；`mearl check --updates` 还会并发查询
client、native-host、cloud-connector 和扩展的最新发布版本。发布版本查询最长等待约 1.5 秒，
无法访问发布源时会提示无法确认更新，不影响浏览器可用性检查。`--json` 输出机器可读的检查结果，
与 `--updates` 同用时包含更新状态。发现更新时会提示适用的命令：client/native-host 使用
`npx @mearl/setup update`，setup 管理的扩展使用 `npx @mearl/setup extension`。

全局安装的 `mearl` CLI 默认在每天首次使用后启动独立后台进程，查询最新发布版本，并比较
client、native-host、cloud-server 和 MCP server 的已安装版本。发现更新时调用
`@mearl/setup update --yes --skip-skill` 更新版本落后的运行环境及其共享 client，也支持独立安装的 CLI。
当前命令不等待网络或安装；检查和安装结果记录在
`~/.mearl/cli-auto-update-state.json`。项目依赖和临时 `npx` 副本不会被自动修改。
浏览器扩展沿用其独立的更新入口。
在 `~/.mearl/config.json` 中设置间隔天数或关闭自动更新：

```json
{ "cliAutoUpdate": { "intervalDays": 7 } }
```

```json
{ "cliAutoUpdate": false }
```

间隔按本地日历日计算。需要立即检查各组件的发布版本时，仍可运行 `mearl check --updates`。

## Skill 插件

安装 skill 并自动注册命令，或直接注册已有入口：

```bash
npx @mearl/setup plugin install https://github.com/mearlhq/mearl --github --skill browser-tab-manager --yes
npx @mearl/setup plugin /absolute/path/to/browser-tab-manager
npx @mearl/setup plugin uninstall tabs
mearl tabs summary
mearl tabs --payload '{"command":"summary","input":{}}'
mearl tabs --help
mearl tabs --version
```

当已注册插件与 Provider 使用同一名称时，`mearl <name> --help` 会先显示 Provider 的启动和生命周期说明，
再自动追加插件注册的扩展命令；`mearl <name> <command> --help` 继续显示单个插件命令的详细帮助。
Provider 与插件仍可独立安装、更新和卸载，帮助聚合不会启动 Provider 或执行业务命令。

目录默认使用 `scripts/main.mjs` 或 `scripts/main.py`；两者同时存在时使用 JavaScript 入口。JavaScript 入口默认导出 `register(app)`，Python 入口导出 `register(app)` 函数；两种入口都可声明简短的 `name` 和 `description`，并通过 `app.command(signature, handler, description?)`
注册动作、`app.invoke(action, payload, options?)` 复用当前浏览器上下文，并用 `app.progress(message)` 报告可选进度。JavaScript 插件还可传入 `{ message, data }`，让工具页通过可 JSON 序列化的 `data` 获取稳定的阶段、对象 ID 等机器信息；CLI 仍只显示 `message`。Python 的 `app.invoke` 是同步调用，handler 可以是普通函数或 `async def`。Python 插件要求 `python3 >= 3.9`，可用 `MEARL_PYTHON` 指定解释器路径；Mearl 不安装 Python 或执行 `pip install`。调用另一个插件时，payload 使用 `{ command, input }` envelope；嵌套调用继承宿主选项并拒绝循环依赖。CLI 默认只输出最终结果，传入
`--verbose` 时才把进度写入 stderr。handler 返回文本或 JSON，宿主统一处理 `--output`、连接和错误。写命令在用户调用后直接执行，业务模块负责目标、状态、幂等和结果校验。
注册名优先使用显式名称，其次读取入口的 `name` metadata，最后回退到 skill 目录名；常规注册只传路径。
setup 会补齐缺失或低于自身版本的 client、native-host；安装参数由 setup 的 Skills 安装器处理，并固定全局共享安装。

JavaScript 入口可导出 `setup({ runCommand })` 准备 Skill 自己的依赖。setup 的两种安装入口都会等待该钩子成功后再注册，失败时停止注册。查看帮助、加载入口及普通调用不执行此钩子；Skill 在首次使用时自行检查依赖。运行代码与资源随 Skill 分发。

需要单独检查插件时运行 `mearl <name> --version`。命令会解析注册记录并加载入口，但不连接浏览器；
退出码为 0 表示插件已注册且入口可加载，stdout 返回同目录 `SKILL.md` 的版本，缺少版本元数据时返回 `unknown`。
未注册、入口丢失或加载失败会以退出码 2 和对应的 `PLUGIN_*` 错误结束。普通业务调用无需预先检查，直接处理同样的错误即可。

插件接受位置参数、字符串业务选项或包含 command/input 的 `--payload`。业务选项推荐写成
`--name=value`，也接受 `--name value`，字段名与 handler 的 input 一致且不依赖位置顺序；同一字段不能同时
使用位置参数和业务选项，`--payload` 不能与前两种形式混用。JSON 保留业务字段类型；正文等文件输入按具体
skill 的字段约定处理。`browser`、`timeout`、`output` 等宿主选项保留原有含义；同名业务字段以及数字、
布尔值、对象和数组通过 `--payload` 传入。插件不使用上表中内置 action 的 `--payload-file` 入口。
业务选项名称支持字母开头的字母、数字和下划线组合，下划线原样传递。

注册后的插件也可从 SDK 调用；实例方法 `client.invokePlugin` 复用既有连接和默认浏览器：

```typescript
import { invokePlugin } from '@mearl/client';

const result = await invokePlugin(
  'tabs',
  { command: 'summary', input: {} },
  { browser: 'work' },
);
```

MCP Server 通过固定工具 `plugin_invoke` 接受 `plugin`、`command` 和 `input`。SDK 与 MCP 使用已注册插件；安装宿主管理的插件目录可触发匹配当前 client 版本的 setup 安装与一次重试，其他未注册名称返回 `PLUGIN_NOT_REGISTERED`。

长命令使用本机持久任务服务。服务按注册目录隔离并自动启动，CLI、SDK、MCP 与工具箱共享任务记录；调用方退出不取消执行。服务重启后将未完成任务标记为 `interrupted`，不自动重放。后台任务固定接受时的源码快照、工作目录与环境；第三方 JS 依赖应预先打包进 Skill，状态文件放在源码目录之外。快照只固定源码和相对资源，不预解析 JS 依赖；缺失依赖和语法错误由执行器加载代码时报告。

```ts
import { PluginTaskClient } from '@mearl/client';

const tasks = new PluginTaskClient();
try {
  const accepted = await tasks.start('example', { command: 'search', input: {} }, {
    executionTimeoutMs: 120000,
    idempotencyKey: 'document-123',
  });
  const result = await tasks.wait(accepted.taskId, { timeoutMs: 30000 });
  console.log(result);
} finally {
  tasks.disconnect();
}
```

`wait` 超时或其 signal 中止只结束等待；`cancel(taskId)` 才取消执行。浏览器任务需显式传 `browser`，名称会在接受前解析为固定 ID。`get/list` 返回任务快照与结果引用，`list` 返回有界分页及 `nextCursor`；`events` 返回游标、缺口标记和最新快照，`subscribe` 封装长轮询。`result(taskId)` 分块读取并校验完整业务结果，最大 64 MiB；终态记录和结果保留 7 天。

插件宿主握手与 `tasks.status()` 返回 `version/buildId`，构建标识用于定位运行代码，兼容性由握手中的协议版本决定。协议相同时，即使版本、构建标识不同或旧宿主未提供标识，任务、模型、页面和状态请求仍可继续使用现有服务，不中断活动任务或页面实例。需要切换到新构建时，确认没有活动任务及页面操作后调用 `tasks.stopHost()`，下次业务调用将启动当前构建；重新注册插件不会重启宿主。本地修改客户端或宿主代码后执行根目录 `pnpm build`，同步生成指纹并构建双方产物；仅运行 `tsc --watch` 不会更新构建指纹。

任务能力由 SDK `PluginTaskClient` 与工具箱 `host.task.*` 使用。对外命令由具体插件按业务需要提供，CLI 使用 `mearl <plugin> <command>`，MCP 使用 `plugin_invoke`。任务、模型、状态、页面实例和宿主诊断不单独暴露为全局 CLI/MCP 命令。仅注册工具箱内部命令的插件不会列入 CLI 插件列表；直接运行其名称会提示工具的打开位置。工具页可用 `window.mearl.waitTask(taskId)`、`readTaskResult(taskId)`、`listTasks()`，范围限定为所属插件的工具箱任务。

`tasks.diagnose({ taskId?, plugin?, instanceId?, includeErrorMessages?, includeLocalPaths? })` 读取当前调用范围内的有界诊断报告。默认不包含业务输入、提示词、进度正文、检查点数据、结果正文、完整 URL、环境变量和凭证，也省略错误消息及本地路径；后两项可显式选择包含。报告的 coverage 和历史 gap 表示采集范围及保留历史限制。

注册记录在 `~/.mearl/plugins/<name>.json`，保存入口路径和可选的简短描述；skill 业务代码原地更新直接生效，换路径或更新描述后重新注册。
`plugin uninstall <name>` 会对 `~/.agents/skills` 中的全局 Skill 调用 Skills 安装器执行全局卸载，
成功后清除相关注册；即使入口目录已被手动删除，也会完成 Skills 跟踪记录的清理。
手工路径只解除注册并保留源码。
`PLUGIN_NOT_REGISTERED` 表示插件尚未注册。`PLUGIN_ENTRY_MISSING` 会显示失效入口，并给出带有实际插件名的
卸载清理命令。其他错误按实际原因处理。
下文描述插件工具箱、页面、状态与任务的通用合同。

插件可选导出 `toolbox`，注册后会出现在扩展 Popup 的工具箱中。页面资源放在 Skill 目录内，注册时由
Mearl 将入口 HTML 引用的本地 CSS、JavaScript 和图片内联为不可变页面包，不需要启动 HTTP 服务，
也不要求普通 HTML/CSS/JS 页面自行构建。

右键工具箱中的工具可单独禁用或启用对应 Skill；禁用状态显示在标题右侧，工具页面和命令仍可使用。禁用将该目录的
`SKILL.md` 重命名为 `SKILL.md.mearl-disabled`，启用时恢复，作用于共享此目录的所有 Agent；
软链接安装会作用于源目录。已有会话可能仍保留已载入的 Skill，需要重启 Agent 或新建会话。
工具箱内更新和重新安装会保留禁用状态；外部安装器的更新不受此状态管理，若出现两份清单，需先处理冲突。
独立复制安装的同名 Skill 需分别禁用。没有 Skill 清单的普通插件不显示此开关。

工具箱元数据示例：

```javascript
export const toolbox = {
  version: 1,
  title: '工作区笔记',
  description: '整理工作区笔记',
  icon: 'notebook-pen',
  locales: {
    en: {
      title: 'Workspace Notes',
      description: 'Organize notes for a workspace',
    },
  },
  agent: {
    skill: 'notebook-skill',
    layout: 'workspace',
  },
  page: {
    type: 'sandbox',
    runtime: 'preact',
    entry: 'assets/toolbox/index.html',
    commands: ['list', 'create', 'delete'],
  },
  order: 100,
};

export default function register(app) {
  app.command('list', async () => ({ items: await listItems() }));
  app.command('create <name>', async input => ({ item: await createItem(input.name) }));
  app.command('delete <id>', async input => ({ item: await deleteItem(input.id) }));
}
```

`app.command(signature, handler, description?, examples?)` 注册 CLI、SDK 和 Agent 可调用的业务命令。

工具箱的 Agent 对话默认显示页面元素选择和评论入口。将 `toolbox.agent.pageElementActions` 设为 `false` 可以隐藏这两个入口。

`toolbox.icon` 支持以下字符串形式，工具列表、切换菜单与网站安装目录使用同一格式：

```js
icon: 'git-branch' // 内置图标名称，最多 40 字符，随主题变色
icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v16H4z"/></svg>' // 单色 SVG，随主题和交互变色
icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#2563eb" d="M4 4h16v16H4z"/></svg>'
icon: 'https://example.com/tool-icon.svg' // HTTP(S) 图片地址，支持 SVG、PNG 等图片
icon: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E'
```

图标字符串最多 32768 字符。SVG 源码使用 `currentColor` 时，按单色遮罩渲染，继承与内置图标相同的主题、悬停和选中颜色；建议用 `fill="none" stroke="currentColor"` 绘制线框图标。显式指定颜色的 SVG、多色 Data URL 和远程图片按原图渲染。SVG 不注入扩展 DOM。远程图片使用无 referrer 请求；不接受带账号密码的 URL，加载失败或名称未知时显示通用图标。相对文件路径不在此字段的支持范围内。

`app.toolboxCommand(signature, handler, description?, examples?)` 注册仅供工具页面调用的命令，参数和 handler 契约相同；
它不出现在 CLI 帮助中，CLI（包括 JSON payload）、SDK、MCP 及插件间的 `app.invoke` 都不能调用。
工具页面通过 `window.mearl.invoke(command, input)` 或 `window.mearl.invoke('host.task.start', { command, input })` 执行；两类命令都必须显式列在 `toolbox.page.commands` 中才能供页面调用。
注册的 `toolboxCommand` 若没有列入该白名单，插件加载会失败。分块上传、分块读取和页面临时资源释放适合使用它；
对 Agent 有独立业务价值的查询、导入、压缩、比较等完整操作使用 `app.command`。
Python 入口也支持 `app.toolboxCommand(...)`，包括 `@app.toolboxCommand(..., description="...")` 装饰器。

声明 `agent` 后工具页可以把任务交给对话 Agent；`layout` 默认为 `drawer`，宿主会提供顶部入口。
页面也可在 `setAgentPanelVisible` 或 `runAgentTask` 中为单次交互指定 `drawer` / `workspace` / `inline`；
Agent 对话会保存在 Codex 会话历史中。带固定
18rem 左侧导航的工作台可默认使用 `workspace`，由导航项切换 Agent，并占满导航栏以外的主内容区；详情页仍可按需唤起右侧抽屉。
`inline` 用于把 Agent 嵌入工具页中的卡片或分区，调用时同时传入作为占位区域的 `anchor` 元素和稳定的
`key`；宿主会跟随该元素的滚动与尺寸变化同步面板位置。`key` 也可用于抽屉或工作区布局，为不同业务对象
隔离会话与输入草稿；`setAgentPanelVisible` 可同时传入绝对路径 `cwd`，让首次创建的会话直接绑定该目录。
传入 `context` 可为面板提供不显示为聊天消息的背景上下文；它会在用户首次发送消息、创建会话时作为
developer instructions 交给 Agent。

页面通过 `await window.mearl.ready()` 取得 `{ locale, theme, title, fontSize }`，通过
`window.mearl.invoke(command, input?)` 调用 `commands` 白名单中的同一插件命令。页面运行在无扩展
API、默认不可联网的 sandbox iframe 中；Native Host 校验插件身份、命令白名单和消息大小。页面包按
内容哈希缓存并分块传输，因此不会增加 Popup 的启动开销。使用模块脚本时需先打包为不再包含 `import`
的单文件；React、Vue 等工程可以把构建后的 `index.html` 作为 `entry`，注册流程仍负责最终资源封装。
需要无构建的组件与状态管理时可声明 `page.runtime: 'preact'`，扩展会在页面完整性校验后注入固定的
Preact、Hooks 和 HTM 运行时。页面从 `window.mearl.ui` 读取 `html`、`render`、`useState` 等 API；
`window.mearl.ui.version` 仅用于诊断，插件不能选择运行时版本。
宿主会同步扩展主题、字号，并注入 `--mearl-bg-primary`、`--mearl-bg-secondary`、
`--mearl-text-primary`、`--mearl-text-secondary`、`--mearl-border`、`--mearl-bg-hover` 和
`--mearl-accent` 等语义变量；主操作按钮使用 `--mearl-action-primary`、
`--mearl-action-primary-hover` 和 `--mearl-action-primary-text`，以保持与扩展按钮一致。

工具箱面向人，CLI 面向 Agent：复用业务操作、保持结果一致即可，不要求共享中间态。表单草稿、选择、预览等纯 UI 状态默认放浏览器内存；确需刷新或重新打开后恢复时再用浏览器存储。sandbox 页不能假定可直接访问 `localStorage`、IndexedDB 或 `chrome.storage`，应使用宿主提供的能力。只有业务记录、关闭页面后继续的任务、安全重试回执或受消息大小限制的资源传输才需要 Node 状态，并说明其生命周期及清理方式。

Skill 插件可提供自定义请求与数据处理命令。CLI 使用 `mearl <plugin> <command>`，业务插件通过 `app.invoke(plugin, { command, input })` 复用同一操作；插件名称、认证方式、请求字段和上传约定以对应 Skill 的契约为准。

Node 插件在运行 CLI、SDK 或 MCP Server 的宿主上执行，不随浏览器或 connector 转发。插件读取的文件路径属于该执行宿主；需要浏览器执行的操作应使用明确的浏览器目标。安装宿主可通过能力目录提供按需安装信息。

## 支持的操作

| 分类          | Actions                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| API 调试      | `tab_checkpoint` `get_requests` `get_logs` `get_events`                                                                              |
| Mock & 规则   | `set_mock` `get_mocks` `set_rule` `get_rules`                                                                                        |
| 网络请求      | `send_request` `request_permission`                                                                       |
| 标签页        | `tab_open` `tab_list` `tab_close`                                                                                                    |
| 页面感知      | `page_snapshot` `page_inspect` `page_screenshot` `page_frames`                                                                       |
| 页面操作      | `page_click` `page_drag` `page_type` `page_hover` `page_scroll` `page_press` `page_wait` `page_navigate` `page_upload` `page_eval` `page_call_tool` |
| 页面运行时    | `page_runtime`（内部文档适配，插件使用 `app.page`） |
| 组合调用      | `run_actions`                                                                                                                        |
| 环境与 Cookie | `set_device_emulation` `set_app_profile` `set_timezone` `get_cookie` `set_cookie`                                                     |
| 浏览器        | `browser_list` `browser_launch` `browser_release` `browser_close`                                                                    |

页面交互动作（`page_click` / `page_drag` / `page_type` / `page_hover` / `page_scroll` / `page_press` / `page_upload`）默认等待异步稳定并返回 `{ action, observation }`。参数、ref 或目标解析在派发前失败时返回 `action.stage: "precondition"`，省略无意义的 `observation` / `diagnostics`；浏览器可能已收到输入但确认超时时返回 `action.stage: "dispatch-uncertain"`，并保留 observation 供核验当前状态。能够在超时前确定的目标、命中、坐标、派发模式和输入序列状态保存在 `action.attempt`，它是诊断证据，不表示动作已经生效。失败时 CLI 退出码为 1。传 `observe: false` 可执行裸动作；需要同一动作期间的新增 error logs 和业务 requests 时传 `diagnostics: true`，埋点通过 `diagnostics.events` 按需开启。`page_eval` 默认裸执行，可按需开启观察或诊断。

`tab_open active:true` 请求激活目标页。扩展免打扰默认开启：HTTP(S) 页面在首次导航前启用后台焦点模拟，不切换标签页或窗口；关闭免打扰才会真实激活并恢复最小化窗口。`activation.mode` 区分 `background` / `foreground`，模拟后的 `visibilityState` 不代表窗口在前台。焦点模拟在交接、释放控制或扩展连接断开时关闭，`preserveEnvironment` 不保留它；交还后按需对同 URL 使用 `reuse:"require", active:true` 再次激活。不带会话时通过 `browser_release` 收尾。纯 CDP 和外部 Provider 遵循各自的激活能力。页面动作的稳定观察会在有限预算内等待有限时长 CSS 动画。selector/ref 点击遇到嵌套滚动裁剪时会先滚动目标，仍不可见时才以明确的裁剪错误停止。

扩展模式下，`tab_open` 传入 `appProfile` 会应用 App 环境。需要模拟 WebView 和系统栏时，设置 `emulation.deviceShell: true`。对于使用单个 WebView 的受支持固定机型，扩展会沿用快捷设置里保存的**手机壳**偏好。Agent 的页面操作以当前业务 WebView 为目标。

`page_click` 默认 `auto` 在隐藏页使用 DOM fallback，selector、文本、ref 和坐标定位都保持可用，并通过 `dispatchMode: "dom"`、`fallbackReason: "page-hidden"` 明确说明实际路径。普通后台任务不需要为了点击主动激活页面；只有站点明确拒绝非可信事件时才切换到可见页并强制 `mouse` / `touch`。

`observation.effects.interactives` 会把内容未变化但 DOM 节点被框架重建的控件标记为 `recreated`，保留 selector/ref 与语义信息供后续定位，同时省略未变化的 value 和状态字段；值或状态确实变化时仍返回完整差异。

`observation.effects.texts` 按需返回普通可见叶子文本的当前值 `{ selector, text }`，覆盖独立计数、金额等非控件文字。结果最多 8 项，每项 text 最多 160 字符；同一节点连续更新只保留最终值。非空文字的 Range 矩形必须完整处于视口和祖先滚动/裁剪框内，并通过命中检查；CSS 掩码文本不进入该通道。空文本使用元素框检查。结果不作为可交互控件或业务成功信号。复杂结构、不可读内容及预算溢出仍保留快照回退；该通道不改变导航等待策略。

`page_press.pressMode` 支持 `auto` / `dom` / `keyboard`。默认 `auto` 在隐藏页使用 DOM 键盘事件，并通过返回的 `dispatchMode`、`fallbackReason` 和 `defaultAction` 说明实际派发及默认行为模拟结果；依赖浏览器原生编辑、选择或滚动行为时使用可见页面和 `keyboard`。

`page_snapshot` 默认返回完整 AX Tree；长列表可传 `mode: "viewport"`，只需要当前视口内的控件时传 `mode: "interactive"`，AX 信息为空或过于稀疏时可显式传 `mode: "dom"`，返回实际渲染文本、原生控件、显式 role 和高置信 clickable 节点。DOM 模式同样返回可供后续动作使用的 `@ref`，但不会猜测任意容器的业务语义。已知 CSS 区域时传 `rootSelector`，已有 ref 时传 `rootRef`（可用 `ancestorDepth` 向上补充上下文），只查找特定文案或角色时传 `query`。`interactive` 在视口内缺少 AX 控件语义时仍只回退到 AX viewport，并返回 `fallbackMode: "viewport"`，不会自动切换数据来源。`maxNodes` / `maxChars` 截断会同时保留首尾内容。

`page_inspect` 用 CSS、snapshot `@ref` 或 DevTools 当前选中元素 `$0` 返回命中数、边框盒、指定计算样式、中心点遮挡、横纵溢出像素和最近滚动容器。省略 selector 并传 `filter: "horizontal-overflow"` / `"vertical-overflow"` / `"scrollable"` 可直接做全页布局诊断。按文本定位时先用 `page_snapshot.query` 取得 `matches` / `matchCount` 和 ref，再把 ref 交给 `page_inspect`，不需要手写 `page_eval`。

重复文本点击可用 `page_click.scope` 限定 CSS / ref 子树；浏览器扩展后端中，容器或 iframe 内的点坐标使用 `coordinateSpace: "active-frame"`，CSS/text 查询可用 `frameId` 显式指定 frame。点击结果通过 `requestedTarget`、`resolvedTarget`、`dispatchTarget`、`hitTarget` 和 `coordinates` 区分请求语义、DOM 解析、派发节点与可信输入实际命中；selector/ref 目标被嵌套滚动容器裁剪时会自动滚动到可点击区域，只有仍被 overflow 裁剪时才要求显式处理。需要主动浏览列表时，`page_scroll.containerPolicy: "nearest"` 可自动解析最近可滚动祖先。未指定 selector 时，`page_scroll` 会优先选择代表性视口位置命中的最近内部滚动容器，再使用文档滚动区域或层级最高且可视面积最大的滚动容器。

`browser_list` 统一列出普通浏览器、Provider 浏览器和托管浏览器。`type` 区分
`regular` / `managed`，`status` 区分 `connected` / `pairing` / `running_disconnected` /
`stopped`；只有 `connected` 的浏览器可作为常规操作目标。本机没有已连接的插件浏览器时，
`browser_list` 会自动探测默认 CDP 端点，即使已有 Provider 配对记录也无需传 `--cdp`。
`browser_list --cdp` 在没有已注册的普通 CDP 浏览器时会主动探测该端点，并只返回 CDP 浏览器；
插件浏览器已连接也不影响这次探测。设置 `MEARL_SOCKET_PATH` 时，清单请求沿用该实例 Socket。
`check --cdp` 也只检查这些 CDP 浏览器。

`browser_release` 仅在用户明确要求结束调试、退出接管或清理会话资源时调用；它会释放
debugger/CDP 控制和会话级临时状态，保留浏览器及全部标签页。托管实例的启动、关闭、持久化、
接入和登录态同步语义由各 Provider 声明；运行 `mearl <providerId>` 获取当前说明。访问入口不在
`browser_list` 中，需要时显式运行 `mearl check --browser <id|名称>`，并把返回的
`browserAccess.url` 按敏感信息处理。

## 架构

```
@mearl/client (CLI / SDK)
  ├─ 本机 → @mearl/native-host → Chrome Extension / CDP
  ├─ 本机 → @mearl/provider runtime → External Provider
  └─ WebSocket → @mearl/cloud-server → @mearl/cloud-connector
                                      ├─ @mearl/native-host → Chrome Extension / CDP
                                      └─ @mearl/provider runtime → External Provider
```

基础设施组件必须避免递归路由：`@mearl/cloud-connector` 使用 `@mearl/client/local` 子路径直连所在机器的 native-host。普通 Agent、CLI 与 MCP 集成均使用包根入口。

插件代码按职责组织在 `src/plugins/`：

| 目录 | 职责 |
| --- | --- |
| `sdk/` | 插件声明、命令接口及页面、模型、状态和恢复声明的校验 |
| `clients/` | 插件服务连接及任务、模型、页面、状态的调用接口 |
| `runtime/` | 服务组装、任务调度、存储、代码快照、执行器和进程清理 |
| 插件目录根部 | 注册、资源打包、官方插件安装及调用端与服务端共享的通信协议 |

测试位于各模块附近的 `__tests__/`。对外通过 `@mearl/client` 和 `@mearl/client/plugin` 导出；包根部的 `plugin.ts` 是插件公开入口。三个进程入口 `plugin-worker.ts`、`plugin-task-host.ts` 和 `pluginModelSessionWorker.ts` 保留在 `src/` 根部，`runtimePaths.ts` 统一定位包版本和进程入口，使逐文件编译与 Native Host 打包使用相同的入口布局。生成协议仍由 `browser-core` 同步到 `src/generated/`。

## 构建

```bash
pnpm build      # tsc 编译到 dist/，并赋予 cli.js 执行权限
pnpm dev        # tsc --watch
pnpm typecheck  # 仅类型检查
```

## License

Apache-2.0

### 插件页面实例

`PluginPageClient` 通过本地插件服务管理 attach/get/list/send/detach/events/activation。插件导出独立 `pageRuntime` 声明并用 `app.page()` 调用。宿主用 Node 内置编译器检查 code 的表达式语法，不执行代码；代码必须在网页中求值得到自包含函数，非函数或外部引用错误在页面运行时报告。扩展与纯 CDP 共用实例、事件、激活和文档运行时；实例绑定 documentId，同插件同文档的所有入口共享初始化，导航后旧实例失效，启用的激活规则负责重建。`frame` 接受 `main`、`business` 或 `page_frames` 返回的 frame ID（扩展为数字，CDP 为字符串）。外部 Provider 仍须明确声明 `page_runtime` 能力。

显式手动 `attach` 复用自动激活的实例时，实例转为手动归属，初始化与在途任务继续复用；随后收窄自动激活范围不会清理该实例。

独立修改匹配范围时，可传 `enabled: true, matchPatch: { add?: string[], remove?: string[] }`，与 `matches` 互斥。宿主原子增删范围，避免并发调用覆盖其他范围；删除最后一个范围会关闭自动激活，保留手动挂载的页面实例。`persistence: 'persistent'` 在浏览器重启后保留，初始化 handler 可读取最新插件偏好，不必将易变配置复制到规则 input。

```typescript
const pages = new PluginPageClient();
try {
  const page = await pages.attach('example', { tabId: 123, frame: 'business' });
  await pages.send('example', page.instanceId, { type: 'read' });
} finally { pages.disconnect(); }
```

后台事件声明 schema 和串行、latest 合并或有限并发策略，处理器用 `app.runtimeCommand()` 注册并通过 `context.page` 访问固定文档。文档绑定任务可用 `app.page('activation')` 只读查询本插件激活规则，不允许设置或关闭规则。页面消息/结果各上限 24 MiB，宿主自动分块并校验；事件负载上限 32 KiB。工具箱使用 `host.page.*`，UI 订阅实例历史与后台执行独立。完整契约见 [插件宿主能力](../../docs/plugin-runtime.md#页面运行时和事件)。

Python 入口同样导出 `pageRuntime` 字典，其中 `code` 仍是运行于网页中的 JavaScript 函数字符串；后台初始化与事件处理器通过 `app.runtimeCommand(...)` 或其装饰器注册。`app.page(operation, payload)`、`context.page.send(message)` 和 `context.page.get()` 都是同步调用，后两者仅在绑定页面实例的处理器中可用。JS 和 Python 的 `context.page.send(message, {timeoutSec: 120})` 可指定单次响应超时（大于 0 且最多 300 秒，Python 使用字典）；`app.page("send", {instanceId, message, timeoutSec})` 和 SDK `pages.send(plugin, instanceId, message, {timeoutSec})` 同样支持。该设置不改变其他请求，任务取消和文档解绑仍立即中断执行，传输失败也会取消对应网页请求。runtime-only 命令不出现在公开命令帮助中，也不能由 CLI 或工具箱直接执行；声明在页面事件中的普通 `app.command` 仍保留公开调用能力。

### 模型任务与声明状态

`PluginModelClient` 使用本机 Codex，不依赖浏览器连接；模型任务和命令任务共享查询、取消与无损结果通道，分别调度。先查询 `capabilities()`；当前只支持显式只读 Agent，严格无工具生成请求会失败。

```typescript
import { PluginModelClient, PluginStateClient } from '@mearl/client';
const models = new PluginModelClient();
try {
  const result = await models.run('example', {
    provider: 'codex', mode: 'agent', permissions: 'read-only', prompt: 'Return a short title.',
    outputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
  }, { signal: controller.signal });
  console.log(result.output);
} finally { models.disconnect(); }
```

`start` 返回持久 taskId；`run` 的 signal 取消模型执行并等待清理。`app.model(request, { onProgress })` / `context.model(request, { onProgress })` 可订阅当前这一次调用的 `model.delta`，并发调用的回调互相隔离；Python 使用 `context.model(request, on_progress=callback)`。增量 `data` 含 `delta/index/partial`，可用时带 `itemId/phase`；按消息隔离、跳过 commentary，序号缺失时回退到最终结果。增量只供临时展示，最终结果来自成功 turn 的完整消息；outputSchema 透传模型 Provider，宿主解析 JSON，插件负责验证结果结构与业务约束；临时显示必须在失败时撤回，不能直接作为缓存或业务成功依据。模型目录与执行通过 `PluginModelClient` 或插件上下文使用。工具页使用 `host.model.capabilities/list/start` 和 `waitTask`。

插件入口声明状态集合，然后从命令上下文访问：

```javascript
export const stateStorage = { version: 1, collections: {
  settings: { scope: 'installation', storage: 'persistent', schemaVersion: 1, schema: { type: 'object' } },
} };
export default app => app.command('save', async (input, context) => {
  const previous = await context.state('settings', 'get', { key: 'config' });
  return context.state('settings', 'transact', { transaction: { operations: [
    { type: 'put', key: 'config', value: input, expectedVersion: previous.version },
  ] } });
});
```

SDK `PluginStateClient.get/getMany/list/transact` 与工具箱 `host.state.*` 共享集合。每次写入需 CAS，冲突后重新读取、合并再重试；`schemaVersion` 升级用显式迁移事务。浏览器会话/实例可声明 `cache` 或 `memory`，页面身份由宿主验证。`memory` 只保存在插件执行宿主进程中，支持同样的 CAS、schema、TTL 与分块值限制；刷新文档时保留浏览器会话范围，浏览器会话变化后隔离，执行宿主重启时清空。内存状态全宿主合计最多 128 MiB / 512 个集合命名空间，按需占用；单集合 `maxBytes` 最大 128 MiB，实例结束释放其内存。容量、TTL 和完整契约见[插件宿主能力](../../docs/plugin-runtime.md#状态和激活)。二进制资产继续使用文件或资源通道。

### 显式任务恢复

插件声明 `taskRecovery`（每个命令的 checkpointVersion/schema）并注册 `app.recoveryCommand(command, handler)`，命令通过 `context.checkpoint(data, expectedSequence)` 保存最多 64 KiB 的恢复依据。检查点数据、版本、宿主 schemaHash、序号和事件与任务记录原子写入；写入必须 CAS。schema 用于声明身份和格式兼容比较，检查点及迁移数据的结构由插件验证。

`tasks.checkpoint(taskId)` 读取检查点；`tasks.resume(taskId, { environment?, revision? })` 为终态根命令建立新 attempt，保持旧任务终态，固定原安装、源码快照、输入、目录和路由。默认提交调用进程的新环境，旧环境不持久化。恢复入口读取 `context.recovery`，先核对外部操作状态；宿主不重放原 handler，也不保证外部提交与检查点原子。

SDK 使用 `tasks.checkpoint(taskId)` / `tasks.resume(taskId)`。当前仅支持 public/service 根命令，拒绝模型、子任务、页面绑定和 caller 路由恢复，且必须确认原执行树已经停止。默认固定原代码；显式 `revision: 'current'` 选择请求进入时的当前快照。同格式版本需 schema 相同，跨格式版本需目标 `taskRecovery` 声明 `migrateFrom: [{ version, schema }]` 并注册隐藏 `app.checkpointMigration(command, handler)`，返回目标检查点数据。宿主先核验历史 schemaHash，禁止转换中的宿主及嵌套插件 API，以 10 秒期限管理进程；转换必须可重试、无副作用，可信代码不构成 OS 沙箱。并发恢复合并为一个转换与后继任务，旧任务和数据保持不变。完整资格与故障域见[检查点与显式恢复](../../docs/plugin-runtime.md#检查点与显式恢复)。

插件 CLI 调用失败以非零退出码和 stderr JSON `{ "error": { "code", "message" } }` 返回，保留 SDK/MCP 的 code，不输出任意异常附加字段。`PLUGIN_TASK_WAIT_TIMEOUT` 仅停止等待；`PLUGIN_EXECUTION_CANCELLED` / `PLUGIN_EXECUTION_DEADLINE` 表示执行取消或到期；`PLUGIN_PAGE_TARGET_CHANGED` / `PLUGIN_PAGE_INVALIDATED` 要求重新获取页面实例；`PLUGIN_STATE_CONFLICT` 需重新读取 CAS 版本；`PLUGIN_MODEL_CAPABILITY_UNSUPPORTED` 表示声明能力不支持；`PLUGIN_INVOCATION_CYCLE` / `PLUGIN_INVOCATION_DEPTH` 拒绝循环或过深组合。进程树无法确认停止时保留失败记录并拒绝恢复。

工具箱内显式页面 attach 缺少站点授权时会申请权限，由用户确认后继续；后台页面运行时不会自动弹窗申请。

模型列表可通过 SDK `PluginModelClient.list()` 或工具箱 `host.model.list` 查询。模型项携带可用时的 `reasoningEfforts` 和 `defaultReasoningEffort`，界面按模型支持范围提供思考级别。宿主合并并发发现请求，已有模型目录立即返回，过期后后台刷新；刷新失败保留可用目录并短暂退避，不创建推理会话。状态批量读取使用 `get-many` 和 `keys`（SDK `getMany`、工具箱 `host.state.getMany`），一次读取同一 revision 的最多 128 个键，含缺失键的 CAS version，结果上限 1 MiB。


插件宿主由 `PluginHost` 组装任务、状态、页面与模型目录服务，统一关闭和诊断。`PluginTaskManager` 接收明确的服务依赖并管理执行树；页面和状态服务不反向修改调度器。SDK 的连接、服务发现、握手、重连和调用桥接由 `PluginHostConnection` 管理。需要共享连接时，在 Task/Model/State 客户端构造选项中传入 `connection`，Page 客户端通过第二个构造参数传入；注入连接由创建者关闭，各客户端的 `disconnect()` 只关闭自己创建的连接。连接始终绑定单个调用范围，不能跨插件、交互渠道或来源复用。

后台连续模型调用可以显式传 `conversation`（1–80 个字母、数字或 `:_-`）。同名会话仅在当前页面实例或宿主管理的当前命令执行内复用；插件、版本、模型、指令、环境和调用归属分别隔离。未指定时每次调用独立。页面解除绑定或命令结束会释放会话；取消、失败和超时会销毁当前会话，空闲 5 分钟释放，每 32 轮重新建立临时会话以限制历史增长。会话仅驻留内存，不新增顶层 CLI/MCP 命令。

## 受管理插件目录

安装宿主可通过 client/plugin 的 replaceOfficialPluginCatalog(revision, plugins) 保存已选 preset 的插件目录。revision 为确切清单摘要，每项声明 description、skill 和安装器参数 installArgs，可选 setup 分组。目录以原子文件替换保存于当前插件注册目录的 .official-catalog.json；目录默认为空。安装源码与 preset 的信任校验由安装宿主负责，目录本身不触发安装。

findOfficialPlugin/listOfficialPluginNames 每次读取当前目录，继续复用同一 setup 入口完成缺失插件安装。readOfficialPluginCatalog 向安装状态页报告损坏；普通插件和浏览器命令忽略损坏的可选目录，不影响已注册能力。OFFICIAL_PLUGINS 兼容导出反映本进程最近读取的目录。

扩展版本检查默认读取 GitHub 最新正式发行物中的 config.json；发行宿主可用 MEARL_EXTENSION_CONFIG_URL 提供返回 version 或 latestVersion 的配置端点。尚未上传扩展发行元数据时，更新信息显示不可用，核心源码版本不作为已发布扩展版本；检查失败仅影响更新提示。
