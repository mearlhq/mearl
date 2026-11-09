# Mearl MCP Server

[简体中文](README.md) | [English](README.en.md)

将支持 MCP 的 Agent 接入 Mearl 浏览器，让它操作页面、查看请求和日志，并调用已注册的 Skill 插件。

MCP 工具与 CLI、SDK 共用浏览器动作、插件入口和控制会话。

## 浏览器交互工作流

首次进入页面时调用 `browser_page_snapshot` 建立结构基线。后续点击、拖动、输入、悬停、滚动、按键和上传直接调用 `browser_page_click/drag/type/hover/scroll/press/upload`，它们默认内置观察，动作与异步同步在一次调用内完成；同页结果读取 `effects.notifications`、`effects.interactives` 和 `effects.focus`。新增或变化的可交互节点会尽量携带可直接用于后续动作的 `node.ref`，解析不到 ref 时回退使用 `node.selector`。导航结果读取新 URL 和就绪状态；动作直接打开新标签页时，`openedTabs` 返回可继续操作的 `tabId`，无需调用 `browser_tab_list`。通常仅在导航后、`fullSnapshotRecommended: true` 或需要视觉判断时重新 snapshot 或截图；滚动后若下一步需要读取新视口内容，可按需获取 viewport 快照。`browser_page_eval` 默认裸执行，仅在表达式会修改页面且需要变化信号时显式传 `observe` 对象。

长列表重新感知时优先使用 `browser_page_snapshot(mode: "viewport")`；已知 CSS 区域时使用 `rootSelector`，已有 ref 时使用 `rootRef`，只查找特定文案或角色时使用 `query`；仅需要当前视口内的控件时使用 `mode: "interactive"`，避免整页 AX Tree 占用上下文。AX 信息为空或过于稀疏时显式使用 `mode: "dom"`，读取实际渲染文本、原生控件、显式 role 和高置信 clickable 节点，并继续通过返回的 `@ref` 操作；DOM 模式不会猜测任意容器的业务语义。`interactive` 在视口内缺少 AX 控件语义时仍只回退到 AX viewport，并返回 `fallbackMode: "viewport"`，不会自动切换数据来源。重复文本点击可用 `scope` 限定子树，滚动子节点所在容器可用 `containerPolicy: "nearest"`。

需要元素数量、边框盒、计算样式或中心点遮挡时使用 `browser_page_inspect`；DevTools 当前选中元素使用 `selector: "$0"`。传 `filter: "horizontal-overflow"` 可直接列出 `scrollWidth > clientWidth` 的节点、溢出像素和最近滚动容器。按文本查询时先用 snapshot `query` 获取结构化 `matches` 和 ref，再检查对应 ref。

页面动作传 `observe: false` 可关闭内置观察仅执行裸动作；不需要在每次动作后固定追加 wait、snapshot 或 screenshot。

打开、导航或快照时，已发现的主文档 WebMCP 工具会随 `webmcp` 数组返回。用工具的 `ref` 和输入 Schema 调用 `browser_page_call_tool`（CLI 为 `page_call_tool`，SDK 为 `pageCallTool`）。默认发现不阻塞页面动作，未发现工具时省略字段。传 `browser_page_snapshot({ tabId, includeWebMcp: "full" })` 可补查，空目录返回 `webmcp: []`。扩展和直连 CDP 都可发现工具。浏览器能按注册实例执行时才会提供可调用的 `ref`，较旧的浏览器返回 `webmcpStatus: "discovery-only"`。页面导航或引用失效后重新获取目录。

浏览器工具与 CLI、SDK 使用同一返回结构。快照中的 `@eN` 可直接操作，内部节点映射只保存在运行时。
常规响应的 `session` 包含会话 ID、浏览器、传输、状态和代次；标签页清单通过 `browser_tab_list`
查询，`browser_control` 的交接结果还包含会话页面的 `tabs`。`browser_run_actions` 的步骤使用各 action 的返回结构。
`browser_get_requests` 指定非空 `fields` 时默认只返回提取字段及请求元数据；同时需要正文时传
`includeBody:true`。省略正文时不返回 `postData` / `responseBody` 字段。

`browser_page_click.clickMode` 默认 `auto`：可见桌面页使用可信 mouse，移动模拟页使用可信 touch；目标页隐藏时不会切换标签或还原窗口，而是使用 DOM fallback，并返回 `dispatchMode: "dom"`、`fallbackReason: "page-hidden"`。可用 `dom` / `mouse` / `touch` 覆盖自动策略；显式 `touch` 要求目标页可见，否则会直接返回前置条件错误；可信输入返回实际 `pointerType`。

