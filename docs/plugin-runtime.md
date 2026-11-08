# 插件运行时合同

[简体中文](plugin-runtime.md) | [English](plugin-runtime.en.md)

插件运行时提供命令执行、任务恢复、页面实例和持久状态服务。CLI、SDK、MCP 与工具箱通过同一宿主合同访问这些服务。

## 检查点与显式恢复

命令入口可声明 `taskRecovery` 并注册同名 `app.recoveryCommand()`，后者只在宿主创建的恢复 attempt 中执行，不通过公开命令、工具箱白名单或嵌套调用开放。

```javascript
export const taskRecovery = { version: 1, commands: {
  work: { checkpointVersion: 1, schema: { type: 'object', properties: {
    operationId: { type: 'string' },
  }, required: ['operationId'], additionalProperties: false } },
} };
export default app => {
  app.command('work', async (input, context) => {
    const operationId = await createIdempotentOperation(input);
    await context.checkpoint({ operationId }, 0);
    return waitForOperation(operationId);
  });
  app.recoveryCommand('work', async (input, context) => {
    const { operationId } = context.recovery.checkpoint.data;
    return reconcileOrWaitForOperation(operationId);
  });
};
```

`context.checkpoint(data, expectedSequence)` 仅在 service 路由、未绑定页面实例的活动受管理公开命令中可用；子任务可记录检查点，显式恢复仍只接受合格根任务。负载最多 64 KiB，插件按声明 schema 验证负载，宿主分配递增检查点序号。数据、版本、宿主计算的 canonical schemaHash、任务快照和 checkpoint 事件写入同一个原子任务记录；并发过期写入明确冲突。检查点不是外部操作的完成证明，与插件 state 事务也不共享提交。外部提交与检查点之间的故障窗口由恢复入口查询操作状态或使用稳定幂等键处理。

SDK 使用 `PluginTaskClient.checkpoint(taskId)` / `resume(taskId, { environment?, revision? })`。resume 只接受失败、取消或中断的根命令，创建新的 taskId 和执行代次，记录 `resumedFrom`，原任务保持终态；相同来源任务只有一个直接后继，重复请求返回已有 attempt，配置不同则冲突。继续恢复失败的新 attempt 时，对新 taskId 调用 resume。

恢复默认 `revision: 'original'`，沿用原安装、代码快照、输入、cwd、路由和执行期限。接受前重新验证安装归属与全部源码 hash，拒绝快照缺失或损坏，不回退到当前代码。原环境不落盘，SDK 默认显式提交调用进程的当前环境，也可传 environment；不使用服务的环境替代。`context.recovery` 包含 fromTaskId、fromRevision、原始 sourceCheckpoint 格式引用和已接受的 checkpoint。新 attempt 继承数据但自己的 checkpoint 序号从 0 开始；resumedFrom 保存原 revision/version/sequence。隐藏恢复入口接收原输入，不要求其满足新版本 CLI 的必填参数，由恢复 handler 处理历史输入。

显式 `resume(taskId, { revision: 'current' })`在首个请求进入时固定当前注册代码快照。同格式版本且 canonical schema 相同时直接接受；同版本修改 schema 拒绝，必须提升 checkpointVersion。跨格式版本只支持目标声明的单步迁移：

```javascript
export const taskRecovery = { version: 1, commands: {
  work: { checkpointVersion: 2, schema: currentSchema,
    migrateFrom: [{ version: 1, schema: historicalSchema }] },
} };
export default app => {
  app.command('work', runWork);
  app.checkpointMigration('work', ({ checkpoint, fromRevision, toRevision }) => {
    return { operationId: checkpoint.data.id };
  });
  app.recoveryCommand('work', recoverWork);
};
```

migrateFrom 最多 16 个不同的旧版本（均低于目标版本），历史 schema 必须与检查点写入时记录的宿主 hash 及保留代码声明一致。即使源码没变，依赖环境等动态声明发生格式漂移也拒绝恢复。迁移和恢复进程调用隐藏 handler 前再次比较目标声明签名，普通 checkpoint 写入也校验执行端声明；Python 每次 run 的 ready ACK 前核对完整加载元数据。迁移返回新检查点的数据，插件验证其符合目标 schema；宿主校验 JSON 和 64 KiB 限制，再将新数据及来源元信息原子写入唯一后继任务；旧任务和检查点不变。没有迁移声明、格式不匹配、转换失败或清理未确认均不接纳新任务。

