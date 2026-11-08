import { useEffect, useState, FC, useRef, useMemo } from 'react';
import { CapturedRequest, PinnedField } from '../types';
import { MockConfigRef } from '../../../shared/types';
import { t } from '../utils/i18n';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useHsfState } from '../hooks/useHsfState';
import {
  extractRequestData,
  preprocessData,
  setValueByPathInParsedData,
  tryParseJsonString,
} from '../utils/helpers';
import { TabPanel } from './TabPanel';
import { HeadersTab } from './tabs/HeadersTab';
import { RequestTab } from './tabs/RequestTab';
import { ResponseTab } from './tabs/ResponseTab';
import { EventStreamTab } from './tabs/EventStreamTab';
import { JsonModal } from './modal';
import { ShareLogLinkButton } from './detail/ShareLogLinkButton';
import { TraceidCopyButton } from './detail/TraceidCopyButton';
import { normalizeSseMessageData } from '../utils/sseMessageData';

const COLLAPSE_STORAGE_KEY = 'mearl-detail-collapsed';
const ACTIVE_TAB_KEY = 'mearl-detail-active-tab';

interface ModalData {
  title: string;
  type: 'request' | 'response';
  pathPrefix: string;
  data: any;
  editable?: boolean;
  onValueChange?: (path: string[], newValue: any) => void;
}

interface RequestDetailProps {
  inspectedTabId?: number;
  request: CapturedRequest | null;
  pinnedFields: PinnedField[];
  onPinField: (path: string[], value: any, type: 'request' | 'response') => void;
  onUnpinField: (path: string, apiName: string, type: 'request' | 'response') => void;
  onReorderPinnedFields?: (
    fromIndex: number,
    toIndex: number,
    apiName: string,
    type: 'request' | 'response',
  ) => void;
  modificationEnabled: boolean;
  onSetResponseOverride: (request: CapturedRequest, modifiedData: any) => void;
  onRemoveResponseOverride: (request: CapturedRequest) => void;
  onSetRedirect?: (sourceUrl: string, redirectUrl: string | null) => void;
  requestMetadataEnabled?: boolean;
  requestCasesEnabled?: boolean;
  requestImportEnabled?: boolean;
  trackingMetadataEnabled?: boolean;
}

