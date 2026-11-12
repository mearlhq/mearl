# @mearl/setup

[简体中文](README.md) | [English](README.en.md)

使用 `@3` 选择最新稳定 3.x 安装器，并配套安装同版的运行包和扩展。

Mearl 环境的一次性安装、更新、卸载与配置工具。无需先全局安装 setup：

安装前用 `node --version` 确认 Node.js >= 20.18.0。

```bash
npx @mearl/setup [install] [--local] [--cloud] [--cloud-mode <id>] [--mcp]
npx @mearl/setup update [--local] [--cloud] [--cloud-mode <id>] [--mcp]
npx @mearl/setup uninstall [--local] [--cloud] [--cloud-mode <id>] [--mcp] [--full]
npx @mearl/setup extension [--full] [--force]
npx @mearl/setup extension --extract
npx @mearl/setup plugin [name] <path>
npx @mearl/setup plugin install <skills add 参数...>
npx @mearl/setup plugin uninstall <name>
npx @mearl/setup provider <install|update|uninstall> <package|id>
npx @mearl/setup profile install <来源> [--browser <标识或名称>]
npx @mearl/setup preset apply [来源]
npx @mearl/setup preset <update|status|uninstall>
```

无交互终端时，`install` 自动采用安装默认项，无需额外传 `--yes`；交互终端保留安装提示。非交互卸载仍需显式传 `--yes` 或 `--non-interactive`。

`--skip-skill` 保留独立管理的 Mearl Skill，不影响 preset 的选择、安装或其声明的托管资源。已有本机 preset、浏览器受信选择和发行默认配置仍按正常优先级处理。

浏览器 Provider 独立安装和演进。安装后运行 `mearl <providerId>` 查看该版本声明的能力、
配置和启动参数。

可选云协议先通过 preset 安装对应能力，再用 `--cloud-mode <id>` 选择。Qoder 配对见 [`@mearl/plugin-qoder`](../plugin-qoder/README.md)；setup 不默认包含或安装它。

## 安装端模拟

```bash
npx @mearl/setup profile install mearlhq/profile-wechat
```

来源支持公开 GitHub 仓库的 `owner/repo`、`owner/repo@ref`，或能力包清单的完整 HTTPS 地址。GitHub 来源从解析后的提交读取根目录 `bundle.json`。命令安装能力包声明的全部端模拟配置，保留当前 Preset。有多个本地扩展连接时，用 `--browser` 选择目标。若扩展提示授权，请确认来源。

在扩展快捷设置的客户端下拉菜单中选择「添加端模拟」，可以选择官方端模拟或输入来源。列表为空时，点击「客户端」可直接打开安装弹窗。

## 安装与注册 Skill 插件

一个命令安装 skill 并注册它的 CLI、SDK 和 MCP 能力：

```bash
npx @mearl/setup plugin install mearlhq/mearl --github --skill browser-tab-manager --yes
mearl tabs summary
```

安装参数传给公共 Skills CLI，使用全局共享目录。默认由 `npx` 按当前 Node.js 版本解析 `skills`。公共 CLI 的默认 symlink 和复制模式都可注册；复制模式通过 list --global --json 确认本次成功结果对应的 canonical path，不猜测目录，也不扫描其他 Skills。自定义 CLI 可通过 MEARL_SKILLS_PATH 指定。参数不接受截断后置选项的 -- 分隔符。

安装宿主提供的本地插件目录决定哪些能力由 preset 管理。install/update 维护目录中的托管注册，保留用户自行注册的插件。卸载最后一个依赖环境时移除托管插件与 Mearl Skill；其他环境需要时保留。配置准备、宿主同步和实际安装状态共用 [安装合同](../../docs/preset-installation.md)。

Native preset 批次新建的插件注册使用 setup 托管归属，后续通过 Agent 更新仍保留该归属；同目录已有的用户注册保持原归属，自定义用户别名也会保留。托管卸载遇到用户别名共用同一 Skill 时，只清除托管注册并保留 Skill 文件。

GUI 和 CLI 使用同一套 preset 安装器及覆盖规则。`preset apply` 接受 URL 或本地文件路径。省略来源时使用已保存的快照重试。`preset update` 重新读取当前来源。重试时可显式重复指定 `--replace-skill`，授权本次替换这些 Skill 的来源或同名旧插件注册。