同一源任务的并发恢复按 revision 选择与环境指纹合并，不同意图冲突；已提交后继的重试先核验请求指纹，不重复转换。迁移在独立受管理进程执行，10 秒期限，与声明解析共享最多 8 个进程预算，无等待队列，服务关闭会取消并等待清理。转换和原执行树均确认停止，且安装和双端代码快照再次核验后才接纳新任务。迁移没有宿主 API、模型、state、页面或嵌套插件调用权限；JS/Python 仍是可信本机代码，具备直接文件和网络访问能力，不构成 OS 沙箱。迁移必须是可重复的纯 JSON 转换：提交前崩溃可能再次执行，不承诺转换恰好执行一次。

当前恢复限于 public 入口、由 service 持有稳定路由的根命令。工具箱/Native Host caller 路由、页面绑定、模型和子任务明确拒绝恢复；它们的生命周期不能从旧任务推断。接纳前递归核验原任务与所有子孙的监督进程、OS 创建身份及 POSIX 进程组，任何执行未停止或清理未确认都拒绝；未确认的所有权记录不因保留期到期而删除。Windows 服务崩溃后缺少完整进程树停止证明时同样拒绝。模型可由恢复入口显式重新请求，它属于新的执行。

## 页面运行时和事件

插件可将自己生成的 HTML 预览写入 `~/.mearl/plugin-previews/<plugin>/`，通过 `pageRuntime.matches` 声明本地文件范围，并绑定主 frame。激活规则必须使用确切的 `file://` 文件地址，查询参数和片段用于运行页配置。宿主核对文件位于该插件的预览目录中并拒绝符号链接。扩展模式还需要启用用户脚本和本地文件访问权限。

页面实例绑定插件 revision、浏览器来源、标签页、frame、文档和实例 ID。业务 frame 选择器用于 attach 时解析，实例随后固定目标；业务 WebView 切换产生旧实例失效和新实例建立。扩展使用原生 documentId；纯 CDP 使用默认执行上下文的 uniqueId 标识文档，隔离世界执行插件代码，通过受校验的 CDP binding 传递事件，支持跨域 iframe。旧版 Chromium 未提供 uniqueId 时使用当前连接生成的文档身份，重连后旧实例失效并由激活规则重建。外部 Provider 须声明 `page_runtime` 能力，未声明时明确失败。

`browser-core` 的 `PluginPageRuntimeHost` 共用实例生命周期、事件确认与重传、激活规则、租约和分块传输，扩展和 CDP 仅实现文档解析、脚本执行、端口与存储适配。CDP 会话存储按浏览器端点身份隔离，宿主重启保留会话身份，浏览器重启清除会话规则并保留持久规则；端点地址仅存储其摘要。CDP 沿用浏览器连接的权限范围，插件声明的 URL 匹配范围仍由公共宿主检查。

CDP 会话层按浏览器端点身份保存 target 与虚拟 tabId 的映射，连接时先恢复映射，再开始页面发现和插件对账。页面存储按 storage key 独立落盘，租约更新只写租约记录；文档解析同时返回所属 target，执行操作只等待该 target。

native-host 被清理或连接短暂中断时，文档实例在最后一次成功校验后的 30 秒租约内保留归属；无法确认文档的操作返回 `PLUGIN_PAGE_UNAVAILABLE`，不执行页面操作，也不把失败的对账响应当成实例缺失。重连后须校验原浏览器、文档和实例身份。已接收但尚未启动任务的事件可以继续排队；已发出的操作不自动重放。明确的导航、卸载、文档失效仍立即清理；长时间失联导致租约到期后清理旧实例，启用的激活规则可在宿主恢复时建立新实例。

CDP 页面会话文件在同一连接标识切换浏览器身份、受控浏览器明确关闭或确认进程已退出时回收，持久激活规则保留。
缺少可验证浏览器归属的旧会话文件保留到完整卸载；`cdp-targets` 的标签 ID 递增计数跨浏览器生命周期保留，避免旧请求误操作新标签。
受控浏览器日志在启动前按 5 MiB 轮转，保留一份备份；无对应浏览器记录的日志保留 7 天，在宿主启动、浏览器查询或启动时清理。

