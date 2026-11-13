# Mearl 核心工作流

本指南说明通用操作流程。参数、返回字段以当前 CLI 的 `mearl <action> --help`、SDK `mearl.help()` 或 MCP 工具 schema 为准；MCP 使用实际提供的工具名，不猜命令映射。仅能使用 MCP、无法执行 CLI 时，直接使用当前 MCP 工具说明与 schema。

## 进入任务

已有目标和明确动作时直接操作，不先做环境巡检。命令不可用或连接失败时再用 `mearl check`；本机连接按需恢复，不手工启动或保活 native host。安装和排障见[连接排查](./troubleshooting.md)。

```bash
mearl tab_open --payload '{"url":"https://example.com","reuse":"prefer"}'
# 使用打开结果中的 tabId，观察后再选择本次快照提供的 ref。
mearl page_snapshot --payload '{"tabId":12345,"mode":"viewport"}'
mearl page_click --payload '{"tabId":12345,"selector":"@e3"}'
```

## 目标与控制归属

页面动作持续复用同一浏览器与传输返回的 `tabId`。无可用页时才打开；已知 URL 优先 `reuse:"prefer"`，绑定开发页时沿用其 `openerTabId`。默认后台操作；确需可见输入时激活同一页。

默认使用统一发现。需要选择目标时用 `browser_list`，沿用返回的完整实例名或 `browserId`。远端连接与 Provider 选择见[浏览器管理](./api-browser-setup.md)。

需要任务归属、并行协作或人工交接时，首次 `tab_open` / `page_snapshot` / `page_screenshot` 传 `--session new`，后续复用完整 `session.sessionId` 与 `tabId`。会话固定目标，但 Cookie/存储仍共享。目标声明由外部工具控制时（例如 Ego 任务），沿用其交接与收尾，不传 Mearl `--session`；跨工具先核验同一实例和物理页面，不能仅凭 URL/标题或直接复用 ref、label、tab ID。详见[工具协作](./browser-tool-cooperation.md)。

## 观察、操作与判读

1. 需要理解页面或选择目标时取一次 `page_snapshot`；只要求截图时直接截图。优先 viewport、局部根节点或 query，确需全貌才取 full；AX 不足时再用 dom。只使用本次快照的 ref。
2. 优先结构化点击、输入、滚动等动作。已知目标的紧密步骤可组合执行；有条件、循环或等待后立即点击时用 `mearl run`，见[代码组合](./scripting.md)。未知页面先输出最小观察，再由模型决定下一步，不预写未知 ref。
3. 默认交互检查 `action.success`；`precondition` 表示未派发，可修正输入；`dispatch-uncertain` 表示可能生效，先看 attempt、observation 或必要快照，不直接重试。关闭观察且没有诊断时可能返回裸结果，按实际结构判读。
4. 使用 effects、导航和 openedTabs 判断效果。新页已有 tabId 时直接使用。动作已内置观察，不固定追加等待、快照或截图；ref 过期、增量不足或 `fullSnapshotRecommended` 时再补观察。`changed:true` 且 effects 为空不表示失败。
5. 用 URL、页面内容或实际配置核验用户要求的终态；动作成功或中间页不单独证明任务完成。视觉、Canvas、跨域 iframe 用截图；只要求切换设备/时区等状态时，以设置响应结束。

复杂控件、文件、弹窗、派发差异见[网页自动化](./api-page-automation.md)；遮挡、布局与视觉验证见[页面排障](./api-page-debugging.md)。布局问题先用 `page_inspect`，必要时做最小只读 `page_eval`，取得目标后回到结构化动作。

## 环境与诊断按需启用

移动视口、UA、触摸使用 `set_device_emulation`，首屏生效用 `tab_open.emulation`。仅在用户明确要求客户端、JSBridge 或容器时启用 App 模拟；普通 H5、唤端链接或操作失败不构成启用理由。

App 可用性以当前目标的 `set_app_profile --help` 或 `get_capabilities` 为准，沿用当前 browser/session。`partial`、`unsupported` 不等于空目录，`available:false` 不可启用。按需读 Profile 的 usage 指引，不自动安装；方法存在不证明真实授权、支付等业务能力可用。环境准备见[设备与 App](./api-page-environment.md)。

已注册插件通过当前 `mearl --help` 或 SDK `mearl.help()` 发现，具体调用看插件帮助；本指南的专用 Skill 列表不代表全部已安装扩展。插件与 Provider 自己提供业务用法，核心入口不枚举它们的参数。

只在任务需要日志、请求或埋点时开启 diagnostics；跨动作使用一次 checkpoint，再按 cursor 查询。输出范围、协议插件、域权限和 Mock 见[接口与埋点调试](./api-request-debugging.md)。不要为每次动作重复查询能力目录；接入、所需能力改变或连接失效时再核验。

## 人工交接与收尾

扫码、验证码或系统交互需要用户时，用 `session_manage` 的 handoff 交接，说明原因。用户接管或 `CONTROL_SESSION_PAUSED` 后停止派发；交回后重新观察，不重放未完成批次。无扩展 UI 时，须在用户明确确认交还后再 resume。

会话任务用 `session_manage --session <id> --payload '{"operation":"end"}'` 释放归属，默认保留页面、Mock 和模拟环境。保留用户原有页和结果页，只有确认不需要的过程页才关闭。不带 session 的浏览器级释放仅用于用户要求结束调试或清理环境；外部工具按其自身约定收尾。具体归属与保留参数见[控制会话](./api-browser-setup.md#control-sessions)。

## 按需深入

- [代码组合](./scripting.md)：SDK、脚本上下文、超时和不确定结果。
- [网页自动化](./api-page-automation.md)：控件、文件、弹窗与动作结果。
- [页面排障](./api-page-debugging.md)：布局、遮挡、iframe、脚本及视觉。
- [环境准备](./api-page-environment.md)：设备、App、时区、Cookie。
- [接口与埋点调试](./api-request-debugging.md)：请求、日志、权限、Mock。
- [浏览器管理](./api-browser-setup.md)：目标、会话、远端与 Provider。
- [工具协作](./browser-tool-cooperation.md)：与 Ego、agent-browser 配合。
- [专用 Skill 使用与安装](./related-skills.md)：Web 终端、本地微信小程序等专用能力的入口与按需安装方法。
- [连接排查](./troubleshooting.md)：连接失败与环境管理。
