# 与其他浏览器工具协作

Mearl 单独使用时沿用主 Skill 的页面操作流程。任务已有 Ego、agent-browser 等工具时保留其任务归属，按需使用 Mearl 的环境和调试能力。安装状态不代表当前页面已经连通或获准执行。

## EgoLite

使用独立 `@mearl/provider-ego`，安装入口和支持范围以 Provider 自身 README 为准。本地源码构建后可用 `{{setup}} provider install '@mearl/provider-ego@/absolute/path/to/provider-ego'` 安装并注册；也可指定 GitHub Release 安装包地址。

- 无需浏览器扩展。已有扩展可关闭 Agent 服务，保留人工调试面板。Mearl 本地运行时仍负责 Provider 路由和已安装 App 资源解析。
- 一个 Provider 浏览器对应一个 Ego Space。启动时传 `providerOptions.name`；已有任务传数字 `providerOptions.spaceId`。只关联 Agent 所有的 Space，不隐式认领用户 Space。
- 使用 Provider 返回的完整 `browserId` 和页面 `tabId`，不需要 Agent 手工匹配扩展标签页。不传 Mearl `--session`。
- Space 交接和完成使用 Provider 的 `mearl-ego` CLI；源码安装时执行 `node /absolute/path/to/provider-ego/dist/cli.js handoff <spaceId>`、`resume <spaceId>`、`finish <spaceId> --keep p1,p2`。这里的 `mearl-ego` 是命令，不是 Skill。仅在用户明确交还后 resume。
- 所有页面操作经过 Ego 原生通道；用户接管、Space 失活时由 Ego 阻断，不改走扩展。连接断开或效果未知时不重放动作。
- 设备和 App 分别通过 `set_device_emulation`、`set_app_profile` 设置。App 来自已安装目录，使用当前已解析版本；UA、声明式全局变量和页面桥通过原生 CDP 安装。导航、截图继续使用同一个 Provider。
- 共享原生页面宿主提供设备外壳、根 WebView、网络控制和已安装 App 的协议/授权桥。真实授权仍需用户批准；接管会取消待授权会话，交还不恢复旧请求。不提供扩展专属请求/日志入口，其他参数限制以 Provider 指引为准。
- `finish` 默认不保留 Agent 页面；需要保留结果时显式传 Ego Page label。`browser_release` 只解绑，不结束 Space、不清除模拟；需要普通页面时先清除模拟再 finish。

## agent-browser 等其他工具

目前没有通用第三方 tab ID/ref 转换入口，也没有其专用 Provider。保留原工具的交互能力；只有已通过受支持连接确认到同一物理页面时才调用 Mearl 增强。
尚不能确认映射或后端未声明所需动作时，明确说明当前限制，不按 URL 猜页或把整个任务切换到另一浏览器。
