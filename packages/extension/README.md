# @mearl/extension

[简体中文](README.md) | [English](README.en.md)

Mearl 的 Chrome 扩展，提供网页调试界面和面向 Agent 的浏览器控制入口。

基于 Manifest V3，技术栈为 React 19 + TypeScript + Tailwind CSS（构建产物使用 Preact 以减小体积）。除了请求查看、Mock、请求规则等调试能力外，还通过 Native Messaging 把浏览器能力暴露给本地/云端 AI Agent（支持 MCP 与 Skills 两种集成模式）。

## 默认不打扰

扩展默认开启「免打扰」：Agent 请求激活页面时，保持页面在后台运行，不切换标签页或唤起窗口。需要 Agent 将页面带到前台时，可在设置中关闭「免打扰」。此偏好适用于扩展接入，不代表 Agent 服务关闭。

## 浏览器兼容性

Agent 服务先完成 Native Host 管理握手，再开放页面控制。已安装 Provider 可通过 `extensionAgentDefault.macBundleIds` 声明由它控制的浏览器；macOS 宿主按直接父进程的 Bundle ID 匹配，不使用网页 UA 或运行中的其他浏览器推断。命中后当前浏览器配置默认关闭扩展 Agent 接入，人工调试仍可使用。自动归属和开关偏好存于 `storage.local`，不会同步到其他配置。用户可在设置中明确启用；Provider 离线、卸载或握手失败不会自动夺回控制。识别能力暂限 macOS；其他平台保留原有默认值。

归属变化由本机安装目录事件通知并合并处理，不轮询网页或进程。已有关闭偏好的配置启动时不为协调而连接宿主。升级时需一起更新扩展和 Native Host，并重新注册带该声明的 Provider。

- 扩展需要 Chrome 120 或更高版本。
- Chrome 120–140 可用快捷键打开 Agent 侧边栏，关闭时请使用 Chrome 侧边栏的关闭按钮。Chrome 141 起支持用快捷键关闭。
- 设备外壳和带页面运行时的 App 配置需要 Chrome 125 或更高版本。
- 插件页面脚本需要 Chrome 135 或更高版本。Chrome 135–137 需要在扩展程序页面开启「开发者模式」。Chrome 138 起需要在 Mearl 扩展详情页开启「允许用户脚本」。
- 浏览器内置翻译需要 Chrome 138 或更高版本。

## 功能

- 📊 **请求查看** —— 查看 HTTP / Protocol 请求、响应与埋点事件。使用固定机型的手机壳时，Mearl Panel 在宽窗口中显示在设备旁，窄窗口中自动收起。点击**调试**图标可手动切换。拖动分隔线设置宽度，之后打开时沿用。截图和浏览器操作以当前业务 WebView 为目标。
- 📱 **设备模拟** —— **系统栏**开关显示顶部状态栏和底部操作区。使用单个 WebView 的受支持固定机型还可以开启扩展专有的**手机壳**，默认开启。扩展打开符合条件的模拟时会沿用已保存的偏好。Agent 命令通过 `deviceShell` 控制系统栏。
- 📝 **日志** —— 收集页面控制台日志
- 🎭 **Mock** —— 动态设置 Mock 数据，借助 Chrome debugger API 修改响应
- 🔀 **请求规则** —— 基于 Declarative Net Request 的重定向 / 改请求头
- 🤖 **Agent 集成** —— 通过 Native Messaging 让 AI 调用浏览器能力（截图、页面操作、快照等）
- 💬 **Agent 对话** —— 从工具栏弹窗或 Agent 侧边栏围绕当前标签页对话。点击对话工具栏里的侧边栏图标可继续对话，并在网页上选取元素和添加批注。浏览器管理默认收在工具箱内。
  可从 Agent 菜单选择 Codex 或 Qoder。若缺少本地组件，点击**安装**即可补齐。点击**登录 Qoder** 在浏览器中完成授权，然后回到 Agent 对话，点击**重发**再次发送失败的纯文本消息。
  两个对话入口都可以预览 Codex 引用的 HTML 图表，文件可保存在 `~/.mearl/visualizations` 或 Codex 的 `visualizations` 目录中。Mearl 对话会提示 Codex 将内嵌图表保存到 `~/.mearl/visualizations`，只要文件还在，历史消息就能显示图表。预览会自动加载 jsDelivr、cdnjs、esm.sh、unpkg 上的图表库，以及 Codex 图表和小组件的运行时、Google Fonts 和 Bunny Fonts。CDN 脚本可以读取预览内的图表内容。预览会拦截 `fetch()` 等接口请求。
- 🔄 **扩展更新提示** —— setup 版本按远端配置检测，Chrome 管理的版本在更新下载完成后提示；均由用户主动 reload 并可查看对应版本日志

## 开发

```bash
# 在仓库根目录安装依赖
pnpm install --frozen-lockfile

# 开发模式（监听 src 变更并重新构建）
pnpm --filter @mearl/extension dev

# 构建扩展及其工作区依赖
pnpm --filter @mearl/extension... build
```

加载到浏览器：

1. 打开 `chrome://extensions/` 并开启「开发者模式」
2. 点击「加载已解压的扩展程序」，选择 `packages/extension/dist_chrome`
3. 在网页按 F12 打开开发者工具，选择「Mearl」面板
4. 需要 CLI、SDK 或 MCP 控制时，在扩展中开启 Agent 服务，并使用 [setup](../setup/README.md) 安装本机环境

## 脚本

```bash
pnpm --filter @mearl/extension build       # 生产构建
pnpm --filter @mearl/extension typecheck   # 类型检查
pnpm --filter @mearl/extension test        # 测试
pnpm --filter @mearl/extension i18n:check  # 翻译键检查
```

## 目录结构

- `src/pages/background/` —— Service Worker：debugger API、请求拦截、Agent Bridge、各能力 handlers
- `src/pages/panel/` —— DevTools 面板（主 UI）
- `src/pages/popup` `sidepanel` `options` `devtools` 等 —— 其他扩展页面
- `src/pages/content-script/` —— 内容脚本（MAIN world 早注入 + ISOLATED world）
- `src/locales/` —— i18n 文案（`zh_CN` / `en`）

> 详细架构、通信模式与代码规范见仓库根目录的 [AGENTS.md](../../AGENTS.md)。

## License

[Apache-2.0](../../LICENSE)
