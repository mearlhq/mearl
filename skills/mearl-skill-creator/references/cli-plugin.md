# Mearl Skill 插件规范

需要编写可复用脚本时读取。插件随 skill 分发，可使用现有 Node 运行时或本机 `python3 >= 3.9`；不需要单独发布 npm 包或维护 manifest。Mearl 不安装 Python，也不执行 `pip install`；需要其他解释器或虚拟环境时通过 `MEARL_PYTHON` 指定可执行文件的绝对路径。

## 入口与注册

默认在 skill 的 `scripts/main.mjs` 或 `scripts/main.py` 创建入口。两者同时存在时使用 `main.mjs`。JavaScript 入口默认导出 `register(app)`，Python 入口导出 `register(app)` 函数。入口主要保留插件元信息、依赖组装和命令注册；很简单的转发或参数处理可以内联，独立业务领域、复杂校验与转换、接口或页面编排、本地 I/O 和子进程操作应按职责放到同目录模块。不为拆分而拆分，也不在模块间引入循环依赖。JavaScript 和 Python 分别通过语言原生的相对加载方式引入这些模块。入口可异步，注册阶段只声明命令，不调用浏览器、不读写业务数据；业务动作放在 handler 内。

```js
export const name = 'example'; // 可选；缺省时使用 skill 安装目录名
export const description = '读取和管理示例内容'; // 可选；显示在 mearl 的插件列表中

export default function register(app) {
  app.command('read <url>', async ({ url }) => {
    app.progress(`正在读取 ${url}`);
    const response = await app.invoke('send_request', {
      url,
      method: 'GET',
      responseType: 'text',
    });
    if (response.status >= 400) throw new Error(`请求失败 (${response.status})`);
    return response.body;
  }, '读取内容');
}
```

示例只展示入口协议，因为逻辑很简单才内联 handler；实际 URL 范围、业务响应校验和输出转换按已验证的站点契约实现，达到上述拆分条件时放入业务模块。

JavaScript 插件可导出 `defaultCommand`，指向一个已注册的公开命令，提供单层 CLI 入口。插件名可使用小写字母、数字、短横线和下划线，以字母开头，不能占用内置命令。例如插件名 `sample_request`、`defaultCommand = 'read'` 对应上面的 `read <url>` 后，可直接运行 `mearl sample_request https://example.com` 或 `mearl sample_request --payload '{"url":"https://example.com"}'`。SDK 和 MCP 仍使用标准 `{ command: 'read', input }` 调用；默认命令不能指向 Toolbox 或页面运行时专用命令。

等价的 Python 入口如下。Python handler 可以是普通函数或 `async def`；`app.invoke` 是同步调用，返回已经解析的 JSON 值：

```python
name = "example"  # 可选；缺省时使用 skill 安装目录名
description = "读取和管理示例内容"  # 可选


def register(app):
    def read(input):
        url = input["url"]
        app.progress(f"正在读取 {url}")
        response = app.invoke(
            "send_request",
            {"url": url, "method": "GET", "responseType": "text"},
        )
        if response["status"] >= 400:
            raise RuntimeError(f"请求失败 ({response['status']})")
        return response["body"]

    app.command("read <url>", read, "读取内容")
```

也可以用 `@app.command("read <url>", description="读取内容")` 装饰 handler。入口、input、`app.invoke` 参数和返回值必须能用 JSON 表示；业务日志不要写 stdout，进度统一使用 `app.progress`。Python 同目录模块可直接 import，第三方依赖必须已存在于所选解释器环境中。业务模块的 handler 可以接收 `app` 或所需的 `invoke`/`progress` 依赖，由入口注入；不要在模块导入时执行业务动作。

注册要求 Node.js >= 20.18.0，默认命令是 `npx @mearl/setup plugin <path>`。path 可为目录（默认按顺序选择 `scripts/main.mjs`、`scripts/main.py`）或具体入口文件，可传绝对或相对路径，不要求切换目录。插件名优先读取入口的 `name` metadata，没有时使用 Skill 目录名；确需覆盖时兼容 `npx @mearl/setup plugin <name> <path>`。名称使用小写字母开头的字母、数字、连字符，不占用 Mearl 内置命令。

在生成的 SKILL.md 中写明具体名称和实际路径定位方式，例如：

```bash
npx @mearl/setup plugin "$SKILL_DIR"
```

提醒 Agent 将 `$SKILL_DIR` 替换为本次读取的 skill 目录。参数确定时直接执行业务命令，遇到 `PLUGIN_NOT_REGISTERED`、`PLUGIN_ENTRY_MISSING` 或基础 mearl 未安装、不支持插件时注册一次并重试。注册会补齐缺失或低于当前 setup 版本的 client、native-host。其他加载错误、参数错误、登录失效和业务失败按实际原因处理。

无需在每次业务调用前探测。确需单独确认注册和入口健康状态时运行 `mearl example --version`：退出码 0 表示注册记录可解析且入口可加载，stdout 返回 `SKILL.md` 顶层 version，未声明时返回 `unknown`；未注册、入口丢失或加载失败返回退出码 2 和对应的 `PLUGIN_*` 错误，不连接浏览器。

