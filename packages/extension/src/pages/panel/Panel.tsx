import { useBrowserUiSettings } from './utils/browserUiSettings';
import { useExtensionConfig } from './hooks/useExtensionConfig';
import { useState, useEffect, useCallback, useMemo, useRef, FC, lazy, Suspense } from 'react';
import {
  CapturedRequest,
  NavigationDivider,
  PinnedField,
  PinnedEventField,
  ResponseOverride,
  RumEvent,
} from './types';
import { RequestList } from './components/RequestList';
import { RequestDetail } from './components/RequestDetail';
import { EventList } from './components/EventList';
import { EventDetail } from './components/EventDetail';
import { Header, HostPermissionBanner } from './components/header';
import { BottomStatusBar } from './components/BottomStatusBar';
import { StatusPanel } from './components/StatusPanel';
import { AgentStatusModal } from './components/AgentStatusModal';
import { MockEditModal } from './components/modal/MockEditModal';
import { SettingsModal } from './components/SettingsModal';
import { ToastContainer } from './components/ToastContainer';
import { ResizablePanels } from './components/ResizablePanels';
import { useLocalStorage } from './hooks/useLocalStorage';
import { useCaptureIdentity } from './hooks/useCaptureIdentity';
import { useRequestMetadataLogin } from './hooks/useRequestMetadataLogin';
import { browserUiText } from '@mearl/preset/bundles';
import { useModificationStatus } from './hooks/useModificationStatus';
import { useAgentBridgeStatus } from './hooks/useAgentBridgeStatus';
import { useCloudConnectorStatus } from './hooks/useCloudConnectorStatus';
import { usePanelPortBridge } from './hooks/usePanelPortBridge';
import { ElementPickerTabContext } from './hooks/useElementPicker';
import { useDevtoolsRequestHandler } from './hooks/useDevtoolsRequestHandler';
import { usePanelActions } from './hooks/usePanelActions';
import { useHostPermissionPrompt } from './hooks/useHostPermissionPrompt';
import { useContentScriptUnreachableToast } from './hooks/useContentScriptUnreachableToast';
import { useSourceTracer, type TraceResult, type FieldMatch } from './hooks/useSourceTracer';
import { SourceTraceCard } from './components/SourceTraceCard';
import { showToast } from './utils/toast';
import { checkAndConsumeReloadToast } from './utils/safeChrome';
import { usePanelDerivedData } from './hooks/usePanelDerivedData';
import { getRequestType, useRequestFilters } from './hooks/useRequestFilters';
import { sendMessageSafely } from './utils/safeChrome';
import { initI18n, t, getCurrentLanguage } from './utils/i18n';
import { toggleSpmOverlay } from './utils/spmHighlight';
import {
  startHeatmap,
  stopHeatmap,
  detectPageSpmAB,
  detectPagePath,
  getYesterdayDs,
  type HeatmapErrorCode,
  type HeatmapMeasure,
  type HeatmapStartResult,
  type HeatmapStatus,
} from './utils/heatmap';
import { setValueByPathInParsedData } from './utils/helpers';
import { normalizeRumSelectedTypes } from './utils/rumEventTypes';
import type { PanelRequestCaptureState } from './utils/capturedState';
import { appendNavigationDivider } from './utils/navigationDividers';
import { PANEL_PRESERVE_LOG_KEY } from '../../shared/devicePreviewPanel';

const RequestCasesModal = lazy(() =>
  import('./components/request-cases/RequestCasesModal').then(m => ({ default: m.RequestCasesModal })),
);

const RequestImportModal = lazy(() =>
  import('./components/request-import/RequestImportModal').then(m => ({
    default: m.RequestImportModal,
  })),
);

const LoginModal = lazy(() =>
  import('./components/LoginModal').then(m => ({ default: m.LoginModal })),
);

interface PanelProps {
  previewToken?: string;
}

