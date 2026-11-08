# 浏览器后台能力

[简体中文](browser-services.md) | [English](browser-services.en.md)

能力包可以通过 `contributions.browserRuntimes.extension` 声明浏览器后台处理器，资源仍使用现有 bundle 的摘要、配额和离线存储。它与 `pageRuntimes` 分工不同：页面运行时提供首屏同步桥，后台能力为界面提供异步操作。两者均可在安装完成后脱离 Native Host 工作。

操作和公共登录声明放在 `contributions.extension` 引用的 JSON 中，格式为 `{ schemaVersion: 1, operations?, logins? }`；下文的 `extension.operations/logins` 指宿主合并后的展示结构。Preset 的 `defaults.extension` 提供配置默认值。完整合同与示例见 [能力包模型](capability-model.md)。

```json
{
  "appProfiles": [],
  "browserRuntimes": {
    "extension": {
      "entry": "runtime.cjs",
      "bindings": { "request.apiSchema": "apiSchema" }
    }
  }
}
```

入口是自包含的 CommonJS 资源，导出 `factory(host, config)`，返回自有函数表。处理器名称必须与声明一致；不提供 Node、任意模块导入或扩展 API。工厂初始化只创建处理器，浏览器操作应放在处理器中。

配置驱动的界面操作在接受时读取一次已校验安装快照，配置、服务默认值和处理器选择共用这份快照；用户显式开关仍实时读取，网络与 Cookie 操作仍检查当前域名授权和 Chrome 权限。安装时检查全部界面贡献，读取请求详情配置时只选择其自身贡献。

`prepareBrowserBundleSnapshot` 选择指定浏览器宿主的模块、配置与绑定，核对资源摘要并拒绝重复 hook；Node 声明不参与此选择。调用接受时捕获代码和输入，更新不会改变正在执行的操作。工厂实例属于单次调用，界面控制器管理草稿与缓存。

Popup 启动时，界面设置响应同时携带当前已安装浏览器 App 模拟的展示信息，快捷设置首次展开即可展示端模拟选择。完整目录仍在展开菜单后查询，不因打开 Popup 提前唤醒 Native Host；目录失败时保留已安装条目，切换 preset 后丢弃旧目录响应，启用状态仍实时读取。

`buildBrowserCapabilityPage` 生成供扩展自带 sandbox 页加载的文档，代码不在 Service Worker 求值。文档阻止直接网络访问，通过私有 MessageChannel 请求宿主的 `request` 和 `cookie`。宿主必须核对活动调用、发送者、当前域名授权及 Chrome 权限，接管临时请求头与 Cookie，并在结束时清理。扩展宿主为初始化设置 30 秒期限、普通调用设置 120 秒期限，沙箱启动超过 15 秒报错；期限到达后关闭 frame/port，释放调用并中止未结束的网络请求。请求默认停在首次重定向，响应以 `redirected: true` 报告遇到跳转，业务模块据此保留原登录提示。需要沿用页面 fetch 行为的操作可以显式选择 `redirect: 'follow'`，其后续目标同样受授权约束。

安装宿主应先校验整组绑定和候选工厂，再激活。`BrowserBundleStore.install` 的第三参数、`activatePreset` 的第五参数可接受校验时的完整 `revisions` 集合；IndexedDB 提交时再次比较集合，避免不同 ID 的并发安装绕过 hook 冲突检查。工厂失败、确认失败或集合变化保留原选择。状态查询只校验资源与绑定，不运行工厂。

`request({ withCookies: true })` 复用宿主 Cookie 收集；请求还需原来源/CSRF 头时，显式设置 `withSourceHeaders: true`。扩展宿主复用原 DNR 来源策略生成 Origin、Referer，以及所收集 Cookie 中存在的 XSRF 头，按完整 URL 匹配域名与路径，收集普通 Cookie 及目标站点的一方分区 Cookie；保留同名 Cookie，并按路径长度降序发送。`withXsrf: false` 可保留来源/Cookie 头而省略自动 XSRF。显式 `injectedHeaders` 按名称忽略大小写覆盖对应默认头；未选择来源策略的请求继续使用其已声明的头。