```bash
npx @mearl/setup preset apply --replace-skill example-skill --replace-skill another-skill
```

已安装的 Skill 仅修复注册；来源冲突项重新安装。未列出的冲突仍会阻止安装，声明外的工具名与变更后的安装身份也会被拒绝。覆盖授权不会保留到后续普通修复或自动更新。缺少浏览器权限时仍需在扩展中授权。输出沿用 preset JSON，已就绪退出 `0`、仍有待完成项退出 `3`、安装失败退出 `1`，无效参数退出 `2`。

运行 `preset uninstall` 清理本机 preset 和匹配的已连接扩展。卸载会移除 preset 托管的能力包和当前目录中由 setup 托管的插件注册，保留独立安装的能力、Skill 文件、Provider 和浏览器权限。[查看卸载范围](../../docs/preset-installation.md)

自动注册默认使用安装目录名；入口可声明 `name` 指定简短命令名。
重装会刷新同名绑定。JavaScript 入口必须默认导出 `register(app)`，Python 入口必须导出 `register(app)` 函数；完整协议见
[插件运行时合同](../../docs/plugin-runtime.md)。

已通过其他渠道分发的 skill 或自定义入口，可以直接传入路径注册：

```bash
npx @mearl/setup plugin /absolute/path/to/browser-tab-manager
npx @mearl/setup plugin custom ./skills/custom/entry.mjs
```