Skill 需要连同源码安装时，在生成的 `SKILL.md` 顶层声明 `install` 元数据，不要在正文中重复安装命令：

```yaml
install:
  description: 安装并注册示例 Skill 和 CLI 命令
  command: npx @mearl/setup plugin install group/project --skill example
```

`command` 中 `plugin install` 后的参数交给当前 preset 指定的 Skills 管理器（默认为 skills），安装固定为全局共享模式。setup 从安装成功输出中取得路径，注册其 `scripts/main.mjs` 或 `scripts/main.py`；不需要额外的 npm 包或安装脚本。自动注册默认使用安装目录名，需要短名称时在入口中声明 `name`；自定义入口文件继续用显式路径注册。

注册保存绝对入口路径和可选的简短描述；同名注册更新绑定。原地更新 skill 入口代码后下一次 CLI 调用生效；扩展打开工具箱时按入口文件元数据自动更新注册描述与工具声明。skill 换路径时重新注册以更新绑定；入口或导入模块的源码修改对新任务生效，运行中的任务保留已接受的资源快照；仅导入模块内的导出元数据变化需要显式重新注册。

卸载命令是 `npx @mearl/setup plugin uninstall <name>`。全局安装到 `~/.agents/skills` 的入口会先通过当前 Skills 管理器的卸载命令移除 Skill，成功后清除关联注册；入口目录已被手动删除时仍清理 当前管理器的跟踪记录。手工路径只解除注册，不删除源码。卸载失败时保留注册以便重试。

## 工具箱页面

需要在浏览器扩展中提供独立界面时，入口可导出一个 `toolbox` 声明。普通命令插件不要声明。注册后的工具按 `order`、标题排序展示在 Popup 工具箱中；真机调试始终位于首项。

页面文件放在 Skill 目录中，注册时由 Mearl 打包，通过 sandbox iframe 加载，不需要本地 HTTP 服务。
普通页面可直接使用 HTML、CSS、JavaScript 和图片，不需要维护构建命令；入口 HTML 引用的本地样式、
脚本和媒体会在注册时内联。React、Vue 等工程也可以自行产出静态页面，再将产物 HTML 设为 `entry`：

```js
export const toolbox = {
  version: 1,
  displayMode: 'both',
  title: '工作区笔记',
  description: '整理工作区笔记',
  icon: 'notebook-pen',
  locales: {
    en: {
      title: 'Workspace Notes',
      description: 'Organize notes for a workspace',
    },
  },
  agent: {
    skill: 'notebook-skill',
    layout: 'workspace',
  },
  page: {
    type: 'sandbox',
    runtime: 'preact',
    entry: 'assets/toolbox/index.html',
    commands: ['list', 'create', 'delete'],
  },
  order: 100,
};

export default function register(app) {
  app.command('list', async () => ({ items: await listItems() }));
  app.command('create <name>', async input => ({ item: await createItem(input.name) }));
  app.command('delete <id>', async input => ({ item: await deleteItem(input.id) }));
}
```

`title` 为 1-80 个字符，`description` 最多 240 个字符；需要国际化时通过 `locales` 按 `en`、`zh_CN` 等语言覆盖这两个字段。`icon` 支持短横线命名的内置图标（最多 40 字符）、SVG 源码、图片 Data URL 和 HTTP(S) 图片地址（总计最多 32768 字符）。例如 `icon: 'git-branch'`、`icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">…</svg>'` 或 `icon: 'https://example.com/icon.png'`。工具图标优先使用内置名称或 `currentColor` 单色 SVG：后者通过遮罩继承与内置图标相同的主题、悬停和选中颜色，不注入扩展 DOM。显式设置颜色的 SVG、图片 Data URL 和远程图片保留原色。图片加载失败或名称未知时显示通用图标。相对文件路径和带凭据的 URL 不受支持。`order` 可选，范围为 0-10000，默认 100。`page.commands` 中声明的命令必须由同一入口实际注册。

`app.command(signature, handler, description?, examples?)` 注册 CLI、SDK 和 Agent 可调用的业务命令。
`app.toolboxCommand(signature, handler, description?, examples?)` 注册仅供工具页面调用的命令，参数和 handler 契约相同；
它不出现在 CLI 帮助中，CLI（包括 JSON payload）、SDK、MCP 及插件间的 `app.invoke` 都不能调用。
工具页面通过 `window.mearl.invoke(command, input)` 或 `window.mearl.invoke('host.task.start', { command, input })` 执行；两类命令都必须显式列在 `toolbox.page.commands` 中才能供页面调用。
注册的 `toolboxCommand` 若没有列入该白名单，插件加载会失败。分块上传、分块读取和页面临时资源释放适合使用它；
对 Agent 有独立业务价值的查询、导入、压缩、比较等完整操作使用 `app.command`。
Python 入口也支持 `app.toolboxCommand(...)`，包括 `@app.toolboxCommand(..., description="...")` 装饰器。

`displayMode` 控制展示位置：`popup` 仅在 Popup 内打开并隐藏全屏按钮，`tab` 点击后直接在独立页打开，
`both` 在 Popup 内打开并保留原有全屏按钮。省略时默认为 `both`，现有插件行为保持一致。
`popup` 工具在独立页访问时显示引导提示；独立页工具的入口仍保留在工具箱和顶部导航中。

