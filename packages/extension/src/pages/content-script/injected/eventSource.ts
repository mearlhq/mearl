// EventSource 劫持模块
//
// 通过 Proxy 包装原生 EventSource 构造函数，在实例创建后直接 addEventListener
// 'message' 事件以及业务通过 addEventListener 注册的自定义事件（event: xxx），
// 保证无论业务代码走 onmessage = fn 还是 addEventListener('xxx', fn) 都能被监听到。

import { generateId, sendToContentScript } from './utils';

export function interceptEventSource(): void {
  const OriginalEventSource = window.EventSource;

  if (!OriginalEventSource) return;

  const ProxiedEventSource = new Proxy(OriginalEventSource, {
    construct(target, args: [string | URL, EventSourceInit?]) {
      const [url, config] = args;
      const eventSource = new target(url, config);
      const id = generateId();
      const rawUrl = typeof url === 'string' ? url : url.toString();
      // 归一化为绝对 URL，与 fetch/XHR 上报及 DevTools network 捕获的 URL 保持一致，
      // 否则相对路径（如 /api/stream）会导致按 URL 去重失败、出现重复条目
      let urlString = rawUrl;
      try {
        urlString = new URL(rawUrl, location.href).href;
      } catch {
        // 保持原值
      }

      // 发送 SSE 连接创建通知
      sendToContentScript({
        type: 'SSE_CREATED',
        requestId: id,
        url: urlString,
        timestamp: Date.now(),
      });

      // 上报消息的通用方法
      const reportEvent = (event: MessageEvent, eventType: string) => {
        sendToContentScript({
          type: eventType === 'message' ? 'SSE_MESSAGE' : 'SSE_CUSTOM_EVENT',
          requestId: id,
          event: eventType,
          data: event.data,
          lastEventId: event.lastEventId,
          timestamp: Date.now(),
        });
      };

      // 直接监听默认 'message' 事件（不依赖业务代码是否赋值 onmessage）
      eventSource.addEventListener('message', event => {
        reportEvent(event as MessageEvent, 'message');
      });

      // 拦截 addEventListener：当业务监听自定义事件时，我们也同步上报
      const originalAddEventListener = eventSource.addEventListener.bind(eventSource);
      const interceptedTypes = new Set<string>(['message']);
      eventSource.addEventListener = function (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (!interceptedTypes.has(type)) {
          interceptedTypes.add(type);
          originalAddEventListener(type, (event: Event) => {
            reportEvent(event as MessageEvent, type);
          });
        }
        return originalAddEventListener(type, listener, options);
      } as typeof eventSource.addEventListener;

      return eventSource;
    },
  });

  window.EventSource = ProxiedEventSource;
}
