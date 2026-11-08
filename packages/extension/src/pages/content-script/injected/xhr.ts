// XMLHttpRequest 劫持模块
//
// 用于捕获 XHR 发起的 SSE（Content-Type: text/event-stream）响应并实时上报，
// 与 fetch.ts / eventSource.ts 共用同一套 SSE_RESPONSE / SSE_CHUNK / SSE_COMPLETE 消息通道。
//
// 仅做"监听上报"，不处理 mock override（fetch 已覆盖 mock 场景，XHR mock 成本高且少见）。
// 增量读取依赖 responseText，因此仅在 responseType 为 '' / 'text' 时生效；
// 其他 responseType（arraybuffer/blob 等）退回 DevTools network 路径在请求结束后展示。

import { generateId, sendToContentScript } from './utils';

interface XHRSSEContext {
  method: string;
  url: string;
  requestHeaders: Array<{ name: string; value: string }>;
  requestId: string;
  requestBody: string | null;
  detected: boolean; // 是否已根据响应头判定过类型
  isSSE: boolean; // 判定结果
  completed: boolean; // 是否已发送 SSE_COMPLETE
  lastIndex: number; // responseText 已处理到的位置
  buffer: string; // 跨 chunk 残留的不完整行
  currentEvent: Record<string, string>;
}

// 解析请求体为字符串
function parseRequestBody(body?: Document | XMLHttpRequestBodyInit | null): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return body;
  try {
    if (body instanceof URLSearchParams) return body.toString();
    return JSON.stringify(body);
  } catch {
    try {
      return String(body);
    } catch {
      return null;
    }
  }
}

// 解析 getAllResponseHeaders() 返回的原始字符串为数组
function parseResponseHeaders(raw: string): Array<{ name: string; value: string }> {
  const headers: Array<{ name: string; value: string }> = [];
  if (!raw) return headers;
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      headers.push({ name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() });
    }
  }
  return headers;
}

export function interceptXHR(): void {
  const XHR = window.XMLHttpRequest;
  if (!XHR) return;

  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  const originalSetRequestHeader = XHR.prototype.setRequestHeader;

  // 用 WeakMap 而非实例属性挂载上下文，避免污染业务对象
  const contexts = new WeakMap<XMLHttpRequest, XHRSSEContext>();

  XHR.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    contexts.set(this, {
      method: method ? String(method).toUpperCase() : 'GET',
      url: typeof url === 'string' ? url : url.toString(),
      requestHeaders: [],
      requestId: '',
      requestBody: null,
      detected: false,
      isSSE: false,
      completed: false,
      lastIndex: 0,
      buffer: '',
      currentEvent: {},
    });
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  };

  XHR.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const ctx = contexts.get(this);
    if (ctx) ctx.requestHeaders.push({ name, value });
    return originalSetRequestHeader.call(this, name, value);
  };

  XHR.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const ctx = contexts.get(this);

    // 无上下文（理论不会发生）或用户关闭了 SSE 实时监听时，原样放行
    if (!ctx || window.__mearlConfig?.sseMonitoringEnabled === false) {
      return originalSend.call(this, body as Document | XMLHttpRequestBodyInit | null);
    }

    ctx.requestId = generateId();
    ctx.requestBody = parseRequestBody(body);

    // progress/load 触发时响应头已可读取；避免访问 readyState/onreadystatechange，
    // 部分风控脚本会劫持这两个成员并在 getter 内重绑回调，额外读取会放大其回调链。
    const detect = () => {
      if (ctx.detected) return;
      let contentType: string;
      try {
        contentType = (this.getResponseHeader('content-type') || '').toLowerCase();
      } catch {
        return;
      }
      ctx.detected = true;
      if (!contentType.includes('text/event-stream')) return;

      // 仅在可增量读取 responseText 时实时上报；否则退回 DevTools 路径
      if (this.responseType !== '' && this.responseType !== 'text') return;

      ctx.isSSE = true;

      // 归一化为绝对 URL，与 DevTools network 捕获的 URL 一致（便于去重）
      try {
        ctx.url = new URL(ctx.url, location.href).href;
      } catch {
        // 保持原值
      }

      sendToContentScript({
        type: 'SSE_RESPONSE',
        requestId: ctx.requestId,
        url: ctx.url,
        method: ctx.method,
        status: this.status || 0,
        statusText: this.statusText || '',
        requestHeaders: ctx.requestHeaders,
        responseHeaders: parseResponseHeaders(this.getAllResponseHeaders()),
        requestBody: ctx.requestBody,
        // 传输类型提示，供面板侧标注非 mtop 请求的资源类型（fetch/xhr）
        resourceType: 'xhr',
        timestamp: Date.now(),
      });
    };

    // 增量解析 responseText 中新到达的部分
    const processChunk = () => {
      if (!ctx.isSSE) return;
      let text: string;
      try {
        text = this.responseText;
      } catch {
        return; // responseType 不支持读取 responseText
      }
      if (text.length <= ctx.lastIndex) return;

      ctx.buffer += text.slice(ctx.lastIndex);
      ctx.lastIndex = text.length;

      const lines = ctx.buffer.split('\n');
      ctx.buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line.startsWith('data:')) {
          ctx.currentEvent.data = (ctx.currentEvent.data || '') + line.slice(5).trimStart();
        } else if (line.startsWith('event:')) {
          ctx.currentEvent.event = line.slice(6).trim();
        } else if (line.startsWith('id:')) {
          ctx.currentEvent.id = line.slice(3).trim();
        } else if (line === '') {
          // 空行 = 事件分隔符，派发当前事件
          if (ctx.currentEvent.data !== undefined) {
            sendToContentScript({
              type: 'SSE_CHUNK',
              requestId: ctx.requestId,
              event: ctx.currentEvent.event || 'message',
              data: ctx.currentEvent.data,
              eventId: ctx.currentEvent.id,
              timestamp: Date.now(),
            });
            ctx.currentEvent = {};
          }
        }
      }
    };

    const complete = () => {
      if (!ctx.isSSE || ctx.completed) return;
      ctx.completed = true;
      sendToContentScript({
        type: 'SSE_COMPLETE',
        requestId: ctx.requestId,
        timestamp: Date.now(),
      });
    };

    // progress 负责流式增量；load 负责短响应或最后一段未触发 progress 的兜底。
    this.addEventListener('progress', () => {
      detect();
      processChunk();
    });

    this.addEventListener('load', () => {
      detect();
      processChunk();
      complete();
    });

    this.addEventListener('error', () => {
      if (!ctx.isSSE || ctx.completed) return;
      ctx.completed = true;
      sendToContentScript({
        type: 'SSE_ERROR',
        requestId: ctx.requestId,
        error: 'XHR error',
        timestamp: Date.now(),
      });
    });

    return originalSend.call(this, body as Document | XMLHttpRequestBodyInit | null);
  };
}
