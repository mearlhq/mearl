import { ResponseOverride, SSEMessage } from '../../shared/types';

export { ResponseOverride, SSEMessage };

export interface CapturedRequest {
  environment?: string;
  id: number;
  timestamp: string;
  timestampMs: number; // 毫秒时间戳，用于生成链接
  method: string;
  url: string;
  apiName: string;
  namespace?: string;
  status: number;
  statusText: string;
  headers: Array<{ name: string; value: string }>;
  responseHeaders: Array<{ name: string; value: string }>;
  queryString: Array<{ name: string; value: string }>;
  postData: any;
  responseBody: any;
  isProxy: boolean;
  proxyRequestUrl: string | null;
  proxyData: any;
  hasPreflight?: boolean; // 是否有 OPTIONS 预检请求
  responseOverride?: ResponseOverride; // 响应覆盖配置
  isSSE?: boolean; // 是否是 SSE (Server-Sent Events) 请求
  duration?: number; // 请求耗时（毫秒）
  requestHeadersSize?: number; // 请求头字节数
  responseHeadersSize?: number; // 响应头字节数
  requestBodySize?: number; // 请求体实际传输字节数（HAR bodySize）
  responseBodySize?: number; // 响应实际传输字节数（优先 HAR bodySize，缺失时回退 HAR _transferSize）
  isPending?: boolean; // 是否正在等待响应（用于提前展示）
  sseMessages?: SSEMessage[]; // SSE 消息列表（实时更新）
  _internalRequestId?: string; // 内部请求 ID（由 injected.ts 生成，用于匹配 SSE 消息）
  _createdByInjected?: boolean; // 是否由 injected script 创建（用于判断是否使用兜底方案）
  tabId?: number; // 请求所属的 tab ID（用于 Agent 过滤）
  isAutoTranslated?: boolean; // 是否已被实时翻译功能自动翻译
  source?: 'protocol' | 'requests'; // 请求来源（mtop 接口 或 普通 HTTP 请求）
  resourceType?: string; // Chrome devtools 资源类型：xhr, fetch, script, stylesheet, document, image 等
  captureSequence?: number; // Agent 后台采集器分配的单调序号
  captureTransport?: 'debugger' | 'background'; // 后台采集的页面请求或扩展代发请求
}

// ---- RUM (埋点验证) 相关类型 ----

export interface RumEvent {
  /** 全局唯一 ID，由 batchId + event_id 拼合 */
  id: string;
  /** 事件来源：由已安装的事件解析能力提供 */
  source: 'rum' | 'aplus' | 'arms';
  /** 所属批次 ID */
  batchId: number;
  /** 批次接收时间戳（ms） */
  batchTimestampMs: number;
  /** 批次接收时间（可读字符串） */
  batchTimestamp: string;
  /** 事件类型，如 "resource" / "view" */
  event_type: string;
  /** 子类型，如 "js" / "css" / "xhr" / "perf" */
  type?: string;
  /** 事件名称（RUM: xhr 的 API 名或 resource/view 的资源路径；aplus: SPM 或页面 URL） */
  name?: string;
  /** 关联 URL（RUM: 当前页面 URL；aplus: 上报请求完整 URL） */
  url?: string;
  /** 事件自身时间戳（ms） */
  timestamp: number;
  /** 是否成功 (1=成功, 0=失败) */
  success?: number;
  /** HTTP 状态码 */
  status_code?: number;
  /** HTTP 方法 */
  method?: string;
  /** 耗时（ms） */
  duration?: number;
  /** Agent 后台采集器为 tracking 请求分配的单调序号 */
  captureSequence?: number;
  /** 原始事件对象的所有字段 */
  _raw: Record<string, any>;
  /** 解析器提供的展示与高亮位置。 */
  point?: { mainSpm: string; highlightSpm: string };
  /** aplus 埋点校验结果（仅 source='aplus' 时存在）；arms 上报不做校验 */
  validation?: {
    level: 'success' | 'warning' | 'error';
    issues: { level: 'warning' | 'error'; message: string }[];
    checks: string[];
  };
  /** 所属批次的上下文信息 */
  _context: {
    requestUrl: string;
    app: Record<string, any>;
    user: Record<string, any>;
    session: Record<string, any>;
    view: Record<string, any>;
    properties: Record<string, any>;
    os: Record<string, any>;
    net: Record<string, any>;
  };
}

// ---- 页面导航分隔记录（保留日志时标记页面跳转） ----

export interface NavigationDivider {
  type: 'navigation-divider';
  id: number;
  timestampMs: number;
  url: string; // 跳转目标 URL
}

export type PanelMode = 'protocol' | 'rum';

// 关注的字段信息
export interface PinnedField {
  path: string; // 字段路径，如 "data.result.list"
  value: any; // 字段值
  type: 'request' | 'response'; // 来源：请求体或响应体
  apiName: string; // 所属 API 名称（同一个 API 的所有请求共享关注字段）
  requestId: number; // 首次关注时的请求 ID（用于记录）
}

// 埋点事件关注的字段信息（按子类型维度关注）
export interface PinnedEventField {
  path: string; // 字段路径，如 "status_code"
  value: any; // 字段值
  /** 事件子类型标识，由 source/event_type 或 source/event_type:type 拼合，如 "rum/resource:js"、"aplus/EXP" */
  eventSubType: string;
  eventId: string; // 首次关注时的事件 ID（用于记录）
}
