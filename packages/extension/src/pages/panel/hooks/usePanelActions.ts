import { Dispatch, SetStateAction, useCallback } from 'react';
import { CapturedRequest, PinnedField, PinnedEventField, ResponseOverride, RumEvent } from '../types';
import { MockConfigRef } from '../../../shared/types';
import { sendMessageSafely } from '../utils/safeChrome';
import { getEventSubType } from '../utils/helpers';
import { clearRemovedResponseOverride } from '../utils/responseOverrideState';
import { buildSseOverrideMessages } from '../utils/sseMessageData';
import { resolveJsonRefs } from '../utils/jsonRefResolver';

interface UsePanelActionsOptions {
  tabId: number | null;
  requests: CapturedRequest[];
  nonCapturedRequests: CapturedRequest[];
  selectedRequestId: number | null;
  setPinnedFields: Dispatch<SetStateAction<PinnedField[]>>;
  setPinnedEventFields: Dispatch<SetStateAction<PinnedEventField[]>>;
  setApiOverrides: Dispatch<SetStateAction<Map<string, ResponseOverride[]>>>;
  setRequests: Dispatch<SetStateAction<CapturedRequest[]>>;
  setNonCapturedRequests: Dispatch<SetStateAction<CapturedRequest[]>>;
  syncDebuggerStatus: () => Promise<void>;
  rumEvents: RumEvent[];
  selectedRumEventId: string | null;
}