`request` 的 `formBody` 接受字符串键值，由宿主构建 multipart FormData 并生成 boundary；与原始 `body` 互斥。能力模块无需在 sandbox 中构造或传输浏览器对象，表单字段名、空值和 Unicode 原样保留。

`cookieHeaders` 在 `withCookies: true` 时将非空 Cookie 映射到请求头，例如 `{ "x-csrf-token": "csrfToken" }`；Cookie 与派生头来自同一次宿主收集，避免读取之间更新造成不匹配。显式 `injectedHeaders` 优先于映射。

`request` 默认使用 `credentials: 'omit'`；原操作依赖浏览器默认凭据策略时，可显式声明 `credentials: 'same-origin'`。目标仍须通过同一权限检查。

`request` 响应的 `headers` 使用小写名称，供能力按 Content-Type 等标准 HTTP 字段处理响应。`cookie({ withRelatedCookies: true })` 使用与请求相同的 URL 匹配和分区选择；未选择时保留指定 URL 的原 Cookie 查询。

`request({ cache: 'no-store' })` 保留原目录请求的禁用缓存语义，普通请求与跟随重定向的请求均应用。未指定时沿用浏览器默认策略。

界面单次操作通过独立 runtime port 持有调用；取消、文档退出或 worker 断连会中止网络请求、销毁沙箱并释放租约。offscreen 在 worker 确认拥有者连接后才创建 iframe，准备阶段的取消不会迟到创建沙箱。已存在的长期视图与抓包控制器继续使用各自生命周期。

## Skill 目录

`extension.operations['skills.catalog']` 可声明同名浏览器 hook。它接受 `describe`、`search`、`markdown` 三种操作；描述返回 `available`、`managerId`、`title`、`homeUrl`，搜索返回原界面使用的技能元数据以及 `pageUrl`，可选 `installSource` 指定明确的安装来源。目录本身不执行安装，也不需要 Native Host。

界面捕获描述返回的提供者 revision，后续搜索和预览固定该实现与配置。只有未声明目录或描述显式返回 `available: false` 时使用公共目录；已选择目录的鉴权、网络、协议或资源错误直接显示，不切换来源。预设更新取消旧目录请求、保留搜索词和安装范围，已安装技能的本地详情继续显示。

公共默认目录离线提供随发行物打包的 Mearl Skills；社区搜索使用 Skills 官方目录，预览读取 GitHub 的确切文件 blob。唯一同名目录先验证 frontmatter，其他情况限制候选扫描并拒绝歧义；限流与读取失败保留打开原页面的入口。

扩展已接入请求元数据界面、服务开关、加载与错误处理入口，按安装定义显示对应贡献位置，后台业务由能力包提供。安装视图与宿主共用安装状态。

## 原位请求详情贡献

`contributions.requestUi` 引用同包内最多 64 KiB 的 JSON 资源。`selectBrowserRequestUi` 纯校验当前图、拒绝多提供者，并要求详情及可选保存 hook 属于同包的浏览器后台声明。资源描述固定的请求链接、详情切换按钮/两行内容、服务开关和登录弹窗位置；现有宿主继续渲染组件、管理草稿、缓存和交互，不解释任意页面布局。

定义包含 `schemaVersion: 1`、`service`、`setting`、`apiLink`、`login`、`details`。文案使用 `{ en, zh_CN? }`；`browserUiText` 选择翻译，`browserRequestUiLink` 按声明的固定参数和 API/版本参数生成链接，`browserRequestLoginError` 判断原登录错误片段。链接只接受不带凭据和 fragment 的 HTTPS 或回环 HTTP。`validateBrowserRequestDetail` 校验处理器返回的显示文本、跳转链接和可选负责人信息；平台响应到展示值的转换由业务包负责。

可选 `save: { hook, setting }` 让现有内联保存控件调用同包业务处理器。`setting` 遵循服务开关键约束；宿主逐调用检查所选 revision 和该开关，已选择处理器失败不能静默转向其他实现。宿主可以保留原按钮、搜索下拉、Portal、焦点与反馈，平台查询和保存参数由业务包处理。跨提供者更新时，每个可选目标应保留其来源身份，防止旧查询结果交给新提供者保存。扩展的内联保存入口仅在当前贡献声明 `save` 时显示，未安装对应能力时隐藏。

