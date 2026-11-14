# Mearl 场景：常规网页自动化

普通操作遵循 [核心工作流](./core.md)。本文件用于复杂控件、派发差异、文件操作或增量结果不足以决策的情况。布局、iframe、脚本与视觉验证见[页面排障](./api-page-debugging.md)，设备/App 联动见[环境准备](./api-page-environment.md)。

## 打开与复用页面

`tabId` 标识当前浏览器与传输中的页面，取得后持续复用；控制会话通过 `--session` 固定目标与控制归属，页面动作仍传 `tabId`。`opened` / `reused` 区分新页与既有页，复用页应保留。移动态或 App 态首屏需在新建时设置；这些配置不应用于复用页，已有页使用对应设置 action。

需要激活已有页面时，对同 URL 使用 `reuse: "require", active: true`，避免另外新开页面。激活方式与临时状态恢复见[浏览器控制与人工交接](./api-browser-setup.md#control-sessions)。

## 快照范围与非语义控件

优先 viewport、局部根节点或 query，避免长页面完整输出；每次快照后只使用本次返回的新 ref。

快照文本中的 @eN 可直接用于后续操作，内部节点映射只保存在运行时；无名称、无 ref 且无状态的分组会折叠，控件状态与文本内容保留。

AX 空或稀疏时显式使用 dom；interactive 无 AX 控件时只回退到 AX viewport，不会自动切换来源。后台弹层仍在过渡时，等待明确可见条件，或用 full + query 核验结构。

自定义复选框、单选框或开关没有原生/ARIA 语义时，AX 可能只返回相邻文案。以文案 ref 为根，用 dom 和 ancestorDepth 1–3 获取局部容器，从其中浏览器标记的 clickable ref 定位控件，不直接点击静态文案或猜 CSS。用观察、局部快照或 inspect 验证状态。

<a id="observe"></a>

## 动作结果判读

交互 action 默认返回动作与增量观察。`page_eval` 默认裸执行，`run_actions` 的步骤不带内置观察。

`observe: false` 且未开启 diagnostics 时返回裸动作结果，没有 `action` 或 `observation`；开启 diagnostics 时返回 `{ action, diagnostics }`。按实际返回结构判断，不将缺少 `action.success` 当作失败。

- **未派发**：`action.stage: "precondition"` 时按 error 修正输入；过期 ref 重建最小快照。此时没有 observation/diagnostics。
- **确认不确定**：`dispatch-uncertain` 时先看 attempt 中的请求目标、解析目标、命中、坐标、派发模式和输入序列确认状态，再用 observation 或最小快照判断是否已生效，确认未生效后才重试。attempt 本身不证明效果。
- **目标差异**：`resolvedTarget`、`dispatchTarget`、`hitTarget` 只在目标存在有效差异时展开；兼容字段 tag/text 或 strategy/distance 的省略不表示缺少派发。无法确定可点击祖先时，actionableAncestorCandidates 仅供检查，不会自动改点。
- **通知**：effects.notifications 是高置信度通知；transient 表示已出现后消失，只读取文案，不继续点击。
- **控件与焦点**：effects.interactives 和 effects.focus 的 node.ref/selector 可继续操作。recreated 是同一语义控件被框架重建，不是新业务入口；状态未变时不会重复返回 value/checked。
- **普通文本**：effects.texts 按需返回短小可见文本的 selector 和当前 text，例如独立计数或金额；不推断业务含义，也不代表可点击。最多 8 项、每项 160 字符；隐藏、遮挡、复杂结构或超限时仍按快照建议核验。
- **快照建议**：按 fullSnapshotRecommended 和 snapshotReasons 补最小范围内容。已有通知/控件仍可能遗漏未分类结构；changed=true 而 effects 为空只说明没有高置信度信号，不能直接判失败。
- **导航**：mode=navigation 中 loaded 只表示文档完成，ready 才表示可继续。network-idle 表示相关请求静默；content-stable 是长连接情况下按内容与 skeleton/busy 状态判断的就绪兜底。
- **上下文重建**：mode=unavailable 时重新建立快照。delta 的 URL/标题未变化时可省略；同页请求用 network.ready/settledBy/pendingRequests 判断。
- **新页面**：openedTabs 只报告当前目标 Tab 直接打开的页面。ready=true 时直接对其 tabId 建立快照，无需 tab_list。
- **观察稳定**：quiet 已有限等待仍运行的动画；无限动画不阻塞。no-change 不自动要求快照；timeout 结合 snapshotReasons 回退。

DOM 增量覆盖主文档（scope=main-document）；iframe、Shadow DOM、Canvas 或纯视觉变化可能不在覆盖范围。按目标补局部快照，跨域 iframe 或视觉任务用截图。

## page_click

文本多匹配时按候选 role/name 缩小范围或取 ref；原生 select 可按 option 文本点击，无需脚本改值。

auto/dom 对原生 option 执行选择并触发 input/change，返回 `selectionState.valueBefore/valueAfter/selectedAfter`。这是事件派发后的即时状态；`selectedAfter` 为 false 表示选项未保持选中（例如页面处理器恢复了旧值），先检查页面再决定下一步。后续异步变化仍需按业务状态核验。禁用的 select、option、optgroup 不会被强行选择。自定义 ARIA option 仍走普通点击。

selector/ref 目标被嵌套容器裁剪时会先滚入可见区；仍裁剪或被弹层覆盖则返回前置条件错误。用 page_inspect 的 hitTest.occludedBy 确认遮挡。派发前的命中检查允许目标自己的祖先/后代。

auto 在可见页按设备使用可信 mouse/touch，在隐藏页回退 DOM；响应的 dispatchMode、pointerType、fallbackReason 说明实际路径。显式 touch 要求可见，显式 mouse 会强制尝试可信输入；只有任务明确依赖真实用户手势时才激活。

## page_drag

起点自动滚入视口，但终点需同时可见；否则先滚动。坐标适合 Canvas 或组件内手势，ref 适合可见元素拖放。DOM 回退属于不可信事件；页面拒绝不可信事件时再接管为可见页可信输入。

## page_type

填写表单后根据 observation 检查目标值及联动控件；不要仅以输入成功判断表单已提交。

## page_hover

hover 展开菜单后需根据内容选择下一步时逐步执行；目标已确定且紧接点击时可用 run_actions。

## page_press

先确认焦点；隐藏页 DOM 输入只实现部分默认行为，依赖编辑、选择、方向键或页面滚动时用可见页 keyboard。用 defaultAction 判断是否模拟了所需语义。

原生 alert/confirm/prompt/beforeunload 会阻塞页面 JS。内置扩展与 CDP 路径通过 `page_snapshot` 返回 `dialog.id/type/message/defaultPrompt`，不运行 DOM 快照；中断回执中的弹窗文本有长度上限，完整读取时按需提高快照 `maxChars`。确认含义后用现有按键接口显式处理：

```bash
mearl page_press --payload '{"tabId":12345,"dialogId":"<dialog.id>","key":"Escape"}'
mearl page_press --payload '{"tabId":12345,"dialogId":"<dialog.id>","key":"Enter","promptText":"仅用于 prompt"}'
```

普通 Enter 不处理原生弹窗；过期 ID 会拒绝，不自动接受或重试。该分支返回裸按键结果 `dispatchMode:"native-dialog"`，不进入 DOM 观察。处理后重新读页面：页面中已派发的 JS 可能继续执行，工具不会回放旧动作。动作已确认成功、仅后续观察被弹窗打断时，保留 `action.success:true` 并附带 `dialog`；没有确认回执时按 `dispatch-uncertain` 核验业务状态。

只能读取监测连接收到的弹窗事件。首次附加前已打开、由其他调试连接持有的弹窗可能阻塞 Chrome 的 Page.enable；此时有界超时并提示人工关闭后重试，不猜测弹窗内容或盲目接受。弹窗文本存储上限 65536 字符，超出时返回 `truncated:true`。

接受 prompt 时省略 `promptText` 会保留预填默认值，显式传 `""` 才清空；默认值超出存储上限时必须显式指定 `promptText`，避免提交被截断的值。

## page_scroll

用 moved、atTop/atBottom 判断是否移动或到达边界；自动发现内部容器时复用 containerSelector。ref 指向子节点时可使用 nearest 找可滚动祖先。需要读取滚动后的新视口时补 viewport 快照。

## page_wait

没有前置动作，或 observation 表明仍需等待且已有明确条件时再调用；以 selector/text/condition 表达业务就绪，固定时间只用于任务本身要求经过一段时间的情况。

服务端渲染页面的节点出现不等于客户端已可交互；需要时等待已确认的业务就绪信号（例如倒计时开始更新），避免输入被后续初始化覆盖。

等待结束后需要立即点击已确认目标时，在同一次 `mearl run` 中 await 等待并紧接点击，不把两个动作拆到不同模型轮次：

```bash
mearl run --session '<sessionId>' --timeout 240 <<'JS'
const tabId = 12345;
const ready = await mearl.pageWait({
  tabId,
  condition: '!!document.querySelector("form button[type=submit]:not(:disabled)")',
  timeout: 200000,
  interval: 100,
});
if (!ready.waited) throw new Error('Target did not become ready');
console.log(await mearl.pageClick({ tabId, selector: 'form button[type=submit]:not(:disabled)' }));
JS
```

整体 `--timeout` 要覆盖等待时限及后续动作；条件等待最多 300000ms。这会省去模型往返，但两次动作仍有传输与派发延迟，不保证原子执行。点击后检查动作结果与业务确认状态；失败或派发不确定时不要自动重放整段脚本。

## page_navigate

在同一 tabId 中导航、刷新或前进/后退，完成后建立新快照。

<a id="file-operations"></a>

## page_upload

找到 input[type=file] 后直接上传，隐藏节点也可用。文件来源按以下方式指定：

- 调用方文件：`files:[{filePath:"/absolute/path"}]`，自动中转到浏览器宿主。
- 浏览器产物：`files:[{artifactId}]`，使用 `page_download` 返回的产物；会话产物继续使用所属会话。
- 浏览器或 Provider 宿主文件：`filePaths:["/absolute/path"]`，路径属于执行上传的宿主；外部平台的文件中转按 Provider 帮助执行。

`files` 与 `filePaths` 互斥。确认页面显示附件或上传成功的业务状态；外部 Provider 的文件能力按其当前帮助执行。

通过 Chrome 扩展连接时，`files` 支持 HTTP(S) 页面的文件输入框，分块传输合计最多 256 MiB，无需开启「允许访问文件网址」。`filePaths` 由 Chrome 直接读取宿主文件，适用于大文件或要求原生文件选择事件的站点，在扩展连接中需要开启该设置。直连 CDP 的上传无需此扩展设置。

## page_download

先监听下载，再执行 `trigger` 点击并等待下载完成。`trigger` 使用不含 `tabId` 的 `page_click` 参数；目标页面由顶层 `tabId` 指定。

`--output <绝对路径>` 将文件保存到调用方；省略时返回 `download.artifactId`，文件保留在浏览器宿主，可用于后续 `page_upload`。扩展无法通过 referrer 确认下载来源时，传入已知 `url`。下载超时或归属不确定时，先检查浏览器下载状态，再决定后续操作，避免重复点击。

## 文件产物与传输

文件中转的单文件上限为 256 MiB。Extension/CDP 支持上传与下载；外部 Provider 按 `capabilities.actions` 声明的 `page_upload`、`page_download` 使用对应能力。无会话产物空闲一小时回收，会话产物默认随 `session_manage --session <sessionId> --payload '{"operation":"end"}'` 清理，需要保留时传 `keepArtifactIds`。宿主退出清理暂存文件，保存到调用方的结果文件保留。

## run_actions

仅批量执行无需中间判断的紧密序列。失败时只检查已完成步骤与 failedStep；后续步骤未执行，不能将部分成功当作整个任务完成。

连续填写等已知步骤可在同一次 `mearl run` 中使用 `observe:false`，最后检查提交前的表单状态或结果页；需要根据中间结果选目标时保留逐步观察。快照 `query` 必须是对象，例如 `{"query":{"text":"提交","exact":false}}`；切换标签用 `tab_open` 的 `reuse:"require",active:true`，刷新用 `page_navigate` 的 `refresh:true`，原生选项用 `page_click` 的 `role:"option"`。
