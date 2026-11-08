# Mearl

[简体中文](README.md) | [English](README.en.md)

在自己的浏览器里，和 Agent 一起操作与调试网页。[产品官网和快速上手](https://mearlhq.github.io/mearl/)

Mearl 沿用浏览器的登录态，帮你验收功能、排查问题、核对设计稿或导出报表。验证过的常用任务可以沉淀成 Skill，复用网页操作或直接调用合适的接口。你可以在扩展里操作，也可以通过 CLI、TypeScript SDK 或 MCP 把任务交给 Agent。

## 可以做什么

- **操作网页**：读取页面快照，点击、输入、滚动、上传、下载和截图，支持多标签页与控制会话。
- **调试请求**：查看 HTTP 请求、响应和流式事件，重发请求，设置 Mock、重定向和请求头规则。
- **观察页面**：读取控制台日志，检查元素尺寸、样式、遮挡与滚动容器，采集和查询埋点事件。
- **模拟环境**：调整设备视口、触摸、User-Agent 和时区；通过已安装的端模拟配置还原 App WebView 环境。
- **组合任务**：在 `mearl run` 中使用 JavaScript 编排浏览器动作与已注册的 Skill 命令。
- **连接更多浏览器**：通过本机扩展、CDP、云端 Connector 或独立 Provider 控制目标浏览器。

浏览器扩展提供 DevTools 面板、Popup、侧边栏和工具箱。CLI、SDK 和 MCP 共用同一套浏览器动作。控制会话让多步任务沿用指定的浏览器和标签页。[控制会话](packages/client/README.md#控制会话与文件)

## 开始使用

Mearl 3.0 的运行包要求 **Node.js ≥ 20.18.0**，浏览器使用 **Chrome ≥ 120** 或支持相应扩展 API 的 Chromium 浏览器。各项功能的版本要求见[扩展兼容性](packages/extension/README.md#浏览器兼容性)。

### 安装本机环境

```bash
npx @mearl/setup
```

安装器配置 `mearl` CLI、Native Host 和主 Mearl Skill。请安装与本机组件同版的扩展。

- 下载并解压 `mearl-chrome-v*.zip`。打开 `chrome://extensions/`，开启「开发者模式」，点击「加载已解压的扩展程序」并选择解压目录。[GitHub Releases](https://github.com/mearlhq/mearl/releases)
- 商店提供同版扩展时，可以直接添加到 Chrome。[Chrome 应用商店](https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm)

在 Mearl 中开启 **Agent 服务**，然后运行 `mearl check --local` 验证连接。[安装器文档](packages/setup/README.md)

首次使用运行 `mearl guide` 读取当前 CLI 的核心工作流，`mearl guide --list` 查看按需专题；参数继续以 `mearl <action> --help` 为准。指南随客户端本地分发，不连接浏览器或触发更新。Skill 只分发精简入口，正文由 CLI 提供。仅使用 MCP 时直接按工具说明与 schema 操作。

### 执行第一个浏览器任务

把这段提示词复制到已接入 Mearl Skill 或 MCP 工具的 Agent 对话中。

> 用 Mearl 在我的浏览器里打开 https://example.com，告诉我页面标题，并截一张图。

也可以在终端用 JavaScript 运行器打开标签页并打印快照。

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

连接多个浏览器时，使用清单返回的 `browserId`，为命令添加 `--browser <browserId>`。后续动作继续使用返回的 `tabId`；命令参数可通过 `mearl <action> --help` 查看。

### 在 Agent 中使用

主 [Mearl Skill](skills/mearl/SKILL.md) 提供浏览器操作指引。配置好本机环境后，可按客户端需要安装 MCP 服务。

```bash
npx @mearl/setup --mcp
```

客户端配置与工具目录见 [MCP 文档](packages/mcp-server/README.md)。

### 在代码中使用

本机环境和浏览器连接就绪后，项目可直接调用 TypeScript SDK：

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

提交约定、代码风格和按改动范围选择的检查见 [AGENTS.md](AGENTS.md)。[发布说明](docs/releases.md) 介绍 beta 自动编号、npm OIDC 与扩展制品分发。

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