宿主激活前应校验自身保留设置键，避免占用其他服务或核心设置。调用必须绑定接受的 bundle/revision；切换提供者时失效旧请求，旧错误不能触发新提供者的登录。安装变更事件在异步校验期间到达时应补读一次，避免渲染长期停留在旧定义。

扩展宿主沿用原服务设置槽和布局。登录打开前先建立文档生命周期连接，接受后固定该次定义；后台记录接受的 origin，同 origin 多文档共享规则。关闭、文档退出和提交期间退出均清理本人记录，最后一份记录释放规则；显式释放不依赖权限服务重新可用。后台重启时界面重连同一记录，已打开的登录定义不随包更新替换。上述生命周期属于宿主私有 UI 通信，不增加公开 Agent/MCP 工具。

## 视图的流连接

`contributions.browserViews.captureLauncher` 是原抓包启动窗口的位置，和 `requestImport`、`requestCases` 独立选择、校验冲突。窗口可以仅提供 UI，使用空的 `actions`；它不因此取得其他包的后台处理器。宿主通过上下文和有限回调共享当前抓包会话、身份与用户选择，保持控制器对代理和清理操作的所有权。窗口和会话执行器独立加载，关闭启动窗口可以继续抓包。

`BrowserViewDefinition.transports` 可声明命名连接，例如 `{ "events": { "kind": "eventSource", "setting": "captureEnabled" } }`；`kind` 只接受 `websocket` 或 `eventSource`。声明最多 16 项，每项绑定已有服务开关。视图通过私有 bridge 的 `transport.open({ id, name, url })`、`transport.close({ id })` 操作连接，通过 `onEvent` 接收 `source: 'transport'` 的事件；事件包含连接 ID、类型和 readyState，消息保留 data、origin、lastEventId，WebSocket 关闭保留 code、reason、wasClean。当前合同支持原抓包控制器使用的打开、默认消息、错误和关闭，不提供发送或具名 SSE 订阅。

浏览器宿主必须使用已接受声明解析连接类型，每次打开检查服务开关、当前域名选择和 Chrome 主机权限。`browserTransportUrl` 校验 URL，WebSocket 使用对应 HTTP(S) URL 检查主机权限；`browserTransportPolicies` 生成两个独立的 CSP connect-src 策略，分别限制用户选择与 Chrome 授权。扩展宿主在专用扩展 iframe 中先应用两个策略，再创建原生连接；动态视图本身仍不能直接联网。浏览器 EventSource 保留重连、Last-Event-ID 和授权范围内的重定向行为，WebSocket 保留浏览器自身的重定向限制。

普通界面的连接属于当前打开视图；常驻控制器的连接属于其拥有者文档。对应生命周期结束、服务/域名设置变更或 Chrome 权限移除都会释放连接，未完成授权不能迟到重建；同 ID 的旧异步结果不能关闭新连接。后台 worker 重启不销毁仍存活的视图连接。此实现无需 Native Host。视图与控制器通过声明的连接类型使用该通道。

CSP 的 HTTP 来源也允许升级到 HTTPS。为避免 SSE 重定向超出 Chrome 授权，策略仅在同主机范围同时具有 HTTP 和 HTTPS 授权时开放 HTTP；只有 HTTP 的独立授权会拒绝连接。现有宿主通常使用 `*://host/*` 成对授权。宿主若采用其他授权模型，必须保留同样的重定向约束，不能仅校验初始 URL。

登录仍由扩展文档呈现。视图组件的登录弹窗位于变换包含块内时，内部视图适配器传递有限的矩形位置，宿主校验当前视口范围后复现相同包含块；尺寸变化及窗口动画结束时重新测量。准备登录期间保留最新矩形，关闭后释放观察器和登录租约。没有包含块的登录继续使用整个视口，外层宿主弹窗可以暂时接管 Esc，避免穿透到其后的动态窗口。

## 抓包会话执行器

`contributions.browserViews.captureController` 是独立的抓包会话位置，沿用同包 actions、preferences 和 transports 校验。代码仍在无直接网络权限的 opaque iframe 执行。`window.mearlView.handle(method, handler)` 注册宿主可调用的命令，返回释放该注册的函数；异步返回值和错误沿原私有 MessagePort 返回。重复注册被拒绝，旧释放函数不能移除后来注册的处理器。该通道不增加 Chrome API、Agent 或 MCP 工具。