export const Panel: FC<PanelProps> = ({ previewToken }) => {
  const isDevtools = previewToken === undefined;
  const [previewState, setPreviewState] = useState<'connecting' | 'capturing' | 'error'>('connecting');
  const browserUiSettings = useBrowserUiSettings();
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState<number | null>(null);
  const [preserveLog, setPreserveLog] = useLocalStorage<boolean>(PANEL_PRESERVE_LOG_KEY, false, { sync: true });
  const [navigationDividers, setNavigationDividers] = useState<NavigationDivider[]>([]);
  const [isHiddenListExpanded, setIsHiddenListExpanded] = useState<boolean>(false);
  const [tabId, setTabId] = useState<number | null>(null);
  const [apiOverrides, setApiOverrides] = useState<Map<string, ResponseOverride[]>>(new Map());
  const [showRequestCasesModal, setShowRequestCasesModal] = useState<boolean>(false);
  const [showRequestImportModal, setShowRequestImportModal] = useState<boolean>(false);
  const [editingOverrideId, setEditingOverrideId] = useState<string | null>(null);
  const [showAgentModal, setShowAgentModal] = useState<boolean>(false);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [config, configLoaded] = useExtensionConfig(undefined, { localOnly: !isDevtools });
  const {
    agentEnabled,
    accountsEnabled,
    requestCasesEnabled,
    requestMetadataEnabled,
    requestImportEnabled,
    trackingMetadataEnabled,
    globalTranslation,
  } = config;
  const trackingMetadataEnabledRef = useRef(trackingMetadataEnabled);
  trackingMetadataEnabledRef.current = trackingMetadataEnabled;
  const [configReady, setConfigReady] = useState<boolean>(false);
  const [filterText, setFilterText] = useState<string>('');
  const [storedMode, setMode] = useLocalStorage<'protocol' | 'rum'>('panel-mode', 'protocol');
  const mode = storedMode === 'rum' ? 'rum' : 'protocol';
  const [nonCapturedRequests, setNonCapturedRequests] = useState<CapturedRequest[]>([]);
  const [showAllSpm, setShowAllSpm] = useState<boolean>(false);
  const spmOverlayRevision = useRef(0);

  // ─── 热度地图 ──────────────────────────────────────────────────────────────
  const [pageSpmAB, setPageSpmAB] = useState<string | null>(null);
  const [pagePath, setPagePath] = useState<string | null>(null);
  const isTripPath = !!pagePath && !!browserUiSettings.heatmap && pagePath.startsWith(browserUiSettings.heatmap.pathPrefix);
  const isTripPathRef = useRef(isTripPath);
  useEffect(() => {
    isTripPathRef.current = isTripPath;
  }, [isTripPath]);
  const [storedHeatmapMeasure, setHeatmapMeasure] = useLocalStorage<HeatmapMeasure>('panel-heatmap-measure', '');
  const heatmapMeasure = browserUiSettings.heatmap?.measures.some(value => value.id === storedHeatmapMeasure) ? storedHeatmapMeasure : browserUiSettings.heatmap?.defaultMeasure ?? '';
  const [heatmapStatus, setHeatmapStatus] = useState<HeatmapStatus>('idle');
  const [heatmapError, setHeatmapError] = useState<string | null>(null);
  const [heatmapErrorCode, setHeatmapErrorCode] = useState<HeatmapErrorCode | null>(null);
  const heatmapStatusRef = useRef(heatmapStatus);
  useEffect(() => {
    heatmapStatusRef.current = heatmapStatus;
  }, [heatmapStatus]);
  const heatmapMeasureRef = useRef(heatmapMeasure);
  useEffect(() => {
    heatmapMeasureRef.current = heatmapMeasure;
  }, [heatmapMeasure]);
  // 数据日期 ds（yyyyMMdd）；不持久化，panel 重开默认 T-1
  const [heatmapDs, setHeatmapDs] = useState<string>(() => getYesterdayDs());
  const heatmapDsRef = useRef(heatmapDs);
  useEffect(() => {
    heatmapDsRef.current = heatmapDs;
  }, [heatmapDs]);
  const [, forceUpdate] = useState({});
  // 记录最近被自动翻译的 API 名，用于在请求创建时打标记
  const recentlyAutoTranslatedRef = useRef<Set<string>>(new Set());
  const [cachedAppList, setCachedAppList] = useState<any[]>([]);

  // RUM 模式状态
  const [rumEvents, setRumEvents] = useState<RumEvent[]>([]);
  const [selectedRumEventId, setSelectedRumEventId] = useState<string | null>(null);
  const [rumFilterText, setRumFilterText] = useState<string>('');
  const [rumSelectedTypes, setRumSelectedTypes] = useLocalStorage<string[]>('rum-selected-types', [
    'rum/view',
    'rum/EXP',
    'rum/CLK',
    'aplus/EXP',
    'aplus/CLK',
  ]);
  useEffect(() => {
    const normalizedTypes = normalizeRumSelectedTypes(rumSelectedTypes);
    if (normalizedTypes !== rumSelectedTypes) setRumSelectedTypes(normalizedTypes);
  }, [rumSelectedTypes, setRumSelectedTypes]);

  // 使用 useLocalStorage hook 管理持久化数据（全局存储）
  const [pinnedFields, setPinnedFields] = useLocalStorage<PinnedField[]>('mearl-pinned-fields', []);
  const [pinnedEventFields, setPinnedEventFields] = useLocalStorage<PinnedEventField[]>(
    'rum-pinned-fields',
    [],
  );
  const [hiddenApis, setHiddenApis] = useLocalStorage<string[]>('mearl-hidden-apis', []);
  const [hiddenNonProtocolApis, setHiddenNonProtocolApis] = useLocalStorage<string[]>(
    'requests-hidden-apis',
    [],
  );

  // Refs for accessing current state inside port.onMessage handler (avoids stale closure)
  const requestsRef = useRef<CapturedRequest[]>([]);
  const nonCapturedRequestsRef = useRef<CapturedRequest[]>([]);
  const rumEventsRef = useRef<RumEvent[]>([]);
  const hiddenApisRef = useRef<string[]>([]);
  const hiddenNonProtocolApisRef = useRef<string[]>([]);
  const requestCaptureStateRef = useRef<PanelRequestCaptureState>({
    source: 'devtools',
    debuggerSince: 0,
  });
  useEffect(() => {
    requestsRef.current = requests;
  }, [requests]);
  useEffect(() => {
    nonCapturedRequestsRef.current = nonCapturedRequests;
  }, [nonCapturedRequests]);
  useEffect(() => {
    rumEventsRef.current = rumEvents;
  }, [rumEvents]);
  useEffect(() => {
    hiddenApisRef.current = hiddenApis;
  }, [hiddenApis]);
  useEffect(() => {
    hiddenNonProtocolApisRef.current = hiddenNonProtocolApis;
  }, [hiddenNonProtocolApis]);

  // 使用 抓包身份 Hook：登录弹窗状态在这里订阅，userInfo 由各子组件直接通过 hook 访问
  const { loginModalOpen, closeLoginWindow, loginDefinition: captureLoginDefinition } = useCaptureIdentity({
    source: 'cookie-first',
    lazy: true,
  });
  const {
    loginModalOpen: requestMetadataLoginModalOpen,
    closeLoginModal: closeRequestMetadataLogin,
    loginDefinition: metadataLoginDefinition,
  } = useRequestMetadataLogin();

  // 使用 useModificationStatus hook 管理响应修改状态
  const { modificationEnabled, toggleModification, syncDebuggerStatus } = useModificationStatus({
    tabId,
  });
  const { handleRequest: handleDevtoolsRequest } = useDevtoolsRequestHandler({
    captureStateRef: requestCaptureStateRef,
    modificationEnabled,
    apiOverrides,
    setRequests,
    setNonCapturedRequests,
    setRumEvents,
    recentlyAutoTranslatedRef,
  });

  // 使用 useAgentBridgeStatus hook 管理 Agent Bridge 生命周期与连接状态
  const { agentConnected } = useAgentBridgeStatus({
    tabId,
    configReady,
    agentEnabled,
  });

  // 云端连接器状态：用于在 agent 徽标上展示云图标
  const { state: cloudConnectorState } = useCloudConnectorStatus(agentEnabled);

  const { currentHost, needsPermission, grantCurrentHostPermission, dismissCurrentHostPrompt } =
    useHostPermissionPrompt(tabId);

  // 用户主动操作（选择元素/高亮/inspect）时若页面无 content script，按需提示授权。
  useContentScriptUnreachableToast(tabId);

  // 将 hiddenApis 数组转换为 Set 以便低阶查找
  const hiddenApisSet = useMemo(() => new Set(hiddenApis), [hiddenApis]);
  const hiddenNonProtocolApisSet = useMemo(() => new Set(hiddenNonProtocolApis), [hiddenNonProtocolApis]);

  const editingOverride = useMemo(
    () =>
      editingOverrideId
        ? Array.from(apiOverrides.values())
            .flat()
            .find(o => o.id === editingOverrideId)
        : undefined,
    [editingOverrideId, apiOverrides],
  );

  useEffect(() => {
    if (!configLoaded) return;
    let disposed = false;
    // The preview subscribes to browser UI settings independently of its local translations.
    void initI18n(config.language, { localOnly: !isDevtools }).then(() => {
      if (disposed) return;
      setConfigReady(true);
      forceUpdate({});
    });
    return () => {
      disposed = true;
    };
  }, [config.language, configLoaded, isDevtools]);

  useEffect(() => {
    if (checkAndConsumeReloadToast()) showToast(t('extension_reloaded'), 'info');
  }, []);

  // 实时翻译：当设置变化时通知 background，并清理之前的翻译标记
  // configReady 为 false 时跳过，避免初始 'none' 值在配置加载前错误地覆盖 background 状态
  useEffect(() => {
    if (!configReady || (!isDevtools && !tabId)) return;

    // 通知 background 更新实时翻译目标
    chrome.runtime
      .sendMessage({
        action: 'setGlobalTranslation',
        target: globalTranslation,
      })
      .catch(() => {});

    // 切换语言或关闭时清理之前的翻译标记
    recentlyAutoTranslatedRef.current.clear();
    setRequests(prev =>
      prev.map(r => {
        if (!r.isAutoTranslated) return r;
        const { isAutoTranslated: _isAutoTranslated, ...rest } = r;
        return rest as CapturedRequest;
      }),
    );
  }, [globalTranslation, configReady, isDevtools, tabId]);

  // 获取当前 tab ID 并加载已有的响应覆盖配置
  useEffect(() => {
    const currentTabId = isDevtools ? chrome.devtools.inspectedWindow.tabId : tabId;
    if (currentTabId) {
      setTabId(currentTabId);
      // 不再自动检测 content script 状态，改为按需检测

      // 从 background 加载已有的响应覆盖配置
      sendMessageSafely({
        action: 'getOverrides',
        tabId: currentTabId,
      }).then(response => {
        if (response && response.overrides && response.overrides.length > 0) {
          setApiOverrides(() => {
            const overridesMap = new Map<string, ResponseOverride[]>();
            response.overrides.forEach((override: any) => {
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
                sceneComment: override.sceneComment,
                source: override.source,
              };
              const list = overridesMap.get(override.apiName) || [];
              list.push(item);
              overridesMap.set(override.apiName, list);
            });
            return overridesMap;
          });
        }
      });
    }
  }, [isDevtools, isDevtools ? null : tabId]);

  // 源码追溯结果（picker → fiber → 字段匹配）
  const [traceResult, setTraceResult] = useState<TraceResult | null>(null);

  // 通过 hook 统一管理 SSE 与 background 长连接消息桥接
  const { clearPreview, retryPreview, markPreviewReady } = usePanelPortBridge({
    previewToken,
    onPreviewState: (id, state) => {
      if (id !== null) setTabId(id);
      setPreviewState(state);
    },
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
  });

  useEffect(() => {
    if (!isDevtools && configReady && tabId !== null) markPreviewReady();
  }, [configReady, isDevtools, markPreviewReady, tabId]);

  useEffect(() => {
    if (!isDevtools) return;
    chrome.devtools.network.onRequestFinished.addListener(handleDevtoolsRequest);

    // 网络日志的清空/分隔只跟随真正的跨文档主框架导航（由 background 的
    // webNavigation.onCommitted 转发为 mearl-main-frame-committed 事件）。DevTools 的
    // onNavigated 对 SPA 同文档路由（pushState/replaceState/hash）同样会触发，用它
    // 清空会把页面未跳转时采集到的请求误删。
    const handleMainFrameCommitted = (event: Event) => {
      const detail = (event as CustomEvent<{ url: string; timestampMs?: number }>).detail;
      const url = detail?.url ?? '';
      const timestampMs = typeof detail?.timestampMs === 'number' && Number.isFinite(detail.timestampMs)
        ? detail.timestampMs : Date.now();
      setTraceResult(null);
      if (!preserveLog) {
        requestCaptureStateRef.current = { ...requestCaptureStateRef.current };
        setRequests([]);
        setSelectedRequestId(null);
        setRumEvents([]);
        setSelectedRumEventId(null);
        setNonCapturedRequests([]);
        setNavigationDividers([]);
        // 注意：pinnedFields 不清空，它们是持久化的配置
      } else {
        // 保留日志模式：每次真实跨文档跳转追加一条导航分隔点
        setNavigationDividers(prev => appendNavigationDivider(prev, url, timestampMs));
      }
    };

    // SPM 高亮、当前页路径与热度地图跟随 DevTools 的导航通知刷新：这些副作用在
    // 同文档路由后也需要按最新 URL 重新对齐，且均为幂等操作。
    const handleNavigated = (url: string) => {
      // 同步当前页路径（用于判断是否启用热度数据）
      try {
        setPagePath(new URL(url).pathname);
      } catch {
        setPagePath(null);
      }
      // 页面跳转后重新识别 spmAB 并按需重启热度地图
      setTimeout(() => {
        detectPageSpmAB().then(ab => {
          setPageSpmAB(ab);
          if (
            trackingMetadataEnabledRef.current &&
            ab &&
            heatmapStatusRef.current === 'active' &&
            isTripPathRef.current
          ) {
            setHeatmapStatus('loading');
            startHeatmap(ab, heatmapMeasureRef.current, heatmapDsRef.current).then(r =>
              applyHeatmapResultRef.current(r),
            );
          }
        });
      }, 800);
    };

    window.addEventListener('mearl-main-frame-committed', handleMainFrameCommitted);
    chrome.devtools.network.onNavigated.addListener(handleNavigated);

    return () => {
      chrome.devtools.network.onRequestFinished.removeListener(handleDevtoolsRequest);
      chrome.devtools.network.onNavigated.removeListener(handleNavigated);
      window.removeEventListener('mearl-main-frame-committed', handleMainFrameCommitted);
    };
  }, [handleDevtoolsRequest, preserveLog, isDevtools]);

  const clearRequests = () => {
    if (!isDevtools) clearPreview();
    sourceTracer.cancel();
    setTraceResult(null);
    requestCaptureStateRef.current = { ...requestCaptureStateRef.current };
    setRequests([]);
    setSelectedRequestId(null);
    setRumEvents([]);
    setSelectedRumEventId(null);
    setNonCapturedRequests([]);
    setNavigationDividers([]);
    // 注意：不清空 pinnedFields，它们是用户配置的持久化数据
  };

  const togglePreserveLog = () => {
    setPreserveLog(prev => !prev);
  };

  useEffect(() => {
    if (tabId === null || mode !== 'rum') return;
    const revision = ++spmOverlayRevision.current;
    void sendMessageSafely<{ enabled: boolean }>({ action: 'getSpmOverlayState', tabId }).then(state => {
      if (revision === spmOverlayRevision.current) setShowAllSpm(state?.enabled === true);
    }).catch(() => {});
    return () => { spmOverlayRevision.current++; };
  }, [tabId, mode]);

  const handleToggleShowAllSpm = () => {
    if (tabId === null) return;
    spmOverlayRevision.current++;
    const next = !showAllSpm;
    setShowAllSpm(next);
    toggleSpmOverlay(tabId, next);
  };

  // 切换离 rum 模式时关闭 SPM 全量高亮
  useEffect(() => {
    if (tabId !== null && mode !== 'rum' && showAllSpm) {
      setShowAllSpm(false);
      toggleSpmOverlay(tabId, false);
    }
  }, [mode, showAllSpm, tabId]);

  // ─── 热度地图：进入 rum 模式时识别一次 spmAB + 当前路径 ──────────────────
  useEffect(() => {
    if (isDevtools && mode === 'rum') {
      detectPageSpmAB().then(setPageSpmAB);
      detectPagePath().then(setPagePath);
    }
  }, [mode, browserUiSettings.heatmap, isDevtools]);

  const applyHeatmapResultRef = useRef<(r: HeatmapStartResult) => void>(() => {});
  const applyHeatmapResult = useCallback((result: HeatmapStartResult) => {
    if (!trackingMetadataEnabledRef.current || (!result.success && result.error === 'HEATMAP_CANCELLED'))
      return;
    if (result.success) {
      setHeatmapStatus('active');
      setHeatmapError(null);
      setHeatmapErrorCode(null);
    } else {
      setHeatmapStatus('error');
      setHeatmapError(result.error);
      setHeatmapErrorCode(result.errorCode);
    }
  }, []);

  useEffect(() => {
    applyHeatmapResultRef.current = applyHeatmapResult;
  }, [applyHeatmapResult]);

  const handleToggleHeatmap = useCallback(async () => {
    if (!trackingMetadataEnabledRef.current) return;
    if (heatmapStatus === 'active' || heatmapStatus === 'error') {
      // 关闭
      await stopHeatmap();
      setHeatmapStatus('idle');
      setHeatmapError(null);
      setHeatmapErrorCode(null);
      return;
    }
    if (!pageSpmAB) return;
    setHeatmapStatus('loading');
    const result = await startHeatmap(pageSpmAB, heatmapMeasure, heatmapDs);
    applyHeatmapResult(result);
  }, [heatmapStatus, pageSpmAB, heatmapMeasure, heatmapDs, applyHeatmapResult]);

  const handleSelectHeatmapMeasure = useCallback(
    async (m: HeatmapMeasure) => {
      setHeatmapMeasure(m);
      // 已开启则立即应用新指标（background 复用缓存）
      if (trackingMetadataEnabledRef.current && heatmapStatus === 'active' && pageSpmAB) {
        setHeatmapStatus('loading');
        const result = await startHeatmap(pageSpmAB, m, heatmapDs);
        applyHeatmapResult(result);
      }
    },
    [setHeatmapMeasure, heatmapStatus, pageSpmAB, heatmapDs, applyHeatmapResult],
  );

  const handleSelectHeatmapDs = useCallback(
    async (ds: string) => {
      if (ds === heatmapDs) return;
      setHeatmapDs(ds);
      // 已开启则按新日期重拉（背景层按 spmAB+ds 缓存，换日 = 重新发请求）
      if (trackingMetadataEnabledRef.current && heatmapStatus === 'active' && pageSpmAB) {
        setHeatmapStatus('loading');
        const result = await startHeatmap(pageSpmAB, heatmapMeasure, ds);
        applyHeatmapResult(result);
      }
    },
    [heatmapDs, heatmapStatus, pageSpmAB, heatmapMeasure, applyHeatmapResult],
  );

  // 热度地图按已安装设置、RUM 模式和路径范围显示。
  useEffect(() => {
    if ((!trackingMetadataEnabled || mode !== 'rum' || !isTripPath) && heatmapStatusRef.current !== 'idle') {
      stopHeatmap();
      setHeatmapStatus('idle');
      setHeatmapError(null);
      setHeatmapErrorCode(null);
    }
  }, [mode, isTripPath, trackingMetadataEnabled]);

  const hideApi = (apiName: string) => {
    setHiddenApis(prev => (prev.includes(apiName) ? prev : [...prev, apiName]));
  };

  const showApi = (apiName: string) => {
    setHiddenApis(prev => prev.filter(api => api !== apiName));
  };

  const hideNonProtocolApi = (apiName: string) => {
    setHiddenNonProtocolApis(prev => (prev.includes(apiName) ? prev : [...prev, apiName]));
  };

  const showNonProtocolApi = (apiName: string) => {
    setHiddenNonProtocolApis(prev => prev.filter(api => api !== apiName));
  };

  const handleSaveConditions = useCallback(
    async (
      id: string,
      apiName: string,
      conditions: Record<string, any> | undefined,
      responseData?: any,
    ) => {
      if (!tabId) return;
      const response = await sendMessageSafely({
        action: 'updateOverrideConditions',
        tabId,
        apiName,
        id,
        conditions,
        responseData,
      });
      if (response?.success) {
        setApiOverrides(prev => {
          const newMap = new Map(prev);
          const list = newMap.get(apiName);
          if (list) {
            newMap.set(
              apiName,
              list.map(o =>
                o.id === id
                  ? {
                      ...o,
                      conditions,
                      ...(responseData !== undefined && { modifiedData: responseData }),
                    }
                  : o,
              ),
            );
          }
          return newMap;
        });
      }
      setEditingOverrideId(null);
    },
    [tabId, setApiOverrides],
  );

  const {
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
  } = usePanelActions({
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
  });

  // 一键 Mock 源码追溯命中的所有字段：在原值后面追加 " {i}"，刷新后能在页面上直接对上原文
  const handleMockTracedFields = useCallback(
    async (matches: FieldMatch[]): Promise<number> => {
      if (matches.length === 0) return 0;
      // 同一 request 上的多个字段必须合并到一次 setResponseOverride，否则后写覆盖前写
      const grouped = new Map<
        FieldMatch['request']['id'],
        { request: FieldMatch['request']; entries: { match: FieldMatch; mockValue: string }[] }
      >();
      matches.forEach((m, idx) => {
        const key = m.request.id;
        let bucket = grouped.get(key);
        if (!bucket) {
          bucket = { request: m.request, entries: [] };
          grouped.set(key, bucket);
        }
        // 强转为 string 后拼上索引 —— 数值字段会被改成字符串，但带原值更易在页面上定位
        const mockValue = `${String(m.value)} ${idx}`;
        bucket.entries.push({ match: m, mockValue });
      });

      let applied = 0;
      for (const { request, entries } of grouped.values()) {
        const base = request.responseOverride?.modifiedData ?? request.responseBody;
        if (base == null) continue;
        // base 在极端情况下可能是 JSON 字符串（响应直接返回字符串载荷），先解析回对象
        let data: any = base;
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data);
          } catch {
            console.warn('[trace-mock] responseBody is non-JSON string, skip', request.apiName);
            continue;
          }
        }
        for (const { match, mockValue } of entries) {
          data = setValueByPathInParsedData(data, data, match.path, mockValue);
        }
        try {
          await setResponseOverride(request, data);
          applied += entries.length;
        } catch (err) {
          console.error('[trace-mock] setResponseOverride failed', request.apiName, err);
        }
      }
      return applied;
    },
    [setResponseOverride],
  );

  const {
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
  } = usePanelDerivedData({
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
  });

  const requestFilters = useRequestFilters(filteredRequests, requests.length > 0);
  const tracePageStartedAt = navigationDividers.at(-1)?.timestampMs ?? 0;
  const getTraceRequests = useCallback(
    () => requestFilters.displayedRequests.filter(request => request.timestampMs >= tracePageStartedAt),
    [requestFilters.displayedRequests, tracePageStartedAt],
  );
  const sourceTracer = useSourceTracer({
    getRequests: getTraceRequests,
    scopeKey: JSON.stringify([filterText, requestFilters.selectedTypes, requestFilters.selectedNamespaces, hiddenApis, hiddenNonProtocolApis, tracePageStartedAt]),
    onResult: setTraceResult,
  });
  const includeGenericRequests = requestFilters.selectedTypes.some(type => type !== 'protocol');
  // 拦截范围跟随类型选择，混合查看时同时支持两类请求的响应修改。
  useEffect(() => {
    if (!tabId || !modificationEnabled) return;
    sendMessageSafely({
      action: 'refreshFetchPatterns',
      tabId,
      includeGeneric: includeGenericRequests,
    }).catch(() => {});
  }, [includeGenericRequests, modificationEnabled, tabId]);

  const visibleSelectedRequest = requestFilters.displayedRequests.some(
    r => r.id === selectedRequestId,
  )
    ? selectedRequest
    : null;
  const allHiddenApis = Array.from(new Set([...hiddenApis, ...hiddenNonProtocolApis]));

  const handleJumpToTracedField = (match: FieldMatch) => {
    setMode('protocol');
    setFilterText('');
    requestFilters.setSelectedTypes([getRequestType(match.request)]);
    requestFilters.setSelectedNamespaces([]);
    setSelectedRequestId(match.request.id);
    // 详情挂载后切换到目标字段。
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('mearl-trace-reveal-field', {
          detail: { requestId: match.request.id, path: match.path },
        }),
      );
    }, 50);
  };

  const handleToggleRumType = useCallback(
    (type: string) => {
      setRumSelectedTypes(prev =>
        prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type],
      );
    },
    [setRumSelectedTypes],
  );

  // 等待 i18n 加载完成再渲染，避免首屏文案先中文后英文的闪烁
  if (!configReady || (!isDevtools && !tabId)) {
    return <div className="h-screen bg-gray-50" />;
  }

  const content = (
    <div className="flex flex-col h-screen bg-gray-50">
      <Header
        inspectedTabId={tabId ?? undefined}
        preserveLog={preserveLog}
        onTogglePreserveLog={togglePreserveLog}
        modificationEnabled={modificationEnabled}
        onToggleModification={toggleModification}
        mode={mode}
        onSetMode={setMode}
        onShowAgentStatus={() => setShowAgentModal(true)}
        agentConnected={agentConnected}
        cloudConnected={cloudConnectorState.connected}
        agentEnabled={agentEnabled}
        onShowSettings={() => setShowSettingsModal(true)}
        showAllSpm={showAllSpm}
        onToggleShowAllSpm={handleToggleShowAllSpm}
        heatmapAvailable={isDevtools && trackingMetadataEnabled && isTripPath}
        pageSpmAB={pageSpmAB}
        heatmapMeasure={heatmapMeasure}
        heatmapDs={heatmapDs}
        heatmapStatus={heatmapStatus}
        heatmapError={heatmapError}
        heatmapErrorCode={heatmapErrorCode}
        onSelectHeatmapMeasure={handleSelectHeatmapMeasure}
        onSelectHeatmapDs={handleSelectHeatmapDs}
        onToggleHeatmap={handleToggleHeatmap}
        accountsEnabled={accountsEnabled}
        onToggleSourceTrace={isDevtools ? sourceTracer.toggle : undefined}
        sourceTraceActive={sourceTracer.isPicking}
      />
      {!isDevtools && (
        <div role="status" className={previewState === 'error'
          ? 'flex items-center justify-between border-b border-border bg-bg-primary px-2 py-1 text-xs text-warning-text'
          : 'sr-only'}>
          {previewState === 'capturing' ? t('devicePreviewCapturing')
            : previewState === 'connecting' ? t('loading') : t('devicePreviewCaptureUnavailable')}
          {previewState === 'error' && <button type="button" className="rounded px-2 py-1 hover:bg-bg-hover" onClick={retryPreview}>{t('retry')}</button>}
        </div>
      )}
      {needsPermission && currentHost && (
        <HostPermissionBanner
          host={currentHost}
          onGrant={async () => {
            const granted = await grantCurrentHostPermission();
            if (!granted) {
              showToast(t('hostPermissionGrantFailed'), 'error');
              return;
            }
            showToast(t('hostPermissionGranted'), 'success');
          }}
          onClose={dismissCurrentHostPrompt}
        />
      )}

      {mode === 'rum' ? (
        <ResizablePanels
          leftPanel={
            <EventList
              events={filteredRumEvents}
              totalEventCount={rumEvents.length}
              onClear={clearRequests}
              selectedEventId={selectedRumEventId}
              onSelectEvent={setSelectedRumEventId}
              filterText={rumFilterText}
              onFilterChange={setRumFilterText}
              availableTypes={rumAvailableTypes}
              selectedTypes={rumSelectedTypes}
              onToggleType={handleToggleRumType}
              onSetTypes={setRumSelectedTypes}
              navigationDividers={navigationDividers}
              pinnedEventFieldsByEventId={allPinnedEventFieldsWithValues}
              onUnpinEventField={unpinEventField}
            />
          }
          rightPanel={
            <EventDetail
              event={selectedRumEvent}
              trackingMetadataEnabled={trackingMetadataEnabled}
              pinnedEventFields={currentPinnedEventFields}
              onPinEventField={pinEventField}
              onUnpinEventField={unpinEventField}
              onReorderPinnedEventFields={reorderPinnedEventFields}
            />
          }
          defaultLeftWidth={30}
          minLeftWidth={15}
          maxLeftWidth={70}
          storageKey="panel-list-width"
        />
      ) : (
        <ResizablePanels
          leftPanel={
            <RequestList
              filters={requestFilters}
              requests={filteredRequests}
              onClear={clearRequests}
              selectedRequestId={selectedRequestId}
              onSelectRequest={setSelectedRequestId}
              onHideApi={apiName => {
                const request = filteredRequests.find(r => r.apiName === apiName);
                if (request?.source === 'requests') hideNonProtocolApi(apiName);
                else hideApi(apiName);
              }}
              pinnedFieldsByRequestId={allPinnedFieldsWithValues}
              onUnpinField={unpinField}
              filterText={filterText}
              onFilterChange={setFilterText}
              navigationDividers={navigationDividers}
            />
          }
          rightPanel={
            <RequestDetail
              inspectedTabId={tabId ?? undefined}
              request={visibleSelectedRequest}
              pinnedFields={currentPinnedFields}
              onPinField={pinField}
              onUnpinField={unpinField}
              onReorderPinnedFields={reorderPinnedFields}
              modificationEnabled={modificationEnabled}
              onSetResponseOverride={setResponseOverride}
              onRemoveResponseOverride={removeResponseOverride}
              onSetRedirect={setResourceRedirect}
              requestMetadataEnabled={requestMetadataEnabled}
              requestCasesEnabled={requestCasesEnabled}
              requestImportEnabled={requestImportEnabled}
              trackingMetadataEnabled={trackingMetadataEnabled}
            />
          }
          defaultLeftWidth={30}
          minLeftWidth={15}
          maxLeftWidth={70}
          storageKey="panel-list-width"
        />
      )}
      {/* 接口调试模式状态栏 */}
      {mode === 'protocol' &&
        (isHiddenListExpanded ? (
          <StatusPanel
            count={requestFilters.displayedRequests.length}
            hiddenApis={allHiddenApis}
            modifiedApis={Array.from(apiOverrides.values())
              .flat()
              .map(override => ({
                id: override.id || '',
                apiName: override.apiName,
                sceneComment: override.sceneComment,
                hasConditions: !!override.conditions && Object.keys(override.conditions).length > 0,
              }))}
            onShow={apiName => {
              showApi(apiName);
              showNonProtocolApi(apiName);
            }}
            onRemoveOverride={(apiName, id) => {
              if (tabId) {
                sendMessageSafely({ action: 'removeResponseOverride', tabId, apiName, id });
              }
              setApiOverrides(prev => {
                const newMap = new Map(prev);
                const list = newMap.get(apiName);
                if (list && id) {
                  const filtered = list.filter(o => o.id !== id);
                  if (filtered.length === 0) {
                    newMap.delete(apiName);
                  } else {
                    newMap.set(apiName, filtered);
                  }
                } else {
                  newMap.delete(apiName);
                }
                return newMap;
              });
            }}
            onRemoveAllOverrides={() => {
              for (const [apiName, list] of apiOverrides.entries()) {
                for (const o of list) {
                  if (tabId) {
                    sendMessageSafely({
                      action: 'removeResponseOverride',
                      tabId,
                      apiName,
                      id: o.id,
                    });
                  }
                }
              }
              setApiOverrides(new Map());
            }}
            onEdit={id => setEditingOverrideId(id)}
            onCollapse={() => setIsHiddenListExpanded(false)}
            onImportClick={() => setShowRequestImportModal(true)}
          />
        ) : (
          <BottomStatusBar
            count={requestFilters.displayedRequests.length}
            hiddenCount={allHiddenApis.length}
            modifiedCount={modifiedCount}
            onExpand={() => setIsHiddenListExpanded(true)}
            onImportClick={() => setShowRequestImportModal(true)}
          />
        ))}

      {/* 埋点验证模式底部状态栏：仅展示事件条数 */}
      {mode === 'rum' && (
        <div className="border-t border-toolbar-border bg-toolbar text-text-secondary px-2 py-1 flex items-center transition-colors">
          <span className="text-xs tabular-nums whitespace-nowrap min-h-4.75 flex items-center">
            {filteredRumEvents.length} {t('requests')}
          </span>
        </div>
      )}

      {/* 请求数据导入弹窗 */}
      <Suspense fallback={null}>
        <RequestImportModal
          isOpen={showRequestImportModal}
          requestImportEnabled={requestImportEnabled}
          onClose={() => setShowRequestImportModal(false)}
          onImportMock={addMockOverride}
          onOpenRequestCases={requestCasesEnabled ? () => setShowRequestCasesModal(true) : undefined}
          requestApiNames={requests.filter(r => !hiddenApisSet.has(r.apiName)).map(r => r.apiName)}
        />
      </Suspense>

      {/* 请求用例弹窗 */}
      <Suspense fallback={null}>
        <RequestCasesModal
          isOpen={requestCasesEnabled && showRequestCasesModal}
          onClose={() => setShowRequestCasesModal(false)}
          cachedAppList={cachedAppList}
          onAppListFetched={setCachedAppList}
          onImportMock={addMockOverride}
        />
      </Suspense>

      {/* Mock 编辑弹窗 */}
      {editingOverride && (
        <MockEditModal
          isOpen
          onClose={() => setEditingOverrideId(null)}
          apiName={editingOverride.apiName}
          responseData={editingOverride.modifiedData ?? editingOverride.responseData}
          conditions={editingOverride.conditions}
          onSave={(conditions, responseData) =>
            handleSaveConditions(
              editingOverride.id!,
              editingOverride.apiName,
              conditions,
              responseData,
            )
          }
        />
      )}

      {/* MCP 状态弹窗 */}
      {agentEnabled && (
        <AgentStatusModal
          isOpen={showAgentModal}
          onClose={() => setShowAgentModal(false)}
          agentConnected={agentConnected}
        />
      )}

      {/* 设置弹窗 */}
      {showSettingsModal && (
        <SettingsModal
          onClose={() => setShowSettingsModal(false)}
          previewTabId={isDevtools ? undefined : tabId ?? undefined}
        />
      )}

      {/* 内嵌登录弹窗 */}
      <Suspense fallback={null}>
        {captureLoginDefinition && <LoginModal
          isOpen={requestCasesEnabled && loginModalOpen}
          onClose={closeLoginWindow}
          url={captureLoginDefinition.url}
          title={t('loginRequestCases')}
        />}
        {metadataLoginDefinition && <LoginModal
          isOpen={requestMetadataEnabled && requestMetadataLoginModalOpen}
          onClose={closeRequestMetadataLogin}
          url={metadataLoginDefinition.login.url}
          title={browserUiText(metadataLoginDefinition.login.title, getCurrentLanguage())}
        />}
      </Suspense>

      <SourceTraceCard
        result={traceResult}
        onClose={() => setTraceResult(null)}
        onJumpToField={handleJumpToTracedField}
        onMockAll={handleMockTracedFields}
      />

      <ToastContainer />
    </div>
  );
  return <ElementPickerTabContext.Provider value={isDevtools ? undefined : tabId}>{content}</ElementPickerTabContext.Provider>;
};