export const usePanelActions = ({
  tabId,
  requests,
  nonCapturedRequests,
  selectedRequestId,
  setPinnedFields,
  setPinnedEventFields,
  setApiOverrides,
  setRequests,
  setNonCapturedRequests,
  syncDebuggerStatus,
  rumEvents,
  selectedRumEventId,
}: UsePanelActionsOptions) => {
  // 公共方法：添加 Mock 覆盖配置
  const addMockOverride = useCallback(
    async (override: {
      apiName: string;
      responseData: any;
      mockConfig?: MockConfigRef;
      conditions?: Record<string, any>;
    }) => {
      if (!tabId) {
        throw new Error('Tab ID not available');
      }

      try {
        const responseData = resolveJsonRefs(override.responseData);

        // 调用 background 设置响应覆盖
        const response = await sendMessageSafely({
          action: 'setResponseOverride',
          tabId,
          data: {
            url: '',
            apiName: override.apiName,
            responseData,
            modifiedData: responseData,
            originalData: null,
            duration: 0,
            mockConfig: override.mockConfig,
            conditions: override.conditions,
          },
        });

        if (response && response.success) {
          // apiOverrides 状态由 notifyPanelOverrideChanged 同步更新
          // 这里只更新已被拦截过的同 API 请求的 responseOverride 引用
          const fullOverride: ResponseOverride = {
            id: response.id,
            apiName: override.apiName,
            originalData: null,
            modifiedData: responseData,
            url: '',
            mockConfig: override.mockConfig,
            source: 'protocol',
          };

          setRequests(prev =>
            prev.map(req => {
              if (req.apiName === override.apiName && req.responseOverride) {
                return { ...req, responseOverride: fullOverride };
              }
              return req;
            }),
          );

          await syncDebuggerStatus();
          return { success: true, id: fullOverride.id };
        }
        throw new Error(response?.error || 'Unknown error');
      } catch (error) {
        console.error('Error adding mock override:', error);
        throw error;
      }
    },
    [tabId, syncDebuggerStatus, setApiOverrides, setRequests],
  );

  // 设置响应覆盖
  const setResponseOverride = useCallback(
    async (request: CapturedRequest, modifiedData: any) => {
      if (!tabId) {
        console.error('Tab ID not available');
        return;
      }

      try {
        // 如果是 SSE 请求，使用原始的 sseMessages 结构，但替换 data 内容
        // modifiedData 一定是数组，每个元素对应一条 SSE 消息
        let sseMessages: any[] | undefined;
        if (request.isSSE && Array.isArray(modifiedData) && request.sseMessages) {
          sseMessages = buildSseOverrideMessages(request.sseMessages, modifiedData);
        }

        const response = await sendMessageSafely({
          action: 'setResponseOverride',
          tabId,
          data: {
            id: request.responseOverride?.id,
            url: request.url,
            apiName: request.apiName,
            responseData: modifiedData,
            originalData: request.responseOverride?.originalData || request.responseBody,
            modifiedData,
            duration: request.responseOverride?.duration,
            responseHeaders: request.responseHeaders,
            isSSE: request.isSSE,
            sseMessages,
            mockConfig: request.responseOverride?.mockConfig,
            sceneComment: request.responseOverride?.sceneComment,
            conditions: request.responseOverride?.conditions,
          },
        });

        if (response && response.success) {
          // 保存该 API 的覆盖配置
          // 如果没有指定 duration，使用原始请求的 duration 作为默认值
          const defaultDuration =
            request.responseOverride?.duration !== undefined
              ? request.responseOverride.duration
              : request.duration;

          const override: ResponseOverride = {
            id: request.responseOverride?.id || response.id,
            apiName: request.apiName,
            originalData: request.responseOverride?.originalData || request.responseBody,
            modifiedData,
            duration: defaultDuration,
            responseHeaders: request.responseHeaders,
            isSSE: request.isSSE,
            sseMessages,
            mockConfig: request.responseOverride?.mockConfig,
            sceneComment: request.responseOverride?.sceneComment,
            conditions: request.responseOverride?.conditions,
            source: request.source ?? 'requests',
          };

          // 只更新当前这条请求本身，历史请求记录完成后不可变
          setRequests(prev =>
            prev.map(req => (req.id === request.id ? { ...req, responseOverride: override } : req)),
          );
          setNonCapturedRequests(prev =>
            prev.map(req => (req.id === request.id ? { ...req, responseOverride: override } : req)),
          );

          // 同步 debugger 状态（因为 background 可能自动启用了 modification）
          await syncDebuggerStatus();
        }
      } catch (error) {
        console.error('Error setting response override:', error);
      }
    },
    [tabId, setApiOverrides, setRequests, setNonCapturedRequests, syncDebuggerStatus],
  );

  // 移除响应覆盖
  const removeResponseOverride = useCallback(
    async (request: CapturedRequest) => {
      if (!tabId) {
        console.error('Tab ID not available');
        return;
      }

      try {
        const removedOverride = request.responseOverride;
        if (!removedOverride) return;

        const response = await sendMessageSafely({
          action: 'removeResponseOverride',
          tabId,
          apiName: request.apiName,
          id: removedOverride.id,
        });

        if (response && response.success) {
          setApiOverrides(prev => {
            const newMap = new Map(prev);
            const list = newMap.get(request.apiName);
            if (list && removedOverride.id) {
              const filtered = list.filter(o => o.id !== removedOverride.id);
              if (filtered.length === 0) {
                newMap.delete(request.apiName);
              } else {
                newMap.set(request.apiName, filtered);
              }
            } else {
              newMap.delete(request.apiName);
            }
            return newMap;
          });

          // 同一个 override 会附着到刷新后产生的多条请求；配置移除后统一清理关联展示状态。
          // duration 保留 mock 配置的完整耗时，避免被拦截请求回落到接近 0ms。
          setRequests(prev => clearRemovedResponseOverride(prev, request.apiName, removedOverride));
          setNonCapturedRequests(prev =>
            clearRemovedResponseOverride(prev, request.apiName, removedOverride),
          );

          // 同步 debugger 状态（因为 background 可能自动启用了 modification）
          await syncDebuggerStatus();
        }
      } catch (error) {
        console.error('Error removing response override:', error);
      }
    },
    [tabId, setApiOverrides, setRequests, setNonCapturedRequests, syncDebuggerStatus],
  );

  // 设置/移除资源重定向
  const setResourceRedirect = useCallback(async (sourceUrl: string, redirectUrl: string | null) => {
    if (redirectUrl) {
      await sendMessageSafely({ action: 'setResourceRedirect', sourceUrl, redirectUrl });
    } else {
      await sendMessageSafely({ action: 'removeResourceRedirect', sourceUrl });
    }
  }, []);

  const pinField = useCallback(
    (path: string[], value: any, type: 'request' | 'response') => {
      const activeRequestId = selectedRequestId;
      if (!activeRequestId) return;

      const selectedReq =
        requests.find(r => r.id === activeRequestId) ||
        nonCapturedRequests.find(r => r.id === activeRequestId);
      if (!selectedReq) return;

      const pathString = path.join('.');

      setPinnedFields(prev => {
        const exists = prev.some(
          f => f.path === pathString && f.apiName === selectedReq.apiName && f.type === type,
        );
        if (exists) return prev;

        return [
          {
            path: pathString,
            value,
            type,
            apiName: selectedReq.apiName,
            requestId: activeRequestId,
          },
          ...prev,
        ];
      });
    },
    [selectedRequestId, requests, nonCapturedRequests, setPinnedFields],
  );

  const unpinField = useCallback(
    (path: string, apiName: string, type: 'request' | 'response') => {
      setPinnedFields(prev =>
        prev.filter(f => !(f.path === path && f.apiName === apiName && f.type === type)),
      );
    },
    [setPinnedFields],
  );

  const reorderPinnedFields = useCallback(
    (fromIndex: number, toIndex: number, apiName: string, type: 'request' | 'response') => {
      setPinnedFields(prev => {
        // 筛选出当前 apiName 和 type 的字段
        const currentTypeFields = prev.filter(f => f.apiName === apiName && f.type === type);
        const otherFields = prev.filter(f => !(f.apiName === apiName && f.type === type));

        // 重新排序当前类型的字段
        const reordered = [...currentTypeFields];
        const [movedItem] = reordered.splice(fromIndex, 1);
        reordered.splice(toIndex, 0, movedItem);

        // 合并回去，保持其他字段的位置
        return [...reordered, ...otherFields];
      });
    },
    [setPinnedFields],
  );

  const pinEventField = useCallback(
    (path: string[], value: any) => {
      if (!selectedRumEventId) return;

      const selectedEvent = rumEvents.find(e => e.id === selectedRumEventId);
      if (!selectedEvent) return;

      const pathString = path.join('.');
      const eventSubType = getEventSubType(selectedEvent);

      setPinnedEventFields(prev => {
        const exists = prev.some(f => f.path === pathString && f.eventSubType === eventSubType);
        if (exists) return prev;

        return [
          {
            path: pathString,
            value,
            eventSubType,
            eventId: selectedRumEventId,
          },
          ...prev,
        ];
      });
    },
    [selectedRumEventId, rumEvents, setPinnedEventFields],
  );

  const unpinEventField = useCallback(
    (path: string, eventSubType: string) => {
      setPinnedEventFields(prev =>
        prev.filter(f => !(f.path === path && f.eventSubType === eventSubType)),
      );
    },
    [setPinnedEventFields],
  );

  const reorderPinnedEventFields = useCallback(
    (fromIndex: number, toIndex: number, eventSubType: string) => {
      setPinnedEventFields(prev => {
        const currentFields = prev.filter(f => f.eventSubType === eventSubType);
        const otherFields = prev.filter(f => f.eventSubType !== eventSubType);

        const reordered = [...currentFields];
        const [movedItem] = reordered.splice(fromIndex, 1);
        reordered.splice(toIndex, 0, movedItem);

        return [...reordered, ...otherFields];
      });
    },
    [setPinnedEventFields],
  );

  return {
    addMockOverride,
    setResponseOverride,
    removeResponseOverride,
    setResourceRedirect,
    pinField,
    unpinField,
    reorderPinnedFields,
    pinEventField,
    unpinEventField,
    reorderPinnedEventFields,
  };
};