复杂的无构建页面可声明 `page.runtime: 'preact'`。宿主会注入固定的 Preact、Hooks 和 HTM 运行时，页面从
`window.mearl.ui` 获取 `html`、`render`、`useState`、`useEffect` 等 API。`window.mearl.ui.version` 是只读
诊断信息，不用于请求或选择版本；未声明 `runtime` 的页面不会加载这份运行时。

插件页先调用 `const context = await window.mearl.ready()` 获取 `locale`、`theme` 和标题，再通过
`window.mearl.invoke('list', {})` 调用白名单命令。页面不能直接访问扩展 API，也不能传入未声明的插件
命令。默认 CSP 禁止联网、提交表单、嵌套页面和远程资源；需要浏览器、HTTP、本地文件、Git 或子进程
能力时，在插件命令中通过 `app.invoke` 或受控业务模块实现并校验输入。

通过 `window.mearl.onContextChange(context => { /* 更新文案与界面 */ })` 订阅宿主语言、主题和标题变化，
返回取消订阅函数。订阅时立即收到当前上下文；后续通知为合并后的只读快照，`window.mearl.context` 和
再次调用 `ready()` 也返回最新快照。语言切换应更新界面并保留表单、选择和正在执行的任务，避免重新加载页面。

工具页面的宿主 RPC 统一使用 `window.mearl.invoke('host.<能力>', input)`，业务命令仍使用 `window.mearl.invoke(command, input)`。宿主按注册能力校验输入并执行平台调用；页面不能传任意 Chrome 方法名或 Native Host action。插件命令中的 `app.invoke(action, payload)` 则沿用宿主已有的浏览器与 Native Host action 路由。

| 宿主能力 | 输入 |
| --- | --- |
| `host.tab.active` | 无 |
| `host.clipboard.read` | 无 |
| `host.clipboard.writeText` | `{ text }` |
| `host.clipboard.writeImage` | `{ data }` |
| `host.directory.select` | 无 |
| `host.link.open` | `{ url }`，HTTP(S) 链接 |
| `host.toast` | `{ message, type?, duration? }` |
| `host.task.start` | `{ command, input, executionTimeoutMs?, idempotencyKey? }` |
| `host.task.get` / `host.task.cancel` | `{ taskId }` |
| `host.task.list` | `{ activeOnly?, cursor?, limit? }`，默认仅活动任务，返回 `{ tasks, nextCursor? }` |
| `host.task.events` | `{ taskId, cursor?, waitMs? }`，返回事件、最新任务与缺口标记 |
| `host.task.result` | `{ taskId, index }`，完整 JSON 结果的 Base64 分块与校验信息 |
| `host.task.diagnose` | `{ taskId?, instanceId?, includeErrorMessages?, includeLocalPaths? }`，仅当前插件的工具箱与 runtime 任务元数据 |
| `host.model.capabilities` / `host.model.list` / `host.model.start` | `list` 传 `{ provider: 'codex' }` 获取本机可选模型；查询能力；或传 `{ request, taskOptions? }` 创建模型任务，用 `waitTask` 读取结果 |
| `host.state.get` / `host.state.getMany` / `host.state.list` / `host.state.transact` | `{ collection, ...操作参数 }`，限声明的集合；`getMany` 使用 `keys` 一次读取最多 128 个键，结果最多 1 MiB；实例或会话作用域需传 `instanceId` |
| `host.page.attach/get/list/send/detach/events/activation` | 页面实例操作，字段与 `app.page(operation, input)` 一致，限定当前插件 |

后台命令由本机用户级任务服务执行，页面关闭后继续。`start` 返回 taskId；`get` 的 result 是资源引用。
页面使用 `await window.mearl.waitTask(taskId, { timeoutMs?, signal?, onProgress? })` 等待并校验完整业务结果，
或 `await window.mearl.readTaskResult(taskId)` 读取成功结果；`await window.mearl.listTasks()` 自动翻页列出活动任务。
等待超时或取消订阅不终止任务，执行取消使用 host.task.cancel。服务重启会将未完成任务标为 interrupted，不重放。
任务入口固定 Skill 源码及相对资源；Node 第三方依赖应先打包，状态和缓存应保存在 Skill 源码目录之外。宿主不静态解析 JS 依赖，缺失依赖和语法错误由执行器加载代码时报告。

宿主还注入 `await window.mearl.invoke('host.directory.select')`、
`await window.mearl.invoke('host.tab.active')` 和 `await window.mearl.invoke('host.clipboard.read')`。
`host.tab.active` 返回当前窗口 HTTP(S) 网页的 `{ tabId, title, url }`，没有网页时返回 `null`；
插件命令仍需验证并显式绑定目标 `tabId`。`host.clipboard.read` 仅在用户点击粘贴等操作时调用，
返回 `{ type: 'image' | 'text', data }`；图片是 PNG/JPEG data URL，文本保留原文；返回内容上限 16 MiB（图片按 data URL 编码后的大小计算）。

