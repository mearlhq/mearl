import { Dispatch, MutableRefObject, SetStateAction, useCallback, useEffect, useRef } from 'react';
import { compileTextPattern, matchesTextPattern, queryTrackingEvents } from '@mearl/browser-core';
import { CapturedRequest, ResponseOverride, RumEvent } from '../types';
import {
  parseRequestInfo,
  calculateHeadersSize,
  generateNonProtocolApiName,
  normalizeNonProtocolResourceType,
} from '../utils/helpers';
import { inspectRequest } from '../utils/apiNameExtractor';
import { getInspectedSelectedElement } from '../utils/selectedElement';
import { findMatchingOverride } from '../utils/conditionMatcher';
import {
  acceptsCollectorRequest,
  mergeCapturedEvents,
  mergeCapturedRequests,
  type PanelRequestCaptureState,
} from '../utils/capturedState';
import { DEVICE_PREVIEW_PANEL_PORT, type DevicePreviewPanelMessage } from '../../../shared/devicePreviewPanel';
import type { NavigationDivider } from '../types';

interface UsePanelPortBridgeOptions {
  previewToken?: string;
  onPreviewState?: (tabId: number | null, state: 'connecting' | 'capturing' | 'error') => void;
  setNavigationDividers?: Dispatch<SetStateAction<NavigationDivider[]>>;
  tabId: number | null;
  modificationEnabled: boolean;
  apiOverrides: Map<string, ResponseOverride[]>;
  setRequests: Dispatch<SetStateAction<CapturedRequest[]>>;
  setNonCapturedRequests: Dispatch<SetStateAction<CapturedRequest[]>>;
  setRumEvents: Dispatch<SetStateAction<RumEvent[]>>;
  setApiOverrides: Dispatch<SetStateAction<Map<string, ResponseOverride[]>>>;
  requestsRef: MutableRefObject<CapturedRequest[]>;
  nonCapturedRequestsRef: MutableRefObject<CapturedRequest[]>;
  rumEventsRef: MutableRefObject<RumEvent[]>;
  hiddenApisRef: MutableRefObject<string[]>;
  hiddenNonProtocolApisRef: MutableRefObject<string[]>;
  recentlyAutoTranslatedRef: MutableRefObject<Set<string>>;
  requestCaptureStateRef: MutableRefObject<PanelRequestCaptureState>;
}

