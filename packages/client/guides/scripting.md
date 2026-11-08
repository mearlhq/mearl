# Mearl 场景：代码组合

目标和后续动作已确定时，优先用 `mearl run` 合并连续调用，尤其是等待就绪后立即点击，避免模型往返错过短暂可操作窗口。需要条件、循环、过滤或组合已注册 Skill 命令时也用此入口。运行时已注入 `mearl` SDK，无需安装依赖：

```bash
mearl run --session '<sessionId>' <<'JS'
const result = await mearl.invoke('get_requests', { tabId: 12345, count: 20 });
console.log(result);
// Skill 的 command/input 以其帮助为准：
// const data = await mearl.invokePlugin('插件名', { command: '命令名', input: {} });
JS
```

等待后立即操作的示例及超时设置见[常规网页自动化](./api-page-automation.md#page_wait)。等待条件和点击目标须已从页面确认；等待失败就停止，不继续点击。

- 浏览器 API 可用 `mearl.pageClick({ tabId, selector })` 等 SDK 方法，或沿用 action 名称的 `mearl.invoke(action, payload, options?)`；Skill 命令用 `mearl.invokePlugin(name, { command, input }, options?)`。参数和返回值与普通调用一致，仍检查 `action.success`、派发状态与业务效果。
- 方法、参数或结果不明确时，输出 `console.log(await mearl.help('pageClick'))`；它与 `mearl page_click --help` 共用帮助，`help()` 列出方法和已注册插件。插件用 `help({ plugin: '插件名', command: '命令名' })`。动态结果可输出 `mearl.structure(result)` 查看字段与类型；它只检查已取得的值，默认取有限深度、字段和数组样本，标注截断与循环引用，不代表完整契约。无需为理解结构重跑业务命令。
- `--browser` / `--session` 等路由参数由所有调用继承。`--session new` 时先 await 建立会话的浏览器调用，再执行插件或并发调用；随后自动复用返回的 ID，可读 `mearl.session`。每轮新建 Node 进程，JS 变量不保留，后续继续传同一 `sessionId` 和 `tabId`。
- 脚本拥有当前宿主的 Node 权限，继承工作目录和环境；使用 `await import()` 加载模块。DOM 代码放入 `mearl.pageEval`，浏览器动作优先使用结构化 API。stdout 只打印必要结果；未知页面需要模型理解时，输出最小观察后在下一轮决策，不预写未知 ref。
- `--file <path>` 可读取脚本文件，内容同样支持顶层 await 和动态 import。`--timeout <seconds>` 是整个脚本时限，默认 60 秒；源码最多 1 MiB，输出最多 256 KiB。await 所有 SDK 调用，失败不自动重试。超时或取消后查看 `pendingActions` / `mayHaveLateEffects`，先核验已派发操作；不要重放整段脚本。
- MCP 使用对应的 `browser_run_code` 工具。脚本适合代码可判断的流程，`run_actions` 保留给无需中间判断的紧密序列；需要模型理解或视觉判断时逐步操作。
