import { BROWSER_DEVICE_PRESET_NAMES, type BrowserCommandAction } from '@mearl/browser-core';

const DEVICE_PRESET_TYPE = BROWSER_DEVICE_PRESET_NAMES.map(name => JSON.stringify(name)).join(
  ' | ',
);

export interface ParamDef {
  name: string;
  type: string;
  required?: boolean;
  description: string;
  /** 复杂字段的结构与组合约束，仅在 action help 展示。 */
  details?: readonly string[];
}

export interface CommandDef {
  name: BrowserCommandAction;
  description: string;
  /** 顶层命令列表使用的简短描述；完整说明保留在 action help。 */
  summary?: string;
  /** CLI 中用于推荐 canonical action 的常见表达，不会作为可执行 action。 */
  aliases?: readonly string[];
  /** 仅用于错误建议；按表达给出 canonical action 的适用示例，不增加可执行别名。 */
  aliasExamples?: Readonly<Record<string, string>>;
  /** payload 字段说明 */
  params?: ParamDef[];
  /** 是否支持 --output */
  outputFlag?: boolean;
  examples?: string[];
  notes?: readonly string[];
  result?: readonly string[];
}

const PAGE_DIAGNOSTICS_PARAM: ParamDef = {
  name: 'diagnostics',
  type: 'object | boolean',
  description:
    '默认关闭；传 true 返回动作期间新增的 error logs/业务 requests，或传对象自定义通道与过滤',
  details: [
    'logs: boolean | { level, limit, filter }；true 默认采集 error 日志',
    'requests: boolean | { count, filter, source, includeBody, includeHeaders, maxBodySize, fields, keysOnly }',
    'events: boolean | { source, event_type, filter, limit, includeRaw }；埋点需显式开启',
    '各通道过滤字段同 get_logs / get_requests / get_events；observe=false 时仍返回诊断增量，但不等待 DOM/导航稳定',
  ],
};

const PAGE_OBSERVE_PARAM: ParamDef = {
  name: 'observe',
  type: 'object | false',
  description: '默认开启 DOM/导航观察；传 false 关闭，不影响显式请求的 diagnostics',
  details: [
    'quietMs: number，DOM 变化后的稳定窗口，默认 100ms',
    'firstChangeTimeoutMs: number，无 DOM 变化时的观察窗口，默认 500ms',
    'timeoutMs: number，DOM 观察阶段最大时间，默认 3000ms',
    'navigationGraceMs: number，低信息量点击/按键的导航宽限，默认 1000ms；相关网络活动可延长宽限',
    'navigationTimeoutMs: number，导航就绪最大等待时间，默认 15000ms',
    'networkIdleMs: number，文档完成且相关请求归零后的静默时间，默认 500ms',
    'contentReadyAfterMs: number，结构稳定兜底保护期，默认 min(5000, navigationTimeoutMs / 2)，并限制在导航超时前',
  ],
};

const PAGE_ACTION_RESULT = [
  '默认返回 { action, observation }；action.success 只表示动作成功，业务效果需结合 observation 和目标状态判断。',
  'observe=false 且未开启 diagnostics 时返回裸动作结果（如 { clicked: true }），没有 action/observation；开启 diagnostics 时返回 { action, diagnostics }。',
  '包装结果中的 action.stage=precondition 表示未派发，省略 observation/diagnostics；dispatch-uncertain 表示可能已派发，先查看 action.attempt 与可用观察或最小快照核验，避免重复提交。CLI 单次调用失败以退出码 1 结束；脚本需检查 action.success。',
  'observation.effects 返回通知、控件和焦点增量，可直接复用 node.ref/selector；changed=true 且 effects 为空不表示失败。',
  'effects.texts 按需返回普通可见文本的 selector/text，不代表可点击控件或业务成功；超限或覆盖不完整时仍提示补快照。',
  'fullSnapshotRecommended/snapshotReasons 提示是否补充快照；openedTabs 返回可继续操作的 tabId 和 ready。navigation 模式的 ready 表示新页面就绪。',
  '显式开启的诊断通道在 diagnostics 中返回动作期间增量，与 observe 独立。',
] as const;