需要动态页面脚本的插件可调用 `app.invoke('page_eval', { tabId, expression, executionWorld: 'isolated', worldId: 'my-plugin' })`。
`worldId` 使用最长 64 字符的小写字母、数字和连字符；相同标签页和标识复用隔离环境。`expression` 必须是 JavaScript 表达式，含多步语句时用 IIFE 包装。脚本可操作 DOM，不能直接读取网页 JS 变量，Promise 返回值会等待完成；同步异常和 Promise 拒绝由宿主统一返回。
需要传入大体积 JSON 数据时，使用 `app.invoke('page_eval', { tabId, executionWorld: 'isolated', worldId: 'my-plugin', expression: '(data) => { /* 页面逻辑 */ }', args: [data] })`。宿主负责参数序列化、分块传输和临时数据清理，返回与 `page_eval` 相同的结果；工具只提供页面函数和业务数据。
扩展连接依赖 Chrome 的 `userScripts` 权限和扩展详情中的「允许用户脚本」开关，权限未开启时明确失败，不自动回退到 debugger；工具页面由宿主统一显示开启指引、扩展详情入口和重试。宿主已展示的错误会带 `handledByHost: true`，工具应避免重复提示。页面截图可显式传 `captureMode: 'visible'`，只捕获目标窗口的活动标签页且不支持元素选择器；设备模拟或 App 外壳的活动页截图复用模拟会话，并裁剪到当前业务 WebView；通用截图默认仍走 CDP。

持续页面能力使用独立于 toolbox 的 `export const pageRuntime`，声明 `{ version: 1, matches, code, initialize?, events? }`。`code` 必须在网页中求值得到自包含函数；宿主仅编译检查表达式语法，不在宿主执行代码，函数类型和外部引用错误在页面运行时报告。函数接收 `{ identity, input, signal, emit }`，返回 `{ receive(message, { signal, requestId }), dispose() }`。消息取消传播独立 signal；异步处理应在修改 DOM 前检查 signal，实例级 host.signal 则在整个实例销毁时取消。匹配范围只支持 HTTP(S)；宿主固定浏览器会话、tab、frame 和原生 documentId，切换文档会取消后台事件任务并清理实例。同插件同文档的 CLI、Popup 和激活入口共享初始化和实例。

插件命令调用 `app.page('attach', { tabId, frame: 'business', input })` 获得 `instanceId`，通过 `app.page('send', { instanceId, message })` 通信；也支持 get/list/detach/events/activation。消息和结果最多 24 MiB，宿主负责双向分块、校验与资源清理。页面运行时支持扩展连接与纯 CDP；扩展连接依赖已授权域名和「允许用户脚本」，CDP 使用对应浏览器的页面运行能力，按该传输的实际权限检查。

事件 schema 是格式描述，后台处理器须自行验证负载。后台事件绑定如 `events: { changed: { command: 'save', schema: {...}, policy: 'latest' } }`，策略支持 serial/latest/parallel（有限并发）。使用 `app.runtimeCommand('save', ({ event }, context) => ...)` 注册隐藏处理器，初始化也注册为 runtimeCommand。`context.page.send/get` 只访问绑定文档；`context.page.send(message, { timeoutSec: 120 })` 可为等待原生 API、下载或用户手势等异步操作设置单次响应超时（大于 0 且最多 300 秒），不修改其他请求的超时，取消、文档解绑和任务执行期限仍然生效。普通页面 action 和 run_actions 不可用于运行时任务。页面 `host.emit('changed', payload)` 等待接收确认，处理完成和失败记录在实例事件历史；负载上限 32 KiB，应在页面合并高频变化。

工具箱用 `await window.mearl.subscribe('page', { instanceId, cursor? }, listener)` 观察后台事件，返回取消订阅函数。事件含 received/running/success/error/navigation/invalidated；received 的 name/payload 是业务事件，resync 表示历史缺口，需要重新读取状态。`host.page.*` 是工具箱对应入口，只允许自己的插件；UI 不负责持久化页面事件。

需要自动恢复时，显式调用 `app.page('activation', { enabled: true, matches, persistence: 'session', frame: 'business', input })`，匹配取用户规则与声明范围的交集；persistent 在浏览器重启后保留，session 仅当前会话。宿主在导航后重建实例、调用 initialize，停用用 enabled:false。声明与事件绑定放在 pageRuntime，不放在 toolbox.page。

独立修改匹配范围时，可传 `enabled: true, matchPatch: { add?: string[], remove?: string[] }`，与 `matches` 互斥。宿主原子增删范围，避免并发调用覆盖其他范围；删除最后一个范围会关闭自动激活，保留手动挂载的页面实例。`persistence: 'persistent'` 在浏览器重启后保留，初始化 handler 可读取最新插件偏好，不必将易变配置复制到规则 input。

### 高频交互与大资源

工具箱业务命令的输入上限为 256 KiB、结果上限为 512 KiB，按完整 JSON 的 UTF-8 字节数计算；持久任务输入同样最多 256 KiB。`app.page('send')` 的消息与结果最多 24 MiB，由宿主分块传输；图片等长期资产保存在源码树外的文件存储中，通过资源 ID 引用。

