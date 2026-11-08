import { useBrowserUiSettings } from '../panel/utils/browserUiSettings';
import { captureStorageKeys } from '../../shared/browserUiSettings';
import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, FC, lazy, Suspense } from 'react';
import { CapturedRequest, PinnedField } from '../panel/types';
import { RequestList } from '../panel/components/RequestList';
import { RequestDetail } from '../panel/components/RequestDetail';
import { BottomStatusBar } from '../panel/components/BottomStatusBar';
import { StatusPanel } from '../panel/components/StatusPanel';
import { ResizablePanels } from '../panel/components/ResizablePanels';
import { useLocalStorage } from '../panel/hooks/useLocalStorage';
import { useRequestFilters } from '../panel/hooks/useRequestFilters';
import { useCaptureIdentity } from '../panel/hooks/useCaptureIdentity';
import { useCaptureProxyLogin } from './hooks/useCaptureProxyLogin';
import { useDeviceCaptureMockImport } from './hooks/useDeviceCaptureMockImport';
import { t, initI18n, getCurrentLanguage } from '../panel/utils/i18n';
import { useExtensionConfig } from '../panel/hooks/useExtensionConfig';
import {
  buildPinnedFieldsWithValuesByRequestId,
  filterRequestsByText,
} from '../panel/utils/helpers';
import { RequestCasesModal } from '../panel/components/request-cases/RequestCasesModal';
import { ToastContainer } from '../panel/components/ToastContainer';
import { showToast } from '../panel/utils/toast';
import { ArrowLeft, Maximize2, QrCode, Webhook, Globe } from 'lucide-react';
import { SettingsModal } from '../panel/components/SettingsModal';
import { QuickSettingsMenu } from '../panel/components/header';
import { clsx } from 'clsx';
import { LauncherModal } from './LauncherModal';
import { PlatformId } from './platforms/types';
import {
  CaptureRuntimeProvider,
  useCaptureRuntime,
  useCaptureRuntimeState,
} from './CaptureRuntimeHost';
import { openDeviceCaptureTab } from '../../shared/deviceCapture';
import { setExtensionPageTitle } from '../../shared/pageTitle';
import {
  applyOverrideToRequestById,
  attachOverrideFromMap,
  buildMockResponseOverride,
  clearAllRequestOverrides,
  clearResponseOverrideOnRequest,
} from './utils/mockOverride';

const LoginModal = lazy(() =>
  import('../panel/components/LoginModal').then(m => ({ default: m.LoginModal })),
);

const RequestImportModal = lazy(() =>
  import('../panel/components/request-import/RequestImportModal').then(m => ({
    default: m.RequestImportModal,
  })),
);

const PENDING_REQUEST_TIMEOUT_MS = 30_000;

/** 未提供已生效 mock 列表时，用稳定空数组避免重复渲染 */
const EMPTY_ONLINE_MOCKS: string[] = [];

interface DeviceCaptureContentProps {
  platformId: PlatformId;
  requestCasesEnabled: boolean;
  requestMetadataEnabled: boolean;
  requestImportEnabled: boolean;
  trackingMetadataEnabled: boolean;
  setPlatformId: (value: PlatformId | ((prev: PlatformId) => PlatformId)) => void;
}