扩展宿主在 offscreen 文档中运行已接受的执行器，固定其 HTML、后台代码和声明。普通命令停止接受后，等待在途命令，再调用并等待 `dispose`，之后释放 iframe 和接受记录；代理申请、规则写入和清理不会随启动窗口关闭而丢失。同文档的下一会话先等待上一会话完成清理，再查询或申请代理。worker 重启通过文档身份和持久接受记录恢复鉴权，offscreen 自身的所有者连接也能在 UI 关闭后唤醒后台完成清理。

浏览器后台只转发已声明的后台操作、偏好和受授权的原生连接，offscreen 文档只使用 runtime 消息。SSO、单次后台工厂及常驻会话共享 offscreen 租约，worker 局部计数不能销毁其他存活任务。提供者卸载后，已接受的清理代码仍可完成该会话；清理专用处理器应限制为释放和删除，不借此绕过普通操作的服务开关。控制器成功接受后才固定候选版本；接受前版本变化可刷新重试。

启动窗口、请求列表和详情由浏览器宿主呈现；处理器通过能力包声明，使用请求转换、响应修改和采集 hook。浏览器执行通道可独立于 Native Host 运行。


## 可复用的纯计算沙箱

`buildBrowserPureCapabilityPage` 使用资源摘要、UTF-8、声明和配置校验，只把代码、处理器声明和配置写入文档。调用参数通过独立 MessagePort 投递，不写入可复用 HTML。工厂初始化一次，调用按编号对应结果；这一模式的 `request`、`cookie` 总是失败，CSP 也禁止联网。

扩展集成使用内容及配置摘要选择实例，每个实例最多 64 个在途调用，启动 15 秒或调用 10 秒超时会释放实例并拒绝在途工作。最多保留 16 个实例，只淘汰空闲实例；60 秒没有调用后释放 iframe 和 offscreen 租约。后台 worker 重新接受相同代码时可以复用仍存活的实例；实例已回收时仅重建一次，仍使用原先接受的字节。纯计算实例不会取得普通后台工厂的网络或 Cookie 权限；宿主确需读取 Cookie 时，应先检查 URL 权限，再显式传递必要数据。




## 跟踪解析的接入

`tracking.decode` 接收按顺序排列的请求输入：`url`、可选 `body`、`options: { now, sequence }` 和 `locale`，每行返回 `{ tracking, events }`。某行不能解析时返回该行的 `error`，其他行仍返回自己的结果；工厂、运行时或结果结构故障作为整个调用失败报告。`tracking.spm` 仅用于缺少位置元数据的历史事件。解析器可随事件提供 `point: { mainSpm, highlightSpm }`，详情页直接使用该次接受的解析结果，同时保留原始事件字段。

扩展在接受请求时固定实现和输入。同一轮请求合并为最多 32 行、16 MiB 的批次；单行仍受运行时输入配额限制。批次串行使用纯计算实例，避免每条请求新建沙箱。安装变更使新请求重新选择实现，已接受请求和缺少 body 时的补查保留原代码。

后台采集先分配序号，再异步解析并按接受顺序提交；游标停在尚未提交请求之前，查询只等待当前队列快照。停止、清空或切换采集来源会使旧结果失效。格式错误写入诊断日志并记录事件缺口；整个模块故障还会记录请求缺口。HTTP 和日志历史仍可读取，事件查询明确报告模块故障，后续成功解析可以恢复当前会话。




## 页面查询与同步链接

页面原本使用自动重定向的查询可通过 `request({ redirect: 'follow' })` 保留原生 fetch 的凭据、状态、响应头、POST 重定向语义和 JSON 结果。扩展复用已有连接页，在每次请求的独立 frame 中应用两份 connect-src 策略，分别限制 Agent 域名选择和 Chrome 主机授权；初始地址仍须通过后台授权。HTTP 来源沿用既有传输策略，只有相应 HTTP/HTTPS 范围同时获准时才开放 HTTP，避免 CSP 的自动 HTTPS 升级超出主机授权。默认 `manual` 的业务操作保持原登录判断。