- 自定义文件分块应使用文件偏移范围读取，使整份资源的累计读取量与文件大小成正比；不要每次读入整文件再截取一块。UTF-8 文本可按字节分块，用 Base64 传输，接收端重组完整字节后统一解码，避免破坏中文或 emoji。144 KiB 二进制编码后约为 192 KiB，可为请求信封留出余量；同时校验分块长度、顺序或索引、总量和资源归属。
- 界面根据资源 ID 或版本变化读取内容；焦点恢复和状态同步只更新变化部分。高频页面事件按业务语义合并或使用 `latest`，普通状态查询与文件传输使用短命令，模型和长耗时处理使用持久任务。
- 不依赖模块内存保存跨执行器状态；需要复用已读取内容时，明确资源有效期、失效条件和内存上限。多张大图并发时仍应避免反复读取整文件。
- 按实际输入规模验证大文件、多字节文本与累积历史记录下的行为。除耗时外检查读取字节数和往返次数，避免小样本或系统文件缓存掩盖读取放大。

`await window.mearl.invoke('host.clipboard.writeImage', { data: dataUrl })` 将 PNG、JPEG 或 WebP data URL 写入宿主剪贴板，编码后的输入上限 16 MiB。PNG 直接复制；JPEG/WebP 转换为原尺寸 PNG（最多 1600 万像素），不改变下载文件的格式。只在用户触发复制操作时调用；失败通过 Promise 抛出，由工具页面用 toast 提示。
宿主还提供
`await window.mearl.invoke('host.toast', { message, type, duration })`、
`await window.mearl.runAgentTask(prompt, { cwd, layout, anchor, key })`、
`await window.mearl.setAgentPanelVisible(visible, { layout, anchor, key, cwd, context })` 和
`await window.mearl.setQueryParam(name, value)` 等通用界面能力。目录选择返回本机规范化绝对路径，
用户取消时返回 `null`；不要用浏览器文件输入模拟目录路径。Toast 的 `type` 可为 `success`、`error` 或
`info`，`duration` 范围为 1000～30000 毫秒，默认 3000 毫秒。短暂的操作结果使用 Toast；需要用户处理的
表单错误仍显示在对应字段或弹窗内。`runAgentTask` 只用于用户明确触发的任务，会打开 Agent 面板并把不超过
16000 字符的提示发送给 Codex；可选 `cwd` 必须是规范化绝对路径，用于把新会话直接绑定到目标项目。`layout` 可按本次交互指定为 `drawer`、`workspace` 或 `inline`；例如工作台首页使用 `workspace`，详情页操作使用 `drawer`。稳定的 `key` 会隔离不同业务对象的会话和输入草稿；`context` 会在用户首次发送消息时作为不展示在对话中的背景上下文写入新会话。`inline` 必须同时传入工具页内的占位 `anchor` 元素和不超过 128 字符的 `key`，宿主会把 Agent 面板覆盖到该元素并跟随滚动与尺寸变化。提示应包含目标、范围和完成边界，不要通过页面加载或后台刷新自动触发。
只有声明 `toolbox.agent` 的插件可以显示 Agent 或提交 Agent 任务。`agent.layout` 默认为 `drawer`：宿主在
工具页顶部提供固定入口，首次打开后将 Agent 常驻在右侧窄抽屉中；页面可通过
`setAgentPanelVisible` 控制显隐，且不要为 Agent 预留布局空间或在加载时自动打开。工作台可声明
`layout: 'workspace'`，由导航项控制 Agent 显隐；调用时可传主内容区域的 `anchor`，面板覆盖该元素并跟随
滚动和尺寸变化，不传 `anchor` 时覆盖工具页的完整内容区。导航宽度及响应式布局由插件页面自行决定。
`agent.skill` 声明该工具页优先使用的已安装 Skill。工具箱的 Agent 对话默认显示页面元素选择和评论入口，
可通过 `agent.pageElementActions: false` 隐藏。Agent 工作区其余 Provider、审批和 Skill 行为与扩展
原有侧边栏一致。
工具页可在加载后通过 `await window.mearl.setAgentGuides(guides)` 设置 1～6 个场景化引导项，替换
通用 Agent 空状态中的能力卡片。每项必须包含 `title`、`description` 和点击后写入输入框的 `prompt`，
可选 `icon` 使用工具箱图标名称。运行时设置便于直接复用页面语言和当前业务状态；提示词只会填入输入框，
不会自动提交或扩大用户授权范围。
`context.query` 是外层插件 Tab 当前 query 的只读快照；`setQueryParam` 接受小写短横线参数名和字符串值，
传 `null` 删除参数。宿主通过 `history.replaceState` 更新外层地址并返回新的 query，适合保存选中项、筛选条件等
可恢复视图状态；不要写入令牌、个人信息或大段业务数据。

宿主会自动设置 `data-mearl-theme="light|dark"`、扩展当前字号和一组 `--mearl-*` 语义变量，包括
`--mearl-bg-primary`、`--mearl-bg-secondary`、`--mearl-toolbar`、`--mearl-text-primary`、
`--mearl-text-secondary`、`--mearl-border`、`--mearl-bg-hover` 和 `--mearl-accent`。主操作按钮使用
`--mearl-action-primary`、`--mearl-action-primary-hover` 和 `--mearl-action-primary-text`。插件页优先使用
这些变量，避免与扩展主体形成两套视觉系统；页面仍可按业务需要覆盖它们。