## 代码组合调用

`browser_run_code` 接受 `{ code, browser?, session?, timeoutSec? }`，在 MCP Server 宿主的独立
Node.js 进程运行代码，预注入与 CLI `mearl run` 相同的 SDK：

```javascript
const tab = await mearl.tabOpen({ url: 'https://example.com', reuse: 'prefer' });
const result = await mearl.invokePlugin('notes', {
  command: 'search',
  input: { query: 'project' },
});
console.log(result);
```

`console.log(await mearl.help('pageClick'))` 返回与 CLI `page_click --help` 共享的帮助；
`help()` 列出方法和已注册插件，`help({ plugin, command? })` 查询插件帮助。
`console.log(mearl.structure(result))` 查看任意已取得结果的有界字段/类型样本，具体用法见 client 的 Agent 脚本说明。

浏览器与会话选项由 API 和 Skill 命令继承。`session: "new"` 需要先 await 建立会话的浏览器调用，
然后再调用插件。脚本每轮重建 JS 变量，浏览器任务通过返回的 `session.sessionId` 与 `tabId` 继续。
浏览器动作保留原有返回结构与失败语义；需要模型决策时，打印必要观察后结束本轮。

结果包含 `success`、`stdout`、`stderr`、可选 `session` / `error`，以及 `executionStopped`、
`mayHaveLateEffects`、`pendingActions`。仅打印需要返回模型的数据，await 所有 SDK 调用；
失败会设置 MCP `isError`。默认执行时限为 60 秒，stdout/stderr 合计最多 256 KiB，源码最多 1 MiB；
MCP 取消会停止脚本。超时或取消不能撤销已派发的操作，应先核验现场再决定是否重试。
脚本拥有 MCP Server 宿主的 Node.js 权限，并继承其工作目录与环境；通过 `await import()` 加载模块，
DOM 代码通过 `mearl.pageEval` 执行。文件和已注册 Skill 均从该宿主读取。

## 安装

**方式一：使用 npx（推荐，保持最新）**

```bash
# 直接运行配置向导，会自动生成 npx 配置
npx @mearl/mcp-server --configure
```

**方式二：全局安装（启动更快）**

```bash
# 全局安装
npm install -g @mearl/mcp-server

# 运行配置向导
mearl-mcp-configure
```

配置向导会自动完成所有设置，支持 **VSCode Copilot**、**Claude Code**、**Cursor**。完成后重启 MCP 客户端即可使用。

## 使用

打开要调试的网页，在 AI 客户端中发送：

```
列出当前标签页
查看当前页面截图
获取指定标签页最近的 HTTP 请求，source 使用 all
```

已通过 `@mearl/setup plugin` 注册的 Skill 插件使用固定的 `plugin_invoke` 工具调用：

```json
{
  "plugin": "site-tools",
  "command": "list",
  "input": { "pageIndex": 2 },
  "browser": "<可选 Browser ID>",
  "timeoutSec": 30
}
```

`plugin` 使用 MCP Server 所在机器已注册的名称；当前能力目录声明的插件可按需安装并注册。插件的本机代码、身份和文件从该 MCP Server 所在宿主执行或读取；插件内的浏览器操作使用当前选择的浏览器，或请求中显式传入的 `browser`。

## 本地开发

```bash
pnpm install
pnpm --filter @mearl/mcp-server build
```

运行配置向导，选择使用自定义 Extension ID：

```bash
node packages/mcp-server/dist/configure-bin.js --extension-id <你的开发版扩展ID>
```

> 💡 在 `chrome://extensions/` 查看你的 Extension ID

发行版本与根仓库及其他 Mearl 包统一维护，`server.json` 的版本也必须一致。发行流程见[发布文档](../../docs/releases.md)。

## 卸载

```bash
# 全局安装的版本
mearl-mcp-uninstall

# 或使用 npx
npx @mearl/mcp-server --uninstall
```

## 故障排查

**配置失败**：检查目录权限和路径是否存在

```bash
# macOS
mkdir -p ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts
```

**"Native host has exited"**：删除配置后重新运行

```bash
rm ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/ai.mearl.mcp.*
```

**Extension ID 不匹配**：使用 `mearl-mcp-configure` 重新配置

**查看日志**：

- MCP Server: AI 客户端的输出面板
- Chrome Extension: `chrome://extensions/` → Mearl → background page

## License

[Apache-2.0](../../LICENSE)