宿主提供 `attach/get/list/send/detach`，独立于 toolbox 声明。工具页关闭只退订 UI；文档刷新按策略重建，SPA 导航通知实例，插件停用时解除事件并清理资源。出队、关键宿主调用和回写前都校验实例有效性。

事件绑定属于运行时声明，指定事件、负载结构、命令和串行、待处理合并或有限并发策略。宿主校验真实来源，控制负载和队列上限。事件按实例及连接代次编号：接收确认与业务完成分开，重发去重与业务重试分开。缓存缺口要求重同步；文档失效后废弃旧事件。不承诺跨故障恰好执行一次。

当前页面实例按插件安装与真实目标文档共享，CLI、工具箱和自动激活的并发 attach 等待同一次初始化；工具箱只能访问自己的插件。`pageRuntime` 独立于工具箱声明，JS 入口导出函数源码与 URL 范围，`app.runtimeCommand()` 注册后台初始化和事件处理器；这些命令不能被公开命令或工具箱命令直接调用。注册代码也在受管理子进程中读取，阻塞注册可终止。

Python 入口也可导出同结构的 `pageRuntime` 字典，`code` 为网页端 JavaScript 函数字符串；`app.runtimeCommand()` 支持直接注册和装饰器。Python 的 `app.page()` 及实例绑定的 `context.page.send/get` 通过同步桥接调用同一页面服务。runtime-only 标记参与描述元数据校验与实际 Python handler 选择，公开命令和工具箱不能直接执行；普通 `app.command` 若同时用于页面事件，则继续保持公开身份。每次 Python run 的 ready ACK 之前核验完整 descriptor，包括页面声明和命令可见性。

```javascript
export const pageRuntime = {
  version: 1,
  matches: ['https://example.com/*'],
  initialize: 'initialize',
  code: `host => ({
    receive(message) { return { title: document.title }; },
    dispose() { /* release listeners and DOM owned by this instance */ },
  })`,
  events: { changed: { command: 'save', policy: 'latest',
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } },
};
export default app => {
  app.runtimeCommand('initialize', (input, context) => context.page.send({ type: 'initialize' }));
  app.runtimeCommand('save', ({ event }, context) => save(event.payload));
  app.command('open', input => app.page('attach', { tabId: input.tabId, frame: 'business' }));
};
```

页面函数的 `host.emit(name, payload)` 返回接收确认；处理结果通过实例事件查询。`context.page.send/get` 始终绑定当前实例，运行时任务的普通页面动作和复合页面入口被拒绝。每次出队、宿主调用和提交结果都重新检查文档。运行时传输保留控制会话归属、暂停与释放检查，并行处理消息和回调；消息顺序由实例与事件策略负责，等待业务消息不会阻塞同文档的校验或取消。页面 `receive(message, { signal, requestId })` 提供每条消息的协作取消信号；任务取消传播到该文档对应请求，插件异步等待后应检查 signal。取消不强制终止页面 JS，已提交的外部操作仍需核对。后台默认每 10 秒并发续租，每实例校验超时 8 秒，浏览器租约 30 秒；续租只更新内存，独立定时器每 5 秒批量保存轻量租约，完整运行时代码与待确认事件只在对应状态变化时持久化。失效时取消排队和运行任务并释放页面资源。

事件负载最多 32 KiB，页面待确认队列 64 条；后台每事件默认待处理 32 条（最多 64），每实例活动事件最多 128，有限并发最多 8。历史最多 256 条及 384 KiB，游标缺口明确返回。Native Messaging 的请求与结果各按 192 KiB 分块并校验 SHA-256，单条页面业务消息/结果最多 24 MiB；浏览器与工具箱回复资源各有 32 MiB 总预算及 30 秒过期。

SDK 使用 `PluginPageClient`。工具箱调用 `host.page.*`，或 `window.mearl.subscribe('page', { instanceId, cursor? }, listener)` 观察后台事件；`events` 接受 `cursor` 与 `waitMs`（0–25000），无新事件时可等待变化；工具箱订阅先读取快照，随后使用长轮询，退订只结束观察。内部 `page_runtime` 是文档适配协议，业务插件使用 `app.page()`。保存事件由执行服务处理，无需 Popup 转发。