### 视觉与交互一致性

工具箱是扩展界面的一部分。开始实现前查看当前环境可用的 1～2 个同类工具页，沿用其控件密度、文字层级和状态反馈；只使用主题颜色不能保证风格一致。不要把工具页设计成营销落地页或未经调整的原生表单。

- 保留宿主设置的根字号，正文通常用 `0.75rem`，小标题用 `0.875rem`。控件高度以 28～32 px、圆角以 4～6 px、间距以 8～12 px 为起点；窄 Popup 保持紧凑，独立页限制内容宽度。不要用大标题、大面积留白和反复嵌套卡片代替信息层级。
- 每个工具都要分别设计 Popup 与全屏布局，按宿主标题栏以外的实际 iframe 宽高分配空间。短表单默认一屏完成：外边距通常 12 px，避免重复宿主标题、重复辅助说明和多段固定高度；编辑区/列表用 flex 吸收剩余高度并在内部滚动，主操作保持可见。独立页适度放宽编辑区与内容宽度。验证时除不同宽度外也要覆盖短视口，不能只检查全屏页面缩窄后的样子。
- 背景、边框、正文、辅助文字、主按钮及错误/成功状态使用宿主 `--mearl-*` 语义变量；图标使用 `currentColor`。控制 hover、focus、selected、disabled 的可辨认性，语言和主题切换保留当前输入。
- 表单提供有用的占位示例，错误靠近字段。文件选择使用与宿主一致的按钮，配合预览、移除、拖放和粘贴反馈。提交中防止重复操作并显示进度；失败保留输入并给出下一步，成功展示可查看的结果。原始诊断放在可展开的详情中，内部协议和标识不进入主流程。
- 用符合实际规模的文字、图片和文件验证宿主输入限制。超过单次 RPC 预算的文件使用分块暂存和资源 ID，不能只用小图验证上传。
- 交付前在扩展中检查 Popup 窄窗口和独立页，以及浅色、深色主题的截图；检查溢出、裁切、控件密度、对比度及空白/加载/失败/成功状态。DOM 或协议测试不能代替视觉验收。没有可用浏览器时明确说明尚未做视觉验证。

`entry` 必须是相对 Skill 根目录的 HTML 路径，不能越出目录。页面源文件总计不超过 16 MiB，打包后
不超过 24 MiB；Native Host 按小于 1 MiB 的消息分块传输，扩展按 SHA-256 校验并缓存。入口可引用
相对 CSS、经典脚本、图片、字体和媒体；模块脚本必须是没有静态或动态 `import` 的单文件，因此框架项目
应先生成浏览器产物。注册生成不可变页面快照并记录实际引用的资源；打开或刷新工具页时按文件元数据
检查这些资源和宿主桥接版本，有变化才重新打包，无后台轮询或全目录扫描。页面变更后刷新或重新打开工具页即可；
插件入口代码在下一次调用时生效，首次添加插件或改变入口路径时仍需注册。

Python 入口使用同结构的模块级 `toolbox` 字典，页面 RPC 调用相同的命令和 JSON 输入输出协议。

## 两种调用形式

```bash
mearl example read "https://example.com"
mearl example --payload '{"command":"read","input":{"url":"https://example.com"}}'
```

`app.command(signature, handler, description?)` 注册一个子命令。signature 中 `<name>` 是必填位置参数，`[name]` 可选，最后一个 `<names...>` 或 `[names...]` 接收数组。CLI 可通过 `--name=value` 传入不依赖顺序的字符串业务字段，名称与 input 字段完全一致；复杂类型使用 JSON payload。`browser`、`timeout`、`output` 等宿主选项保留原有含义，同名业务字段也使用 JSON payload。位置参数、业务选项与 JSON payload 最终传给同一个 handler；同一字段不能重复传入，`--payload` 不能与前两种形式混用。handler 应拒绝不支持的字段，避免拼写错误被静默忽略。

公共层校验必填参数和多值数组；枚举、数值范围、互斥项和危险环境由 handler 校验。不要为复杂 input 维护另一套 flags 解析。可选 description 用于自动帮助，详细业务字段放在 skill 的相关说明中。

注册后的同一入口也由 SDK 与 MCP 共享。SDK 调用 `invokePlugin(name, { command, input }, options?)`，或复用 `UnifiedClient.invokePlugin`；MCP 调用固定工具 `plugin_invoke`，传入 `plugin`、`command`、`input` 和可选的 `browser`、`timeoutSec`，其中 `plugin` 对应 CLI `mearl <plugin>` 中的插件名。只使用 registry 中已注册的名称，或当前 preset 按需目录中已声明的插件，不接受调用方提供入口路径；按需安装只适用于当前 preset 已声明并通过来源检查的插件。不要为每个插件或子命令生成独立 MCP 工具。

## 注入能力与输出

