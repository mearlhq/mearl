// Fetch 劫持和 SSE 处理模块

import { generateId, sendToContentScript } from './utils';

interface SSEOverride {
  isSSE?: boolean;
  sseMessages?: Array<{
    event?: string;
    data: string;
    eventId?: string;
    duration?: number;
  }>;
}

// 存储待处理的 SSE 请求
const pendingSSERequests = new Map<string, { resolve: (override: SSEOverride | null) => void }>();

// 监听来自 content-script 的消息
export function listenForOverrideMessages(): void {
  window.addEventListener('message', event => {
    if (event.data && event.data.source === 'mearl-content') {
      // 处理 override 开关状态更新
      if (event.data.type === 'UPDATE_OVERRIDE_ENABLED') {
        window.__MEARL_OVERRIDE_ENABLED__ = event.data.enabled;
        return;
      }

      // 处理 override 响应
      if (event.data.type === 'SSE_OVERRIDE_RESPONSE') {
        const { requestId, override } = event.data;
        const pending = pendingSSERequests.get(requestId);

        if (pending) {
          pendingSSERequests.delete(requestId);

          if (override && override.isSSE && override.sseMessages) {
            pending.resolve(override);
          } else {
            pending.resolve(null);
          }
        }
      }
    }
  });
}

// 创建 mock 的 SSE 响应
function createMockSSEResponse(
  requestId: string,
  url: string,
  method: string,
  requestBody: unknown,
  override: SSEOverride,
): Response {
  // 收集请求头（用于通知）
  const requestHeaders: Array<{ name: string; value: string }> = [];

  // 通知 SSE 响应开始
  sendToContentScript({
    type: 'SSE_RESPONSE',
    requestId,
    url,
    method,
    status: 200,
    statusText: 'OK (Mocked)',
    requestHeaders,
    responseHeaders: [{ name: 'content-type', value: 'text/event-stream' }],
    requestBody,
    timestamp: Date.now(),
  });

  // 处理 SSE 消息
  const messages = override.sseMessages || [];

  // 创建可读流
  const stream = new ReadableStream({
    start(controller) {
      let index = 0;
      const encoder = new TextEncoder();

      function pushNext() {
        if (index < messages.length) {
          const msg = messages[index];
          const eventType = msg.event || 'message';

          // 构造 SSE 格式的 chunk
          let chunk = '';

          if (msg.eventId) {
            chunk += `id: ${msg.eventId}\n`;
          }

          if (msg.event && msg.event !== 'message') {
            chunk += `event: ${msg.event}\n`;
          }

          chunk += `data: ${msg.data}\n`;
          chunk += '\n';

          controller.enqueue(encoder.encode(chunk));

          sendToContentScript({
            type: 'SSE_CHUNK',
            requestId,
            event: eventType,
            data: msg.data,
            eventId: msg.eventId,
            timestamp: Date.now(),
          });

          index++;

          if (index < messages.length) {
            const delay = messages[index].duration !== undefined ? messages[index].duration : 500;
            setTimeout(pushNext, delay);
          } else {
            setTimeout(() => {
              controller.close();
              sendToContentScript({
                type: 'SSE_COMPLETE',
                requestId,
                timestamp: Date.now(),
              });
            }, 100);
          }
        }
      }

      pushNext();
    },
  });

  return new Response(stream, {
    status: 200,
    statusText: 'OK',
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

// 查询 SSE override
async function querySSEOverride(
  requestId: string,
  url: string,
  apiName: string | null,
  requestBody?: unknown,
): Promise<SSEOverride | null> {
  return new Promise(resolve => {
    pendingSSERequests.set(requestId, { resolve });

    sendToContentScript({
      type: 'QUERY_SSE_OVERRIDE',
      requestId,
      url,
      apiName, requestBody,
    });

    // 首次安装的协议检查可能需要初始化沙箱；查询仍有明确上限。
    setTimeout(() => {
      if (pendingSSERequests.has(requestId)) {
        pendingSSERequests.delete(requestId);
        resolve(null);
      }
    }, 1500);
  });
}

// 解析请求体
function parseRequestBody(body: BodyInit | null | undefined): string | null {
  if (!body) return null;

  if (typeof body === 'string') {
    return body;
  }

  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

// 收集请求头
function collectRequestHeaders(
  headers: HeadersInit | undefined,
): Array<{ name: string; value: string }> {
  const requestHeaders: Array<{ name: string; value: string }> = [];

  if (!headers) return requestHeaders;

  if (headers instanceof Headers) {
    headers.forEach((value: string, name: string) => {
      requestHeaders.push({ name, value });
    });
  } else if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      requestHeaders.push({ name, value });
    }
  } else {
    for (const [name, value] of Object.entries(headers)) {
      requestHeaders.push({ name, value: String(value) });
    }
  }

  return requestHeaders;
}

// 处理 SSE 流读取
async function handleSSEStream(
  reader: ReadableStreamDefaultReader,
  requestId: string,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  // currentEvent 必须在循环外，跨 chunk 保持状态（event:/id: 和 data: 可能在不同 chunk 到达）
  let currentEvent: Record<string, string> = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        sendToContentScript({
          type: 'SSE_COMPLETE',
          requestId,
          timestamp: Date.now(),
        });
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // 解析 SSE 数据块
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        // 兼容 \r\n 行尾：去掉末尾 \r 再判断
        const trimmedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (trimmedLine.startsWith('data:')) {
          currentEvent.data = (currentEvent.data || '') + trimmedLine.slice(5).trimStart();
        } else if (trimmedLine.startsWith('event:')) {
          currentEvent.event = trimmedLine.slice(6).trim();
        } else if (trimmedLine.startsWith('id:')) {
          currentEvent.id = trimmedLine.slice(3).trim();
        } else if (trimmedLine === '') {
          // 空行 = 事件分隔符，派发当前事件
          if (currentEvent.data !== undefined) {
            sendToContentScript({
              type: 'SSE_CHUNK',
              requestId,
              event: currentEvent.event || 'message',
              data: currentEvent.data,
              eventId: currentEvent.id,
              timestamp: Date.now(),
            });
            currentEvent = {};
          }
        }
      }
    }
  } catch (error) {
    sendToContentScript({
      type: 'SSE_ERROR',
      requestId,
      error: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
  }
}

// 拦截 Fetch API
export function interceptFetch(): void {
  const originalFetch = window.fetch;

  window.fetch = async function (...args: Parameters<typeof fetch>): Promise<Response> {
    const firstArg = args[0];
    const rawUrl =
      typeof firstArg === 'string'
        ? firstArg
        : firstArg instanceof URL
          ? firstArg.toString()
          : firstArg.url;
    // 归一化为绝对 URL，与 DevTools network 捕获的 URL 保持一致，
    // 否则相对路径（如 /api/stream）会导致后续按 URL 去重失败、mtop 判定不准
    const url = (() => {
      try {
        return new URL(rawUrl, location.href).href;
      } catch {
        return rawUrl;
      }
    })();
    const init = typeof firstArg === 'string' ? args[1] : undefined;

    // 只有在启用 override 功能时才做 Mock 查询（需要在请求前判断）
    if (window.__MEARL_OVERRIDE_ENABLED__) {
      const requestId = generateId();
      const method = init?.method || 'GET';
      const requestBody = parseRequestBody(init?.body);
      const apiName = null;

      // 查询 SSE override
      const override = await querySSEOverride(requestId, url, apiName, requestBody);

      if (override && override.isSSE && override.sseMessages) {
        return createMockSSEResponse(requestId, url, method, requestBody, override);
      }
    }

    // 发起真实请求
    return originalFetch.apply(this, args).then(async response => {
      const contentType = response.headers.get('content-type') || '';

      // 只处理 SSE 响应
      if (!contentType.includes('text/event-stream')) {
        return response;
      }

      // 用户在 Options 里关闭了 SSE 实时监听时，不再上报 SSE 响应
      // （mock override 分支已在上方处理，不受此开关影响）
      if (window.__mearlConfig?.sseMonitoringEnabled === false) {
        return response;
      }

      // SSE 响应处理
      const requestId = generateId();
      const method = init?.method || 'GET';
      const requestBody = parseRequestBody(init?.body);
      const requestHeaders = collectRequestHeaders(init?.headers);

      const cloned = response.clone();
      const reader = cloned.body?.getReader();

      if (reader) {
        const responseHeaders: Array<{ name: string; value: string }> = [];
        response.headers.forEach((value: string, name: string) => {
          responseHeaders.push({ name, value });
        });

        sendToContentScript({
          type: 'SSE_RESPONSE',
          requestId,
          url,
          method,
          status: response.status,
          statusText: response.statusText,
          requestHeaders,
          responseHeaders,
          requestBody,
          timestamp: Date.now(),
        });

        // 在后台持续读取 SSE 流
        handleSSEStream(reader, requestId);
      }

      return response;
    });
  };
}
