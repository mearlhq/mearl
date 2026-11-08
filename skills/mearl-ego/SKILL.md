---
name: mearl-ego
description: 在 Ego / EgoLite 的指定 Space 中配合 Mearl 扩展进行设备或 App 端模拟、接口调试与页面验证，核对 Ego Page 与扩展 tabId，并协调操作入口和人工交接。适用于明确需要组合 Ego 与 Mearl 的任务；普通 Ego 网页操作、单独使用 Mearl 或开发 Browser Provider 不使用。
version: "3.0.0"
---

# Ego 与 Mearl 协作

Ego 管理 Space、页面归属和人工交接；Mearl 扩展提供设备/App 模拟、请求与日志调试。此 Skill 通过两者已有入口协作，无需额外 Provider。

## 使用前

- 先运行 `ego-browser skill`，按当前版本指南操作 Space 与 Page；已有任务沿用同一 Space。用户指定的已有 Space 按数字 ID 关联，新建 Space 仅在任务需要时进行。
- Mearl 的通用操作与连接排障沿用已安装的 `mearl` Skill。未提供该 Skill 时通过 `mearl --help` 和具体 action 的 `--help` 确认能力；不要假定另一份 Skill 与本目录一同安装。
- Ego 所在浏览器需安装并连接 Mearl 扩展。通过 `mearl browser_list` 选择 `transport: "extension"` 的连接，并保留其完整 `browserId`；本机 Ego 任务可用 `--local` 缩小发现范围。Provider 或其他浏览器的条目不能替代该扩展连接。

需要具体命令时读取[协作流程与示例](./references/workflow.md)。命令不可用或扩展未连接时按相应工具的安装/排障指引处理，不通过安装 Provider 替代扩展。

## 页面身份

Ego 的 Space ID、Page label、CDP target ID 与扩展的数字 `tabId` 是不同标识。Ego `task.tabs()` 只提供其 Space 内的页面信息，不直接返回扩展 `tabId`。

1. 在当前 Space 确定 Page，读取 `page.cdp("Page.getFrameTree")` 的主 frame ID。
2. 用扩展 `tab_list` 获取候选页；URL、标题只能用于缩小范围。
3. 对候选调用 `page_frames`，只有 `isMainFrame: true` 的 `frameId` 与 Ego 读取值一致，才确定对应的扩展 `browserId + tabId`。没有唯一匹配时停止扩展写操作，检查连接与当前页面。

在当前任务中复用已核验的对应关系。页面关闭、重建、连接变化或失联恢复后重新核对，不跨任务持久化映射，不跨工具复用快照 ref。设备外壳中的业务 iframe 不是用于匹配标签页的主 frame。

## 操作入口

| 场景 | 入口 |
| --- | --- |
| Space 创建、关联、页面归属与人工交接 | Ego 原生 API |
| 普通网页操作，尚未启用设备或 App 模拟 | Ego Page API |
| 设备模拟、端模拟、请求和日志调试 | 核验后的 Mearl 扩展连接 |
| 设备或 App 模拟期间的点击、输入、滚动、导航、快照与截图 | Mearl 扩展的页面 action |

App/客户端/容器/JSBridge 模拟只在用户明确要求时启用 `set_app_profile`；纯移动视口使用 `set_device_emulation`。App ID 与设备预设以目标浏览器的当前帮助为准，选择已安装的端模拟。

设备或 App 模拟开启期间，通过扩展操作同一标签页；Ego 的鼠标输入可能与触摸模拟冲突，原生导航或截图也可能改变设备参数。确认本次模拟已撤销后，再恢复 Ego 原生页面交互。扩展 `page_eval` 默认读取设备外壳中的业务 frame，显式指定 `frameId` 时先查询当前 frame 列表。

## 交接、验证与收尾

- 域名权限、登录或浏览器提示需要用户处理时，按实际错误发起必要请求，通过 Ego `handOff()` 交还控制。用户确认后按 Ego 指南接管同一 Space，再核对页面；等待期间两套工具都停止写入。
- 每轮转入 Mearl 写操作前，按 Ego 当前指南恢复同一 Space 并确认仍由 Agent 控制；不要长期只调用扩展而跳过 Ego 的控制状态检查。用户接管、Space 失活或归属变化时两套工具均停止写入。此协作流程不提供跨工具的强制阻断，扩展连通不代表拥有 Ego 控制权；动作结果未知时先观察，不换工具重放。
- 只切换配置时以设置回执确认；需要检查页面效果时，通过扩展读取业务状态或截图。声明式桥对象存在不证明真实原生授权、支付等业务能力可用。
- 保留用户页面及需要展示的结果页，Space 按 Ego 当前指南调用一次 `finish({ keep })` 收尾；保留结果页时同时保留用户需要的模拟状态。用户要求恢复时，在结束前通过扩展显式清除相应模拟；不要把 `browser_release` 当作清除模拟的保证，也不要关闭整个扩展浏览器来结束一个 Space。
