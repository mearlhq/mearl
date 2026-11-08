import { useMemo, useRef } from 'react';
import { getEventLabel } from '../components/EventList';
import { CapturedRequest, PinnedField, PinnedEventField, ResponseOverride, RumEvent } from '../types';
import {
  computePinnedFieldsForRequest,
  filterRequestsByText,
  getEventSubType,
  getValueByPath,
} from '../utils/helpers';
import { getRumEventFilterType } from '../utils/rumEventTypes';

interface UsePanelDerivedDataOptions {
  requests: CapturedRequest[];
  nonCapturedRequests: CapturedRequest[];
  rumEvents: RumEvent[];
  pinnedFields: PinnedField[];
  pinnedEventFields: PinnedEventField[];
  selectedRequestId: number | null;
  selectedRumEventId: string | null;
  hiddenApisSet: Set<string>;
  hiddenNonProtocolApisSet: Set<string>;
  filterText: string;
  rumFilterText: string;
  rumSelectedTypes: string[];
  apiOverrides: Map<string, ResponseOverride[]>;
}

export const usePanelDerivedData = ({
  requests,
  nonCapturedRequests,
  rumEvents,
  pinnedFields,
  pinnedEventFields,
  selectedRequestId,
  selectedRumEventId,
  hiddenApisSet,
  hiddenNonProtocolApisSet,
  filterText,
  rumFilterText,
  rumSelectedTypes,
  apiOverrides,
}: UsePanelDerivedDataOptions) => {
  // WeakMap 缓存 pinnedFields 计算结果：同一 request 对象引用不重新计算
  const pinnedFieldsCacheRef = useRef<WeakMap<CapturedRequest, PinnedField[]>>(new WeakMap());
  const prevPinnedFieldsRef = useRef<PinnedField[]>([]);

  // 获取当前请求的关注字段（按 apiName 匹配）
  // 为有关注字段的请求计算实际值（包括解析 String 类型的 JSON）
  const allPinnedFieldsWithValues = useMemo(() => {
    if (pinnedFields.length === 0) {
      pinnedFieldsCacheRef.current = new WeakMap();
      prevPinnedFieldsRef.current = pinnedFields;
      return new Map<number, PinnedField[]>();
    }

    // pinnedFields 引用变化时清空缓存，避免旧值残留
    if (pinnedFields !== prevPinnedFieldsRef.current) {
      pinnedFieldsCacheRef.current = new WeakMap();
      prevPinnedFieldsRef.current = pinnedFields;
    }

    // 按 apiName 分组 pinnedFields
    const fieldsByApi = new Map<string, PinnedField[]>();
    pinnedFields.forEach(field => {
      const fields = fieldsByApi.get(field.apiName);
      if (fields) {
        fields.push(field);
      } else {
        fieldsByApi.set(field.apiName, [field]);
      }
    });

    const cache = pinnedFieldsCacheRef.current;
    const result = new Map<number, PinnedField[]>();

    const computeForRequest = (req: CapturedRequest) => {
      const apiFields = fieldsByApi.get(req.apiName);
      if (!apiFields) return;

      // 命中缓存：req 对象引用未变（数据未更新），直接复用
      if (cache.has(req)) {
        result.set(req.id, cache.get(req)!);
        return;
      }

      const fieldsWithValues = computePinnedFieldsForRequest(req, apiFields);

      cache.set(req, fieldsWithValues);
      result.set(req.id, fieldsWithValues);
    };

    requests.forEach(computeForRequest);
    nonCapturedRequests.forEach(computeForRequest);

    return result;
  }, [pinnedFields, requests, nonCapturedRequests]);

  // 获取当前选中请求的关注字段
  const currentPinnedFields = useMemo(() => {
    if (!selectedRequestId) return [];
    return allPinnedFieldsWithValues.get(selectedRequestId) || [];
  }, [allPinnedFieldsWithValues, selectedRequestId]);

  const filteredRequests = useMemo(() => {
    const visibleRequests = [
      ...requests.filter(r => !hiddenApisSet.has(r.apiName)),
      ...nonCapturedRequests.filter(r => !hiddenNonProtocolApisSet.has(r.apiName)),
    ].sort((a, b) => a.timestampMs - b.timestampMs);
    return filterRequestsByText(visibleRequests, filterText, ['apiName', 'url']);
  }, [requests, nonCapturedRequests, hiddenApisSet, hiddenNonProtocolApisSet, filterText]);

  const rumAvailableTypes = useMemo(() => {
    // key 格式: "${source}/${eventTypeKey}"，如 "rum/view" "aplus/EXP"
    const counts = new Map<string, number>();
    rumEvents.forEach(ev => {
      const key = getRumEventFilterType(ev);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    const SOURCE_ORDER = ['rum', 'arms', 'aplus'];
    const TYPE_ORDER = [
      'view',
      'fsp',
      'error',
      'action',
      'custom',
      'EXP',
      'CLK',
      'PV',
      'SDF',
      'pv',
      'perf',
      'health',
      'resource:xhr',
      'resource:fetch',
      'assets',
    ];
    const LAST_TYPE = 'resource:other';
    return Array.from(counts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => {
        const [aSrc, aEvKey] = a.type.split('/');
        const [bSrc, bEvKey] = b.type.split('/');
        const srcCmp = SOURCE_ORDER.indexOf(aSrc) - SOURCE_ORDER.indexOf(bSrc);
        if (srcCmp !== 0) return srcCmp;
        if (aEvKey === LAST_TYPE) return 1;
        if (bEvKey === LAST_TYPE) return -1;
        const ia = TYPE_ORDER.indexOf(aEvKey);
        const ib = TYPE_ORDER.indexOf(bEvKey);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return aEvKey.localeCompare(bEvKey);
      });
  }, [rumEvents]);

  const filteredRumEvents = useMemo(() => {
    const result =
      rumSelectedTypes.length > 0
        ? rumEvents.filter(ev => rumSelectedTypes.includes(getRumEventFilterType(ev)))
        : [];
    if (!rumFilterText.trim()) return result;
    try {
      const regex = new RegExp(rumFilterText, 'i');
      return result.filter(ev => regex.test(getEventLabel(ev)));
    } catch {
      const lower = rumFilterText.toLowerCase();
      return result.filter(ev => getEventLabel(ev).toLowerCase().includes(lower));
    }
  }, [rumEvents, rumFilterText, rumSelectedTypes]);

  const selectedRequest = filteredRequests.find(r => r.id === selectedRequestId) || null;
  const selectedRumEvent = filteredRumEvents.find(e => e.id === selectedRumEventId) || null;

  // ---- 埋点事件关注字段：按 eventSubType 匹配，为每个事件计算实际值 ----
  const allPinnedEventFieldsWithValues = useMemo(() => {
    if (pinnedEventFields.length === 0) return new Map<string, PinnedEventField[]>();

    // 按 eventSubType 分组
    const fieldsBySubType = new Map<string, PinnedEventField[]>();
    pinnedEventFields.forEach(field => {
      const fields = fieldsBySubType.get(field.eventSubType);
      if (fields) {
        fields.push(field);
      } else {
        fieldsBySubType.set(field.eventSubType, [field]);
      }
    });

    const result = new Map<string, PinnedEventField[]>();
    filteredRumEvents.forEach(ev => {
      const subType = getEventSubType(ev);
      const subTypeFields = fieldsBySubType.get(subType);
      if (!subTypeFields) return;

      const fieldsWithValues = subTypeFields.map(field => {
        const currentValue = getValueByPath(ev._raw, field.path);
        return { ...field, value: currentValue };
      });

      result.set(ev.id, fieldsWithValues);
    });

    return result;
  }, [pinnedEventFields, filteredRumEvents]);

  // 获取当前选中事件的关注字段
  const currentPinnedEventFields = useMemo(() => {
    if (!selectedRumEventId) return [];
    return allPinnedEventFieldsWithValues.get(selectedRumEventId) || [];
  }, [allPinnedEventFieldsWithValues, selectedRumEventId]);

  // 修改配置独立于运行时请求列表。
  const modifiedCount = useMemo(
    () => Array.from(apiOverrides.values()).flat().length,
    [apiOverrides],
  );

  return {
    allPinnedFieldsWithValues,
    currentPinnedFields,
    allPinnedEventFieldsWithValues,
    currentPinnedEventFields,
    filteredRequests,
    rumAvailableTypes,
    filteredRumEvents,
    selectedRequest,
    selectedRumEvent,
    modifiedCount,
  };
};
