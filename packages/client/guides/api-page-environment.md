# Mearl 场景：页面测试环境准备

需要联动设备/App、折叠屏/分屏、时区或 Cookie 时读取本文件。设备预设与端模拟列表以当前 CLI 为准，不从静态文档推断当前列表。远端/Provider 选择见[浏览器管理](./api-browser-setup.md)。

设备模拟直接可用。App 模拟入口由已安装的能力包提供，配置可声明 UA、JSBridge 和容器行为。先查看 `mearl set_app_profile --help` 展示的目标浏览器动态目录；需要机器可读的桥方法、可调设置与默认版本时用 SDK `mearl.getCapabilities({ app: '目录中的完整 ID' })` 或 MCP `browser_get_capabilities`。按需读取 `usage.skills` / `usage.documentation`，再执行对应动作。

## 设备模拟与设备外壳

移动视口、UA、触摸或机型布局用 set_device_emulation；新建页在 tab_open.emulation 中传入，首屏直接生效。已有页用设置 action，保持 tabId。默认纯设备模拟，不创建 iframe；deviceShell=true 会在根 iframe WebView 内加载业务页并显示系统栏。

scale 只改变视觉比例，不改变页面读取的视口或 DPR。预设的真实生效方向、尺寸、UA 和触摸能力以设置响应为准；折叠设备可能按自然方向归一化，不自行按 ID 推断方向。旧预设仍保留原尺寸与 UA。

设备外壳开启/移除需要重载。任务会话用 `browser_release --session <sessionId>` 收尾，默认保留设备与 App 模拟；明确需要清理时传 `preserveEnvironment=false`。不带会话的浏览器级 release 会清理依赖调试连接的模拟，关闭 Tab 后该 Tab 的配置失效。任务只要求切换配置时，成功响应足够；要求查看页面效果时再做快照/截图。

## App 与设备联动

只有用户明确要求 App、客户端、容器、JSBridge 或容器栈模拟时启用 set_app_profile / tab_open.appProfile；普通 H5、唤端链接、客户端分支或操作失败不是启用理由。

- 只注入桥：省略 emulation，保留设备状态；App 注入本身不创建根 iframe 或系统栏。
- 完整端模拟：同一个 set_app_profile 调用传 emulation；空对象采用端模拟配置推荐的设备，设备外壳默认开启。
- 左右分屏：端模拟与 deviceShell=true、orientation=landscape、splitScreen=true 必须同时满足。新建页需要首屏分屏时，在 tab_open 同时传 appProfile 与该 emulation 组合。
- 桥方法覆盖：bridgeConfig 只声明受控行为、固定 JSON 回包或成功空实现，不执行配置脚本。
- 恢复：enabled=false 且省略 emulation 只清除 App；传 emulation={} 同时清除设备模拟。

页面网络环境通过已安装预设声明的 networkControl 切换，传入其 id 和 value；省略保留当前设置，null 清除。可用控制项与取值以当前能力目录和预设文档为准。仅作用于目标 Tab，扩展模式与该 Tab 的快捷设置共享；关闭 Tab 或重启浏览器后清除。单次协议请求的参数不等于修改页面网络环境。

## 时区

用 set_timezone 覆盖目标 Tab 的 Date/Intl 时区，无需刷新；空字符串清除覆盖。按成功响应确认 enabled/timezone，不为单纯状态切换追加页面验证。

## Cookie 与页面状态

用已知 Cookie 名核验功能分支、实验或账号标识，不列举全部 Cookie、不读取认证 Token；HttpOnly 读取会被拒绝。

只操作 Cookie 时可传 url，不为获取 tabId 额外打开页面；显式 tabId 用于选择该页的存储区（含无痕）。get_cookie 不回退同名分区 Cookie。

set_cookie 只写非分区 session Cookie，空值不删除。需要页面重新读取 Cookie 时显式 reload=true 并提供 tabId；响应不回显写入值。按响应或页面业务状态验证，托管身份鉴权使用已安装的身份插件。