- 命令 handler 可接收第二个参数 `context`：`app.command('read', async (input, context) => { ... })`。
  `context.identity` 包含 `invocationId`、`host.hostId`、`host.epoch`、`source`、`plugin` 和可选的 `parentInvocationId`；
  字段由调用入口生成，业务 input 不参与构造，`source` 只用于记录来源，不授予权限。
  `context.invoke`、`context.progress` 与 `context.signal` 绑定当前调用；执行结束后不能继续使用该上下文。
  取消后停止后续批次，并将 signal 传给支持中断的本地操作。Python handler 同样可接收 `context`，
  通过 `context.identity` 字典、`context.invoke`、`context.progress` 和 `context.signal.throw_if_aborted()` 使用。
  工具箱后台命令运行在受管理的独立执行器中，跨命令资源必须保存在业务存储中，不能依赖后台命令的模块内存继续存活。

- JavaScript 的 `app.invoke(action, payload?, options?)` 返回 Promise，Python 的同名方法同步返回结果。调用浏览器 action 时 payload 是 action 参数；调用另一个插件时传 `app.invoke('plugin-name', { command: 'subcommand', input })`。插件调用默认继承宿主选项并复用客户端连接，当前 preset 目录中声明的按需插件可在缺失时安装后重试一次，循环依赖会被拒绝。
- `app.progress(message)` 把非空进度文本交给宿主；JavaScript 插件也可传 `{ message, data }`，其中 `data` 必须可 JSON 序列化，供工具页稳定识别阶段和对象 ID，CLI 仍只输出 `message`。它和 `app.invoke` 一样只能在 handler 执行期间调用，帮助与注册阶段不得产生进度。
- `app.options` 是只读宿主调用选项。浏览器请求通过 app.invoke，避免重新启动 mearl 子进程或从全局 npm 目录 import SDK。
- 工具箱面向人，CLI 面向 Agent；复用业务操作并保持结果一致，不要求共享中间态。表单草稿、选择、预览等纯 UI 状态默认放浏览器内存，确需刷新或重新打开后恢复时才使用浏览器存储；sandbox 页不能假定可直接使用 `localStorage`、IndexedDB 或 `chrome.storage`，应通过宿主提供的能力访问。只有业务记录、后台执行、安全重试或传输暂存等具体需要才使用 Node 存储，并说明保留时间和清理方式，不为复用 Node 命令而额外共享或持久化 UI 状态。
- 后台模型执行使用 `app.model(request)` 或 `context.model(request)`，请求显式指定 `{ provider: 'codex', mode: 'agent', permissions: 'read-only', prompt, model?, reasoningEffort?, outputSchema? }`。先通过 SDK 或工具箱模型能力接口查询支持能力；当前 Codex 不支持严格无工具 `generate`，不会自动降级。返回 `{ text, output?, provider, mode, model? }`，outputSchema 透传模型 Provider，宿主解析最终 JSON，插件负责验证数据结构与业务约束。模型在本机执行，不依赖浏览器或侧边栏，复用持久任务和父子取消。JS 使用 `context.model(request, { onProgress })` 订阅单次调用的流式进度；Python 使用 `context.model(request, on_progress=callback)`。`model.delta` 的 data 含 `delta/index/partial`，可用时带 `itemId/phase`；按消息隔离、跳过 commentary，序号不连续时回退最终结果。增量只供临时展示，需自行校验完整记录；整次调用失败应撤回临时结果，最终校验成功后才能确认和缓存，不把增量当作业务成功。可选模型通过 SDK `PluginModelClient.list(provider)` 或工具箱 `host.model.list` 查询。模型项可包含 `reasoningEfforts/defaultReasoningEffort`，按所选模型支持范围提供思考级别；已有目录立即返回，过期后台刷新并合并并发查询，不创建推理会话；界面异步加载列表，保留默认配置和自定义输入。工具箱使用 `host.model.start` 和 `waitTask`。
- 共享配置和缓存声明 `export const stateStorage = { version: 1, collections: { settings: { scope: 'installation', storage: 'persistent', schemaVersion: 1, schema: { type: 'object' } } } }`，Python 导出同名 dict。命令使用 `context.state('settings', 'get', { key })` 和 `context.state('settings', 'transact', { transaction: { operations: [{ type: 'put', key, value, expectedVersion: previous.version }] } })`。批量读取使用 `context.state('settings', 'get-many', { keys })` 或 SDK `getMany`，一次读取同一 revision 的 `entries`，包括缺失键的 CAS version，避免逐键重复解析集合文件。schema 是格式描述与版本身份，插件负责验证状态值和迁移结果；宿主检查 JSON、大小、版本和事务约束。写入必须 CAS，冲突后重读并合并；迁移需提升 schemaVersion，并带 migrateFromVersion/expectedRevision。浏览器会话与实例使用 cache，context.state 自动绑定当前实例。图片等资产继续使用文件存储；不要把任务记录或大资源塞入状态集合。
- handler 返回字符串时输出文本，返回对象或数组时输出 JSON；带有 `success: false` 的结果仍完整输出，并使 CLI 以状态码 1 结束。宿主支持 `--compact` 和 `--output`。业务脚本不直接写 stdout/stderr；进度使用 `app.progress`，失败抛出异常，不主动退出进程。多文件任务可自行写入产物并返回路径。
- 命令行文件路径按调用工作目录解析；JavaScript 随 skill 的资源通过 `new URL('./resource', import.meta.url)` 定位，Python 使用 `Path(__file__).with_name('resource')`。不要改变进程工作目录。
- 底层页面动作的 action.success 为 false 时 app.invoke 抛出错误；HTTP 与业务协议的成功信号仍由业务模块检查。
- 工具箱宿主统一处理浏览器 action 执行前的域权限申请，获准后重试一次。授权未完成时，JavaScript 插件可根据 `code='DOMAIN_PERMISSION_REQUIRED'`、`requestDispatched=false` 保留未提交任务供用户重试；插件不必自行申请权限或匹配错误文案。CLI/Agent 显式申请域权限；网络失败、业务失败和 `run_actions` 不自动重放。

