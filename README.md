# Mearl

[简体中文](README.md) | [English](README.en.md)

用 AI Agent 操作和调试网页。

让 Agent 在浏览器里操作页面、查看网络请求和控制台日志，并验证结果。接入日常使用的 Chrome，可沿用已有标签页和登录态。

[产品官网](https://mearlhq.github.io/mearl/) · [Chrome 应用商店](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm) · [GitHub Releases](https://github.com/mearlhq/mearl/releases)

## 可以做什么

- **操作网页**。读取页面、点击、填表、上传和下载文件，以及截取屏幕。
- **调试和验证网页**。查看网络请求、响应和控制台日志，用 Mock 响应验证页面行为。
- **发送带登录态的请求**。用浏览器中匹配目标地址的 Cookie 调用已知 HTTP 接口，或重放已捕获的请求。
- **模拟移动设备**。切换视口、触摸输入、User-Agent 和时区。
- **复用常用流程**。将重复任务做成 Skill，可包含 Agent 操作指引、可执行命令或工具箱界面。

## 开始使用

### 1. 安装 Chrome 扩展和本机组件

在要接入的 Chrome 配置中安装 [Mearl 扩展](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm)。需要 Chrome 120 或更高版本。

使用 Node.js 20.18.0 或更高版本运行安装器，按提示选择 Agent 接入方式。

```bash
npx @mearl/setup
```

使用 MCP 客户端时，运行 `npx @mearl/setup --mcp`，然后重启客户端。[安装指南](https://mearlhq.github.io/mearl/installation.html) · [MCP 文档](packages/mcp-server/README.md)

### 2. 确认连接并运行首个任务

保持 Chrome 运行，确认列表中出现要使用的浏览器。

```bash
mearl check
mearl browser_list
```

在已接入 Mearl 的 Agent 中试一句。连接多个浏览器时，附上目标 `browserId`。

> 用 Mearl 打开 <https://example.com>，告诉我页面标题，并截一张图。

### 其他浏览器接入方式

- **CDP**。接入已开启远程调试的 Chrome 或 Electron。
- **[Firefox Provider](https://github.com/mearlhq/provider-firefox)**。用 `npx @mearl/setup provider install @mearl/provider-firefox` 安装，通过 WebDriver BiDi 接入 Firefox。
- **[外部 Provider](packages/provider/README.md)**。接入其他本地或远端浏览器和设备。可用动作取决于所选 Provider。

更多连接方式和权限说明见 [CLI / SDK 文档](packages/client/README.md)。

## CLI 与 SDK

连接就绪后，也可以在终端打开页面并打印快照：

```bash
mearl browser_list
mearl run <<'JS'
const tab = await mearl.tabOpen({
  url: 'https://example.com',
  reuse: 'prefer',
});
console.log(await mearl.pageSnapshot({ tabId: tab.tabId, mode: 'viewport' }));
JS
```

连接多个浏览器时，使用 `mearl browser_list` 返回的 `browserId`，通过 `mearl run --browser <browserId>` 选择目标。用 `mearl guide` 查看工作流，`mearl guide --list` 查看专题，`mearl <action> --help` 查看参数。

在项目中使用 TypeScript SDK：

```bash
npm install @mearl/client
```

```typescript
import * as mearl from '@mearl/client';

const tab = await mearl.tabOpen({ url: 'https://example.com' });
const page = await mearl.pageSnapshot({ tabId: tab.tabId });
console.log(page.snapshot);
```

更多动作、控制会话、脚本和插件示例见 [CLI / SDK 文档](packages/client/README.md)。

## 扩展 Mearl

| 扩展方式 | 用途 | 文档 |
| --- | --- | --- |
| Skill | 为 Agent 提供操作指引，并可附带 CLI 命令和工具箱页面 | [Skills](skills/README.md) · [开发 Skill](skills/mearl-skill-creator/SKILL.md) |
| Provider | 连接其他浏览器平台或设备，声明支持的动作与生命周期 | [Provider](packages/provider/README.md) · [开发 Provider](skills/mearl-provider-creator/SKILL.md) |
| Profile | 定义 App WebView 的 User-Agent、JSBridge 和容器行为，用于端模拟 | [App Profile](packages/app-profiles/README.md) |
| Preset | 整套安装 Profile、服务集成、Skills 和 Providers，并设置默认配置与权限需求 | [Preset](packages/preset/README.md) · [安装流程](docs/preset-installation.md) |

仓库提供设计稿叠加、双语阅读、格式转换、笔记、标签页管理和图片压缩等 [可安装 Skills](skills/README.md)。

## 源码开发

源码构建要求 **Node.js ≥ 22.23.4** 和 **pnpm 10.34.5**。

```bash
pnpm install --frozen-lockfile
pnpm build
```

扩展输出位于 `packages/extension/dist_chrome`，可作为已解压扩展加载。开发官网使用 `pnpm dev:website`。

使用 `pnpm dev:link` 构建项目，并将带有 CLI 入口的本地包及命令（包括 `mearl`、`mearl-setup`、Native Host 和 MCP）软链到 `npm prefix -g` 对应的全局目录。该命令支持 macOS/Linux，会替换已有安装且不保留备份；重复运行会跳过正确的软链。使用 `pnpm dev:link --dry-run` 预览，或 `pnpm dev:link --skip-build` 复用已有构建产物。请确保该 prefix 的 `bin` 目录在 `PATH` 中，且优先于其他 Mearl 安装。

源码修改后仍需重新构建。此命令不安装 Skills、不注册 Native Messaging Host，也不重启运行中的进程；浏览器扩展仍需手动加载或重载。本地 Native Host 需要接入浏览器时，运行 `mearl-native-host --init`。

提交钩子会检查并格式化暂存的源码。可运行 `pnpm lint` 和 `pnpm format:check` 手动检查。[开发规范](AGENTS.md) · [发布流程](docs/releases.md)

| 目录 | 职责 |
| --- | --- |
| `packages/extension` | 浏览器扩展与交互界面 |
| `packages/client` · `packages/mcp-server` | CLI、SDK 与 MCP 接入 |
| `packages/native-host` · `packages/cloud` | 本机和远端连接 |
| `packages/browser-core` · `packages/app-profiles` | 浏览器动作、共享协议与环境模拟 |
| `packages/preset` · `packages/provider` | Preset、资源清单与 Provider 合同 |
| `packages/agent-runtime` · `packages/daemon-core` | 模型、任务和进程运行时 |
| `packages/setup` · `packages/website` | 安装器、产品网站和安装引导 |
| `skills` | 可独立安装的 Skills、脚本与工具箱资源 |

## 许可证

[Apache-2.0](LICENSE)。第三方依赖和资源保留各自的许可证声明。
