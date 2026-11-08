# 协作流程与示例

下面演示新建 Space、关联扩展页面并设置 App 模拟的流程。`https://example.com` 是示例网址，执行时使用任务的目标网址；任务名称、Space ID、页面 label、扩展 browserId 与 tabId 都从本次执行取得，不照搬示例数字。先读取 `ego-browser skill`；API 与当前指南不同时按当前指南执行。

## 1. 取得 Ego 页面身份

新任务需要新 Space 时，为本次任务选择唯一名称，新 Space 自带 `p1`，直接复用。先打开目标 HTTP(S) 页面，再通过扩展设置模拟并重载；`chrome://newtab/` 不是普通网页，不能用于扩展页面操作。此方式会先访问一次普通页面；任务要求首屏即为模拟环境时，需要另行确认当前工具支持的初始化方式，不能把重载后的状态描述成首次访问即生效。

```bash
ego-browser nodejs <<'JS'
const task = await taskSpace("端模拟回归-本次任务");
console.log({ spaceId: task.spaceId, page: "p1" });
const page = task.page("p1");
await page.goto("https://example.com");
console.log({
  spaceId: task.spaceId,
  label: page.label,
  url: await page.url(),
  mainFrameId: (await page.cdp("Page.getFrameTree")).frameTree.frame.id,
});
JS
```

后续轮次用 `taskSpace(spaceId)` 继续 Agent 自己控制的同一任务。任务已有 Space 时直接沿用，不再创建；需要用户选择时可只读调用 `listTaskSpaces()`，使用返回的 `id`。用户明确指定的用户所有或已结束 Space 用 `claimTaskSpace(id)`；交接后恢复同一任务用 `takeOverTaskSpace(id)`。已有页面 label 从当前 `task.tabs()` 获取，没有 label 的页面先按 Ego 指南 `adopt`，不猜 `p1`。

## 2. 找到对应扩展 tab

先列出扩展连接，再读取候选页及主 frame：

```bash
mearl browser_list --local
mearl tab_list --browser '<extensionBrowserId>'
mearl page_frames --browser '<extensionBrowserId>' --payload '{"tabId":123}'
```

只用 `transport: "extension"` 的已连接实例。目标若在另一宿主，按 Mearl 的实际路由选择对应宿主连接，不把本机列表当作所有 Ego 实例。

候选页的 `frames` 中必须有 `isMainFrame: true` 且 `frameId` 与上一步 `mainFrameId` 一致的记录。多个页面 URL 相同也分别核对；多个扩展连接存在时同样确认所属连接。记录唯一匹配的完整 `browserId` 与数字 `tabId`，后续扩展动作都显式使用这组目标。

扩展若提示域名未授权，先通过 `mearl --help` 确认当前版本的域名授权命令，再按错误中的实际域名申请。以下使用 `request_domain_permission`；当前 CLI 若提供 `request_permission`，则使用该命令并查询其帮助。

```bash
mearl request_domain_permission --browser '<extensionBrowserId>' --payload '{"domain":"example.com"}'
```

需要用户在弹窗中允许时，用 `task.handOff()` 交还 Space 并说明待处理的授权。收到确认且授权请求返回 `granted: true` 后，用 `takeOverTaskSpace(spaceId)` 恢复，再核对页面并继续失败前未执行的步骤。原请求已超时时，恢复后重新申请以确认当前权限；超时或拒绝不等于授权成功，不通过另一工具绕过扩展的域名权限检查。

## 3. 应用模拟

每轮从 Ego 转入 Mearl 写操作前，按当前 Ego 指南恢复同一 Space 并确认 Agent 仍有控制权。用户已接管或 Space 失活时保留现场，不通过扩展继续操作；交接后仅在用户确认并恢复控制后继续。此检查是本轮协作约定，不能自动撤销已经派发的扩展动作。

按目标扩展的当前帮助确认可用的端模拟，将下方 `<appId>` 替换为任务需要且已安装的端模拟 ID；没有所需配置时按能力包提示处理，不静默替换为其他 App。已有页面按任务要求记录可取得的原有模拟设置，供需要恢复时使用，不把未知配置当作未启用。

```bash
mearl set_app_profile --help --browser '<extensionBrowserId>'
mearl set_app_profile --browser '<extensionBrowserId>' --payload '{"tabId":123,"enabled":true,"profile":"<appId>","emulation":{}}'
```

`emulation: {}` 联动使用端模拟配置推荐的设备；省略该字段只设置 App 环境。只需要设备模拟时改用 `set_device_emulation`，具体 preset 查询当前帮助。修改后的 App、设备、是否重载等以实际回执为准。

## 4. 检查页面效果

模拟开启后，导航、交互和截图使用扩展 action。查询 UA、标题及业务 frame 视口可以一次完成；不需要调用原生桥来证明实际授权或支付能力。

```bash
mearl page_eval --browser '<extensionBrowserId>' --payload '{"tabId":123,"expression":"({url:location.href,title:document.title,readyState:document.readyState,userAgent:navigator.userAgent,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})"}'
mearl page_screenshot --browser '<extensionBrowserId>' --payload '{"tabId":123}' --output /tmp/mearl-ego-preview.png
```

需要视觉验证时查看保存的截图；设备外壳包含系统栏、导航栏与业务区域，业务 frame 的高度可能小于设备总高度。需要继续操作时取扩展 `page_snapshot`，使用其返回的 ref，不复用 Ego snapshot 的 ref。

动作失败先读取当前状态。导航重定向到未授权域名时处理新域名权限，不按初始 URL 推断已覆盖所有跳转。

## 5. 恢复与保留

只在用户要求恢复环境或任务确实不再需要本次模拟时，显式清除本次设置；页面原来已有的模拟配置应按任务前记录恢复，而非一律关闭：

```bash
mearl set_app_profile --browser '<extensionBrowserId>' --payload '{"tabId":123,"enabled":false,"emulation":{}}'
```

关闭 App 时省略 `emulation` 只清除 App 环境；传空对象同时清除设备模拟。只开启过设备模拟则用 `set_device_emulation` 的 `enabled: false`。保留结果页供用户查看时保留需要的模拟状态。

最后按当前 Ego 指南收尾。以下数字 `8` 需替换为本次 Space ID，`p1` 需替换为实际结果页 label；没有需要保留的页面时用 `keep: []`。调用 `finish()` 后不再操作旧 Page label。

```bash
ego-browser nodejs <<'JS'
const task = await taskSpace(8);
await task.finish({ keep: ["p1"] });
JS
```

用户接管或遇到未解决错误时保留现场，不把成功收尾套用到暂停的任务。若本次额外建立 Mearl 控制会话，按 Mearl 的会话规则释放该会话；其释放不替代 Ego Space 收尾或显式清除模拟。
