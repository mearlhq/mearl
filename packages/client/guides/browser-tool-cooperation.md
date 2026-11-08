# 与其他浏览器工具协作

Mearl 单独使用时沿用主 Skill 的页面操作流程。任务已有 Ego、agent-browser 等工具时保留其任务归属，按需使用 Mearl 的环境和调试能力。安装状态不代表当前页面已经连通或获准执行。

## EgoLite

需要设备/App 模拟、接口或日志调试时，优先使用已安装的 `mearl-ego` Skill。该 Skill 通过 Ego 原生 API 管理 Space 与交接，通过已连接的 Mearl 扩展操作同一页面，无需额外 Provider 或插件注册。

未安装协作 Skill 时遵循以下边界：

- 先读取 `ego-browser skill`，沿用当前 Space；创建、关联、人工交接与 `finish({ keep })` 均按 Ego 当前指南执行。
- Ego 浏览器需安装并连接 Mearl 扩展。用 `browser_list` 选择 `transport: "extension"` 的连接，记录完整 `browserId`。
- 在 Ego Page 读取 `page.cdp("Page.getFrameTree")` 的主 frame ID，再用扩展 `tab_list` 与 `page_frames` 核对。只有 `isMainFrame: true` 的 `frameId` 唯一匹配时，才使用该扩展 `browserId + tabId`；URL、标题和其他工具的页面标识不能代替核验。
- 每轮转入扩展写操作前，按 Ego 指南确认同一 Space 仍由 Agent 控制；用户接管、Space 失活或归属变化时两套工具均停止写入。扩展不会自动继承 Ego 的控制阻断，未知结果先观察，不换工具重放。
- 设备或 App 模拟开启期间，导航、交互、快照与截图使用扩展 action；Ego 鼠标输入可能与触摸模拟冲突，原生导航或截图可能改变设备参数。撤销并确认模拟清除后，再恢复 Ego 原生页面交互。
- 对应的端模拟须已安装并取得实际站点权限，以当前目标的帮助为准。桥对象存在不证明真实原生授权或支付能力；跨域 iframe 的原生 screen/DPR、媒体查询与 CSS 安全区也不保证与真机一致。
- 普通打开后设置模拟并重载，不等于业务页首次访问即处于模拟环境。需要首屏模拟时先确认当前工具支持的准备流程。
- 成功收尾遵守 Ego 的页面保留规则；保留结果页时保留用户需要的模拟状态。需要恢复时在结束前通过扩展显式恢复原配置；Mearl 会话释放不替代 Ego 收尾，也不保证清除模拟。

## agent-browser 等其他工具

目前没有通用第三方 tab ID/ref 转换入口，也没有其专用 Provider。保留原工具的交互能力；只有已通过受支持连接确认到同一物理页面时才调用 Mearl 增强。
尚不能确认映射或后端未声明所需动作时，明确说明当前限制，不按 URL 猜页或把整个任务切换到另一浏览器。