export const COMMANDS = [
  {
    name: 'get_capabilities',
    description:
      '只读查询当前目标浏览器的动作、设备和已安装 App 能力、限制与 Skill/帮助入口；不打开页面或启用模拟',
    params: [
      {
        name: 'app',
        type: 'string',
        description: '可选，使用目录中的完整 App ID 查询桥方法、可调设置和默认版本详情',
      },
    ],
    notes: [
      '沿用 --browser / --session 路由；不传 app 返回摘要。apps.status=partial 表示目录未完整取得，unsupported 表示目标未提供目录；不能把两者当作未安装。',
      'available=false 的 App 当前不可启用；支持某个 action 不代表已有域名权限或真实设备授权。按需读取 usage.skills / usage.documentation，查询不会自动安装或加载 Skill。',
    ],
    examples: ['get_capabilities', `get_capabilities --payload '{"app":"example/app"}'`],
  },
  {
    name: 'browser_control',
    description: '交接或恢复浏览器控制；外部 Provider 也可结束任务',
    params: [
      {
        name: 'operation',
        type: '"handoff" | "resume" | "finish"',
        required: true,
        description: '交给用户操作；resume 仅在用户明确交还后使用',
      },
      { name: 'tabId', type: 'number', description: '可选的目标页面' },
      { name: 'reason', type: 'string', description: '用户需要处理的事项' },
      {
        name: 'keepTabIds',
        type: 'number[]',
        description: '外部 Provider finish 时保留的结果页；默认不保留任务页面',
      },
    ],
    notes: [
      '统一使用 --browser 选择目标。普通浏览器自动选择唯一的控制会话；多个会话时用 tabId 或 --session 明确任务。外部 Provider 由宿主管理任务，不传 --session。finish 仅用于支持它的外部 Provider。仅在用户明确交还后 resume；已经发出的操作可能仍然生效。',
    ],
  },
  {
    name: 'page_download',
    description: '先监听再点击，等待下载完成并创建浏览器文件产物',
    outputFlag: true,
    params: [
      { name: 'tabId', type: 'number', required: true, description: '下载来源页面' },
      {
        name: 'trigger',
        type: 'object',
        required: true,
        description: 'page_click 参数，不含 tabId',
      },
      {
        name: 'url',
        type: 'string',
        description: '预期下载 URL；扩展无法通过 referrer 归属时需显式指定',
      },
      {
        name: 'timeout',
        type: 'number',
        description: '下载等待毫秒，默认 30000，范围 1000–300000',
      },
    ],
    notes: [
      '--output 把文件分块保存到调用方机器；未指定时返回 artifactId，可供 page_upload 复用。',
      '共享 CDP 浏览器保持原下载目录；Chrome 未返回文件路径时明确报错。超时不能直接重复点击。',
    ],
  },
  // ── API 调试 ──────────────────────────────────────────────────────────────
  {
    name: 'tab_checkpoint',
    description: '为目标标签页建立日志、请求和埋点增量边界',
    params: [
      {
        name: 'tabId',
        type: 'number',
        required: true,
        description: '目标标签页 ID，从 tab_open 获取',
      },
    ],
    examples: [`tab_checkpoint --payload '{"tabId":12345}'`],
  },
  {
    name: 'get_requests',
    description: '获取最近的网络请求（协议请求或普通 xhr/fetch）',
    params: [
      {
        name: 'tabId',
        type: 'number',
        required: true,
        description: '目标标签页 ID，从 tab_list 获取',
      },
      { name: 'count', type: 'number', description: '返回条数，默认 10' },
      {
        name: 'source',
        type: '"protocol" | "requests" | "all"',
        description: '数据来源，不填时默认 all；all 返回全部业务请求',
      },
      { name: 'filter', type: 'string', description: '按 URL 或 API 名称过滤，支持正则' },
      { name: 'since', type: 'number', description: '只返回最近 N 秒内的请求' },
      {
        name: 'after',
        type: 'string',
        description: '只返回指定 tab checkpoint 或同类查询 cursor 之后的请求',
      },
      {
        name: 'includeBody',
        type: 'boolean',
        description: '是否包含请求/响应体；指定 fields 时默认 false，否则默认 true',
      },
      { name: 'includeHeaders', type: 'boolean', description: '是否包含请求/响应头，默认 false' },
      { name: 'maxBodySize', type: 'number', description: '单个请求/响应体最大字符数，默认 50000' },
      { name: 'fields', type: 'string[]', description: '从响应体提取指定字段路径，最多 100 个' },
      { name: 'keysOnly', type: 'boolean', description: '只返回数据结构，不返回叶子值' },
    ],
    notes: [
      '流式请求开始后即进入缓冲区；页面及 App 桥代发的 协议 SSE 都归入 protocol。无法归属当前页面 target 的 Service Worker 请求不在采集范围内。',
    ],
    result: [
      'nextCursor 用于同类查询续读，hasMore 表示还有数据，gap 表示缓冲区淘汰造成缺口；checkpoint cursor 可分别用于三类查询的初始边界。',
      '省略正文时不返回 postData / responseBody 字段；指定 fields 后需要同时读取全文时显式传 includeBody:true。',
      'isPending 标记未完成请求；SSE 的 responseBody 保存按序到达的 event/data/timestamp/duration 分片。敏感请求头返回脱敏值。',
    ],
    examples: [
      `get_requests --payload '{"tabId":12345,"count":5}'`,
      `get_requests --payload '{"tabId":12345,"source":"protocol","filter":"cart"}'`,
    ],
  },
  {
    name: 'get_logs',
    description: '获取浏览器控制台日志',
    params: [
      {
        name: 'tabId',
        type: 'number',
        required: true,
        description: '目标标签页 ID，从 tab_list 获取',
      },
      { name: 'limit', type: 'number', description: '返回最新 N 条，默认 100' },
      { name: 'level', type: 'string', description: '按日志级别过滤：log/info/warn/error/all' },
      { name: 'filter', type: 'string', description: '按内容过滤，支持正则' },
      { name: 'since', type: 'number', description: '只返回最近 N 秒内的日志' },
      {
        name: 'after',
        type: 'string',
        description: '只返回指定 tab checkpoint 或同类查询 cursor 之后的日志',
      },
    ],
    result: [
      'nextCursor 用于同类查询续读，hasMore 表示还有数据，gap 表示缓冲区淘汰造成缺口；checkpoint cursor 可分别用于三类查询的初始边界。',
    ],
    examples: [`get_logs --payload '{"tabId":12345,"limit":10,"level":"error"}'`],
  },
  {
    name: 'get_events',
    description: '获取 RUM/aplus/ARMS 埋点事件',
    params: [
      {
        name: 'tabId',
        type: 'number',
        required: true,
        description: '目标标签页 ID，从 tab_list 获取',
      },
      {
        name: 'source',
        type: '"rum" | "aplus" | "arms" | "all"',
        description: '数据来源，默认 all',
      },
      { name: 'event_type', type: 'string', description: '按事件类型过滤，支持正则，如 CLK/PV' },
      { name: 'filter', type: 'string', description: '按 name 或 url 过滤，支持正则' },
      { name: 'since', type: 'number', description: '只返回最近 N 秒内的事件' },
      { name: 'after', type: 'string', description: '只返回指定 tab checkpoint 之后的事件' },
      { name: 'limit', type: 'number', description: '返回条数，默认 20' },
      {
        name: 'includeRaw',
        type: 'boolean',
        description: '返回完整 URL、_raw 和 _context；默认 false',
      },
    ],
    notes: [
      'tab_open 新页从首屏采集；既有页面首次查询才启用采集，需要刷新或重新触发埋点。同批事件不会被 limit 拆开。',
    ],
    result: [
      'nextCursor 用于同类查询续读，hasMore 表示还有数据，gap 表示缓冲区淘汰造成缺口；checkpoint cursor 可分别用于三类查询的初始边界。',
      'captureStatus 为 armed/active/inactive；空结果附 hint 时按提示刷新或触发。默认去除 tracking URL query 与 _raw/_context，includeRaw=true 时保留。',
    ],
    examples: [
      `get_events --payload '{"tabId":12345,"source":"aplus","event_type":"CLK","limit":10}'`,
      `get_events --payload '{"tabId":12345,"filter":"order","includeRaw":true,"limit":1}'`,
      `get_events --payload '{"tabId":12345,"source":"all","limit":20}'`,
    ],
  },
  // ── Mock & 规则 ───────────────────────────────────────────────────────────
  {
    name: 'set_mock',
    description: '设置 API mock 数据',
    params: [
      {
        name: 'tabId',
        type: 'number',
        required: true,
        description: '目标标签页 ID，从 tab_list 获取',
      },
      { name: 'apiName', type: 'string', required: true, description: 'API 名称或正则表达式' },
      { name: 'mockData', type: 'object', description: '完整 mock 响应数据（与 fields 二选一）' },
      {
        name: 'fields',
        type: 'array',
        description: '按字段路径修改真实响应（与 mockData 二选一）',
      },
      {
        name: 'enabled',
        type: 'boolean',
        description: '是否启用，默认 true。false 时恢复真实数据',
      },
      {
        name: 'duration',
        type: 'number',
        description: '完整响应时长（毫秒）：mock 的总耗时，绕过真实服务器精确控制',
      },
      {
        name: 'conditions',
        type: 'object',
        description: '请求 query/body 字段子集匹配；$index 从 0 开始指定调用顺序',
      },
    ],
    notes: [
      '启用时至少提供 mockData 或非空 fields；非空 fields 优先。fields 每项 { path: string, value: any }，path 支持点号和数组索引。',
      '相同 apiName 的多条无条件 Mock 会覆盖；conditions 子集匹配 query/body（含 data 内层），不同条件可共存；$index 从 0 起控制调用顺序，不参与字段匹配。',
      '大字段可用顶层 @<绝对路径> 文件引用或 --payload-file；文件展开后仍受 Native Messaging 单条消息大小限制。',
    ],
    examples: [
      `set_mock --payload '{"tabId":12345,"apiName":"cart.query","mockData":{"ret":["SUCCESS::调用成功"]}}'`,
      `set_mock --payload-file ./mock-data.json`,
    ],
  },
  {
    name: 'get_mocks',
    description: '查看当前生效的 mock 列表',
    params: [
      {
        name: 'tabId',
        type: 'number',
        required: true,
        description: '目标标签页 ID，从 tab_list 获取',
      },
      { name: 'apiName', type: 'string', description: '按 API 名称或正则表达式过滤' },
    ],
    examples: [`get_mocks --payload '{"tabId":12345}'`],
  },
  {
    name: 'set_rule',
    description: '添加浏览器请求规则；enabled=false 且传 ruleId 时彻底删除规则',
    params: [
      { name: 'ruleId', type: 'number', description: '删除时必填，从 get_rules 获取' },
      { name: 'enabled', type: 'boolean', description: '省略时添加；false 时按 ruleId 删除' },
      {
        name: 'actionType',
        type: '"redirect" | "block" | "allow" | "upgradeScheme" | "modifyHeaders"',
        description: '添加时必填，规则动作',
      },
      { name: 'filter', type: 'string', description: '添加时必填，URL 过滤表达式' },
      { name: 'redirectUrl', type: 'string', description: 'redirect 动作的目标 URL' },
      {
        name: 'requestHeaders',
        type: 'array',
        description: 'modifyHeaders 动作的请求头修改列表',
        details: [
          '每项 { header: string, operation: "set" | "append" | "remove", value?: string }；set/append 需 value',
        ],
      },
      {
        name: 'responseHeaders',
        type: 'array',
        description: 'modifyHeaders 动作的响应头修改列表',
        details: [
          '每项 { header: string, operation: "set" | "append" | "remove", value?: string }；set/append 需 value',
        ],
      },
      { name: 'initiatorDomains', type: 'string', description: '发起方域名过滤' },
      { name: 'resourceTypes', type: 'string[]', description: '资源类型过滤' },
      { name: 'priority', type: 'number', description: '规则优先级' },
      { name: 'description', type: 'string', description: '规则说明' },
    ],
    notes: [
      '扩展模式规则持久化；CDP 仅支持会话级 modifyHeaders 请求头 set，不支持响应头、initiatorDomains 或其他动作。Provider 是否支持以其能力声明为准。',
      '扩展模式会检查规则请求 URL 和显式来源域名的访问权限；缺失时仍保存规则，返回 warnings 和 missingOrigins，不自动弹窗。可在请求规则页面授权，或按提示调用 request_permission。复杂 URL 表达式无法完整推断域名时会提示手动检查。',
    ],
    examples: [
      `set_rule --payload '{"actionType":"block","filter":"^https://example\\\\.com/ads/.*"}'`,
      `set_rule --payload '{"ruleId":42,"enabled":false}'`,
    ],
  },
  {
    name: 'get_rules',
    description: '查看当前模式的请求规则；扩展模式包含 Options 面板配置的规则',
    examples: ['get_rules'],
  },
  // ── 网络代理 ──────────────────────────────────────────────────────────────
  {
    name: 'send_request',
    description: '发送 HTTP 请求，自动携带浏览器 Cookie，支持 multipart 和原始二进制上传',
    params: [
      { name: 'url', type: 'string', required: true, description: '完整目标 URL' },
      { name: 'method', type: 'string', description: 'HTTP 方法，默认 GET' },
      { name: 'headers', type: 'object', description: '自定义请求头' },
      { name: 'params', type: 'object', description: 'URL 查询参数' },
      { name: 'body', type: 'any', description: '请求体（传对象时自动 JSON 序列化）' },
      {
        name: 'bodyFile',
        type: 'object',
        description:
          '原始二进制请求体：filePath 或 base64 二选一，可选 contentType（默认 application/octet-stream）；与 body/formData/files 互斥',
      },
      {
        name: 'formData',
        type: 'object',
        description: 'multipart 文本字段（值支持 string/number/boolean）',
      },
      {
        name: 'files',
        type: 'SendRequestFile[]',
        description:
          'multipart 文件，最多 20 个、总计不超过 40 MiB；Base64 文件总计不超过 7 MiB。每项传 fieldName 和绝对 filePath，或传 base64 + filename',
        details: [
          'fieldName: string（必填）；filePath: string 与 base64: string 二选一',
          'filename: string，base64 时必填，filePath 时默认文件 basename',
          'contentType: string（可选），默认按文件名推断 MIME，否则 application/octet-stream',
        ],
      },
      { name: 'withCookies', type: 'boolean', description: '是否附加浏览器 Cookie，默认 true' },
      {
        name: 'responseType',
        type: '"json" | "text" | "auto"',
        description: '响应解析方式，默认 auto',
      },
      { name: 'timeout', type: 'number', description: '超时毫秒数，默认 30000' },
    ],
    notes: [
      '需要托管认证的接口使用相应能力插件；不要手工传入其管理的凭据。',
      'body 不能与 formData/files 组合；bodyFile 以原始字节发送，不包 multipart boundary，不能用于 GET/HEAD。',
      'bodyFile.filePath 属于 native-host，最大 40 MiB；base64 解码后最大 7 MiB。multipart 不手工设置 Content-Type，由 Mearl 生成 boundary。',
      'filePath 属于请求执行宿主；无法引用远端路径时用 base64。',
    ],
    result: [
      '返回 status、statusText、headers、body、bodyType、attachedCookieCount；bodyType 为 json/text/base64，二进制 body 需解码后保存。',
    ],
    examples: [
      `send_request --payload '{"url":"https://api.example.com/data","method":"GET"}'`,
      `send_request --payload '{"url":"https://api.example.com/upload","method":"POST","formData":{"folder":"assets"},"files":[{"fieldName":"file","filePath":"/absolute/path/image.png"}]}'`,
      `send_request --payload '{"url":"https://api.example.com/upload","method":"POST","bodyFile":{"filePath":"/absolute/path/image.png","contentType":"image/png"}}'`,
    ],
  },
  // ── 浏览器 ────────────────────────────────────────────────────────────────
  {
    name: 'browser_list',
    description: '列出所有浏览器及其连接状态、类型和 Provider 托管实例信息',
    summary: '列出本地及远端浏览器与连接状态',
    params: [
      {
        name: 'provider',
        type: 'string',
        description: '配合 launchForm，仅查询一个本机已安装 Provider 的启动候选；需 --local',
      },
      {
        name: 'launchForm',
        type: 'object',
        description: '现有动态启动表单请求：{variant?,values:{}}，不创建或接入实例',
      },
    ],
    examples: ['browser_list', 'browser_list --local'],
  },
  {
    name: 'browser_release',
    description:
      '释放当前浏览器的调试控制和会话级临时效果（含设备/时区模拟）；不用于普通任务收尾，Provider 实例的行为以 mearl <providerId> 为准',
    params: [
      {
        name: 'closeCreatedTabs',
        type: 'boolean',
        description: '带 --session 时关闭会话创建的过程页，默认 false',
      },
      {
        name: 'keepTabIds',
        type: 'number[]',
        description: '保留的结果页面；复用的用户页面始终保留',
      },
      {
        name: 'preserveEnvironment',
        type: 'boolean',
        description: '带 --session 时默认 true，保留 Mock 与模拟现场；false 清理这些页面的环境',
      },
      {
        name: 'keepArtifactIds',
        type: 'string[]',
        description: '保留在浏览器宿主的文件产物；其余会话临时文件删除',
      },
    ],
    notes: [
      '带 --session 时可用于任务收尾，只释放该会话；未带会话时保留原浏览器级释放行为，活动会话存在时拒绝全局释放。',
    ],
    summary: '释放浏览器调试控制和会话级临时效果',
    examples: ['browser_release', 'browser_release --browser chrome-a'],
  },
  {
    name: 'browser_launch',
    description: '启动本地 Chrome，或通过已注册 Provider 创建浏览器实例',
    params: [
      {
        name: 'name',
        type: 'string',
        description: '本地实例名称；使用 local Provider 时必填',
      },
      {
        name: 'provider',
        type: 'string',
        description: '运行环境，默认 local；可传 mearl --help 中展示的已注册 Provider ID',
      },
      {
        name: 'providerOptions',
        type: 'Record<string, JSON value>',
        description: '所选 Provider 声明的结构化启动参数；不能与顶层启动字段混用',
      },
      {
        name: 'headless',
        type: 'boolean',
        description: '本地 Provider 是否无头运行，默认 true',
      },
      {
        name: 'userAgentMode',
        type: '"default" | "desktop"',
        description: '本地 UA 模式：default 使用默认 UA；desktop 使用匹配本机版本的 UA',
      },
      {
        name: 'persistent',
        type: 'boolean',
        description: '本地实例关闭后是否保留 Profile，默认 false',
      },
      { name: 'url', type: 'string', description: '登录完成后打开的初始页面' },
      { name: 'executablePath', type: 'string', description: '自定义 Chrome 可执行文件路径' },
      {
        name: 'copyCookieDomains',
        type: 'string[] | string | { presets?: string[]; domains?: string[] }',
        description:
          '从控制浏览器复制 Cookie：可传域名数组、已安装能力提供的范围名，或组合范围与额外域名',
      },
    ],
    examples: [
      `browser_launch --payload '{"provider":"example-device","providerOptions":{}}'`,
      `browser_launch --payload '{"name":"figma","userAgentMode":"desktop","copyCookieDomains":["figma.com"]}'`,
      `browser_launch --payload '{"name":"with-cookies","copyCookieDomains":["example.com","sub.example.org"]}'`,
    ],
  },
  {
    name: 'browser_close',
    description: '关闭指定托管浏览器，并按 Provider 策略保留或清理持久化数据',
    params: [
      {
        name: 'browser',
        type: 'string',
        required: true,
        description: '托管浏览器的 browserId 或名称',
      },
      {
        name: 'deleteProfile',
        type: 'boolean',
        description: '强制删除持久化数据，默认 false',
      },
    ],
    examples: [
      `browser_close --payload '{"browser":"managed:account-a"}'`,
      `browser_close --payload '{"browser":"account-b","deleteProfile":true}'`,
    ],
  },
  // ── 标签页 ────────────────────────────────────────────────────────────────
  {
    name: 'tab_open',
    description: '打开或按 URL 规则复用 Tab，并观察新页面的导航状态',
    aliases: ['tab_new', 'new_tab', 'tab_create', 'create_tab'],
    aliasExamples: {
      tab_activate: `tab_open --payload '{"url":"https://example.com","reuse":"require","active":true}'`,
    },
    params: [
      { name: 'url', type: 'string', required: true, description: '要打开的 URL' },
      {
        name: 'active',
        type: 'boolean',
        description:
          '是否激活目标 Tab，默认 false；扩展免打扰默认开启，使用后台焦点模拟，关闭后才切换前台；响应返回 activation',
      },
      {
        name: 'openerTabId',
        type: 'number',
        description: '来源 Tab ID；用于把目标 Tab 关联到来源侧边栏对话',
      },
      {
        name: 'closeExisting',
        type: 'boolean',
        description: '打开前先关闭 Agent 受控的已有标签页，默认 false',
      },
      {
        name: 'group',
        type: 'string',
        description:
          '把新 Tab 加入指定标题的标签页分组（同名分组存在则加入，否则新建）。仅扩展模式支持',
      },
      {
        name: 'reuse',
        type: '"never" | "prefer" | "require"',
        description: 'never 始终新开；prefer 优先复用；require 只允许复用。默认 never',
      },
      {
        name: 'match',
        type: 'object',
        description:
          '复用匹配规则：urlPattern（支持 *）、ignoreSearch、ignoreHash、onMultiple（error/first）',
      },
      {
        name: 'restoreFocusOnClose',
        type: 'boolean',
        description: '关闭本次新开的 active Tab 后恢复原活动标签页，默认 false',
      },
      {
        name: 'emulation',
        type: 'object',
        description:
          '开 tab 即进入移动端模拟态（首屏即移动态、无需 reload）。字段同 set_device_emulation 去掉 enabled/reload；与 appProfile、deviceShell=true、orientation=landscape、splitScreen=true 组合可首屏进入左右分屏',
      },
      {
        name: 'appProfile',
        type: 'string',
        description:
          '启用已安装的端模拟，ID 与限制见当前动态帮助。需要系统栏时同时传 emulation.deviceShell=true',
      },
      {
        name: 'os',
        type: '"ios" | "android"',
        description: '与 appProfile 配合；容器系统，默认 ios',
      },
      {
        name: 'bridgeConfig',
        type: 'object',
        description:
          '与 appProfile 配合；声明式覆盖桥方法，形如 {methods:{api:{behavior|response|noop,silent?}}}',
      },
    ],
    notes: [
      'emulation / appProfile 只应用到新建 Tab；复用 Tab 要切换状态时用对应设置 action。',
      'closeExisting 不能与复用或 openerTabId 组合；多匹配默认报错，match.onMultiple=first 可显式选择第一个。',
    ],
    result: [
      '返回 tabId、url、title、opened/reused；reused=true 的既有页面应保留。',
      'CDP 新开页返回 navigation.status：ready 表示 DOM 可读，pending 表示尚未收到导航回执，loading 表示文档仍在加载，failed 附带浏览器错误。等待超时后仍可用返回的 tabId 检查页面。',
      'active=true 时 activation 包含 tabActive、windowFocused、windowState、visibilityState；emulation 返回实际生效配置。',
      'capture.cursor 是导航前诊断边界，可分别用于 get_logs/get_requests/get_events 的 after。',
    ],
    examples: [
      `tab_open --payload '{"url":"https://example.com"}'`,
      `tab_open --payload '{"url":"https://example.com/page","reuse":"prefer","match":{"ignoreSearch":true}}'`,
      `tab_open --payload '{"url":"https://m.example.com","emulation":{"preset":"iphone-17-pro"}}'`,
      `tab_open --payload '{"url":"https://example.com/app/home","appProfile":"reader"}'`,
      `tab_open --payload '{"url":"https://example.com/app/home","appProfile":"reader","emulation":{"preset":"ipad-mini-a17-pro","orientation":"landscape","deviceShell":true,"splitScreen":true}}'`,
      `tab_open --payload '{"url":"https://example.com","appProfile":"reader","os":"android"}'`,
      `tab_open --payload '{"url":"https://example.com","group":"验证任务"}'`,
    ],
  },
  {
    name: 'tab_close',
    description: '关闭指定标签页',
    aliases: ['tab_remove', 'remove_tab', 'tab_delete', 'delete_tab'],
    params: [{ name: 'tabId', type: 'number', required: true, description: '要关闭的标签页 ID' }],
    examples: [`tab_close --payload '{"tabId":123}'`],
  },
  {
    name: 'tab_list',
    description: '列出目标浏览器所有窗口中的标签页',
    aliases: ['tabs', 'list_tabs', 'show_tabs'],
    examples: ['tab_list'],
  },
  {
    name: 'tab_group',
    description:
      '把同一窗口中的标签页加入分组，或通过 ungroup 取消分组并保留标签页；仅扩展模式支持',
    params: [
      {
        name: 'tabIds',
        type: 'number[]',
        required: true,
        description: '标签页 ID，分组最多 100 个，取消分组最多 1000 个',
      },
      { name: 'title', type: 'string', required: false, description: '分组标题；取消分组时省略' },
      {
        name: 'ungroup',
        type: 'boolean',
        required: false,
        description: '为 true 时取消分组并保留标签页',
      },
    ],
    examples: [
      `tab_group --payload '{"tabIds":[123,124],"title":"项目文档"}'`,
      `tab_group --payload '{"tabIds":[123,124],"ungroup":true}'`,
    ],
  },
  // ── 页面操作 ──────────────────────────────────────────────────────────────
  {
    name: 'page_click',
    description: '点击页面元素，支持 CSS/@ref、可见文本或视口坐标定位',
    aliasExamples: {
      page_select: `page_click --payload '{"tabId":12345,"text":"选项文案","role":"option"}'`,
    },
    params: [
      {
        name: 'selector',
        type: 'string',
        description:
          '原生 CSS 选择器，或 page_snapshot / 页面动作 observation 返回的 @eN ref（必须带 @ 前缀）。不支持 :has-text/:visible 等 Playwright 私有伪类',
      },
      {
        name: 'text',
        type: 'string',
        description:
          '按可见文本（accessibility name）定位。需要时配合 role/exact 消歧；多匹配会报错并列出候选',
      },
      {
        name: 'point',
        type: '{ x: number; y: number }',
        description:
          '按视口坐标点击（CSS 像素）。手机壳预览默认使用业务视口坐标，其他页面默认使用外层视口坐标',
      },
      {
        name: 'frameId',
        type: 'string',
        description:
          '浏览器扩展后端：显式指定 CSS/text 查询或 active-frame 坐标所属的 frame；省略时容器模式自动使用当前业务 frame',
      },
      {
        name: 'coordinateSpace',
        type: '"outer-viewport" | "active-frame"',
        description:
          '仅配合 point 使用；手机壳预览默认 active-frame，其他页面默认 outer-viewport；扩展后端会换算 iframe 偏移与缩放',
      },
      {
        name: 'role',
        type: 'string',
        description: '配合 text 使用，按 AX role 过滤（如 button、link、heading）',
      },
      {
        name: 'exact',
        type: 'boolean',
        description: '配合 text 使用，默认 true 精确匹配；false 时按子串匹配',
      },
      {
        name: 'scope',
        type: 'string',
        description:
          '配合 text 使用，把文本匹配限制在指定 CSS 元素或 @eN ref 子树内，适合消除重复文案歧义',
      },
      {
        name: 'clickMode',
        type: '"auto" | "dom" | "mouse" | "touch"',
        description:
          '默认 auto：可见页使用匹配设备的可信输入，隐藏页使用 DOM；dom/mouse/touch 可强制指定派发方式',
      },
      PAGE_OBSERVE_PARAM,
      PAGE_DIAGNOSTICS_PARAM,
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    result: PAGE_ACTION_RESULT,
    notes: [
      'selector / text / point 必须且只能提供一个。隐藏页 auto 使用 DOM；只有明确依赖真实用户手势时才激活页面。',
      'auto 对原生 option、checkbox/radio 使用状态感知的 DOM 路径；显式 mouse/touch 保留可信输入。',
      '原生 select 可按 option 文本点击；auto/dom 返回 selectionState.valueBefore/valueAfter/selectedAfter，检查选中状态是否保持。checkbox/radio 返回 controlState.checkedBefore/checkedAfter。',
    ],
    examples: [
      `page_click --payload '{"tabId":12345,"text":"提交"}'`,
      `page_click --payload '{"tabId":12345,"text":"退款明细","role":"button"}'`,
      `page_click --payload '{"tabId":12345,"text":"确定","scope":"@e12"}'`,
      `page_click --payload '{"tabId":12345,"selector":"@e3"}'`,
      `page_click --payload '{"tabId":12345,"selector":".submit-btn"}'`,
      `page_click --payload '{"tabId":12345,"selector":".gesture-btn","clickMode":"touch"}'`,
      `page_click --payload '{"tabId":12345,"point":{"x":336,"y":117}}'`,
      `page_click --payload '{"tabId":12345,"point":{"x":196,"y":240},"coordinateSpace":"active-frame"}'`,
    ],
  },
  {
    name: 'page_drag',
    description: '拖动页面元素或视口坐标，适用于轮播图、滑块和拖放',
    params: [
      {
        name: 'from',
        type: 'string | { x: number; y: number }',
        required: true,
        description: '起点：原生 CSS、@eN ref，或 { x, y } 视口坐标（CSS 像素）',
      },
      {
        name: 'to',
        type: 'string | { x: number; y: number }',
        required: true,
        description: '终点：原生 CSS、@eN ref，或 { x, y } 视口坐标（CSS 像素）',
      },
      {
        name: 'dragMode',
        type: '"auto" | "dom" | "mouse" | "touch"',
        description:
          '默认 auto：可见页使用匹配设备的可信输入，隐藏页使用 DOM；dom/mouse/touch 可强制指定派发方式',
      },
      {
        name: 'durationMs',
        type: 'number',
        description: '拖动持续时间，0–5000ms，默认 400ms；内部自动分段移动',
      },
      PAGE_OBSERVE_PARAM,
      PAGE_DIAGNOSTICS_PARAM,
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    result: PAGE_ACTION_RESULT,
    notes: [
      '起点会自动滚入视口，终点必须同时位于当前视口；否则先滚动页面。隐藏页 auto 使用 DOM，不切换活动页。',
    ],
    examples: [
      `page_drag --payload '{"tabId":12345,"from":{"x":350,"y":80},"to":{"x":80,"y":80}}'`,
      `page_drag --payload '{"tabId":12345,"from":"@e3","to":"#drop-zone","dragMode":"mouse"}'`,
    ],
  },
  {
    name: 'page_type',
    description: '向输入框填写文本，兼容 React 受控组件',
    aliasExamples: {
      page_fill: `page_type --payload '{"tabId":12345,"selector":"@e6","text":"填写内容","clearFirst":true}'`,
    },
    params: [
      {
        name: 'selector',
        type: 'string',
        required: true,
        description:
          '原生 CSS 选择器，或 page_snapshot / 页面动作 observation 返回的 @eN ref（必须带 @ 前缀）',
      },
      { name: 'text', type: 'string', required: true, description: '要填写的文本' },
      { name: 'clearFirst', type: 'boolean', description: '是否先清空原有内容，默认 true' },
      PAGE_OBSERVE_PARAM,
      PAGE_DIAGNOSTICS_PARAM,
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    result: PAGE_ACTION_RESULT,
    examples: [`page_type --payload '{"tabId":12345,"selector":"@e6","text":"搜索关键词"}'`],
  },
  {
    name: 'page_hover',
    description: '将鼠标悬停在页面元素上',
    params: [
      {
        name: 'selector',
        type: 'string',
        required: true,
        description:
          '原生 CSS 选择器，或 page_snapshot / 页面动作 observation 返回的 @eN ref（必须带 @ 前缀）',
      },
      PAGE_OBSERVE_PARAM,
      PAGE_DIAGNOSTICS_PARAM,
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    result: PAGE_ACTION_RESULT,
    examples: [`page_hover --payload '{"tabId":12345,"selector":".nav-menu"}'`],
  },
  {
    name: 'page_scroll',
    description: '滚动页面或指定容器；页面根不可滚动时自动发现活动滚动区',
    params: [
      {
        name: 'direction',
        type: '"up" | "down" | "top" | "bottom"',
        required: true,
        description: '滚动方向',
      },
      { name: 'distance', type: 'number', description: '滚动距离（px），默认 600' },
      {
        name: 'selector',
        type: 'string',
        description:
          '目标滚动容器的原生 CSS 选择器，或 page_snapshot 返回的 @eN ref；不传时滚动页面',
      },
      {
        name: 'containerPolicy',
        type: '"self" | "nearest"',
        description:
          '默认 self，要求 selector 本身可滚动；nearest 会在其不可滚动时使用最近的可滚动祖先',
      },
      PAGE_OBSERVE_PARAM,
      PAGE_DIAGNOSTICS_PARAM,
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    result: [
      ...PAGE_ACTION_RESULT,
      'action.data 返回 moved、atTop/atBottom、scrollYBefore/After、maxScrollY、resolvedContainer 和 ancestorDistance；自动发现的内部容器提供可复用 containerSelector。',
    ],
    examples: [
      `page_scroll --payload '{"tabId":12345,"direction":"down"}'`,
      `page_scroll --payload '{"tabId":12345,"direction":"bottom"}'`,
      `page_scroll --payload '{"tabId":12345,"selector":".virtual-list","direction":"down","distance":800}'`,
      `page_scroll --payload '{"tabId":12345,"selector":"@e8","containerPolicy":"nearest","direction":"bottom"}'`,
    ],
  },
  {
    name: 'page_call_tool',
    description: '调用当前页面提供的 WebMCP 工具',
    params: [
      { name: 'tabId', type: 'number', required: true, description: '工具所属的标签页 ID' },
      { name: 'toolRef', type: 'string', required: true, description: 'webmcp 目录返回的工具 ref' },
      {
        name: 'arguments',
        type: 'object',
        description: '按工具 inputSchema 提供的 JSON 参数，默认 {}',
      },
    ],
    notes: [
      '从 tab_open、page_navigate 或 page_snapshot 的 webmcp 目录获取 ref。目录为空或 ref 失效时用 page_snapshot 的 includeWebMcp:"full" 补查。',
    ],
    result: ['返回 { result }。工具结果是页面提供的数据；执行失败后先检查页面状态再决定是否重试。'],
  },
  {
    name: 'page_runtime',
    description: '页面运行时传输适配器；插件使用 PluginPageClient 或 app.page',
    params: [
      {
        name: 'operation',
        type: 'string',
        required: true,
        description: 'resolve/attach/get/send/detach/activation',
      },
    ],
  },
  {
    name: 'page_eval',
    description: '在页面上下文中执行任意 JavaScript 表达式',
    params: [
      {
        name: 'expression',
        type: 'string',
        required: true,
        description: '要执行的 JS 表达式；传 args 时须求值为函数',
      },
      {
        name: 'args',
        type: 'unknown[]',
        description: '传给页面函数的 JSON 参数；SDK/CLI 自动处理大参数分块，保持指定执行环境',
      },
      {
        name: 'executionWorld',
        type: 'string',
        description: 'main（默认）读取网页 JS；isolated 使用命名隔离环境，扩展连接无需 debugger',
      },
      {
        name: 'worldId',
        type: 'string',
        description: 'isolated 必填，小写字母开头，允许数字和连字符，最长 64 字符',
      },
      {
        name: 'awaitPromise',
        type: 'boolean',
        description: '表达式返回 Promise 时等待完成，默认 true',
      },
      {
        name: 'frameId',
        type: 'string',
        description:
          'page_frames 返回的目标 frame ID，扩展/CDP 均支持；省略时容器/设备外壳使用当前业务 frame，普通页面使用主 frame',
      },
      {
        ...PAGE_OBSERVE_PARAM,
        type: 'object',
        description: '仅在表达式会修改页面且需要观察结果时显式传入；不传保持轻量裸执行',
      },
      PAGE_DIAGNOSTICS_PARAM,
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    notes: ['优先使用结构化 action；仅在其无法表达需求时执行最小范围脚本。'],
    result: [
      '默认返回 { result }；observe 对象启用观察并返回 { action, observation }；仅开启 diagnostics 时返回 { action, diagnostics }。diagnostics=false 不启用包装。失败阶段语义同 page_click。',
    ],
    examples: [`page_eval --payload '{"tabId":12345,"expression":"document.title"}'`],
  },
  {
    name: 'page_inspect',
    description: '查询 DOM 元素的控件状态、数量、边框盒、计算样式、遮挡、溢出和最近滚动容器',
    params: [
      {
        name: 'selector',
        type: 'string',
        description:
          '原生 CSS、page_snapshot 返回的 @eN ref，或 DevTools Elements 当前选区 $0；做全页溢出诊断时可省略',
      },
      {
        name: 'filter',
        type: '"all" | "overflowing" | "horizontal-overflow" | "vertical-overflow" | "scrollable"',
        description: '结果过滤；省略 selector 时必须指定非 all 的过滤条件',
      },
      {
        name: 'styles',
        type: 'string[]',
        description: '要返回的计算样式属性，默认 display/position/box-sizing/overflow-x/overflow-y',
      },
      {
        name: 'maxResults',
        type: 'number',
        description:
          '最多返回的明细数，默认 20，最大 100；未触发 scanTruncated 时 count 为完整命中数',
      },
      {
        name: 'includeOuterHTML',
        type: 'boolean',
        description: '是否返回 outerHTML（最多 3000 字符）；$0 默认 true，其他目标默认 false',
      },
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    result: [
      'matches[] 包含 boundingBox、computedStyle、hitTest、scroll 溢出量及可用的 scrollContainer。receivesPointerEvents=false 时读取 occludedBy。',
      'state 返回原生/ARIA 状态及来源；缺失字段表示未知。',
      '$0 还返回 resolvedSelector、属性、XPath 和可用框架信息。',
    ],
    examples: [
      `page_inspect --payload '{"tabId":12345,"selector":".form-field","styles":["display","width"]}'`,
      `page_inspect --payload '{"tabId":12345,"selector":"@e8"}'`,
      `page_inspect --payload '{"tabId":12345,"selector":"$0"}'`,
      `page_inspect --payload '{"tabId":12345,"filter":"horizontal-overflow"}'`,
      `page_inspect --payload '{"tabId":12345,"filter":"scrollable"}'`,
    ],
  },
  {
    name: 'page_press',
    description: '在页面中按下键盘按键或组合键',
    params: [
      {
        name: 'key',
        type: 'string',
        required: true,
        description: '按键名称：Enter/Tab/Escape/Backspace 等',
      },
      { name: 'modifiers', type: 'string[]', description: '修饰键数组：ctrl/alt/shift/meta/cmd' },
      {
        name: 'dialogId',
        type: 'string',
        description: '原生弹窗回执或 page_snapshot 中的 dialog.id；仅配合 Enter 接受或 Escape 取消',
      },
      {
        name: 'promptText',
        type: 'string',
        description: '仅用于 dialogId + Enter 接受原生 prompt 时填写文本',
      },
      {
        name: 'pressMode',
        type: '"auto" | "dom" | "keyboard"',
        description: '派发模式；auto 默认在隐藏页降级为 DOM 键盘事件',
      },
      PAGE_OBSERVE_PARAM,
      PAGE_DIAGNOSTICS_PARAM,
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    notes: [
      '隐藏页 DOM 模式支持 Tab 焦点移动、原生控件 Enter/Space 激活和输入框 Enter 提交；编辑、选择、方向键和页面滚动等原生行为需可见页与 pressMode=keyboard。',
      '原生 alert/confirm/prompt/beforeunload 弹窗需显式传 dialogId；普通 Enter 不处理弹窗。弹窗处理绕过 DOM 观察，不自动重放被中断的动作；处理后重新读取页面。',
    ],
    result: [
      ...PAGE_ACTION_RESULT,
      'action.data.dispatchMode / fallbackReason / defaultAction 说明实际输入路径。',
    ],
    examples: [`page_press --payload '{"tabId":12345,"key":"Enter"}'`],
  },
  {
    name: 'page_wait',
    description: '等待指定时间、元素状态、可见文本或页面条件成立',
    params: [
      {
        name: 'time',
        type: 'number',
        description: '等待毫秒数（与 selector/text/condition 四选一）',
      },
      {
        name: 'selector',
        type: 'string',
        description: '目标 CSS 选择器（与 time/text/condition 四选一）',
      },
      {
        name: 'state',
        type: '"attached" | "detached" | "visible" | "hidden"',
        description: 'selector 的目标状态，默认 attached',
      },
      { name: 'text', type: 'string', description: '等待页面出现的可见文本' },
      { name: 'exact', type: 'boolean', description: 'text 是否精确匹配，默认 false' },
      {
        name: 'condition',
        type: 'string',
        description: '在页面主上下文轮询的 JS 表达式，返回 truthy 时结束',
      },
      { name: 'timeout', type: 'number', description: '等待超时毫秒数，默认 10000' },
      { name: 'interval', type: 'number', description: '轮询间隔毫秒数，默认 200' },
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    notes: [
      'time / selector / text / condition 必须且只能提供一个；time 范围 0–60000ms。页面交互已有内置观察，仅在需要独立等待条件时使用。',
      '等待后须立即执行已知动作时，用 mearl run 在同一脚本中 await pageWait 后紧接 pageClick，避免模型往返。整体 --timeout 须覆盖等待及后续动作；等待失败不继续点击。',
    ],
    examples: [
      `page_wait --payload '{"tabId":12345,"time":1000}'`,
      `page_wait --payload '{"tabId":12345,"selector":".dialog","state":"visible"}'`,
      `page_wait --payload '{"tabId":12345,"selector":".loading","state":"hidden"}'`,
      `page_wait --payload '{"tabId":12345,"text":"提交成功"}'`,
      `page_wait --payload '{"tabId":12345,"condition":"window.appReady === true","timeout":30000}'`,
    ],
  },
  {
    name: 'page_navigate',
    description: '在当前标签页内导航到 URL、刷新页面，或沿浏览历史后退/前进',
    aliasExamples: {
      page_reload: `page_navigate --payload '{"tabId":12345,"refresh":true}'`,
    },
    params: [
      {
        name: 'url',
        type: 'string',
        description: '要导航到的 URL；与 refresh/history 互斥',
      },
      {
        name: 'refresh',
        type: 'boolean',
        description: '为 true 时直接重新加载当前页面；与 url/history 互斥',
      },
      {
        name: 'history',
        type: '"back" | "forward"',
        description: '沿当前标签页浏览历史后退或前进；与 url/refresh 互斥',
      },
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    notes: ['url / refresh=true / history 必须且只能提供一个。'],
    examples: [
      `page_navigate --payload '{"tabId":12345,"url":"https://example.com/page2"}'`,
      `page_navigate --payload '{"tabId":12345,"refresh":true}'`,
      `page_navigate --payload '{"tabId":12345,"history":"back"}'`,
    ],
  },
  {
    name: 'page_upload',
    description: '向 <input type="file"> 元素上传一个或多个文件',
    params: [
      {
        name: 'files',
        type: 'object[]',
        description: '调用方绝对路径 {filePath} 或浏览器产物 {artifactId}；与 filePaths 二选一',
      },
      {
        name: 'selector',
        type: 'string',
        required: true,
        description:
          '原生 CSS 选择器，或 page_snapshot / 页面动作 observation 返回的 @eN ref（必须带 @ 前缀），必须指向 input[type=file]',
      },
      {
        name: 'filePaths',
        type: 'string[]',
        description: '浏览器宿主上的绝对路径数组；与 files 二选一',
      },
      PAGE_OBSERVE_PARAM,
      PAGE_DIAGNOSTICS_PARAM,
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    result: PAGE_ACTION_RESULT,
    notes: [
      '直接写入 input[type=file]，不依赖 file chooser；隐藏的文件节点也可上传。外部 Provider 的文件中转能力查询 mearl <providerId>。',
    ],
    examples: [
      `page_upload --payload '{"tabId":12345,"selector":"#file-input","filePaths":["/Users/me/photo.jpg"]}'`,
    ],
  },
  // ── 页面感知 ──────────────────────────────────────────────────────────────
  {
    name: 'page_snapshot',
    description: '获取带 @ref 的页面结构快照，默认使用无障碍树，也可显式读取渲染 DOM',
    params: [
      {
        name: 'includeWebMcp',
        type: '"full"',
        description: '显式补查页面 WebMCP 工具目录，返回 webmcp 数组',
      },
      { name: 'depth', type: 'number', description: '树深度，默认 15，复杂页面可调大' },
      {
        name: 'mode',
        type: '"full" | "interactive" | "viewport" | "dom"',
        description:
          '默认 full；interactive/viewport 裁剪 AX 树；AX 信息缺失时可显式使用 dom 读取渲染 DOM',
      },
      {
        name: 'rootSelector',
        type: 'string',
        description: '只获取指定 CSS 元素的局部子树，可与 mode 组合；与 rootRef 互斥',
      },
      {
        name: 'rootRef',
        type: 'string',
        description: '以已有 @eN ref 为根获取局部子树；与 rootSelector 互斥',
      },
      {
        name: 'ancestorDepth',
        type: 'number',
        description: 'rootRef 向上扩展的 DOM 祖先层数，默认 0，最大 20',
      },
      {
        name: 'query',
        type: '{ text?: string; role?: string; exact?: boolean }',
        description: '服务端按 name / role 过滤当前模式的树，只保留命中节点及祖先路径',
      },
      { name: 'maxNodes', type: 'number', description: '最多输出节点数，0 表示不限制' },
      {
        name: 'maxChars',
        type: 'number',
        description: '快照文本最大字符数，默认 60000，超出保留首尾；传 0 不限制',
      },
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    notes: [
      'query.text / query.role 至少提供一个；query.exact 默认 true。每次快照刷新有效 ref 集合。',
      'interactive 无 AX 控件时回退到 viewport，不会自动改用 dom；Canvas 内容需截图。',
    ],
    result: [
      '返回 snapshot、elementCount、outputNodeCount、mode；截断时 truncated=true。',
      'snapshot 中的 @eN 可直接用于操作；内部节点映射仅保存在运行时。无名称、无 ref 且无状态的分组折叠到子节点。',
      'query 返回 matches 与完整 matchCount，matches 最多 100 项，裁剪时 matchesTruncated=true。容器/iframe 的视口裁剪返回 outerViewport、contentViewport 和滚动位置。',
    ],
    examples: [
      `page_snapshot --payload '{"tabId":12345}'`,
      `page_snapshot --payload '{"tabId":1,"mode":"viewport"}'`,
      `page_snapshot --payload '{"tabId":1,"mode":"dom"}'`,
      `page_snapshot --payload '{"tabId":1,"rootSelector":"[role=dialog]"}'`,
      `page_snapshot --payload '{"tabId":1,"rootRef":"@e8","ancestorDepth":1}'`,
      `page_snapshot --payload '{"tabId":1,"query":{"text":"保存","role":"button"}}'`,
    ],
  },
  {
    name: 'page_screenshot',
    description: '获取当前视口或指定元素截图',
    outputFlag: true,
    params: [
      { name: 'selector', type: 'string', description: 'CSS 选择器，提供后只截取该元素区域' },
      { name: 'format', type: '"png" | "jpeg"', description: '图片格式，默认 png' },
      { name: 'quality', type: 'number', description: 'JPEG 压缩质量（0-100），默认 80' },
      {
        name: 'captureMode',
        type: '"cdp" | "visible"',
        description:
          '默认 cdp；visible 使用活动标签页截图，普通网页无需 debugger；设备模拟复用模拟会话并截取业务视口，不支持 selector',
      },
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    notes: [
      '使用 --output <path> 保存图片；省略时 stdout 返回含 base64 data 的 JSON，避免直接将其加载为文本。',
    ],
    result: ['meta 包含 format、width、height、size、url、title；宽高为实际截图的物理像素。'],
    examples: [
      `page_screenshot --payload '{"tabId":12345}' --output ./screenshot.png`,
      `page_screenshot --payload '{"tabId":12345,"selector":".product-card"}' --output ./card.png`,
    ],
  },
  // ── 移动端模拟 ────────────────────────────────────────────────────────────
  {
    name: 'set_device_emulation',
    description:
      '把目标 tab 切换为移动端模拟（视口/DPR/UA/触摸/视觉比例），等价 DevTools 设备工具栏，作用域 per-tab；需保持调试控制才持续生效',
    summary: '设置或清除目标标签页的设备模拟',
    params: [
      { name: 'enabled', type: 'boolean', required: true, description: 'true=启用，false=清除' },
      {
        name: 'preset',
        type: DEVICE_PRESET_TYPE,
        description: '内置设备预设，提供 width/height/DPR/UA 默认值；旧机型 ID 继续兼容',
      },
      { name: 'width', type: 'number', description: '视口宽度（覆盖 preset）' },
      { name: 'height', type: 'number', description: '视口高度（覆盖 preset）' },
      { name: 'deviceScaleFactor', type: 'number', description: 'DPR（覆盖 preset）' },
      {
        name: 'scale',
        type: 'number',
        description: '画面视觉比例，不改变视口尺寸或 DPR；必须为有限正数，默认 1',
      },
      { name: 'mobile', type: 'boolean', description: '是否走移动渲染模式，默认从 preset 推断' },
      { name: 'userAgent', type: 'string', description: '自定义 UA（覆盖 preset）' },
      {
        name: 'orientation',
        type: '"portrait" | "landscape"',
        description: '横竖屏，默认 portrait',
      },
      {
        name: 'touch',
        type: 'boolean',
        description: '是否启用触摸事件，默认从 preset 推断；无 preset 时跟随 mobile',
      },
      {
        name: 'deviceShell',
        type: 'boolean',
        description: '是否使用 iframe WebView 并渲染顶部状态栏与底部操作区，默认 false',
      },
      {
        name: 'splitScreen',
        type: 'boolean',
        description:
          '是否将首页与业务页分置左右 WebView；仅在已启用端模拟、deviceShell=true、横屏时生效，默认 false',
      },
      { name: 'reload', type: 'boolean', description: '启用后是否重载页面，默认 true' },
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    notes: [
      '无 preset 时 width/height 必须成对提供且 userAgent 必填；mobile 默认 true，touch 跟随 mobile。',
      'deviceShell 开启/移除时必须重载；splitScreen 仅在已启用端模拟、deviceShell=true、横屏时生效。',
    ],
    result: [
      '返回实际 viewport（width/height/deviceScaleFactor/scale）、UA、mobile、touch、orientation、deviceShell、splitScreen 和 reloaded；应以响应确认生效状态。',
    ],
    examples: [
      `set_device_emulation --payload '{"tabId":12345,"enabled":true,"preset":"iphone-17-pro"}'`,
      `set_device_emulation --payload '{"tabId":12345,"enabled":true,"preset":"pixel-11","orientation":"landscape"}'`,
      `set_device_emulation --payload '{"tabId":12345,"enabled":true,"preset":"ipad-mini-a17-pro","orientation":"landscape","deviceShell":true,"splitScreen":true}'`,
      `set_device_emulation --payload '{"tabId":12345,"enabled":false}'`,
    ],
  },
  {
    name: 'set_app_profile',
    description:
      '设置目标标签页的端模拟；完整 JSBridge 由能力包提供。可同时设置已安装的网络控件，传 emulation 时联动设备模拟',
    summary: '设置或清除目标标签页的 App 容器模拟',
    params: [
      { name: 'enabled', type: 'boolean', required: true, description: 'true=启用，false=清除' },
      {
        name: 'profile',
        type: 'string',
        description: '已安装的端模拟 ID（enabled=true 时必填）；当前动态帮助直接展示目标浏览器目录',
      },
      { name: 'os', type: '"ios" | "android"', description: '容器系统，默认 ios' },
      {
        name: 'refreshDefinition',
        type: 'boolean',
        description: '立即采用最新端模拟配置，保留用户显式设置',
      },
      {
        name: 'lockDefinition',
        type: 'boolean',
        description: '固定当前定义；默认在下次刷新或文档导航时自动更新',
      },
      { name: 'appVersion', type: 'string', description: '覆盖配置中的默认 App 版本号' },
      {
        name: 'deviceModel',
        type: 'string',
        description: 'Android 机型名（拼入 UA 与 __DEVICE_MODEL__）',
      },
      {
        name: 'bridgeConfig',
        type: 'object',
        description:
          '声明式覆盖桥方法，形如 {methods:{api:{behavior|response|noop,silent?}}}；不执行配置脚本',
      },
      {
        name: 'networkControl',
        type: 'object | null',
        description:
          '可选已安装网络控件 {id,value}；null 清除，省略时保持当前设置。仅作用于目标 tab',
      },
      {
        name: 'emulation',
        type: 'object',
        description:
          '可选设备联动参数，字段同 set_device_emulation 去掉 enabled/reload；字段覆盖端模拟配置推荐的设备，deviceShell 默认 true，横屏时可传 splitScreen=true。省略时不设置或清除设备',
      },
      { name: 'reload', type: 'boolean', description: '应用/清除后是否重载页面，默认 true' },
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
    ],
    notes: [
      '只有用户明确要求 App/客户端/容器/JSBridge 模拟时启用。移动视口或普通 H5 调试使用 set_device_emulation。',
      'emulation={} 使用端模拟配置推荐的设备；enabled=false 时省略 emulation 只清除 App 注入，传 {} 同时清除设备模拟。',
      'bridgeConfig.methods 按方法声明 behavior / response / noop 三选一，可传 silent；只支持受控行为、固定 JSON 回包或成功空实现，不执行配置脚本。',
    ],
    result: [
      '返回 enabled、profile、label、userAgent、os、networkControl、reloaded；联动设备时额外返回实际 emulation。',
    ],
    examples: [
      `set_app_profile --payload '{"tabId":12345,"enabled":true,"profile":"reader"}'`,
      `set_app_profile --payload '{"tabId":12345,"enabled":true,"profile":"reader","networkControl":{"id":"environment","value":"pre"}}'`,
      `set_app_profile --payload '{"tabId":12345,"enabled":false,"networkControl":null}'`,
      `set_app_profile --payload '{"tabId":12345,"enabled":true,"profile":"reader","emulation":{}}'`,
      `set_app_profile --payload '{"tabId":12345,"enabled":true,"profile":"wallet","emulation":{"preset":"pixel-11","deviceShell":true}}'`,
      `set_app_profile --payload '{"tabId":12345,"enabled":true,"profile":"reader","emulation":{"preset":"ipad-mini-a17-pro","orientation":"landscape","deviceShell":true,"splitScreen":true}}'`,
      `set_app_profile --payload '{"tabId":12345,"enabled":false}'`,
      `set_app_profile --payload '{"tabId":12345,"enabled":false,"emulation":{}}'`,
    ],
  },
  {
    name: 'set_timezone',
    description: '覆盖目标 tab 的时区，传空字符串恢复浏览器默认时区',
    params: [
      { name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' },
      {
        name: 'timezone',
        type: 'string',
        required: true,
        description: 'IANA 时区标识（如 Asia/Shanghai）；空字符串表示清除覆盖',
      },
    ],
    examples: [
      `set_timezone --payload '{"tabId":12345,"timezone":"America/New_York"}'`,
      `set_timezone --payload '{"tabId":12345,"timezone":""}'`,
    ],
  },
  {
    name: 'get_cookie',
    description: '从目标浏览器读取一个指定非分区 Cookie；拒绝返回 HttpOnly Cookie',
    params: [
      {
        name: 'tabId',
        type: 'number',
        description: '可选；指定标签页的 Cookie 存储区，省略时使用浏览器默认存储区',
      },
      {
        name: 'name',
        type: 'string',
        required: true,
        description: '要读取的 Cookie 名称；不支持列举全部 Cookie',
      },
      {
        name: 'url',
        type: 'string',
        description: 'Cookie 查询 URL；未传 tabId 时必填，省略时使用指定标签页 URL',
      },
      {
        name: 'domain',
        type: 'string',
        description: '可选精确域过滤，只允许 Cookie 查询 URL 的 host 或其父域',
      },
      { name: 'path', type: 'string', description: '可选精确 path 过滤' },
    ],
    notes: [
      '只读取指定非分区 Cookie，不列举全部、不回退分区 Cookie，拒绝 HttpOnly；禁止读取认证 Token。指定 url 不导航，指定 tabId 仅选择存储区时不启动采集。',
    ],
    result: ['找到时 found=true 并返回 value/domain/path；不存在时 found=false。'],
    examples: [
      `get_cookie --payload '{"tabId":12345,"name":"feature_flag"}'`,
      `get_cookie --payload '{"url":"https://www.shop.com/","name":"account_name"}'`,
      `get_cookie --payload '{"tabId":12345,"name":"feature_channel","domain":"example.com"}'`,
      `get_cookie --payload '{"tabId":12345,"name":"account_name","url":"https://www.shop.com/","domain":"example.com","path":"/"}'`,
    ],
  },
  {
    name: 'set_cookie',
    description: '在目标浏览器设置一个指定非分区 session Cookie，可选刷新指定页面',
    params: [
      {
        name: 'tabId',
        type: 'number',
        description: '可选；指定标签页的 Cookie 存储区，reload=true 时必填',
      },
      {
        name: 'url',
        type: 'string',
        description: 'Cookie 目标 URL；未传 tabId 时必填，省略时使用指定标签页 URL',
      },
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'Cookie 名称',
      },
      {
        name: 'value',
        type: 'string',
        required: true,
        description: 'Cookie 值，可传空字符串；空字符串不会删除 Cookie',
      },
      {
        name: 'domain',
        type: 'string',
        description: 'Cookie 域，默认目标 URL 的 host；只允许目标 host 或其父域',
      },
      { name: 'path', type: 'string', description: 'Cookie path，默认 /' },
      {
        name: 'reload',
        type: 'boolean',
        description: '设置后是否刷新指定 tabId，默认 false；true 时必须传 tabId',
      },
    ],
    notes: ['仅写非分区 session Cookie，不支持删除。reload=true 时校验目标域与刷新页域的授权。'],
    result: ['返回 url/name/domain/path/reloaded，指定标签页时包含 tabId；不回显 Cookie 值。'],
    examples: [
      `set_cookie --payload '{"tabId":12345,"name":"feature_flag","value":"enabled"}'`,
      `set_cookie --payload '{"url":"https://www.shop.com/","name":"feature_flag","value":"enabled"}'`,
      `set_cookie --payload '{"tabId":12345,"name":"feature_channel","value":"3.6.63","domain":"example.com","reload":true}'`,
    ],
  },
  // ── 其他 ──────────────────────────────────────────────────────────────────
  {
    name: 'page_frames',
    description: '获取页面主 frame 与所有 iframe 列表',
    params: [{ name: 'tabId', type: 'number', required: true, description: '目标标签页 ID' }],
    result: [
      'frames[] 包含 frameId、url、name 和 isMainFrame；frameId 可用于 page_eval 等支持 frame 定位的 action。',
    ],
    examples: [`page_frames --payload '{"tabId":12345}'`],
  },
  {
    name: 'request_permission',
    description: '申请访问指定域名的权限（必要时弹窗让用户授权）',
    params: [
      {
        name: 'domain',
        type: 'string',
        required: true,
        description: '需要授权的域名，如 example.com',
      },
    ],
    notes: [
      'domain 使用纯主机名，不传 URL。在 send_request 或 set_rule 提示缺少浏览器域名权限时申请。',
      '弹窗等待用户选择，90 秒超时或关闭按拒绝处理；granted=true 后才重试原请求。',
    ],
    result: ['返回 granted、domain，授权成功时包含 origin。'],
    examples: [`request_permission --payload '{"domain":"example.com"}'`],
  },
  // ── 组合调用 ────────────────────────────────────────────────────────────────
  {
    name: 'run_actions',
    description:
      '批量顺序执行多个 action，减少往返延迟。遇错即停，返回已完成步骤结果；步骤内的页面动作不带内置观察',
    summary: '批量顺序执行多个 action，遇错即停',
    params: [
      {
        name: 'actions',
        type: 'Array<{action: string, data?: object}>',
        required: true,
        description: '要依次执行的 action 列表',
      },
      {
        name: 'tabId',
        type: 'number',
        required: true,
        description: '所有步骤共享的 tabId，步骤自身指定的优先',
      },
    ],
    notes: ['最多 50 步，不允许嵌套 run_actions；需要根据每步效果决策时逐步调用普通 action。'],
    result: [
      '返回 results、completedSteps、totalSteps；失败时包含 error/failedStep，后续步骤未执行。',
    ],
    examples: [
      `run_actions --payload '{"tabId":12345,"actions":[{"action":"page_hover","data":{"selector":"#menu"}},{"action":"page_click","data":{"selector":"#menu-item"}}]}'`,
    ],
  },
] as const satisfies readonly CommandDef[];

type AssertNever<T extends never> = T;
type _MissingCommandActions = AssertNever<
  Exclude<BrowserCommandAction, (typeof COMMANDS)[number]['name'] | 'capture_checkpoint'>
>;

export const COMMAND_MAP: ReadonlyMap<string, CommandDef> = new Map(
  COMMANDS.map(command => [command.name, command]),
);
