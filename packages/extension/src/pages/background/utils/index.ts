import { replayProtocolRequest } from '../requestReplay';
import { inspectBrowserRequest } from '../requestInspection';
// Utils
// 公共工具函数

// 记录每个 tab 上次提示"内容脚本不可达"的时间，避免连续操作时反复弹提示
const unreachableNotifiedAt = new Map<number, number>();
const UNREACHABLE_NOTIFY_INTERVAL = 5000;

/**
 * content script 不可达时，通知面板判断是否需要提示用户授权。
 * 同一 tab 在 UNREACHABLE_NOTIFY_INTERVAL 毫秒内只提示一次。
 */
export function notifyContentScriptUnreachable(tabId: number): void {
  const now = Date.now();
  if (now - (unreachableNotifiedAt.get(tabId) ?? 0) < UNREACHABLE_NOTIFY_INTERVAL) return;
  unreachableNotifiedAt.set(tabId, now);
  // 面板可能未打开，sendMessage 会失败，忽略即可
  chrome.runtime.sendMessage({ action: 'contentScriptUnreachable', tabId }).catch(() => {});
}

/**
 * 给页面 content script 发消息的安全封装。
 * 当目标 tab 没有 content script（chrome:// 页、未匹配站点、尚未注入）
 * 或页面已跳转/卸载时，静默返回 undefined，不抛错、不产生
 * "Unchecked runtime.lastError: Could not establish connection / message port closed" 告警。
 *
 * 对于用户主动发起的操作（选择元素、高亮、inspect 等），传 notifyOnUnreachable: true，
 * 失败时会通知面板判断是否需要提示授权；清理类操作（cancel/clear）不传，保持静默。
 */
export function sendTabMessageSafe<T = any>(
  tabId: number,
  message: unknown,
  options?: { notifyOnUnreachable?: boolean; frameId?: number; documentId?: string },
): Promise<T | undefined> {
  const sendOptions = options?.documentId
    ? { documentId: options.documentId }
    : typeof options?.frameId === 'number'
      ? { frameId: options.frameId }
      : undefined;
  const request = sendOptions
    ? chrome.tabs.sendMessage(tabId, message, sendOptions)
    : chrome.tabs.sendMessage(tabId, message);
  return request.catch(() => {
    if (options?.notifyOnUnreachable) notifyContentScriptUnreachable(tabId);
    return undefined;
  }) as Promise<T | undefined>;
}

/** Protocol names come only from an installed inspector. */
export async function extractApiName(url: string, postData?: unknown): Promise<string | null> {
  return (await inspectBrowserRequest({ url, body: postData }))?.apiName ?? null;
}

// 重发已安装协议请求
export async function resendProtocolRequest(
  _tabId: number,
  data: {
    apiName: string;
    method: string;
    requestData: any;
    originalUrl: string;
    queryParams?: Array<{ name: string; value: string }>;
    requestHeaders?: Array<{ name: string; value: string }>;
  },
): Promise<{ success: boolean; error?: string; response?: any; requestData?: any }> {
  try {
    return await replayProtocolRequest(data);
  } catch (error) {
    console.error('[Resend] Failed to resend protocol request:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