export const usePanelPortBridge = ({
  previewToken,
  onPreviewState,
  setNavigationDividers,
  tabId,
  modificationEnabled,
  apiOverrides,
  setRequests,
  setNonCapturedRequests,
  setRumEvents,
  setApiOverrides,
  requestsRef,
  nonCapturedRequestsRef,
  rumEventsRef,
  hiddenApisRef,
  hiddenNonProtocolApisRef,
  recentlyAutoTranslatedRef,
  requestCaptureStateRef,
}: UsePanelPortBridgeOptions) => {
  const previewStateRef = useRef(onPreviewState);
  previewStateRef.current = onPreviewState;
  const previewPortRef = useRef<chrome.runtime.Port | null>(null);
  const markPreviewReady = useCallback(() => {
    try {
      previewPortRef.current?.postMessage('ready');
    } catch {
      // The viewer can disconnect while the replacement document is mounting.
    }
  }, []);
  // 用 ref 同步最新的 modificationEnabled / apiOverrides，避免 SSE 回调捕获旧值
  // 同时保证回调引用稳定，防止 port 连接被频繁断开重建
  const modificationEnabledRef = useRef(modificationEnabled);
  const apiOverridesRef = useRef(apiOverrides);
  modificationEnabledRef.current = modificationEnabled;
  apiOverridesRef.current = apiOverrides;

  // 记录每个 SSE 请求归属的列表（协议接口 vs 普通请求），
  // 以便后续 SSE_CHUNK/SSE_COMPLETE（只带 requestId、不带 url）能更新到正确的列表
  const sseQueueRef = useRef<Promise<void>>(Promise.resolve());
  const sseRequestListRef = useRef<Map<string, { list: 'protocol' | 'requests'; state: PanelRequestCaptureState; source: PanelRequestCaptureState['source'] }>>(new Map());

  // 处理 SSE 连接消息 - 立即创建请求记录
  const handleSSEConnectionMessage = useCallback(
    async (message: any, current: () => boolean) => {
      const {
        requestId,
        url,
        method,
        status,
        statusText,
        requestHeaders,
        responseHeaders,
        requestBody,
        timestamp,
      } = message;

      // 根据 URL 判断归属：协议接口进 mtop 列表，普通请求进 requests 列表
      const captureState = requestCaptureStateRef.current;
      const extraction = await inspectRequest(url, requestBody) ?? undefined;
      if (!current() || requestCaptureStateRef.current !== captureState) return;
      const isProtocol = Boolean(extraction);
      sseRequestListRef.current.set(requestId, { list: isProtocol ? 'protocol' : 'requests', state: captureState, source: captureState.source });
      const setter = isProtocol ? setRequests : setNonCapturedRequests;

      setter(prev => {
        // 检查是否已存在相同 _internalRequestId 的请求
        let existingIndex = prev.findIndex(req => req._internalRequestId === requestId);
        if (existingIndex === -1) {
          const requestTimestamp = timestamp || Date.now();
          for (let index = prev.length - 1; index >= 0; index--) {
            const request = prev[index];
            if (
              request.captureSequence !== undefined &&
              !request._internalRequestId &&
              request.url === url &&
              Math.abs(request.timestampMs - requestTimestamp) <= 5000
            ) {
              existingIndex = index;
              break;
            }
          }
        }

        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = {
            ...updated[existingIndex],
            isSSE: true,
            isPending: true,
            sseMessages: updated[existingIndex].sseMessages || [],
            _internalRequestId: requestId,
            _createdByInjected: true,
            headers: requestHeaders || updated[existingIndex].headers,
            responseHeaders: responseHeaders || updated[existingIndex].responseHeaders,
            postData: requestBody
              ? (() => {
                  if (requestBody.startsWith('{')) {
                    try {
                      return JSON.parse(requestBody);
                    } catch {
                      return requestBody;
                    }
                  }
                  return requestBody;
                })()
              : updated[existingIndex].postData,
            method: method || updated[existingIndex].method,
          };
          return updated;
        }

        // 创建新的 SSE 请求记录
        const now = timestamp || Date.now();
        const date = new Date(now);
        const timestampStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;

        const {
          queryString,
          postData: parsedPostData,
          proxyData,
        } = parseRequestInfo(url, requestBody, extraction);

        // 协议 / 普通请求只在 apiName、proxy 系字段、resourceType 上有差异，其余字段一致，
        // 故先确定差异部分，再与公共 base 合并，避免两份近乎相同的对象字面量
        let specifics: Pick<
          CapturedRequest,
          'apiName' | 'isProxy' | 'proxyRequestUrl' | 'proxyData' | 'resourceType' | 'source'
        >;
        if (extraction) {
          specifics = {
            apiName: extraction.apiName || 'unknown',
            isProxy: extraction.isProxy || false,
            proxyRequestUrl: extraction.proxyRequestUrl || null,
            proxyData,
            source: 'protocol',
          };
        } else {
          // resourceType 取注入脚本上报的传输类型，便于与后台采集记录合并。
          const resourceType = normalizeNonProtocolResourceType(
            typeof message.resourceType === 'string' ? message.resourceType : 'fetch',
            url,
            responseHeaders || [],
          );
          specifics = {
            apiName: generateNonProtocolApiName(url, resourceType),
            isProxy: false,
            proxyRequestUrl: null,
            proxyData: null,
            resourceType,
            source: 'requests',
          };
        }

        // 检查该 API 是否有覆盖配置且条件匹配
        const override = modificationEnabledRef.current
          ? findMatchingOverride(
              apiOverridesRef.current.get(specifics.apiName),
              parsedPostData,
              queryString,
            )
          : undefined;

        const newRequest: CapturedRequest = {
          environment: extraction?.environment, namespace: extraction?.namespace,
          id: Date.now() + Math.random(),
          url,
          method: method || 'GET',
          status: status || 0,
          statusText: statusText || 'SSE Streaming',
          timestamp: timestampStr,
          timestampMs: now,
          headers: requestHeaders || [],
          requestHeadersSize: calculateHeadersSize(requestHeaders || []),
          responseHeaders: responseHeaders || [
            { name: 'content-type', value: 'text/event-stream' },
          ],
          responseHeadersSize: calculateHeadersSize(responseHeaders || []),
          queryString,
          postData: parsedPostData,
          responseBody: null,
          duration: undefined,
          isSSE: true,
          isPending: true,
          sseMessages: [],
          _internalRequestId: requestId,
          _createdByInjected: true,
          responseOverride: override,
          ...specifics,
        };

        return [...prev, newRequest];
      });
    },
    [setRequests, setNonCapturedRequests],
  ); // modificationEnabled / apiOverrides 通过 ref 读取，保持回调引用稳定

  // 处理 SSE 完成或错误
  const handleSSEComplete = useCallback(
    (message: any) => {
      const { requestId, type, error, timestamp } = message;

      const owner = sseRequestListRef.current.get(requestId);
      if (!owner || owner.state !== requestCaptureStateRef.current || owner.source !== requestCaptureStateRef.current.source) return;
      const setter = owner.list === 'requests' ? setNonCapturedRequests : setRequests;
      sseRequestListRef.current.delete(requestId);

      setter(prev => {
        const targetIndex = prev.findIndex(req => req._internalRequestId === requestId);

        if (targetIndex >= 0) {
          const updated = [...prev];
          const target = updated[targetIndex];

          const duration =
            timestamp && target.timestampMs
              ? Math.round(timestamp - target.timestampMs)
              : target.duration;

          // 聚合所有 SSE 消息到 responseBody，保留完整结构
          let responseBody: any;
          if (target.sseMessages && target.sseMessages.length > 0) {
            // 保留完整的 SSE 消息结构（包含 event、duration 等）
            const allMessages = target.sseMessages.map(msg => {
              let parsedData;
              try {
                parsedData = JSON.parse(msg.data);
              } catch {
                parsedData = msg.data;
              }
              return {
                event: msg.event,
                data: parsedData,
                eventId: msg.eventId,
                timestamp: msg.timestamp,
                duration: msg.duration,
              };
            });
            responseBody = allMessages.length === 1 ? allMessages[0] : allMessages;
          } else {
            // 如果没有收到任何消息，设置一个空的响应体标记
            responseBody = { _emptySSE: true, message: 'No SSE messages received' };
          }

          updated[targetIndex] = {
            ...target,
            isPending: false,
            duration,
            statusText: type === 'SSE_ERROR' ? `Error: ${error || 'Unknown'}` : target.statusText,
            responseBody,
            // 保留 responseOverride，确保 Modified 标签继续显示
            responseOverride: target.responseOverride,
          };

          return updated;
        }

        return prev;
      });
    },
    [setRequests, setNonCapturedRequests],
  );

  // 处理 SSE 消息更新
  const handleSSEMessageUpdate = useCallback(
    (message: any) => {
      const { requestId, event, data, eventId, timestamp } = message;

      const owner = sseRequestListRef.current.get(requestId);
      if (!owner || owner.state !== requestCaptureStateRef.current || owner.source !== requestCaptureStateRef.current.source) return;
      const setter = owner.list === 'requests' ? setNonCapturedRequests : setRequests;

      setter(prev => {
        const updated = [...prev];
        const targetIndex = updated.findIndex(req => req._internalRequestId === requestId);

        if (targetIndex >= 0) {
          const target = updated[targetIndex];
          const sseMessages = target.sseMessages || [];

          // 计算与前一条消息的时间差作为 duration
          const lastMessage = sseMessages[sseMessages.length - 1];
          const duration =
            lastMessage && lastMessage.timestamp
              ? (timestamp || Date.now()) - lastMessage.timestamp
              : 0;

          const newMessage = {
            event: event || 'message',
            data: data || '',
            eventId,
            timestamp: timestamp || Date.now(),
            duration, // 记录消息间隔
          };

          updated[targetIndex] = {
            ...target,
            isSSE: true,
            sseMessages: [...sseMessages, newMessage],
          };
        }

        return updated;
      });
    },
    [setRequests, setNonCapturedRequests],
  );

  const applyCapturedRequests = useCallback(
    (captured: CapturedRequest[], removedRequestIds: number[] = [], replace = false) => {
      const protocolRequests: CapturedRequest[] = [];
      const regularRequests: CapturedRequest[] = [];

      for (const request of captured) {
        let decorated = request;
        if (modificationEnabledRef.current && !request.responseOverride) {
          const matched = findMatchingOverride(
            apiOverridesRef.current.get(request.apiName),
            request.postData,
            request.queryString,
          );
          if (matched) decorated = { ...decorated, responseOverride: matched };
        }
        if (recentlyAutoTranslatedRef.current.has(request.apiName)) {
          decorated = { ...decorated, isAutoTranslated: true };
          recentlyAutoTranslatedRef.current.delete(request.apiName);
        }

        if (request.source === 'requests') regularRequests.push(decorated);
        else protocolRequests.push(decorated);
      }

      setRequests(previous => mergeCapturedRequests(replace ? [] : previous, protocolRequests, removedRequestIds));
      setNonCapturedRequests(previous =>
        mergeCapturedRequests(replace ? [] : previous, regularRequests, removedRequestIds),
      );
    },
    [recentlyAutoTranslatedRef, setNonCapturedRequests, setRequests],
  );

  // 建立与 background 的长连接
  useEffect(() => {
    if (!tabId && previewToken === undefined) return;

    let port: chrome.runtime.Port | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isCleaned = false;
    let connectFailCount = 0;
    const enqueueSse = (work: (current: () => boolean) => void | Promise<void>) => {
      const accepted = requestCaptureStateRef.current;
      const source = accepted.source;
      const current = () => !isCleaned && requestCaptureStateRef.current === accepted && accepted.source === source;
      sseQueueRef.current = sseQueueRef.current.then(() => { if (current()) return work(current); }).catch(console.warn);
    };

    const switchRequestCaptureSource = (
      source: PanelRequestCaptureState['source'],
      since = Date.now(),
    ) => {
      sseQueueRef.current = Promise.resolve();
      sseRequestListRef.current.clear();
      requestCaptureStateRef.current = {
        source,
        debuggerSince: source === 'debugger' ? since : 0,
      };
      if (source === 'devtools') {
        setRequests(previous => previous.filter(request => !request.isPending));
        setNonCapturedRequests(previous => previous.filter(request => !request.isPending));
      }
    };

    // 使用 ref 来避免闭包问题
    const messageHandler = (message: any) => {
      if (message.action === 'requestCaptureSourceChanged') {
        switchRequestCaptureSource(
          message.source === 'debugger' ? 'debugger' : 'devtools',
          typeof message.since === 'number' ? message.since : undefined,
        );
        return;
      }

      // 外层页面或根 WebView 的跨文档导航由 background 转发。
      if (message.action === 'mainFrameCommitted') {
        window.dispatchEvent(
          new CustomEvent('mearl-main-frame-committed', {
            detail: { url: typeof message.url === 'string' ? message.url : '', timestampMs: message.timestampMs },
          }),
        );
        return;
      }

      if (message.action === 'collectorSnapshot') {
        const captureState = requestCaptureStateRef.current;
        const snapshot = message.snapshot;
        if (Array.isArray(snapshot?.requests)) {
          applyCapturedRequests(
            snapshot.requests.filter((request: CapturedRequest) =>
              acceptsCollectorRequest(captureState, request),
            ),
          );
        }
        if (captureState.source === 'debugger' && Array.isArray(snapshot?.events)) {
          setRumEvents(previous =>
            mergeCapturedEvents(
              previous,
              snapshot.events.filter(
                (event: RumEvent) => event.batchTimestampMs >= captureState.debuggerSince,
              ),
            ),
          );
        }
        return;
      }

      if (message.action === 'collectorUpdate') {
        const captureState = requestCaptureStateRef.current;
        const update = message.update;
        if (
          update?.type === 'request' &&
          update.request &&
          acceptsCollectorRequest(captureState, update.request)
        ) {
          applyCapturedRequests([update.request], update.removedRequestIds);
        } else if (
          captureState.source === 'debugger' &&
          update?.type === 'events' &&
          Array.isArray(update.events)
        ) {
          setRumEvents(previous =>
            mergeCapturedEvents(
              previous,
              update.events.filter(
                (event: RumEvent) => event.batchTimestampMs >= captureState.debuggerSince,
              ),
              update.removedEventIds,
            ),
          );
        }
        return;
      }

      if (message.action === 'agentQuery') {
        const { correlationId, query } = message;
        let data: any;
        try {
          const { type } = query;
          if (type === 'getRequests') {
            const source = query.source ?? 'protocol';
            const pool = source === 'requests' ? nonCapturedRequestsRef.current : requestsRef.current;
            const hidden = new Set(
              source === 'requests' ? hiddenNonProtocolApisRef.current : hiddenApisRef.current,
            );
            const totalInBuffer = pool.length;
            let filtered = [...pool].reverse(); // newest first
            if (query.applyHiddenFilter) {
              filtered = filtered.filter(r => !hidden.has(r.apiName));
            }
            if (query.since !== undefined) {
              const sinceMs = Date.now() - query.since * 1000;
              filtered = filtered.filter(r => r.timestampMs >= sinceMs);
            }
            if (query.filter) {
              const pattern = compileTextPattern(query.filter);
              filtered = filtered.filter(
                r => matchesTextPattern(r.apiName, pattern) || matchesTextPattern(r.url, pattern),
              );
            }
            const totalMatched = filtered.length;
            data = { requests: filtered.slice(0, query.count ?? 10), totalMatched, totalInBuffer };
          } else if (type === 'getEvents') {
            const { source = 'all', event_type, filter, since, limit = 20 } = query;
            data = queryTrackingEvents(rumEventsRef.current, {
              source,
              event_type,
              filter,
              since,
              limit,
            });
          } else if (type === 'getRequestBody') {
            const { apiName } = query;
            const pool = [...requestsRef.current, ...nonCapturedRequestsRef.current];
            const match = [...pool].reverse().find(r => r.apiName === apiName && r.responseBody);
            data = { responseBody: match?.responseBody ?? null };
          } else if (type === 'getSelectedElement') {
            // 提前 return，异步完成后发送响应
            const { includeOuterHTML = true } = query;
            getInspectedSelectedElement(includeOuterHTML)
              .then(result => {
                chrome.runtime
                  .sendMessage({ action: 'agentQueryResponse', correlationId, data: result })
                  .catch(() => {});
              })
              .catch(err => {
                chrome.runtime
                  .sendMessage({
                    action: 'agentQueryResponse',
                    correlationId,
                    data: { error: err instanceof Error ? err.message : String(err) },
                  })
                  .catch(() => {});
              });
            return;
          } else {
            data = { error: `Unknown query type: ${type}` };
          }
        } catch (e) {
          data = { error: String(e) };
        }
        chrome.runtime
          .sendMessage({ action: 'agentQueryResponse', correlationId, data })
          .catch(() => {});
        return;
      }

      // 处理来自 background 的 overrides 更新通知
      if (message.action === 'overridesChanged') {
        if (message.overrides && Array.isArray(message.overrides)) {
          setApiOverrides(prev => {
            const overridesMap = new Map<string, ResponseOverride[]>();
            message.overrides.forEach((override: any) => {
              const existingList = prev.get(override.apiName);
              const existingItem = existingList?.find(o => o.id === override.id);
              const item: ResponseOverride = {
                id: override.id,
                apiName: override.apiName,
                originalData: override.originalData || null,
                modifiedData: override.modifiedData || override.responseData,
                duration: override.duration,
                conditions: override.conditions,
                isSSE: override.isSSE,
                sseMessages: override.sseMessages,
                mockConfig: override.mockConfig,
                sceneComment: override.sceneComment ?? existingItem?.sceneComment,
                source: override.source ?? existingItem?.source,
              };
              const list = overridesMap.get(override.apiName) || [];
              list.push(item);
              overridesMap.set(override.apiName, list);
            });
            return overridesMap;
          });

          // 请求记录在完成后不可变，不因 mock 配置变更而追溯修改
        }
        return;
      }

      // 处理实时翻译完成通知
      if (message.action === 'requestAutoTranslated') {
        const { apiName, duration } = message;
        // 记录到 set，以便在请求创建时打标记（通知先于请求到达的情况）
        recentlyAutoTranslatedRef.current.add(apiName);
        // 同时尝试更新已存在的最新一条请求（通知后于请求到达的情况）
        // 只标记同 apiName 中 timestampMs 最大的那条，避免旧请求被误标
        // 找到匹配时才从 ref 删除；若未找到（通知先于请求到达），保留 ref 条目
        // 让后台采集请求到达时消费它
        setRequests(prev => {
          let latestMatch: CapturedRequest | null = null;
          for (const req of prev) {
            if (req.apiName === apiName && !req.responseOverride && !req.isAutoTranslated) {
              if (!latestMatch || req.timestampMs > latestMatch.timestampMs) {
                latestMatch = req;
              }
            }
          }
          if (!latestMatch) return prev; // 通知先到，保留 ref，等采集请求消费
          // 找到匹配，从 ref 删除（此处是唯一的删除点，不存在 Strict Mode 重复调用问题
          // 因为即使回调被调用两次，第二次 latestMatch 仍能找到，但 isAutoTranslated 已为 true 会跳过）
          recentlyAutoTranslatedRef.current.delete(apiName);
          const targetId = latestMatch.id;
          return prev.map(req =>
            req.id === targetId
              ? { ...req, isAutoTranslated: true, ...(duration !== undefined ? { duration } : {}) }
              : req,
          );
        });
        return;
      }

      // 处理 debugger 状态变化通知（定向 port 消息）
      if (message.action === 'debuggerAttached' || message.action === 'debuggerDetached') {
        switchRequestCaptureSource(message.action === 'debuggerAttached' ? 'debugger' : 'devtools');
        // 触发自定义事件，让 useModificationStatus 监听
        window.dispatchEvent(
          new CustomEvent('mearl-debugger-status-changed', {
            detail: { attached: message.action === 'debuggerAttached' },
          }),
        );
        return;
      }

      // 直接在这里处理消息，避免依赖外部函数
      if (message.source !== 'mearl-content-script') {
        return;
      }

      const { type } = message;

      switch (type) {
        case 'FETCH_REQUEST':
          // 暂不处理
          break;

        case 'SSE_CREATED':
        case 'SSE_RESPONSE':
          enqueueSse(current => handleSSEConnectionMessage(message, current));
          break;

        case 'SSE_MESSAGE':
        case 'SSE_CHUNK':
        case 'SSE_CUSTOM_EVENT':
          enqueueSse(() => { handleSSEMessageUpdate(message); });
          break;

        case 'SSE_COMPLETE':
        case 'SSE_ERROR':
          enqueueSse(() => { handleSSEComplete(message); });
          break;

        case 'FETCH_RESPONSE':
          // 暂不处理
          break;

        case 'ELEMENT_PICKED':
          window.dispatchEvent(
            new CustomEvent('mearl-element-picked', {
              detail: {
                text: message.text ?? '',
                element: message.element ?? null,
                page: message.page,
                ...(message.frame ? { frame: message.frame } : {}),
              },
            }),
          );
          break;

        case 'ELEMENT_PICK_CANCELLED':
          window.dispatchEvent(new CustomEvent('mearl-element-pick-cancelled'));
          break;

        case 'TRACE_RESULT':
          window.dispatchEvent(
            new CustomEvent('mearl-element-traced', {
              detail: {
                tagId: message.tagId,
                payload: message.payload,
                frameId: message.frameId,
              },
            }),
          );
          break;
      }
    };

    const handlePreviewMessage = (update: DevicePreviewPanelMessage) => {
      switch (update.type) {
        case 'state':
          previewStateRef.current?.(update.tabId, update.state);
          break;
        case 'snapshot':
          applyCapturedRequests(update.requests, [], true);
          setRumEvents(update.events);
          setNavigationDividers?.(update.navigation);
          break;
        case 'request':
          applyCapturedRequests(update.request ? [update.request] : [], update.removed);
          break;
        case 'events':
          setRumEvents(previous => mergeCapturedEvents(previous, update.events, update.removed));
          break;
        case 'notification':
          messageHandler(update.message);
          break;
      }
    };

    const doConnect = () => {
      if (isCleaned) return;
      try {
        port = chrome.runtime.connect({ name: previewToken === undefined
          ? `devtools-panel-${tabId}` : DEVICE_PREVIEW_PANEL_PORT + previewToken });
        previewPortRef.current = previewToken === undefined ? null : port;
        connectFailCount = 0; // 连接成功，重置失败计数
        port.onMessage.addListener(previewToken === undefined ? messageHandler : handlePreviewMessage);
        port.onDisconnect.addListener(() => {
          if (isCleaned) return;
          port = null;
          if (previewToken !== undefined) {
            void chrome.runtime.lastError;
            previewPortRef.current = null;
            previewStateRef.current?.(null, 'error');
            window.parent.postMessage({ type: 'mearl-device-preview-reconnect' }, '*');
            return;
          }
          connectFailCount = 0; // 断开后重置，重新计数
          // Service worker 重启，重新连接
          reconnectTimer = setTimeout(() => {
            doConnect();
          }, 1500);
        });
      } catch {
        connectFailCount++;
        if (connectFailCount >= 4) {
          // 连续 4 次失败（~6s），扩展 context 已永久失效（插件已更新），重载面板以恢复
          window.location.reload();
          return;
        }
        // 扩展 context 暂时失效（插件刷新中），稍后重试，不触发全局错误处理重载循环
        reconnectTimer = setTimeout(doConnect, 1500);
      }
    };

    doConnect();

    return () => {
      isCleaned = true;
      sseQueueRef.current = Promise.resolve();
      sseRequestListRef.current.clear();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      port?.disconnect();
      previewPortRef.current = null;
    };
  }, [previewToken === undefined ? tabId : null, previewToken]);

  return {
    markPreviewReady,
    clearPreview: () => previewPortRef.current?.postMessage('clear'),
    retryPreview: () => {
      if (previewPortRef.current) previewPortRef.current.postMessage('retry');
      else if (previewToken !== undefined) {
        window.parent.postMessage({ type: 'mearl-device-preview-reconnect' }, '*');
      }
    },
  };
};
