# Mearl

[简体中文](README.md) | [English](README.en.md)

面向 Agent 的浏览器工作环境，在你选择的浏览器中执行任务、排查问题并验证结果。

Mearl 把页面操作、网络请求、日志和环境模拟连接起来，让 Agent 执行任务、排查问题并验证结果。按任务需要接入日常浏览器、CDP 浏览器或 Provider 提供的远端环境；将验证过的流程沉淀为 Skill，通过 Agent、CLI 或工具箱再次使用。人也可以通过扩展的 DevTools 面板参与调试。

[产品官网](https://mearlhq.github.io/mearl/) · [Chrome 应用商店](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm) · [GitHub Releases](https://github.com/mearlhq/mearl/releases)

## 开始使用

### 1. 安装本机环境

需要 **Node.js ≥ 20.18.0**。先运行 setup，安装 CLI、Native Host 和 Mearl Skill，按提示选择 Agent 接入：

```bash
npx @mearl/setup
```

也可以把这段交给支持 Skill 的 Agent：

```text
请运行 npx @mearl/setup 安装 Mearl，读取安装后的 Mearl Skill。
按任务需要配置浏览器连接，需要我操作时告诉我具体步骤。
完成后运行 mearl check 和 mearl browser_list，报告目标浏览器是否已连接。
```

使用 MCP 客户端时，运行 `npx @mearl/setup --mcp` 完成接入。[安装器文档](packages/setup/README.md) · [MCP 文档](packages/mcp-server/README.md)

### 2. 选择浏览器接入方式

- **日常浏览器**：可选安装 [Chrome 扩展](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm)，复用已有标签页和登录态，并使用工具箱与 DevTools。
- **浏览器 / Electron · CDP**：接入已开放远程调试的浏览器或 Electron 客户端页面，无需安装 Mearl 扩展。
- **远端浏览器或设备**：安装并配置对应 Provider，可用动作以该 Provider 声明为准。

连接方式、权限和能力范围见 [CLI / SDK 文档](packages/client/README.md)。setup 准备本机工具；浏览器扩展安装和环境连接需按所选方式完成。

### 3. 确认连接并执行首个任务

保持目标环境运行，确认列表中出现要使用的浏览器：

```bash
mearl check
mearl browser_list
```

在已接入 Mearl 的 Agent 中试一句。连接多个环境时，附上目标 `browserId`：

> 用 Mearl 在选中的浏览器里打开 https://example.com，告诉我页面标题，并截一张图。

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

## 可以做什么

- **操作网页**，包括读取快照、点击、输入、滚动、上传、下载和截图。
- **调试请求**，包括查看 HTTP 请求、响应和流式事件，重发请求，设置 Mock、重定向和请求头规则。
- **检查页面**，读取控制台日志，检查元素尺寸、样式、遮挡和滚动容器，采集和查询埋点事件。
- **模拟环境**，包括切换设备视口、触摸、User-Agent 和时区，以及通过端模拟配置还原 App WebView。
- 用 `mearl run` **编排任务**，在 JavaScript 中组合浏览器动作和 Skill 命令。
- 通过本机扩展、CDP、云端 Connector 或 Provider **连接浏览器**。

扩展提供 DevTools 面板、弹窗、侧边栏和工具箱。CLI、SDK 和 MCP 共用浏览器动作，可通过控制会话把多步任务保持在指定浏览器和标签页。[控制会话](packages/client/README.md#控制会话与文件)

## 扩展 Mearl

| 扩展方式 | 用途 | 文档 |
| --- | --- | --- |
| Skill | 为 Agent 提供操作指引，并可附带 CLI 命令和工具箱页面 | [Skills](skills/README.md) · [开发 Skill](skills/mearl-skill-creator/SKILL.md) |
| Provider | 连接其他浏览器平台或设备，声明支持的动作与生命周期 | [Provider](packages/provider/README.md) · [开发 Provider](skills/mearl-provider-creator/SKILL.md) |
| 端模拟 | 定义新的 App WebView 环境，包括 User-Agent、JSBridge 和容器行为，随能力包分发 | [端模拟配置](packages/app-profiles/README.md) |
| 能力包 | 通过清单提供宿主实现和浏览器资源 | [能力包模型](docs/capability-model.md) |
| Preset | 组合能力包、Skills 和 Providers，设置默认配置与权限需求 | [Preset](packages/preset/README.md) · [安装流程](docs/preset-installation.md) |

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
| `packages/preset` · `packages/provider` | 能力包、Preset 与 Provider 合同 |
| `packages/agent-runtime` · `packages/daemon-core` | 模型、任务和进程运行时 |
| `packages/setup` · `packages/website` | 安装器、产品网站和安装引导 |
| `skills` | 可独立安装的 Skills、脚本与工具箱资源 |

## 许可证

[Apache-2.0](LICENSE)。第三方依赖和资源保留各自的许可证声明。