const DeviceCaptureContent: FC<DeviceCaptureContentProps> = ({
  platformId,
  setPlatformId,
  requestCasesEnabled,
  requestMetadataEnabled,
  requestImportEnabled,
  trackingMetadataEnabled,
}) => {
  const storage = captureStorageKeys(useBrowserUiSettings());
  const embedded = new URLSearchParams(window.location.search).get('embedded') === '1';
  const embeddedInToolbox = new URLSearchParams(window.location.search).get('toolbox') === '1';
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState<number | null>(null);
  const [filterText, setFilterText] = useState<string>('');
  const [isHiddenListExpanded, setIsHiddenListExpanded] = useState<boolean>(false);
  const [showRequestCasesModal, setShowRequestCasesModal] = useState<boolean>(false);
  const [showLauncherModal, setShowLauncherModal] = useState(
    () => new URLSearchParams(window.location.search).get('autoLaunch') !== '0',
  );
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [showRequestImportModal, setShowRequestImportModal] = useState<boolean>(false);

  const [modificationEnabled, setModificationEnabled] = useLocalStorage<boolean>(
    storage.modification,
    false,
  );
  const [allRequestsEnabled, setAllRequestsEnabled] = useLocalStorage<boolean>(
    storage.allRequests,
    false,
  );
  const [requestSubMode, setRequestSubMode] = useLocalStorage<'protocol' | 'requests'>(
    storage.subMode,
    'protocol',
  );
  const [pinnedFields, setPinnedFields] = useLocalStorage<PinnedField[]>('mearl-pinned-fields', []);
  const [hiddenApis, setHiddenApis] = useLocalStorage<string[]>('mearl-hidden-apis', []);

  // 仅订阅抓包共享身份，不主动触发 fetch；由子组件按需拉取
  useCaptureIdentity({ lazy: true });
  const { loginModalOpen: proxyLoginModalOpen, closeLoginWindow: closeProxyLogin, loginDefinition: proxyLoginDefinition } = useCaptureProxyLogin();

  /** 仅首次进入页面时允许自动关闭启动弹窗；用户手动打开后不再自动关 */
  const launcherAutoCloseEnabledRef = useRef(true);
  const modificationEnabledRef = useRef(modificationEnabled);
  modificationEnabledRef.current = modificationEnabled;
  const modificationToggleInitializedRef = useRef(false);

  // pending 请求超过阈值后按失败处理，避免列表里长期悬挂。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setRequests(prev => {
        let changed = false;
        const next = prev.map(req => {
          if (
            !req.isPending ||
            !Number.isFinite(req.timestampMs) ||
            now - req.timestampMs < PENDING_REQUEST_TIMEOUT_MS
          ) {
            return req;
          }

          changed = true;
          return {
            ...req,
            isPending: false,
            status: 0,
            statusText: 'timeout',
            duration: req.duration ?? now - req.timestampMs,
          };
        });
        return changed ? next : prev;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  // 平台 modify 钩子无条件调用，靠当前平台选择具体实现，避免违反 hook 规则。
  const { channels } = useCaptureRuntimeState();
  const platform = channels[platformId];
  const activeModify = platform?.modify;
  const activeModifyRef = useRef(activeModify);
  activeModifyRef.current = activeModify;

  // 关闭「修改」时清理远端 mock 规则与本地 override（跳过首次挂载且已为关闭状态）
  useEffect(() => {
    if (!modificationToggleInitializedRef.current) {
      modificationToggleInitializedRef.current = true;
      if (!modificationEnabled) return;
    }
    if (modificationEnabled) return;
    void activeModifyRef.current?.removeAllOverrides();
    setRequests(prev => clearAllRequestOverrides(prev));
  }, [modificationEnabled, platformId]);

  // 把请求按 id upsert 进列表：首次出现 append，重复出现 merge（流式分阶段事件需要）
  const upsertRequest = useCallback(
    (req: CapturedRequest) => {
      setRequests(prev => {
        const idx = prev.findIndex(r => r.id === req.id);
        if (idx === -1) {
          const next = attachOverrideFromMap(
            req,
            activeModify?.apiOverrides,
            modificationEnabledRef.current,
          );
          return [...prev, next];
        }

        const merged = attachOverrideFromMap(
          { ...prev[idx], ...req },
          activeModify?.apiOverrides,
          modificationEnabledRef.current,
        );
        const next = prev.slice();
        next[idx] = merged;
        return next;
      });
    },
    [activeModify],
  );

  const handleMessage = useCallback(
    (request: CapturedRequest) => {
      if (request.method === 'OPTIONS' || request.status === 307) return;
      activeModify?.onRequest?.(request);
      upsertRequest(request);
    },
    [activeModify, upsertRequest],
  );

  useCaptureRuntime(handleMessage);
  const connection = platform?.connection;

  useLayoutEffect(() => {
    setRequests([]);
    setSelectedRequestId(null);
  }, [platformId]);

  // 切换平台：清空请求 + 选中态
  const handlePlatformChange = useCallback(
    (id: PlatformId) => {
      if (id === platformId) return;
      setPlatformId(id);
    },
    [platformId, setPlatformId],
  );

  const dismissLauncherIfInitial = useCallback(() => {
    if (!launcherAutoCloseEnabledRef.current) return;
    launcherAutoCloseEnabledRef.current = false;
    setShowLauncherModal(false);
  }, []);

  // 首次进入：列表出现抓包请求时自动关闭启动弹窗
  useEffect(() => {
    if (requests.length > 0 && showLauncherModal) {
      dismissLauncherIfInitial();
    }
  }, [requests.length, showLauncherModal, dismissLauncherIfInitial]);

  const openLauncherModal = useCallback(() => {
    launcherAutoCloseEnabledRef.current = false;
    setShowLauncherModal(true);
  }, []);

  const hiddenApisSet = useMemo(() => new Set(hiddenApis), [hiddenApis]);

  const filteredRequests = useMemo(() => {
    let filtered = requests.filter(req => !hiddenApisSet.has(req.apiName));
    if (!allRequestsEnabled) {
      filtered = filtered.filter(req => req.source === 'protocol');
    } else {
      filtered = filtered.filter(req => {
        const isProtocol = req.source === 'protocol';
        return requestSubMode === 'protocol' ? isProtocol : !isProtocol;
      });
    }
    return filterRequestsByText(filtered, filterText, ['apiName']);
  }, [requests, hiddenApisSet, filterText, allRequestsEnabled, requestSubMode]);

  const requestFilters = useRequestFilters(filteredRequests, true, { filterTypes: false });
  const selectedRequest = requests.find(req => req.id === selectedRequestId) || null;

  const clearRequests = () => {
    setRequests([]);
    setSelectedRequestId(null);
  };

  const hideApi = (apiName: string) => {
    setHiddenApis(prev => (prev.includes(apiName) ? prev : [...prev, apiName]));
  };
  const showApi = (apiName: string) => {
    setHiddenApis(prev => prev.filter(name => name !== apiName));
  };

  const pinField = (path: string[], value: any, type: 'request' | 'response') => {
    if (!selectedRequestId) return;
    const selectedReq = requests.find(r => r.id === selectedRequestId);
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
          requestId: selectedRequestId,
        },
        ...prev,
      ];
    });
  };

  const unpinField = (path: string, apiName: string, type: 'request' | 'response') => {
    setPinnedFields(prev =>
      prev.filter(f => !(f.path === path && f.apiName === apiName && f.type === type)),
    );
  };

  const reorderPinnedFields = (
    fromIndex: number,
    toIndex: number,
    apiName: string,
    type: 'request' | 'response',
  ) => {
    setPinnedFields(prev => {
      const fieldsForApi = prev.filter(f => f.apiName === apiName && f.type === type);
      const otherFields = prev.filter(f => !(f.apiName === apiName && f.type === type));
      const [movedField] = fieldsForApi.splice(fromIndex, 1);
      fieldsForApi.splice(toIndex, 0, movedField);
      return [...fieldsForApi, ...otherFields];
    });
  };

  const allPinnedFieldsWithValues = useMemo(
    () => buildPinnedFieldsWithValuesByRequestId(requests, pinnedFields),
    [requests, pinnedFields],
  );

  const currentPinnedFields = useMemo(() => {
    if (!selectedRequestId) return [];
    return allPinnedFieldsWithValues.get(selectedRequestId) || [];
  }, [allPinnedFieldsWithValues, selectedRequestId]);

  // 能力包返回的真机已生效 mock 接口，合并进「已修改」列表展示
  const onlineMocks = activeModify?.onlineMocks ?? EMPTY_ONLINE_MOCKS;
  const refreshOnlineMocks = activeModify?.refreshOnlineMocks;

  const modifiedApis = useMemo(() => {
    const merged = new Map<string, { id: string; apiName: string }>();
    // 会话内下发的 mock：按 apiName 展示，走原有移除链路
    for (const apiName of activeModify?.apiOverrides.keys() ?? []) {
      merged.set(apiName, { id: apiName, apiName });
    }
    // 真机上已生效的 mock（含历史遗留）：用完整 URL 反解 apiName 去重，id 以 online: 标记来源
    for (const url of onlineMocks) {
      const parsed = requests.find(request => request.url === url)?.apiName;
      const apiName = parsed && parsed !== 'unknown' ? parsed : url;
      if (merged.has(apiName)) continue;
      merged.set(apiName, { id: `online:${url}`, apiName });
    }
    return Array.from(merged.values());
  }, [activeModify, onlineMocks, requests]);

  const modifiedCount = modifiedApis.length;

  // 修改入口由当前通道声明支持
  const supportsModify = !!platform?.supportsModify && !!activeModify;

  const applyMockOverride = useCallback(
    async (request: CapturedRequest, modifiedData: unknown) => {
      if (!activeModify) return;

      const override = buildMockResponseOverride(request, modifiedData);
      const requestWithMeta: CapturedRequest = { ...request, responseOverride: override };

      setRequests(prev => applyOverrideToRequestById(prev, request.id, override));

      try {
        await activeModify.setOverride(requestWithMeta, modifiedData);
      } catch {
        setRequests(prev => {
          if (request.responseOverride) {
            return applyOverrideToRequestById(prev, request.id, request.responseOverride);
          }
          return clearResponseOverrideOnRequest(prev, request.id);
        });
        throw new Error('Failed to apply mock override');
      }
    },
    [activeModify],
  );

  const setResponseOverride = useCallback(
    async (request: CapturedRequest, modifiedData: unknown) => {
      if (!modificationEnabledRef.current) return;
      await applyMockOverride(request, modifiedData);
    },
    [applyMockOverride],
  );

  const { addMockOverride } = useDeviceCaptureMockImport({
    platformId,
    prepareOverride: activeModify?.prepareOverride,
    requests,
    supportsModify,
    modificationEnabled,
    modificationEnabledRef,
    setModificationEnabled,
    applyMockOverride,
  });

  const removeResponseOverride = useCallback(
    async (request: CapturedRequest) => {
      if (!activeModify) return;
      try {
        await activeModify.removeOverride(request);
        setRequests(prev => clearResponseOverrideOnRequest(prev, request.id));
      } catch {
        // removeOverride 内部已 toast
      }
    },
    [activeModify],
  );

  const handleRemoveOverrideByApiName = useCallback(
    async (apiName: string, id: string) => {
      // 真机遗留 mock：id 以 online: 标记，直接按 URL 清除
      if (id.startsWith('online:')) {
        await activeModify?.cleanOnlineMock?.(id.slice('online:'.length));
        return;
      }
      const request = requests.find(req => req.apiName === apiName);
      if (request) await removeResponseOverride(request);
    },
    [requests, removeResponseOverride, activeModify],
  );

  const handleRemoveAllOverrides = useCallback(async () => {
    await activeModify?.removeAllOverrides();
    setRequests(prev => clearAllRequestOverrides(prev));
  }, [activeModify]);

  // 展开状态栏时按需拉取真机已生效的 mock 列表（deviceId 需已从抓包事件中捕获）
  useEffect(() => {
    if (isHiddenListExpanded) {
      void refreshOnlineMocks?.();
    }
  }, [isHiddenListExpanded, platformId, refreshOnlineMocks]);

  // 已抓到数据即视为设备在线：重连后 onopen 会把 upstream 重置为 waiting、
  // 设备的 offline 心跳也会回落 upstream，若仅看 upstream 会在有数据时误显示「连接中」。
  const hasCaptureData = requests.length > 0;
  const connStatus = connection?.status;
  const isConnectingOrConnected = connStatus === 'connecting' || connStatus === 'connected';
  const isOnline = isConnectingOrConnected && (connection?.upstream === 'active' || hasCaptureData);
  const isConnecting = isConnectingOrConnected && !isOnline;

  const statusDotClass = isOnline ? 'bg-green-500' : isConnecting ? 'bg-orange-400' : 'bg-gray-400';

  const statusLabel = !connection
    ? ''
    : isOnline
      ? connection.statusText.active
      : isConnecting
        ? connection.statusText.connecting
        : connection.statusText.idle;

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="flex items-center justify-between border-b border-border bg-toolbar px-2 py-1.5 text-text-primary">
        <div className="flex min-w-0 items-center gap-2">
          {embeddedInToolbox ? (
            <button
              type="button"
              onClick={() =>
                window.parent.postMessage({ type: 'mearl-toolbox-back' }, window.location.origin)
              }
              className="cursor-pointer self-center rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              title={t('toolboxBack')}
              aria-label={t('toolboxBack')}
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
          {allRequestsEnabled ? (
            <button
              onClick={() => setRequestSubMode(v => (v === 'protocol' ? 'requests' : 'protocol'))}
              className="flex shrink-0 cursor-pointer items-center gap-1 text-xs font-medium transition-opacity hover:opacity-70"
              title={t('switchRequestSubMode')}
            >
              {requestSubMode === 'protocol' ? 'Protocol' : 'Requests'}
            </button>
          ) : (
            <span className="shrink-0 text-xs font-medium">{t('realDeviceCapture')}</span>
          )}
          <span className="shrink-0 text-3xs text-text-secondary">
            {platform?.label}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-3xs text-text-secondary">
            <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', statusDotClass)} />
            <span className="truncate">{statusLabel}</span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-2xs">
          <button
            onClick={() => {
              const newValue = !allRequestsEnabled;
              setAllRequestsEnabled(newValue);
              if (newValue) {
                showToast(t('allRequestsEnabledHint'), 'info', 5000);
              } else {
                setRequestSubMode('protocol');
              }
            }}
            className={clsx(
              'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 transition-colors',
              allRequestsEnabled
                ? 'bg-blue-500/20 text-blue-600 hover:bg-blue-500/30 dark:text-blue-400'
                : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
            title={t('allRequests')}
          >
            <Globe className="h-3 w-3" />
            <span>{t('allRequests')}</span>
          </button>
          {supportsModify && (
            <button
              onClick={() => setModificationEnabled(v => !v)}
              className={clsx(
                'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 transition-colors',
                modificationEnabled
                  ? 'bg-yellow-500/20 text-yellow-600 hover:bg-yellow-500/30 dark:text-yellow-400'
                  : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              )}
              title={t('enableResponseModification')}
            >
              <Webhook className="h-3 w-3" />
              <span>{t('modify')}</span>
            </button>
          )}
          {/* 清空已移至下方请求列表顶部工具条 */}
          <button
            onClick={openLauncherModal}
            className="flex cursor-pointer items-center gap-1 rounded bg-blue-600 px-1.5 py-0.5 font-medium text-white transition-colors hover:bg-blue-700"
            title={t('scanQrCodeCapture')}
          >
            <QrCode className="h-3 w-3" />
            <span>{t('scanQrCodeCapture')}</span>
          </button>
          {embeddedInToolbox ? <div id="mearl-toolbox-header-actions" /> : null}
          {embedded ? (
            <button
              type="button"
              onClick={() => void openDeviceCaptureTab()}
              className="cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              title={t('openInNewTab')}
              aria-label={t('openInNewTab')}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          ) : (
            <QuickSettingsMenu
              onShowSettings={() => setShowSettingsModal(true)}
              dropdownAlign="far-right"
            />
          )}
        </div>
      </div>

      <ResizablePanels
        leftPanel={
          <RequestList
            filters={requestFilters}
            requests={filteredRequests}
            onClear={clearRequests}
            selectedRequestId={selectedRequestId}
            onSelectRequest={setSelectedRequestId}
            onHideApi={hideApi}
            pinnedFieldsByRequestId={allPinnedFieldsWithValues}
            onUnpinField={unpinField}
            filterText={filterText}
            onFilterChange={setFilterText}
          />
        }
        rightPanel={
          <RequestDetail
            request={selectedRequest}
            pinnedFields={currentPinnedFields}
            onPinField={pinField}
            onUnpinField={unpinField}
            onReorderPinnedFields={reorderPinnedFields}
            requestCasesEnabled={requestCasesEnabled}
            requestMetadataEnabled={requestMetadataEnabled}
            requestImportEnabled={requestImportEnabled}
            trackingMetadataEnabled={trackingMetadataEnabled}
            modificationEnabled={supportsModify && modificationEnabled}
            onSetResponseOverride={setResponseOverride}
            onRemoveResponseOverride={removeResponseOverride}
          />
        }
        defaultLeftWidth={30}
        minLeftWidth={15}
        maxLeftWidth={70}
        storageKey={storage.listWidth}
      />

      {isHiddenListExpanded ? (
        <StatusPanel
          count={filteredRequests.length}
          hiddenApis={Array.from(hiddenApis)}
          modifiedApis={modifiedApis}
          onShow={showApi}
          onRemoveOverride={handleRemoveOverrideByApiName}
          onRemoveAllOverrides={handleRemoveAllOverrides}
          onEdit={() => {}}
          onCollapse={() => setIsHiddenListExpanded(false)}
          onRequestCasesClick={() => setShowRequestCasesModal(true)}
          showRequestCases={requestCasesEnabled}
          onImportClick={supportsModify ? () => setShowRequestImportModal(true) : undefined}
          showEdit={false}
        />
      ) : (
        <BottomStatusBar
          count={filteredRequests.length}
          hiddenCount={hiddenApis.length}
          modifiedCount={modifiedCount}
          onExpand={() => setIsHiddenListExpanded(true)}
          onRequestCasesClick={() => setShowRequestCasesModal(true)}
          showRequestCases={requestCasesEnabled}
          onImportClick={supportsModify ? () => setShowRequestImportModal(true) : undefined}
        />
      )}

      <Suspense fallback={null}>
        <RequestImportModal
          isOpen={showRequestImportModal}
          requestImportEnabled={requestImportEnabled}
          onClose={() => setShowRequestImportModal(false)}
          onImportMock={addMockOverride}
          onOpenRequestCases={requestCasesEnabled ? () => setShowRequestCasesModal(true) : undefined}
          requestApiNames={filteredRequests.filter(r => r.source === 'protocol').map(r => r.apiName)}
        />
      </Suspense>

      <RequestCasesModal
        isOpen={requestCasesEnabled && showRequestCasesModal}
        onClose={() => setShowRequestCasesModal(false)}
        cachedAppList={[]}
        onAppListFetched={() => {}}
        onImportMock={addMockOverride}
      />

      <LauncherModal
        isOpen={showLauncherModal}
        onClose={() => {
          launcherAutoCloseEnabledRef.current = false;
          setShowLauncherModal(false);
        }}
        requestCasesEnabled={requestCasesEnabled}
        platformId={platformId}
        onPlatformChange={handlePlatformChange}
      />

      <Suspense fallback={null}>
        {proxyLoginDefinition && <LoginModal
          isOpen={proxyLoginModalOpen}
          onClose={closeProxyLogin}
          url={proxyLoginDefinition.url}
          title={getCurrentLanguage().startsWith('zh') ? proxyLoginDefinition.title.zh_CN ?? proxyLoginDefinition.title.en : proxyLoginDefinition.title.en}
        />}
      </Suspense>

      {showSettingsModal && <SettingsModal onClose={() => setShowSettingsModal(false)} />}
      <ToastContainer />
    </div>
  );
};

export const DeviceCapture: FC = () => {
  const [platformId, setPlatformId, platformReady] = useLocalStorage<PlatformId>(
    'device-capture-platform',
    '',
  );
  const [config, configLoaded] = useExtensionConfig();
  const [loadedLanguage, setLoadedLanguage] = useState<string>();
  useEffect(() => {
    if (!configLoaded) return;
    let disposed = false;
    void initI18n(config.language).then(() => {
      if (disposed) return;
      setExtensionPageTitle(t('toolboxDeviceCaptureTitle'));
      setLoadedLanguage(config.language);
    });
    return () => {
      disposed = true;
    };
  }, [config.language, configLoaded]);
  if (!loadedLanguage || !config.requestCasesEnabled || !platformReady) return null;
  return (
    <CaptureRuntimeProvider enabled={config.requestCasesEnabled} platformId={platformId} onPlatformChange={setPlatformId}>
      <DeviceCaptureContent platformId={platformId} setPlatformId={setPlatformId} {...config} />
    </CaptureRuntimeProvider>
  );
};