激活通过 `app.page('activation', { enabled: true, matches, persistence: 'session' | 'persistent', frame, input })` 显式配置；实际范围是用户规则与声明范围的交集；自动激活实例在注入、SPA 导航及日常校验时复查该交集，离开范围即失效，手动挂载遵循插件声明范围。关闭规则清理实例，在途挂载由规则代次校验阻止。扩展 worker 重启后先与执行服务握手，核验 hostId、service epoch、安装、revision、browserSessionId、documentId 和 instanceId；同一所有者按服务端已接收位置续传未确认事件，确认位置只前进。连接 epoch 变化不改变业务事件序号。桥接暂时不可用时保留队列等待对账，租约过期后失效。

独立修改匹配范围时，可传 `enabled: true, matchPatch: { add?: string[], remove?: string[] }`，与 `matches` 互斥。宿主原子增删范围，避免并发调用覆盖其他范围；删除最后一个范围会关闭自动激活，保留手动挂载的页面实例。`persistence: 'persistent'` 在浏览器重启后保留，初始化 handler 可读取最新插件偏好，不必将易变配置复制到规则 input。

执行服务 epoch 变化、实例消失或接收位置回退时，旧实例和队列失效，不向新服务重放旧事件。已有激活规则可以创建新实例，手动实例需重新 attach；规则绑定安装 ID，插件卸载或换源后同名新安装不会继承授权。新注入在独立脚本世界内串行交接，等待旧 handler 完成 dispose，再建立新实例，避免旧覆盖层清理影响新 DOM。

## 状态和激活

插件导出 `stateStorage = { version: 1, collections: { ... } }`，每个集合声明 `scope`（installation/host/browser-session/instance）、`storage`（persistent/cache/memory）、`schemaVersion`、JSON Schema 和可选 `maxEntries/maxBytes/ttlMs`。浏览器会话与实例只接受 cache/memory；memory 只允许这两种作用域，并且只驻留插件执行宿主内存，按需分配，全宿主合计上限 128 MiB / 512 个集合命名空间，宿主重启清空；实例结束释放对应内存。浏览器会话在文档刷新时保留，新的浏览器会话使用独立空间。所有页面作用域都由真实活动页面解析，不能用业务字段伪造。实例结束清理专属缓存；其他缓存默认 TTL 一天，最多七天，读取、定时维护和配额检查会回收过期值。持久配置、缓存、任务记录和二进制资产分别管理。

同一命名空间已有状态时，memory 与磁盘存储之间切换须使用新的集合名或作用域；不支持跨存储介质迁移。

`get/list/transact` 在用户级任务服务串行处理，集合的值、CAS 版本、schema 版本、TTL 与最近 64 次幂等回执一起写入单个原子记录。每个 put/delete 必须携带读取获得的 opaque `expectedVersion`；集合版本单调递增，删除和过期不会重用版本。多键事务最多 128 项、512 KiB，单值最多 256 KiB，默认每集合 1024 项/8 MiB，磁盘状态每插件总量 64 MiB；memory 按前述全宿主上限管理。list 返回有界分页，调用方带 `expectedRevision` 检测翻页期间的变动。

变更 schema 或存储类型需要提升 `schemaVersion`。迁移事务明确带 `migrateFromVersion` 与 `expectedRevision`，插件验证全部保留值符合新 schema 后提交迁移事务，宿主检查 JSON、大小、版本及事务约束后原子提交；旧 revision 禁止回写新 schema。同步 handler 也校验加载时的声明签名，避免代码更新期间误写。更换安装不会继承旧安装命名空间。

命令使用 `app.state(collection, operation, input)`，或通过自动绑定当前页面实例的 `context.state(...)` 调用。SDK `PluginStateClient` 与工具箱 `host.state.*` 使用同一服务。素材和设置可使用 browser-session memory，并通过有界分块读写。用户显式导出的图片不属于缓存。

插件声明可用 URL 范围与激活入口，用户规则决定是否启用、匹配范围和跨重启保留。激活维护页面实例，业务命令由显式调用或事件触发。扩展、浏览器和执行服务分别重启时，通过握手对账实例及任务，防止重复恢复。