export const RequestDetail: FC<RequestDetailProps> = ({
  inspectedTabId,
  request,
  pinnedFields,
  onPinField,
  onUnpinField,
  onReorderPinnedFields,
  modificationEnabled,
  onSetResponseOverride,
  onRemoveResponseOverride,
  onSetRedirect,
  requestMetadataEnabled = false,
  requestCasesEnabled = false,
  requestImportEnabled = false,
  trackingMetadataEnabled = false,
}) => {
  const {
    hsfEnabled,
    hsfLoading,
    hsfDisplayValue,
    hsfMaintainerDisplayValue,
    hsfMaintainerTitle,
    onToggleHsf,
    onOpenHsf,
  } = useHsfState(request, requestMetadataEnabled);

  const [modalData, setModalData] = useState<ModalData | null>(null);
  const [collapsedSections, setCollapsedSections] = useLocalStorage<Record<string, boolean>>(
    COLLAPSE_STORAGE_KEY,
    {},
  );
  const [activeTab, setActiveTab] = useLocalStorage<string>(ACTIVE_TAB_KEY, 'headers');

  // 管理 JSON 展开状态
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});

  // Tab 内容滚动容器的统一 ref
  const tabContentRef = useRef<HTMLDivElement>(null);

  // 统一的展开/收起方法，支持单个和批量更新
  const handleToggleExpand = (paths: Record<string, boolean>) => {
    setExpandedPaths(prev => ({
      ...prev,
      ...paths,
    }));
  };

  useEffect(() => {
    setModalData(null);
    setExpandedPaths({});
  }, [request?.id]);

  // 源码追溯：跳转到指定字段（切 tab、展开祖先、滚动到目标行）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ requestId: number; path: string[] }>).detail;
      if (!detail || !request || request.id !== detail.requestId) return;

      setActiveTab('response');

      const prefix = 'response-body';
      const expansions: Record<string, boolean> = { [prefix]: true };
      for (let i = 0; i < detail.path.length; i++) {
        const k = `${prefix}.${detail.path.slice(0, i + 1).join('.')}`;
        expansions[k] = true;
      }
      setExpandedPaths(prev => ({ ...prev, ...expansions }));

      // 等 React 把展开渲染出来再滚动
      setTimeout(() => {
        const fullKey = `${prefix}.${detail.path.join('.')}`;
        const target = document.querySelector(
          `[data-json-path="${CSS.escape(fullKey)}"]`,
        ) as HTMLElement | null;
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const original = target.style.backgroundColor;
        const originalTransition = target.style.transition;
        target.style.transition = 'background-color 0.3s';
        target.style.backgroundColor = 'rgba(245, 158, 11, 0.35)';
        setTimeout(() => {
          target.style.backgroundColor = original;
          setTimeout(() => {
            target.style.transition = originalTransition;
          }, 350);
        }, 1500);
      }, 150);
    };
    window.addEventListener('mearl-trace-reveal-field', handler);
    return () => window.removeEventListener('mearl-trace-reveal-field', handler);
  }, [request?.id, setActiveTab]);

  // 自动切换 Tab 逻辑
  useEffect(() => {
    if (!request) return;

    // 如果是 SSE 请求且正在进行中，从 response tab 自动切换到 eventstream tab
    if (request.isSSE && request.isPending && activeTab === 'response') {
      setActiveTab('eventstream');
    }

    // 如果不是 SSE 请求，从 eventstream tab 自动切回 response tab
    if (!request.isSSE && activeTab === 'eventstream') {
      setActiveTab('response');
    }
  }, [request?.id, request?.isSSE, request?.isPending]);

  const toggleSection = (id: string) => {
    setCollapsedSections(prev => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  // 提取并预处理请求数据（统一处理 POST 和 GET 请求）
  const parsedRequestData = useMemo(() => {
    if (!request) return null;
    const requestData = extractRequestData(request);
    return requestData ? preprocessData(requestData) : null;
  }, [request?.proxyData, request?.postData, request?.queryString]);

  // 获取当前显示的响应数据（已修改的或原始的）
  const getCurrentResponseData = () => {
    return request?.responseOverride?.modifiedData || request?.responseBody;
  };

  // 预处理响应数据
  const parsedResponseData = useMemo(() => {
    return preprocessData(getCurrentResponseData());
  }, [request?.responseOverride?.modifiedData, request?.responseBody]);

  // 处理字段值修改
  const handleValueChange = (path: string[], newValue: any) => {
    if (!request) return;

    const currentData = getCurrentResponseData();

    // 使用辅助函数处理嵌套的 JSON 字符串
    const updatedData = setValueByPathInParsedData(currentData, parsedResponseData, path, newValue);

    // 应用修改
    onSetResponseOverride(request, updatedData);
  };

  // 处理关注字段值修改
  const handlePinnedFieldValueChange = (_fieldPath: string) => (path: string[], newValue: any) => {
    // path 已经是完整的路径（包含 basePath），直接使用
    handleValueChange(path, newValue);
  };

  // 处理 SSE 单条消息的字段值修改
  // modifiedData 是「每条消息数据」的数组，仅替换被编辑的那一条，其余保持原样（或已有的 override）
  const handleSseMessageChange = (index: number, path: string[], newValue: any) => {
    if (!request?.sseMessages) return;
    const modified = request.responseOverride?.modifiedData;
    const overrideData = Array.isArray(modified) ? modified : undefined;
    // 各消息当前数据（override 优先），保持原始形态（对象或 JSON 字符串）
    const baseArray = request.sseMessages.map((m, i) => overrideData?.[i] ?? m.data);
    // 仅对被编辑的消息解析并写入（与 JsonViewer 展示的根一致，兼容 data 为 JSON 字符串的情况）
    const normalizedTarget = normalizeSseMessageData(baseArray[index]);
    const { parsed: parsedTarget } = tryParseJsonString(normalizedTarget);
    const updatedTarget = setValueByPathInParsedData(parsedTarget, parsedTarget, path, newValue);
    const newArray = baseArray.map((d, i) => (i === index ? updatedTarget : d));
    onSetResponseOverride(request, newArray);
  };

  // 处理响应时长修改
  const handleDurationChange = (duration: number | undefined) => {
    if (!request) return;

    // 获取当前的响应数据（如果没有修改过，就使用原始响应）
    const currentData = request.responseOverride?.modifiedData || request.responseBody;

    // 创建或更新响应覆盖对象
    const tempRequest = {
      ...request,
      responseOverride: {
        apiName: request.apiName,
        originalData: request.responseBody,
        modifiedData: currentData,
        ...(request.responseOverride || {}),
        duration: duration !== undefined ? duration : request.duration, // 未指定时沿用原始 duration
      },
    };

    // 应用修改（包括响应时长）
    onSetResponseOverride(tempRequest, currentData);
  };

  // 处理 Mock 配置变化
  const handleMockConfigChange = (config: MockConfigRef) => {
    if (!request) return;

    // 只在已有 mock 时更新 mockConfig，不触发新的 mock
    if (!request.responseOverride) return;
    const tempRequest = {
      ...request,
      responseOverride: {
        ...request.responseOverride,
        mockConfig: config,
      },
    };
    onSetResponseOverride(tempRequest, request.responseOverride.modifiedData);
  };

  // 处理场景名称备注变化
  const handleSceneCommentChange = (comment: string) => {
    if (!request || !request.responseOverride) return;
    const currentData = request.responseOverride.modifiedData;
    const tempRequest = {
      ...request,
      responseOverride: {
        ...request.responseOverride,
        sceneComment: comment,
      },
    };
    onSetResponseOverride(tempRequest, currentData);
  };

  const handleModalValueChange = (path: string[], newValue: any) => {
    if (!modalData) return;

    if (modalData.onValueChange) {
      modalData.onValueChange(path, newValue);
      setModalData(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          data: setValueByPathInParsedData(prev.data, prev.data, path, newValue),
        };
      });
      return;
    }

    if (modificationEnabled && modalData.type === 'response') {
      handleValueChange(path, newValue);
      setModalData(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          data: setValueByPathInParsedData(prev.data, prev.data, path, newValue),
        };
      });
    }
  };

  // 根据 pathPrefix 动态获取对应的数据

  if (!request) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-bg-primary text-text-secondary">
        <div className="text-center text-xs">
          <p>{t('noRequests')}</p>
        </div>
      </div>
    );
  }

  const handleRemoveOverride = () => {
    onRemoveResponseOverride(request);
  };

  const isModalEditable =
    modalData?.editable ?? (modificationEnabled && modalData?.type === 'response');
  const traceid = request.responseHeaders.find(
    header => header.name.toLowerCase() === 'eagleeye-traceid',
  )?.value;

  return (
    <div className="w-full h-full flex flex-col bg-bg-primary text-text-primary">
      <TabPanel
        tabs={[
          {
            id: 'headers',
            label: t('headersTab'),
            content: (
              <HeadersTab
                request={request}
                collapsedSections={collapsedSections}
                toggleSection={toggleSection}
                expandedPaths={expandedPaths}
                onToggleExpand={handleToggleExpand}
                onTabChange={setActiveTab}
                showHsfEntry={request.source !== 'requests' && requestMetadataEnabled}
                hsfEnabled={hsfEnabled}
                hsfLoading={hsfLoading}
                hsfDisplayValue={hsfDisplayValue}
                hsfMaintainerDisplayValue={hsfMaintainerDisplayValue}
                hsfMaintainerTitle={hsfMaintainerTitle}
                onToggleHsf={onToggleHsf}
                onOpenHsf={onOpenHsf}
                onOpenModal={setModalData}
                requestMetadataEnabled={requestMetadataEnabled}
                requestImportEnabled={requestImportEnabled}
                trackingMetadataEnabled={trackingMetadataEnabled}
              />
            ),
          },
          {
            id: 'request',
            label: t('requestTab'),
            content: (
              <RequestTab
                inspectedTabId={inspectedTabId}
                request={request}
                parsedRequestData={parsedRequestData}
                collapsedSections={collapsedSections}
                toggleSection={toggleSection}
                pinnedFields={pinnedFields}
                onUnpinField={onUnpinField}
                onPinField={onPinField}
                onReorderPinnedFields={onReorderPinnedFields}
                expandedPaths={expandedPaths}
                onToggleExpand={handleToggleExpand}
                onOpenModal={setModalData}
              />
            ),
          },
          {
            id: 'response',
            label: t('responseTab'),
            content: (
              <ResponseTab
                request={request}
                parsedResponseData={parsedResponseData}
                collapsedSections={collapsedSections}
                toggleSection={toggleSection}
                pinnedFields={pinnedFields}
                onUnpinField={onUnpinField}
                onPinField={onPinField}
                onReorderPinnedFields={onReorderPinnedFields}
                modificationEnabled={modificationEnabled}
                expandedPaths={expandedPaths}
                onToggleExpand={handleToggleExpand}
                onValueChange={handleValueChange}
                onValueChangeForField={handlePinnedFieldValueChange}
                onRemoveOverride={handleRemoveOverride}
                onOpenModal={setModalData}
                onDurationChange={handleDurationChange}
                onMockConfigChange={handleMockConfigChange}
                onSceneCommentChange={handleSceneCommentChange}
                onSetRedirect={request.source === 'requests' ? onSetRedirect : undefined}
                requestCasesEnabled={requestCasesEnabled}
              />
            ),
          },
          // 只在 SSE 请求时显示 EventStream Tab
          ...(request.isSSE
            ? [
                {
                  id: 'eventstream',
                  label: 'EventStream',
                  content: (
                    <EventStreamTab
                      request={request}
                      collapsedSections={collapsedSections}
                      toggleSection={toggleSection}
                      expandedPaths={expandedPaths}
                      onToggleExpand={handleToggleExpand}
                      containerRef={tabContentRef}
                      onSwitchToResponse={() => setActiveTab('response')}
                      modificationEnabled={modificationEnabled}
                      onMessageDataChange={handleSseMessageChange}
                      onResetOverride={handleRemoveOverride}
                    />
                  ),
                },
              ]
            : []),
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        contentRef={tabContentRef}
        rightActions={
          <div className="flex items-center gap-0.5">
            {traceid && <TraceidCopyButton traceid={traceid} />}
            {requestImportEnabled && <ShareLogLinkButton request={request} />}
          </div>
        }
      />

      {/* JSON 全屏模态框 */}
      <JsonModal
        isOpen={!!modalData}
        onClose={() => setModalData(null)}
        title={modalData?.title || ''}
        data={modalData?.data ?? null}
        onPinField={
          modalData
            ? (path, value) => {
                onPinField(path, value, modalData.type);
              }
            : undefined
        }
        editable={isModalEditable}
        onValueChange={isModalEditable ? handleModalValueChange : undefined}
        expandedPaths={expandedPaths}
        onToggleExpand={handleToggleExpand}
        pathPrefix={modalData?.pathPrefix || ''}
      />
    </div>
  );
};
