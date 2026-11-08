// 共享类型定义
// 用于 background service worker 和 panel 之间通信

// SSE 消息
export interface SSEMessage {
  event: string; // 事件类型
  data: any; // 消息数据（已解析的对象或字符串）
  eventId?: string; // 事件 ID
  timestamp?: number; // 消息时间戳（仅在实时捕获时有值，历史数据无此字段）
  duration?: number; // 与前一条消息的间隔时间（毫秒），用于 mock 时模拟真实时序
}

// 请求用例 Mock 配置引用（保证 id、appname、caseId 一致性）
export interface MockConfigRef {
  id: string; // Mock 配置 ID
  appname: string; // App 名称
  caseId: number; // 用例集 ID
}

// 响应覆盖配置（用于 background 和 panel 之间通信）
export interface ResponseOverride {
  id?: string; // 唯一标识（支持同一 API 多条 override）
  url?: string; // 请求 URL（background 需要用于匹配）
  apiName: string; // API 名称
  responseData?: any; // 响应数据（兼容旧版本字段，等同于 modifiedData）
  originalData?: any; // 原始响应数据
  modifiedData?: any; // 修改后的数据
  duration?: number; // 完整响应时长（毫秒）：mock 生效时的总耗时，绕过真实服务器精确控制
  responseHeaders?: Array<{ name: string; value: string }>; // 原始响应头（用于 duration 请求阶段 fulfill）
  disabled?: boolean; // 是否禁用该覆盖（保留供 agent API 兼容）
  conditions?: Record<string, any>; // 请求字段子集匹配；保留字段 $index 表示调用顺序
  isSSE?: boolean; // 是否是 SSE 请求
  sseMessages?: SSEMessage[]; // SSE 消息列表（用于 mock SSE 流）
  mockConfig?: MockConfigRef; // 请求用例 Mock 配置引用
  sceneComment?: string; // 场景名称备注，生成二维码时作为 comment 参数
  source?: 'protocol' | 'requests'; // 请求来源：mtop 接口或普通 XHR/Fetch
}

export interface BrowserAccountItem {
  provider?: { bundleId: string; revision: string };
  id: number;
  principalId?: number | string;
  loginId: string;
  ownerName?: string;
  site?: string;
  status?: string;
}

export interface BrowserAccountsData {
  pagedNum?: number;
  totalNum?: number;
  currentNum?: number;
  accountList: BrowserAccountItem[];
}