执行前先建立后台调用者的 port 并完成离屏握手，只有仍有所有者的请求才能创建 frame。取消、撤权、后台退出或期限到达会中止 fetch 并释放 frame、port 和离屏租约。跟随模式返回最终响应；`redirected` 表示浏览器实际发生过重定向，调用方可以按最终状态和正文处理结果。

`defaults.extension.linkTemplates` 提供固定目的地的命名链接，例如 `trace: { template, title: { en, zh_CN? } }`。变量仅允许出现在 query 或 fragment 中，按数据逐项编码，不能替换 origin 或路径。trace 位置接受 `traceId`、`startTime`、`endTime`；模板和本地数据足够同步完成点击，不在点击后等待插件网络结果。没有目的地时保留原始 ID。

元数据查询调用已安装操作，处理器定义参数和结果。结果按接受的能力快照缓存，查询参数或能力选择改变时丢弃过期响应。`identity.panel` 提供界面身份；`capture.identity` 接受 `source: "full"` 请求完整资料。`extension.logins.capture` 配置登录入口，`CAPTURE_LOGIN_REQUIRED` 表示需要登录。

身份结果为 `{ subject: string, displayName?: string, complete: boolean, ...claims }`。`subject` 用于登录判断，`displayName` 用于显示，`complete` 表示资料是否完整。宿主原样传递其他 claims，在保存前请求补全不完整资料。

元数据组件提交查询值，由处理器解析身份。身份缓存和在途请求按 Preset 会话隔离；切换时丢弃旧结果和文档广播。登录窗口使用租约协调生命周期；已接受的嵌入界面保持到窗口关闭，下一次打开采用当前会话。



账号徽章沿用登录弹窗、借号、列表刷新和移动端二维码。通用宿主只消费 `accounts` 操作；账号平台的路径、身份字段、分页、借号参数、票据策略、登录页面识别和二维码备用地址由能力包提供。`extension.logins.accounts` 提供登录和门户地址，打开与关闭复用文档所有的登录租约。

`extension.operations.accounts` 绑定账号处理器，接受 `list`、`borrow`、`sso`、`qr`、`normalize`、`current` 和 `loginContext`。列表返回 `accountList`、`totalNum`、`pagedNum`；账号记录使用 `id`、`principalId`、`loginId`、`site` 和可选 `ownerName`／`status`。`qr` 返回 `{ url, alternateUrl? }`。`loginContext` 返回 `{ supported, selector?, redirectUrl? }`，宿主保留原倒计时、取消与回跳。

`extension.operations.accountIdentity` 独立绑定身份读取，返回 `{ value, watch: [{ name, domain }] }`，供当前身份标记和 Cookie 变更监听使用。宿主将账号记录与身份缓存绑定到实际执行的 bundle/revision；同一 bundle 更新时，由新版本的 `normalize` 固定新 revision 重新校验缓存，票据等业务操作仍严格固定接受时的 revision。切换 preset 后丢弃旧请求结果，归属验证失败时隐藏记录并保留原缓存。`normalize` 可接收 `legacyIdentity`，仅在能力包识别其原始记录归属后返回额外 `identity`，用于首次恢复旧缓存。平台字段识别与兼容规则不放在公共宿主。

首次确认空身份或 `ACCOUNT_LOGIN_REQUIRED` 后，同步失效本地名称快照与后台的名称恢复资格，后续打开 Popup 不再闪现旧名称。上次账号标识仍保留给自动登录使用，重新确认有效身份后才恢复名称缓存；网络错误和不完整的身份响应不当作退出登录。身份探测按存储作用域核对请求先后次序，迟到的旧结果不能恢复已失效的显示状态。

日志分享按钮通过 `logs.share` 操作获取 HTTPS 链接。处理器定义查询参数和结果；宿主验证链接后提供复制操作，失败时显示错误并保留操作入口。

`links.manual`、`links.agentDocs` 和 `links.skillSetup` 配置帮助入口；未配置时使用仓库文档。登录提示使用已校验 URL 的 hostname 作为翻译替换参数。Skill 安装提示使用标准 `skills` CLI。