写命令在用户调用后直接提交，不增加通用的二次确认参数。业务模块仍须保留已验证的目标校验、幂等检查、危险环境限制和结果回查，提交失败不自动重试。

## 验证

验证默认目录入口和必要的自定义入口能注册；帮助不能调用浏览器。用同一输入验证两种命令产生相同业务请求和结果，包含所需的浏览器选择。写操作验证目标校验、单次提交、结果回查和业务失败；真实写入遵守当前用户授权。

测试遵循目标项目已经存在的测试目录和命令，不为未知工作区假定固定布局。若目标是直接安装的 Skill 且没有项目级测试位置，可在临时工作目录完成验证，避免把仅用于开发的测试随 Skill 分发。可直接给 register 注入假的 app 收集 handler、记录 invoke/progress 调用，不需要浏览器登录或单独安装 SDK 即可验证业务逻辑。

受管理任务的跨插件 `app.invoke(name, { command, input })` 建立独立子任务，固定子插件自己的 installation/revision，并提供自己的 state/model/page/checkpoint 归属。子调用只可执行公开命令，不继承工具箱或 runtime 隐藏命令权限；循环调用和超过 16 层的调用明确失败。父任务取消、到期或结束时取消并等待整个子执行树。子插件不能换浏览器路由；页面绑定调用继承原文档约束，页面实例需由子插件显式 attach 并遵循自己的 pageRuntime，不能借用父插件实例或控制其他文档。子任务可记录检查点，但显式 resume 仍只支持合格根任务。

恢复应显式声明：入口导出 `taskRecovery = { version: 1, commands: { work: { checkpointVersion: 1, schema } } }`，并注册 `app.recoveryCommand('work', handler)`。正常 handler 用 `context.checkpoint(data, expectedSequence)` 保存恢复依据，恢复 handler 从 `context.recovery.checkpoint.data` 读取并核对外部状态。检查点最多 64 KiB，初始序号 0，宿主 CAS 成功后递增；与插件 state 或外部操作不共享事务。JS 与 Python 使用相同 API。恢复仅支持 public/service 根命令；SDK resume 建立新任务并保持原任务终态，不回放原 handler，也不自动续跑子模型或旧页面。默认固定原代码；显式 `revision: 'current'` 可选当前快照，同版本需相同 schema，跨格式版本须声明 `migrateFrom: [{ version, schema }]` 并注册 `app.checkpointMigration('work', ({ checkpoint, fromRevision, toRevision }) => newData)`。迁移仅做可重试的纯 JSON 转换，宿主 API 和嵌套插件不可用，10 秒期限，结果校验后才创建唯一后继；可信本机代码并非 OS 沙箱。检查点保存宿主 schemaHash，动态声明漂移会拒绝恢复。完整契约见[宿主恢复能力](https://github.com/mearlhq/mearl/blob/main/packages/native-host/README.md#检查点与显式恢复)。

诊断使用 SDK `tasks.diagnose()`。工具页调用 `host.task.diagnose`，范围固定为当前插件。默认仅导出身份、版本、状态、关联与运行时元数据；业务正文、提示词、环境和凭证不进入报告。错误消息与完整本地路径需分别显式开启。


## 对外命令边界

任务、模型、状态与页面是插件内部宿主能力。对外只注册业务所需的命令，例如 `translate start/state/stop`，长任务的进度、取消与恢复也由所属插件按需提供。CLI 使用 `mearl <plugin> <command>`，MCP 使用 `plugin_invoke`，不要求调用者操作宿主任务或理解分块、版本、缓存集合和页面实例协议。通用浏览器动作直接用 `app.invoke()`，不为插件重复包装 tab_list 等无业务含义的命令。命令上下文已经绑定插件与页面身份，直接使用 `context.model/state/page`，无需额外命名空间包装。

后台连续模型调用可以显式传 `conversation`（1–80 个字母、数字或 `:_-`）。同名会话仅在当前页面实例或宿主管理的当前命令执行内复用；插件、版本、模型、指令、环境和调用归属分别隔离。未指定时每次调用独立。页面解除绑定或命令结束会释放会话；取消、失败和超时会销毁当前会话，空闲 5 分钟释放，每 32 轮重新建立临时会话以限制历史增长。会话仅驻留内存，不新增顶层 CLI/MCP 命令。
