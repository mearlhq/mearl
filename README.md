# Mearl

[简体中文](README.md) | [English](README.en.md)

在你日常使用的浏览器里，和 Agent 一起操作与调试网页。

Mearl 复用浏览器已有的登录态，让 Agent 帮你验收功能、排查页面问题、导出报表。你也可以直接在 Chrome DevTools 面板里查看请求、设置 Mock、模拟设备环境。验证过的常用流程可以做成 Skill，供下次任务复用。

[产品官网](https://mearlhq.github.io/mearl/) · [Chrome 应用商店](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm) · [GitHub Releases](https://github.com/mearlhq/mearl/releases)

## 开始使用

### 1. 安装浏览器扩展

从 [Chrome 应用商店](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm)安装扩展，或从 [GitHub Releases](https://github.com/mearlhq/mearl/releases) 下载 `mearl-chrome-v*.zip`，解压后在 `chrome://extensions/` 开启「开发者模式」，选择「加载已解压的扩展程序」。

浏览器需要 **Chrome ≥ 120** 或支持相应扩展 API 的 Chromium 浏览器。[浏览器兼容性](packages/extension/README.md#浏览器兼容性)

安装后即可使用 DevTools 调试面板。要让 Agent 操作浏览器，继续完成下面的配置。

### 2. 连接 Agent

本机组件需要 **Node.js ≥ 20.18.0**。你可以让 Agent 完成配置，也可以手动安装，选择一种方式即可。

**交给 Agent 配置**：把下面这段复制给支持 Skill 的 Agent。

```text
请运行以下命令安装 Mearl Skill：
npx --yes skills add mearlhq/mearl --skill mearl --global

读取 Skill 并按指引配置本机环境，检查扩展与本机组件版本是否一致。
需要我在 Chrome 中操作时，告诉我具体步骤。
运行 mearl check 验证连接并报告结果。
```

**手动配置**：在终端运行安装器，安装 CLI、Native Host 和 Mearl Skill。

```bash
npx @mearl/setup
```

使用与本机组件同版的扩展。在 Mearl 弹窗的「设置 → 服务集成」中开启 **Agent 服务**，运行 `mearl check` 验证连接。[安装器文档](packages/setup/README.md)

使用 MCP 客户端时，在本机环境就绪后运行 `npx @mearl/setup --mcp` 完成接入。[MCP 文档](packages/mcp-server/README.md)

### 3. 执行第一个任务

在已接入 Mearl 的 Agent 中试一句。

> 用 Mearl 在我的浏览器里打开 https://example.com，告诉我页面标题，并截一张图。

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