path 接受目录或具体文件；目录默认读取 `scripts/main.mjs` 或 `scripts/main.py`，相对路径基于调用工作目录解析。插件名优先使用显式 name，其次读取入口的 `name` metadata，最后回退到 Skill 目录名；常规注册只传 path，显式 name 仅用于覆盖或兼容旧入口。Python 插件要求 `python3 >= 3.9`，可通过 `MEARL_PYTHON` 指定解释器路径；setup 只验证入口可加载，不安装 Python，也不执行 `pip install`。
命令检查入口注册函数，然后保存绝对入口路径，同名注册更新绑定。
两种注册流程都会检查本机 `@mearl/client` 和 `@mearl/native-host`：缺失或低于当前 setup 版本时，
复用已有包管理器安装 setup 的对应版本，更新后再次验证；更高版本保持不动。
native-host 会幂等初始化 Skills 模式。基础环境补齐或初始化失败时保留已安装的 skill，并停止注册。
JavaScript 插件可导出 `setup({ runCommand })`，在注册前准备 Skill 自己的依赖。两种安装入口都会等待执行完成，失败时停止注册。首次使用的依赖检查由 Skill 自行处理，见 [client 契约](../client/README.md#skill-插件)。

注册后可在任意目录运行 `mearl <name> --help`，也可通过 `@mearl/client` 的 `invokePlugin` 或 MCP 的 `plugin_invoke` 工具调用。日常调用不更新 Skill 源码；已选目录中的缺失插件会触发一次按需安装。Skill 自身的依赖由安装钩子和首次使用检查准备。

不再需要插件时执行：

```bash
npx @mearl/setup plugin uninstall tabs
```

若入口位于 `~/.agents/skills/<skill>/`，setup 会先执行
`skills remove <skill> --global --yes`，成功后清除该 Skill 对应的全部插件注册；
入口目录已被手动删除时会让 Skills 仍能识别本次移除，从而一并清理其跟踪记录。
移除失败时保留注册以便重试。手工注册的其他路径只解除 Mearl 注册，不删除源码。
重复卸载未注册名称会成功返回，不产生改动。

## 管理浏览器 Provider

Provider 由 npm 包分发，但包本身无需暴露 CLI 或安装脚本。setup 使用当前 npm 包管理器
完成全局包生命周期，再读取包内的 `package.json#mearl.provider` 元数据登记协议入口、
可创建的浏览器类型名称及其表单参数：

```bash
npx @mearl/setup provider install @example/mearl-provider-device
npx @mearl/setup provider update example-device
npx @mearl/setup provider uninstall example-device
```

安装参数接受包名、版本或 dist-tag；更新和卸载可使用 providerId 或完整包名。核心 @mearl 包固定使用公共 npm registry；其余 scope 沿用调用方的包管理器配置。安装沿用启动 setup 的包管理器，
更新和卸载沿用当前 Provider 的原包管理器。Provider 登记只保存
经过校验的包名、安装目录和包内入口；不接受包自行注入启动命令、参数、工作目录或环境变量。
卸载仅在包管理器成功移除包后清除登记，以便失败时可以重试。

## 行为

- Mearl 自有 npm 包的安装和更新固定使用 `https://registry.npmjs.org/`，与最新版本查询使用同一来源；第三方包沿用当前包管理器的源配置。
- `install` 可以省略；直接执行 `npx @mearl/setup` 等同于 `npx @mearl/setup install`。
  以选项开头时也默认安装，例如 `npx @mearl/setup --cloud --yes`。
- `install` 未指定环境时默认 `--local`。
- `-h` / `--help` 显示帮助，`-v` / `--version` 显示 setup 版本。
- `update` 和 `uninstall` 未指定环境时，从当前 `PATH` 中的
  `mearl-native-host`、`mearl-cloud-server`、`mearl-mcp-server` 自动检测，可同时处理
  多个已安装环境。
- `--local`、`--cloud` 与 `--mcp` 可以组合，显式传入时只处理选中的环境；
  `--cloud-mode <id>` 同时选择 cloud 环境，模式实现必须来自已安装能力。
- 已有环境沿用其原包管理器和全局安装前缀；首次安装沿用启动 setup 的包管理器。
- `uninstall` 也识别 `npm link` 或 `dev:link` 注册到 npm 全局目录的开发软链，
  通过原 npm 前缀移除包与命令链接，保留仓库源码。安装和更新的自动检测仅处理常规全局安装。
- cloud 环境统一管理 `@mearl/cloud-server` 与 `@mearl/client`：WebSocket 模式首次安装后
  启动 Server，更新后仅在 Server 原本运行时重启；其他 mode 由安装的 `cloud.server.<id>` 处理；卸载前均调用 `stop`。
- local/cloud 共用一份 `@mearl/client`；组合安装只处理一次，卸载单个环境时若另一个环境仍在使用则保留。
- 从 2.5.x 更新 cloud 环境时会先卸载旧 `@mearl/cloud-client`，避免它遗留的 `mearl` bin 与统一 client 冲突。
- local/cloud 共用的全局 mearl skill 通过 `skills` 的 JSON 清单定位，只处理一次。
- 安装和更新通过 `skills add` 从公开仓库重新安装全局 mearl skill，并关联当前检测到的 Agent；更新须确认本次安装完成并核对全局 JSON 清单，不能仅依据第三方更新命令的退出码。
  可用 `--skip-skill` 跳过。
- 卸载一个环境但另一个仍依赖全局 mearl skill 时会保留 skill。
- 已选择 preset 的自动维护保留用户注册；托管卸载遇到同目录的用户别名时只移除托管注册并保留共享 Skill。
- `uninstall --full` 在环境卸载之外，还会逐项卸载所有已注册 CLI 插件与浏览器 Provider。
  Skills 安装的插件会同时移除 Skill；手工注册的外部插件只清除注册、保留源码；Provider
  只有在包管理器成功卸载 npm 包后才清除注册。单项失败不阻止其他项继续清理，命令最终返回非零。
  该选项不删除 Chrome 扩展；`extension --full` 仍表示安装扩展及完整本地环境。
- `uninstall --full` 在所有环境、插件与 Provider 成功移除后统一收尾：停止插件执行服务，
  确认没有活跃或退出状态未明的任务，再删除任务历史、源码快照、服务日志和已结束宿主的页面会话文件。只卸载部分环境、单项失败或服务重新启动时保留共享缓存。
  即使包和注册已移除，也可以再次运行该命令完成缓存收尾。自定义 `MEARL_PLUGIN_DIR` 只清理该注册表的执行缓存。
  记事本、迭代记录、配置与身份、插件持久状态、Provider 私有数据、浏览器配置及用户导出的设计稿均保留；
  CDP 标签 ID 计数也保留，防止旧请求命中新标签。
- `--mcp` 的客户端配置和清理由 `@mearl/mcp-server` 自己的命令完成。
- 默认的 `install` / `update` 不处理浏览器扩展。`extension` 是独立命令：从
  `https://github.com/mearlhq/mearl/releases/download/v<version>/` 读取同版本 beta 扩展发行元数据（正式 setup 使用 `releases/latest/download/`）并下载对应的 `mearl-chrome-v*.zip`，原子解压到
  `~/.mearl/chrome-extension`。首次安装通过浏览器级 CDP 的 `Extensions.loadUnpacked`
  加载；后续更新由 `mearl check --local --json` 确认当前扩展仍来自 setup 管理目录后，直接替换
  文件并通过 Native Host 触发扩展 reload。固定目录和 manifest 中的 `key` 保证扩展 ID
  与浏览器存储保持稳定。
- `extension --full` 会先安装或更新扩展，再复用 local profile 安装
  `@mearl/client`、安装并初始化 `@mearl/native-host`，最后安装全局 Mearl Skill。
  两部分都会尽量执行；任一步失败时命令返回非零退出码，已安装的部分会保留。它不安装
  cloud 或 MCP 环境。
- 下载前会通过 CDP 检查同 ID 插件的来源。未安装，或来源为固定目录中的 `UNPACKED`
  插件时可继续；Chrome 商店、企业策略或其他本地目录安装的版本默认保持不变。只有显式
  传入 `--force` 才会接管并替换这些版本。

## 安装或更新浏览器扩展

首次使用时，先运行 `npx @mearl/setup`，再加载同版的离线 ZIP。商店提供同版扩展时，也可以直接安装。[安装步骤](../../README.md#安装本机环境)

如需由 setup 管理扩展，运行下面的命令。

```bash
npx @mearl/setup extension
```

加上 `--full` 可以在同一次运行中安装本机 CLI、Native Host 和 Skill。

需要手动导入时，运行 `npx @mearl/setup extension --extract`。setup 会下载发行 ZIP，
在 `~/.mearl/extension-downloads/` 下创建新目录并解压，然后打印完整路径。打开
`chrome://extensions/`，启用**开发者模式**，点击**加载已解压的扩展程序**并选择该目录。
Chrome 使用扩展期间请保留目录。Chrome 关闭或远程调试关闭时也可以下载。

自动安装在首次安装、旧版 setup 扩展首次迁移，或 Native Host reload 不可用时使用 CDP。如果
Chrome 尚未开放 CDP，交互命令会提示打开
`chrome://inspect/#remote-debugging`、启用远程调试并允许连接，然后等待安装完成。面向人的
安装指引不要添加 `--yes`。无 TTY 环境使用 `npx @mearl/setup extension --yes`；它只尝试
一次，CDP 不可用时立即中断。无法确认 setup 管理来源且 CDP 不可用时不会下载或修改插件
目录，打开 CDP 后重新执行同一命令即可。Chrome 版本过低、缺少扩展安装所需的 CDP 方法时，
命令会中断并提示升级 Chrome。

该命令每次都读取下载页上的最新插件版本，不要求与 setup、CLI 或 Native Host 同版本。
CDP 来源检查和 `Extensions.loadUnpacked` 复用同一条连接，避免一次安装重复请求授权。
安装成功后目录内会保存 setup 管理标记；`mearl check --local --json` 同时从当前运行扩展读取该
标记，只有两侧路径一致时才允许无 CDP 更新。如果用户后来改装 Chrome 商店版本，运行中
的扩展不会返回 setup 标记，命令会重新通过 CDP 检查来源，并在未传 `--force` 时保持商店
版本不变。

setup 管理的扩展会读取远端 `config.json` 检查新版本，但不会静默更新。发现更高版本后，
DevTools 面板的设置按钮会显示红点，快捷设置中提供“立即更新”和对应版本的“更新日志”。
只有用户点击“立即更新”后，Native Host 才会重新校验远端版本、setup 管理标记、下载地址、
可选的 SHA256 和压缩包 manifest，再原子替换目录并 reload。该入口不会回退到 CDP；商店版、
企业策略版和其他本地目录版本不会进入 setup 更新链路。对于 Chrome 自身管理并已下载完成的
更新，扩展只被动监听 `runtime.onUpdateAvailable`，沿用相同的更新提示并由用户点击 reload；不会
调用 `runtime.requestUpdateCheck()` 主动检查。

## 跟随浏览器扩展自动更新

浏览器扩展与 Native Host 首次建联时会交换版本。每次扩展后台启动只检查一次；当扩展
进入更高的 `major.minor` release line 时，旧 Host 会在保持当前连接可用的前提下，调用
对应 `major.minor.x` 范围内最新的 `@mearl/setup`，把 `@mearl/native-host` 与
`@mearl/client` 一起更新到该范围内的最新版本。成功后 Host 退出，扩展通过已有重连机制
启动新版本。只有两个本地 CLI 版本一致且都属于扩展的 release line 时，更新才会被视为成功。

自动更新不会降级较新的 Host，也不会改动 cloud、MCP 或独立安装的 Mearl Skill。
目标 npm 版本尚未发布、网络不可用或更新失败时，旧 Host 会继续运行；下一次扩展后台
生命周期可重新尝试，也可手动执行 `npx @mearl/setup update --local`。

## 人工与 Agent 使用

- 人工在终端执行时不加 `--yes`，需要选择 Skill 安装目标或 MCP 客户端时会显示交互提示。
- Agent、CI 或其他无 TTY 环境应加 `--yes`（也可写
  `--non-interactive`）。首次安装会选择已检测到的 Agent / MCP 客户端，卸载会清理
  所有已检测到的相关配置。
- 无 TTY 环境执行 `install` 或 `uninstall` 却未加上述参数时，会在任何改动前退出并提示正确命令。
- 退出码 `0` 表示完整成功，`1` 表示执行未完成，`2` 表示参数或交互模式不适用。

## 示例

```bash
# 默认安装本地浏览器环境
npx @mearl/setup

# 与上一条等价
npx @mearl/setup install

# Agent / CI 无交互安装
npx @mearl/setup --yes

# 安装云端 Agent 环境
npx @mearl/setup --cloud

# 同一台机器同时作为本地浏览器宿主和云端 Agent
npx @mearl/setup --local --cloud

# 自动更新当前 PATH 中检测到的全部 Mearl 环境
npx @mearl/setup update

# 独立安装或更新到最新浏览器扩展
npx @mearl/setup extension

# 安装完整本地环境（client、Native Host、Skill 和扩展）
npx @mearl/setup extension --full

# 只卸载本地环境
npx @mearl/setup uninstall --local

# 自动检测并无交互卸载
npx @mearl/setup uninstall --yes

# 卸载环境，并清理全部 CLI 插件与 Provider
npx @mearl/setup uninstall --full

# 安装可选浏览器 Provider
npx @mearl/setup provider install @example/mearl-provider-device
npx @mearl/setup provider install @example/mearl-provider-cloud
```

原有 Mearl 环境包的 npm/npx 安装方式和 CLI 保持可用；setup 是统一的便利入口。

## Preset 安装

`mearl-setup preset apply <source-url-or-path>` 准备确切资源、激活本机 Node 选择，并向已连接的兼容扩展同步浏览器资源。`preset update` 保留用户覆盖，`preset status` 报告本机就绪情况和已连接扩展的状态。CLI setup 返回退出码 `3` 表示仍有本机组件待同步或安装。 [本机安装合同](../../docs/preset-installation.md)

install/update 在替换包前保存选中 Preset 的确切资源和期望选择，运行时初始化后同步宿主并安装 Skills；`extension --full` 在替换扩展前完成同一准备流程。已有本机选择优先保留，显式 `--preset` 用于更新或修复资源。配置或资源不可用时停止包变更；部分升级后的重试使用已保存记录。卸载不准备或安装 Preset。

默认目录为公共站点的 `installation.json`，可通过 `MEARL_INSTALLATION_CONFIG_URL` 指定其他 HTTPS 目录（本地验证允许回环 HTTP）。目录采用网页安装的校验合同；本机与浏览器未全部确认时报告 pending。

## 浏览器 preset 与发行入口

主动执行 setup 时，先沿用本机已选 preset；本机未选择时，在运行时初始化后、安装 Skill 前采用已连接浏览器的受信 preset。显式 `--preset <source>` 优先。多个浏览器的选择不同、来源不受信或状态读取失败时要求显式选择。首次连接最多等待约一分钟；浏览器关闭时只安装基础环境并说明重试方式。普通连接和后台核心更新不会自动安装首次本机 preset。

发行包可设置本机进程环境变量 `MEARL_SETUP_DEFAULT_PRESET` 提供默认清单来源；默认值仅在两端均无选择时生效，插件、Provider、卸载等子命令保持原行为。安装与状态核验仍由安装器负责。

发行包可设置 `MEARL_SETUP_STATUS_FORMAT=text`，让生命周期命令结束时显示警告和待处理提示。`preset status` 仍输出 JSON，退出码仍表示实际就绪情况。
