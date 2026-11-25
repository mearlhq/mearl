# 与其他浏览器工具协作

Mearl 单独使用时沿用主 Skill 的页面操作流程。任务已有 Ego、agent-browser 等工具时保留其任务归属，按需使用 Mearl 的环境和调试能力。安装状态不代表当前页面已经连通或获准执行。

## EgoLite

使用 `{{setup}} provider install @mearl/provider-ego` 安装并注册独立 Ego Provider。在支持 Provider 任务会话的宿主上，`browser_list` 会发现正在运行的 EgoLite 实例。

- 用完整 `browserId` 执行 `session_manage` 的 `new`，并保存返回的 `sessionId`。可选的 `providerOptions.name` 用于新 Space，数字 `providerOptions.spaceId` 用于关联已有 Agent Space。
- 扩展已连接、开启 Agent 服务且能匹配同一个物理页面时，Mearl 优先由扩展执行页面操作。Provider 负责 Space 生命周期和标签页范围。页面通道在会话建立时确定，见 `session.task.pageTransport`。
- 后续操作传 `--session <sessionId>` 和当前会话返回的页面 `tabId`。以 `get_capabilities` 核对当前通道能力。
- 交接、恢复和完成使用 `session_manage` 的 `handoff`、`resume`、`end`。仅在用户明确交还后恢复。已有页面会保留，用 `keepTabIds` 留下本次会话新建的结果页。
- 旧版宿主可沿用 `browser_manage` 的 `launch`，然后使用返回的完整任务 `browserId`。这种任务的 `session_manage` 同样按该 `browserId` 路由。

## agent-browser 等其他工具

目前没有通用第三方 tab ID/ref 转换入口，也没有其专用 Provider。保留原工具的交互能力；只有已通过受支持连接确认到同一物理页面时才调用 Mearl 增强。
尚不能确认映射或后端未声明所需动作时，明确说明当前限制，不按 URL 猜页或把整个任务切换到另一浏览器。