服务开关为 `accountsEnabled`、`requestCasesEnabled`、`requestMetadataEnabled`、`requestImportEnabled` 和 `trackingMetadataEnabled`。默认值来自已安装能力配置，通过 session 中的 `{ services }` 快照通知界面；用户偏好优先。偏好修改与默认值刷新共用串行队列。请求元数据处理器的自定义设置键通过同一入口写入，提交时核对当前选择。

账号登录策略由 `accounts` 操作的 `sso` 命令提供。宿主验证返回的 HTTPS 目的地、域名授权和 Chrome 权限，再通过文档拥有的 iframe 执行。Preset 的权限声明覆盖操作涉及的来源和目的地。

环境切换通过 bundle 的 `contributions.browserControls` 引用经过完整性校验的本地 JSON 资源。资源定义一个 `schemaVersion: 1`、`kind: "segmented"` 的原生快捷控件：`id`、中英文 `label` / `description`、`defaultValue`、`messages.changed` / `messages.failed` 及 `options`。每个选项包含 `value`、`label` 和 `networkRoutes: { routes: [{ id?: "api", fromHost: "api.example.test", toHost: "qa.example.test" }] }`，默认选项必须清空路由。选项名称、网关和业务文案由 capability 提供；同一 preset 图只能有一个提供者。

宿主校验精确 DNS 名、重复来源、资源和规则大小，并检查目标域名权限。选择操作绑定控件所属包及其 revision，规则与已接受的完整计划按 tab 保存，写入失败时回滚。document_start 的 MAIN 改写和后续 iframe CORS 使用同一份快照；preset 更新或 worker 重启不会重新解释当前选择，再次选择同一选项则接受新计划。菜单位置、尺寸、fetch / XHR / JSONP 拦截和手动刷新生效的交互保持一致，无需 native-host。移除提供者后仍可清除已接受的规则。

能力包提供上述标准资源时显示环境控件。

`browserControls` 与通用抓包身份字段属于 3.x 开发期的配套协议，SDK、扩展和 capability 使用对应的 3.x 构建产物联调。

iframe 的 origin 上报只扩充已接受配置。运行中文档固定其接受的映射；重新点击同目标按钮接受当前配置，并提示刷新。会话规则在 worker 重启后保留，写入失败恢复完整旧规则。CORS 目的地从已接受配置中按授权范围扩充。

`extension.accountState` 可声明 `{ cacheKey, identityKey }`，供能力包沿用已有账号缓存。两键必须共享命名空间，分别为 `<namespace>-accounts-cache` 和 `<namespace>-last-<field>-id`；宿主拒绝其他设置键与跨命名空间组合。未配置时使用公共默认键。能力更新或切换存储键时，界面会重新读取对应缓存，读取完成前不展示或写入另一键的数据。

抓包控制器通过 `state.channels` 声明当前实现的通道，各项包含 `label`、`supportsModify`、`connection`、`overrides` 和可选 `onlineMocks`。通道 ID 为最多 64 字符的小写字母、数字与连字符；宿主不枚举平台名称。每个通道的命令使用 `<id>.setOverride`、`removeOverride`、`removeAllOverrides`、`reconnect`、`disconnect`，在线 Mock 可提供 `refreshOnlineMocks` 与 `cleanOnlineMock`。`prepareOverride` 在导入修改前执行能力专属校验；失败保留用户原先的修改开关。控制器仍同时维护各通道，页面按接受的通道订阅请求。无已选通道或旧选择不可用时，使用控制器返回的第一项并保存选择。

`extension.captureState.namespace` 为现有抓包开关、请求子模式和列表宽度指定统一存储前缀；只能组合宿主固定的角色后缀，不能读取任意其他设置。未配置时使用默认前缀。代理选择与连接生命周期通过通用抓包代理上下文传递；`logins.captureProxy` 提供代理平台登录地址与标题。

请求用例、请求导入、元数据和热力图使用通用入口；服务名称、按钮与提示可由 `extension.messages` 覆盖。热力图操作绑定为 `tracking.heatmap`。保存请求读取用例视图的应用选择时，只接受与当前元数据提供者相同 bundle/revision、明确声明为 local 的 `appKey` 偏好；session 偏好不从 Chrome local 读取。普通偏好使用包与 slot 命名空间，共享编辑器偏好使用有限的 `shared` 合同。
