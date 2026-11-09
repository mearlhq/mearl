import { useExtensionConfig } from '../panel/hooks/useExtensionConfig';
import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense, FC } from 'react';
import {
  ArrowLeft,
  Bot,
  Search,
  Copy,
  Check,
  Braces,
  LoaderCircle,
  Monitor,
  Rotate3d,
  Wrench,
  createLucideIcon,
  Maximize2,
  QrCode,
  Cloud,
} from 'lucide-react';
import { JsonTree, type JsonTreeInteraction } from '../panel/components/json-tree/JsonTree';
import { SearchBar } from '../panel/components/detail/SearchBar';
import { JsonKeyboardHints } from '../panel/components/JsonKeyboardHints';
import { ToastContainer } from '../panel/components/ToastContainer';
import { AccountBadge } from '../panel/components/header/AccountBadge';
import { Banner } from '../panel/components/header/Banner';
import { QuickSettingsMenu } from '../panel/components/header/QuickSettingsMenu';
import { PermissionDialog } from './components/PermissionDialog';
import { UrlQueryPresetButton } from './components/UrlQueryPresetButton';
import { DeviceCaptureEntry } from './components/DeviceCaptureEntry';
import { Toolbox, readStoredToolboxSelection } from './components/Toolbox';
import { requestToolbox } from './toolboxRequest';
import type { ToolboxPluginTool } from '@mearl/browser-core';
import { cacheToolboxNavigation, readToolboxNavigationCache } from './toolboxNavigationCache';
import { localizeToolboxMetadata } from '../../shared/toolboxLocale';
import { ToolboxIcon } from '../../shared/toolboxIcons';
import { ToolSwitcher } from './components/ToolSwitcher';
import {
  BUILT_IN_TOOL_IDS,
  readPinnedToolCount,
  readToolOrder,
  sortToolsByOrder,
} from './toolboxOrder';
import { togglePresetInQuery, type UrlQueryPreset } from '../panel/utils/urlQueryPresets';
import { useSearchUI } from '../panel/hooks/useSearchUI';
import { useJsonInput, type JsonInputSnapshot } from './hooks/useJsonInput';
import { useUndoHistory } from './hooks/useUndoHistory';
import { useAgentBridgeStatus } from '../panel/hooks/useAgentBridgeStatus';
import { useCloudConnectorStatus } from '../panel/hooks/useCloudConnectorStatus';
import { useRemoteConfig } from '../panel/hooks/useRemoteConfig';
import { t, initI18n } from '../panel/utils/i18n';
import type { ExtensionConfig } from '../panel/utils/config';
import {
  copySvgImageToClipboard,
  copyToClipboard,
  readClipboardContent,
} from '../panel/utils/clipboard';
import {
  setValueByPathInParsedData,
  serializeWithFormat,
  tryParseJsonString,
} from '../panel/utils/helpers';
import { generateQrCodeSvgMarkup } from '../panel/utils/qrCode';
import { showToast } from '../panel/utils/toast';
import { MEARL_DOC_URL } from '../../shared/constants';
import { AgentSidePanelShortcut } from '../sidepanel/components/AgentSidePanelShortcut';
import { openExtensionTab } from '../../shared/extensionTab';
import { setExtensionPageTitle } from '../../shared/pageTitle';
import { clsx } from 'clsx';

const SettingsModal = lazy(() =>
  import('../panel/components/SettingsModal').then(module => ({
    default: module.SettingsModal,
  })),
);

const AgentStatusModal = lazy(() =>
  import('../panel/components/AgentStatusModal').then(module => ({
    default: module.AgentStatusModal,
  })),
);

const RulesEditor = lazy(() => import('../options/components/RulesEditor'));

const AgentChat = lazy(() =>
  import('../sidepanel/SidepanelChat').then(module => ({
    default: module.SidepanelChat,
  })),
);

const BrowserManager = lazy(() =>
  import('./components/BrowserManager').then(module => ({
    default: module.BrowserManager,
  })),
);

const GlobeCheck = createLucideIcon('GlobeCheck', [
  ['path', { d: 'm15 6 2 2 4-4', key: 'check' }],
  [
    'path',
    {
      d: 'M2 12h20A10 10 0 1 1 12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 4-10',
      key: 'globe',
    },
  ],
]);

interface PopupProps {
  isSidePanel?: boolean;
  bootstrapConfig?: ExtensionConfig;
  bootstrapInput?: JsonInputSnapshot;
}

type PopupView = 'formatter' | 'chat' | 'browsers' | 'rules' | 'capture' | 'toolbox';
const POPUP_VIEW_STORAGE_KEY = 'mearl.popup.activeView';

function isPopupView(value: string | null): value is PopupView {
  return (
    value === 'formatter' ||
    value === 'chat' ||
    value === 'browsers' ||
    value === 'rules' ||
    value === 'capture' ||
    value === 'toolbox'
  );
}

function popupViewTitle(view: PopupView): string {
  switch (view) {
    case 'chat':
      return t('agentChatTitle');
    case 'browsers':
      return t('popupToolBrowsers');
    case 'rules':
      return t('popupToolRules');
    case 'toolbox':
      return t('popupToolToolbox');
    case 'capture':
      return t('popupToolDeviceCapture');
    default:
      return t('popupToolFormatter');
  }
}

function isToolboxBuiltInView(view: PopupView): boolean {
  return view === 'chat' || view === 'rules' || view === 'browsers';
}

function normalizeCapabilityView(view: PopupView, captureEnabled = true): PopupView {
  if (view === 'capture' && !captureEnabled) return 'formatter';
  return view;
}

function initialPopupView(isSidePanel: boolean): PopupView {
  if (isSidePanel) return 'formatter';
  const requestedView = new URLSearchParams(window.location.search).get('view');
  if (isPopupView(requestedView)) return requestedView;
  try {
    const storedView = window.localStorage.getItem(POPUP_VIEW_STORAGE_KEY);
    return isPopupView(storedView) ? storedView : 'formatter';
  } catch {
    return 'formatter';
  }
}

function PopupViewFallback() {
  return (
    <div
      role="status"
      aria-label={t('loading')}
      className="flex h-full w-full items-center justify-center text-text-secondary"
    >
      <LoaderCircle className="h-4 w-4 animate-spin" />
    </div>
  );
}

export const Popup: FC<PopupProps> = ({ isSidePanel = false, bootstrapConfig, bootstrapInput }) => {
  const remoteConfig = useRemoteConfig();
  const containerRef = useRef<HTMLDivElement>(null);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>(
    bootstrapInput?.expandedPaths ?? {},
  );
  const [copied, setCopied] = useState<boolean>(false);
  const [qrCodeCopied, setQrCodeCopied] = useState<boolean>(false);
  const [config, configLoaded] = useExtensionConfig(bootstrapConfig);
  const { accountsEnabled, requestCasesEnabled } = config;
  const agentEnabled = configLoaded && config.agentEnabled;
  const [pluginTools, setPluginTools] = useState(readToolboxNavigationCache);
  const [toolOrder, setToolOrder] = useState(readToolOrder);
  const [pinnedCount, setPinnedCount] = useState(readPinnedToolCount);
  const [toolboxKey, setToolboxKey] = useState(0);
  const [initialToolboxSelection] = useState(readStoredToolboxSelection);
  const [selectedToolboxId, setSelectedToolboxId] = useState<string | null>(() =>
    initialToolboxSelection?.kind === 'capture'
      ? 'builtin:capture'
      : (initialToolboxSelection?.id ?? null),
  );
  const [toolboxSelectionOverride, setToolboxSelectionOverride] = useState<
    | {
        kind: 'plugin';
        id: string;
        title: string;
      }
    | null
    | undefined
  >(undefined);
  const handleToolboxSelectionChange = useCallback(
    (toolId: string | null) => {
      setSelectedToolboxId(toolId);
      if (toolboxSelectionOverride?.kind !== 'plugin') {
        setToolboxEntryId(toolId);
      } else if (toolId !== null && toolId !== toolboxSelectionOverride.id) {
        setToolboxEntryId(toolId);
        setToolboxSelectionOverride(undefined);
      }
    },
    [toolboxSelectionOverride],
  );
  const [activeView, setActiveView] = useState<PopupView>(() => initialPopupView(isSidePanel));
  const [toolboxEntryId, setToolboxEntryId] = useState(selectedToolboxId);
  const initialViewRef = useRef(activeView);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [showAgentModal, setShowAgentModal] = useState<boolean>(false);
  const [hasOpenedAgentModal, setHasOpenedAgentModal] = useState<boolean>(false);
  const loadedLanguageRef = useRef(bootstrapConfig?.language);
  const [i18nReady, setI18nReady] = useState<boolean>(bootstrapConfig !== undefined);
  const [qrCodeManualOverride, setQrCodeManualOverride] = useState<boolean | null>(null);
  const [jsonTreeInteraction, setJsonTreeInteraction] = useState<JsonTreeInteraction | null>(null);
  const [sidePanelWindowId, setSidePanelWindowId] = useState<number | null>(null);
  const [i18nRevision, forceUpdate] = useState({});
  const enterNavigateRef = useRef<{
    isUrlFormat: boolean;
    urlForQRCode: string;
    showSearch: boolean;
  }>({ isUrlFormat: false, urlForQRCode: '', showSearch: false });

  const [topLevelParsed, setTopLevelParsed] = useState<{
    parsed: any;
    format?: import('../panel/utils/helpers').StringFormat;
    prefix?: string;
  } | null>(() =>
    bootstrapInput?.inputText ? tryParseJsonString(bootstrapInput.inputText) : null,
  );
  const parsedData = topLevelParsed?.parsed ?? null;
  const inputFormat = topLevelParsed?.format;
  const inputPrefix = topLevelParsed?.prefix;

  const {
    inputText,
    setInputText,
    parseError,
    isStandalonePage,
    isInitialized: isInputInitialized,
    processInputText,
  } = useJsonInput({
    initialInput: bootstrapInput,
    onExpandedPathsRestore: setExpandedPaths,
  });
  const isStandaloneRoute = new URLSearchParams(window.location.search).get('standalone') === '1';
  const chatAvailable = agentEnabled && !isSidePanel && !isStandalonePage && !isStandaloneRoute;

  // 撤销/重做历史：仅记录用户主动动作（粘贴/编辑）前的 inputText + expandedPaths 快照
  const { pushSnapshot, undo, redo } = useUndoHistory<{
    inputText: string;
    expandedPaths: Record<string, boolean>;
  }>({
    onRestore: snapshot => {
      setInputText(snapshot.inputText);
      setExpandedPaths(snapshot.expandedPaths);
    },
  });

  // 通过 ref 保存最新状态，便于在压栈/撤销时拿到快照而不依赖闭包
  const snapshotRef = useRef({ inputText, expandedPaths });
  snapshotRef.current = { inputText, expandedPaths };

  const recordSnapshot = () => {
    pushSnapshot({ ...snapshotRef.current });
  };

  useEffect(() => {
    if (!configLoaded || loadedLanguageRef.current === config.language) return;
    let disposed = false;
    void initI18n(config.language).then(() => {
      if (disposed) return;
      loadedLanguageRef.current = config.language;
      setI18nReady(true);
      forceUpdate({});
    });
    return () => {
      disposed = true;
    };
  }, [config.language, configLoaded]);

  useEffect(() => {
    if (!i18nReady) return;
    setExtensionPageTitle(popupViewTitle(activeView));
  }, [activeView, i18nReady, i18nRevision]);

  const handleToolboxToolsChange = useCallback((tools: ToolboxPluginTool[]) => {
    setPluginTools(tools);
    cacheToolboxNavigation(tools);
  }, []);

  useEffect(() => {
    if (isSidePanel || initialViewRef.current === 'toolbox') return;

    let active = true;
    const refreshAvailability = async () => {
      try {
        const result = await requestToolbox('toolbox_tools_list');
        if (active) handleToolboxToolsChange(result.tools);
      } catch {
        // 本地宿主暂不可用时仍保留内置工具与工具箱入口。
      }
    };
    void refreshAvailability();
    return () => {
      active = false;
    };
  }, [isSidePanel, handleToolboxToolsChange]);

  useEffect(() => {
    if (!chatAvailable || activeView !== 'chat') {
      setSidePanelWindowId(null);
      return;
    }

    let active = true;
    chrome.windows
      .getLastFocused({ windowTypes: ['normal'] })
      .then(window => {
        if (active) setSidePanelWindowId(typeof window.id === 'number' ? window.id : null);
      })
      .catch(() => {
        if (!active) return;
        setSidePanelWindowId(null);
      });

    return () => {
      active = false;
    };
  }, [chatAvailable, activeView]);

  const {
    searchQuery,
    setSearchQuery,
    currentMatchIndex,
    matchNavigationVersion,
    totalMatches,
    setTotalMatches,
    showSearch,
    setShowSearch,
    searchInputRef,
    handleNextMatch,
    handlePrevMatch,
    handleClose,
  } = useSearchUI(containerRef);

  // Agent 连接状态
  const { agentConnected } = useAgentBridgeStatus({
    tabId: null,
    configReady: i18nReady,
    agentEnabled,
  });

  // 云端连接器状态：用于在 agent 徽标上展示云图标
  const { state: cloudConnectorState } = useCloudConnectorStatus(agentEnabled);

  // 快捷键支持（粘贴 / URL 回车跳转）
  useEffect(() => {
    if (activeView === 'chat') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // 检查是否在可编辑元素中，如果是则不拦截
      const target = e.target as HTMLElement;
      const isEditable =
        target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !isEditable) {
        e.preventDefault();
        handlePaste();
      }

      // Cmd/Ctrl + Z 撤销 / Cmd/Ctrl + Shift + Z 重做（仅在非输入场景生效，避免与系统原生撤销冲突）
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !isEditable) {
        e.preventDefault();
        if (e.shiftKey) {
          redo({ ...snapshotRef.current });
        } else {
          undo({ ...snapshotRef.current });
        }
      }

      // URL 格式时按 Enter 跳转（非编辑态、非搜索态）
      const nav = enterNavigateRef.current;
      if (
        e.key === 'Enter' &&
        !isEditable &&
        nav.isUrlFormat &&
        nav.urlForQRCode &&
        !nav.showSearch
      ) {
        e.preventDefault();
        handleEnterNavigate();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeView]);

  const handleToggleExpand = (paths: Record<string, boolean>) => {
    setExpandedPaths(prev => ({
      ...prev,
      ...paths,
    }));
  };

  const handleValueChange = (path: string[], newValue: any) => {
    if (!parsedData) return;

    const updatedData = setValueByPathInParsedData(parsedData, parsedData, path, newValue);

    // 改变前记录快照，用于撤销
    recordSnapshot();

    // 顶层替换且新值已是字符串（如 raw 模式编辑 URL），直接作为输入文本
    if (path.length === 0 && typeof updatedData === 'string') {
      setInputText(updatedData);
      return;
    }

    // 使用 serialize 方法自动选择正确的序列化格式
    setInputText(serialize(updatedData));
  };

  const handleCopy = () => {
    // 使用 serialize 方法保持格式一致性
    const content = parsedData ? serialize(parsedData) : inputText;

    if (content) {
      copyToClipboard(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handlePaste = async () => {
    const { text, image } = await readClipboardContent();
    if (text?.trim()) {
      recordSnapshot();
      processInputText(text);
      return;
    }
    if (!image) return;

    const { decodeQrCodeFromImage } = await import('../../shared/qrCodeDecoder');
    const result = await decodeQrCodeFromImage(image);
    if (result.success) {
      recordSnapshot();
      processInputText(result.text);
      showToast(t('qrPasteDetected'), 'success');
      return;
    }
    if (result.error === 'not_found') {
      showToast(t('qrPasteNotFound'), 'info');
      return;
    }
    showToast(t('qrPasteFailed'), 'error');
  };

  const handleOpenInTab = async () => {
    await chrome.storage.local.set({
      jsonFormatterData: inputText,
      jsonFormatterExpandedPaths: expandedPaths,
    });

    const popupUrl = chrome.runtime.getURL(
      'src/pages/popup/index.html?view=formatter&standalone=1',
    );
    await openExtensionTab(popupUrl);
    window.close();
  };

  const handleEnterNavigate = () => {
    const nav = enterNavigateRef.current;
    if (nav.isUrlFormat && nav.urlForQRCode && !nav.showSearch) {
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id) {
          chrome.tabs.update(tab.id, { url: nav.urlForQRCode });
          window.close();
        }
      });
    }
  };

  const handleToggleQueryPreset = (preset: UrlQueryPreset) => {
    if (!parsedData) return;
    const currentQuery = typeof parsedData.query === 'string' ? parsedData.query : '';
    const nextQuery = togglePresetInQuery(currentQuery, preset);

    // 切换前记录快照，用于撤销
    recordSnapshot();

    const updated = { ...parsedData };
    if (nextQuery) updated.query = nextQuery;
    else delete updated.query;
    setInputText(serialize(updated));
  };

  const handleOpenAgentSidePanel = async () => {
    if (sidePanelWindowId === null) return;

    try {
      await chrome.sidePanel.open({ windowId: sidePanelWindowId });
      window.close();
    } catch {
      showToast(t('openAgentSidePanelFailed'), 'error');
    }
  };

  useEffect(() => {
    setActiveView(view =>
      view === 'chat' && configLoaded && !chatAvailable
        ? 'formatter'
        : normalizeCapabilityView(view, requestCasesEnabled),
    );
  }, [chatAvailable, configLoaded, requestCasesEnabled]);

  const handleViewChange = (view: PopupView) => {
    view = normalizeCapabilityView(view, requestCasesEnabled);
    const builtIn = navigationTools
      .slice(pinnedCount)
      .find(tool => isToolboxBuiltInView(tool.view) && tool.view === view);
    if (builtIn) setToolboxEntryId(builtIn.id);
    else if (unpinnedBuiltIn && view !== 'toolbox') setToolboxEntryId(unpinnedBuiltIn.id);
    setActiveView(view);
    try {
      window.localStorage.setItem(POPUP_VIEW_STORAGE_KEY, view);
    } catch {
      // 存储不可用时仅维持当前 Popup 内的选择。
    }
  };

  const serialize = (data: any) => serializeWithFormat(data, inputFormat, inputPrefix);

  const isUrlFormat = inputFormat?.id === 'url';
  // 二维码是否展示：手动覆盖优先，否则 URL 模式默认开启
  const qrCodeEnabled = qrCodeManualOverride !== null ? qrCodeManualOverride : !!isUrlFormat;
  const showQrCode = qrCodeEnabled && parsedData && !isSidePanel && !jsonTreeInteraction;
  const urlForQRCode = showQrCode ? serialize(parsedData) : '';
  const navigateUrl = isUrlFormat && parsedData ? serialize(parsedData) : '';
  const navigationTools = sortToolsByOrder(
    [
      {
        id: BUILT_IN_TOOL_IDS[0],
        view: 'formatter' as PopupView,
        icon: Braces,
        label: t('popupToolFormatter'),
      },
      {
        id: BUILT_IN_TOOL_IDS[1],
        view: 'chat' as PopupView,
        icon: Bot,
        label: t('agentChatTitle'),
      },
      {
        id: BUILT_IN_TOOL_IDS[2],
        view: 'rules' as PopupView,
        icon: GlobeCheck,
        label: t('popupToolRules'),
      },
      {
        id: BUILT_IN_TOOL_IDS[3],
        view: 'browsers' as PopupView,
        icon: Monitor,
        label: t('popupToolBrowsers'),
      },
      {
        id: BUILT_IN_TOOL_IDS[4],
        view: 'capture' as PopupView,
        icon: Rotate3d,
        label: t('popupToolDeviceCapture'),
      },
      ...pluginTools.map(tool => ({
        id: tool.id,
        view: 'toolbox' as PopupView,
        icon: tool.icon ?? 'blocks',
        label: localizeToolboxMetadata(tool).title,
      })),
    ].filter(
      tool =>
        (tool.view !== 'capture' || requestCasesEnabled) && (tool.view !== 'chat' || chatAvailable),
    ),
    toolOrder,
  );
  const pinnedTools = navigationTools.slice(0, pinnedCount);
  const unpinnedBuiltIn = navigationTools
    .slice(pinnedCount)
    .find(tool => isToolboxBuiltInView(tool.view) && tool.view === activeView);
  const selectedToolboxIsPinned = pinnedTools.some(tool => tool.id === selectedToolboxId);
  const toolboxEntryIsPinned = pinnedTools.some(tool => tool.id === toolboxEntryId);
  const selectedToolboxTool =
    unpinnedBuiltIn ??
    (toolboxEntryIsPinned
      ? undefined
      : (navigationTools.find(tool => tool.id === toolboxEntryId) ??
        (initialToolboxSelection?.kind === 'plugin' && initialToolboxSelection.id === toolboxEntryId
          ? {
              icon: initialToolboxSelection.icon ?? 'blocks',
              label: initialToolboxSelection.title,
            }
          : undefined)));
  const navigationItems = [
    ...pinnedTools,
    {
      id: 'toolbox',
      view: 'toolbox' as PopupView,
      icon: selectedToolboxTool?.icon ?? Wrench,
      label: t('popupToolToolbox'),
    },
  ];

  const returnToToolbox = () => {
    setSelectedToolboxId(null);
    setToolboxEntryId(null);
    setToolboxSelectionOverride(null);
    setToolboxKey(key => key + 1);
    handleViewChange('toolbox');
  };

  const openNavigationTool = (tool: (typeof navigationItems)[number]) => {
    if (tool.id === 'toolbox') {
      const builtIn = navigationTools
        .slice(pinnedCount)
        .find(item => item.id === toolboxEntryId && isToolboxBuiltInView(item.view));
      if (builtIn && activeView !== builtIn.view) {
        handleViewChange(builtIn.view);
        return;
      }
      if (unpinnedBuiltIn) {
        returnToToolbox();
        return;
      }
      if (
        (activeView === 'toolbox' && toolboxSelectionOverride?.kind !== 'plugin') ||
        toolboxEntryIsPinned
      ) {
        setSelectedToolboxId(null);
        setToolboxEntryId(null);
        setToolboxSelectionOverride(null);
      } else {
        setSelectedToolboxId(toolboxEntryId);
        setToolboxSelectionOverride(undefined);
      }
      setToolboxKey(key => key + 1);
      handleViewChange('toolbox');
    } else if (tool.id.startsWith('builtin:')) {
      handleViewChange(tool.view);
    } else {
      setSelectedToolboxId(tool.id);
      if (!pinnedTools.some(item => item.id === tool.id)) setToolboxEntryId(tool.id);
      setToolboxSelectionOverride({ kind: 'plugin', id: tool.id, title: tool.label });
      setToolboxKey(key => key + 1);
      handleViewChange('toolbox');
    }
  };

  const builtInHeaderActions = unpinnedBuiltIn ? (
    <>
      <ToolSwitcher
        currentId={unpinnedBuiltIn.id}
        tools={navigationTools.slice(pinnedCount).map(tool => ({
          id: tool.id,
          title: tool.label,
          icon: tool.icon,
          onClick: () => openNavigationTool(tool),
        }))}
      />
      {unpinnedBuiltIn.view !== 'chat' &&
        !isStandaloneRoute &&
        !isStandalonePage &&
        !isSidePanel && (
          <button
            type="button"
            title={t('openInNewTab')}
            aria-label={t('openInNewTab')}
            className="cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            onClick={() =>
              void openExtensionTab(
                chrome.runtime.getURL(
                  `src/pages/popup/index.html?view=${unpinnedBuiltIn.view}&standalone=1`,
                ),
              ).then(() => window.close())
            }
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
    </>
  ) : undefined;

  enterNavigateRef.current = { isUrlFormat: !!isUrlFormat, urlForQRCode: navigateUrl, showSearch };

  const urlQrSvgMarkup = useMemo(() => {
    if (!urlForQRCode) return '';
    try {
      return generateQrCodeSvgMarkup(urlForQRCode);
    } catch {
      return '';
    }
  }, [urlForQRCode]);

  const handleCopyQrCode = async () => {
    if (!urlQrSvgMarkup || !urlForQRCode) return;

    const success = await copySvgImageToClipboard(urlQrSvgMarkup, urlForQRCode);
    if (!success) {
      showToast(t('copyQRCodeFailed'), 'error');
      return;
    }

    setQrCodeCopied(true);
    setTimeout(() => setQrCodeCopied(false), 2000);
  };

  return (
    <div
      ref={containerRef}
      style={
        isSidePanel || isStandaloneRoute
          ? { width: '100vw', height: '100vh' }
          : { width: 680, height: 560 }
      }
      className="flex flex-col overflow-hidden bg-bg-primary text-text-primary"
    >
      {/* 头部 */}
      <div className="@container flex items-center justify-between border-b border-border bg-toolbar px-3 py-1.5">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-medium">
            <a href={MEARL_DOC_URL} target="_blank">
              Mearl
            </a>
          </h1>
          {agentEnabled && (
            <button
              onClick={() => {
                setHasOpenedAgentModal(true);
                setShowAgentModal(true);
              }}
              className={clsx(
                'px-1 rounded text-3xs font-semibold -mt-1 -ml-1 cursor-pointer inline-flex items-center gap-0.5',
                agentConnected
                  ? 'bg-green-500/20 text-green-600 hover:bg-green-500/30 dark:bg-green-500/30 dark:text-green-400 dark:hover:bg-green-500/40'
                  : 'bg-gray-500/20 text-gray-600 hover:bg-gray-500/30 dark:bg-gray-500/30 dark:text-gray-400 dark:hover:bg-gray-500/40',
              )}
              title={`${agentConnected ? t('mcpIntegrationConnected') : t('mcpIntegrationDisconnected')}`}
            >
              {cloudConnectorState.connected && <Cloud className="w-2.5 h-2.5" />}
              <span>agent</span>
            </button>
          )}
        </div>
        <Banner config={remoteConfig} />
        <div className="flex min-w-0 items-center justify-end gap-2">
          {!isSidePanel && (
            <div className="flex h-6 min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-bg-secondary p-px">
              {navigationItems.map(tool => {
                const isActive =
                  (tool.id === 'toolbox' && Boolean(unpinnedBuiltIn)) ||
                  (activeView === tool.view &&
                    (tool.view !== 'toolbox' ||
                      (tool.id === 'toolbox'
                        ? !selectedToolboxIsPinned
                        : selectedToolboxId === tool.id)));
                return (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => openNavigationTool(tool)}
                    className={clsx(
                      'flex h-5 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors',
                      isActive
                        ? 'border-border bg-bg-primary text-text-primary'
                        : 'border-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                    )}
                    title={
                      tool.id === 'toolbox'
                        ? (selectedToolboxTool?.label ?? tool.label)
                        : tool.label
                    }
                    aria-label={tool.label}
                    aria-pressed={isActive}
                  >
                    <ToolboxIcon
                      icon={tool.icon}
                      className={tool.icon === Bot ? 'h-4 w-4' : 'h-3.5 w-3.5'}
                    />
                  </button>
                );
              })}
            </div>
          )}
          {accountsEnabled && (
            <AccountBadge
              count={0}
              showRequestCountToggle={false}
              dropdownAlign="default"
              iconSize={12}
              className="h-6"
            />
          )}
          <QuickSettingsMenu
            onShowSettings={() => setShowSettingsModal(true)}
            dropdownAlign="far-right"
            remoteConfig={remoteConfig}
          />
        </div>
      </div>

      {/* 搜索栏 */}
      {activeView === 'formatter' && showSearch && parsedData && (
        <SearchBar
          searchQuery={searchQuery}
          currentMatchIndex={currentMatchIndex}
          totalMatches={totalMatches}
          onSearchChange={setSearchQuery}
          onPrevMatch={handlePrevMatch}
          onNextMatch={handleNextMatch}
          onClose={handleClose}
          searchInputRef={searchInputRef}
        />
      )}

      {activeView === 'browsers' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Suspense fallback={<PopupViewFallback />}>
            <BrowserManager
              accountsEnabled={accountsEnabled}
              onBack={unpinnedBuiltIn ? returnToToolbox : undefined}
              headerActions={builtInHeaderActions}
            />
          </Suspense>
        </div>
      )}
      {chatAvailable && activeView === 'chat' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {unpinnedBuiltIn && (
            <div className="flex shrink-0 items-center justify-between border-b border-border bg-toolbar px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={returnToToolbox}
                  title={t('toolboxBack')}
                  aria-label={t('toolboxBack')}
                  className="shrink-0 cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <h2 className="truncate text-xs font-medium text-text-primary">
                  {t('agentChatTitle')}
                </h2>
              </div>
              {builtInHeaderActions}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            <Suspense fallback={<PopupViewFallback />}>
              <AgentChat
                windowId={sidePanelWindowId}
                embedded
                compact
                pageElementActions={false}
                showAllHeaderActions
                footerAction={flushDraft => (
                  <AgentSidePanelShortcut
                    onClick={() => {
                      flushDraft();
                      void handleOpenAgentSidePanel();
                    }}
                    disabled={sidePanelWindowId === null}
                  />
                )}
              />
            </Suspense>
          </div>
        </div>
      )}
      {activeView === 'toolbox' && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <Toolbox
            key={toolboxKey}
            chatAvailable={chatAvailable}
            requestCasesEnabled={requestCasesEnabled}
            onToolsChange={handleToolboxToolsChange}
            onSelectionChange={handleToolboxSelectionChange}
            onSelectBuiltIn={handleViewChange}
            onOrderChange={setToolOrder}
            onPinnedCountChange={setPinnedCount}
            initialSelectionOverride={toolboxSelectionOverride}
            directEntry={toolboxSelectionOverride?.kind === 'plugin'}
            surface={isStandalonePage || isStandaloneRoute ? 'tab' : 'popup'}
          />
        </div>
      )}
      {requestCasesEnabled && activeView === 'capture' && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <DeviceCaptureEntry
            surface={isStandalonePage || isStandaloneRoute || isSidePanel ? 'tab' : 'popup'}
          />
        </div>
      )}
      {activeView === 'rules' && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <Suspense fallback={<PopupViewFallback />}>
            <RulesEditor
              onBack={unpinnedBuiltIn ? returnToToolbox : undefined}
              headerActions={builtInHeaderActions}
            />
          </Suspense>
        </div>
      )}

      {activeView === 'formatter' && (
        <div className="flex-1 overflow-hidden flex flex-col relative group">
          {/* 右上角工具按钮 + 二维码区域 */}
          {i18nReady && !showSearch && (
            <div className="absolute top-2 right-2 z-10 group/qrzone pointer-events-none">
              {showQrCode && urlQrSvgMarkup && (
                <button
                  type="button"
                  onClick={handleCopyQrCode}
                  className="group/qrcopy overflow-hidden rounded bg-white p-1 shadow-xs pointer-events-auto transition-transform duration-300 group-has-[:hover]/qrzone:translate-y-7"
                  aria-label={qrCodeCopied ? t('qrCodeCopied') : t('copyQRCode')}
                >
                  <div
                    role="img"
                    aria-label="QR Code"
                    style={{ width: 200, height: 200 }}
                    dangerouslySetInnerHTML={{ __html: urlQrSvgMarkup }}
                  />
                  <span
                    aria-hidden="true"
                    className={clsx(
                      'grid transition-[grid-template-rows] duration-200 ease-out',
                      qrCodeCopied
                        ? 'grid-rows-[1fr]'
                        : 'grid-rows-[0fr] group-hover/qrcopy:grid-rows-[1fr] group-focus-visible/qrcopy:grid-rows-[1fr]',
                    )}
                  >
                    <span className="min-h-0 overflow-hidden">
                      <span className="flex items-center justify-center gap-1 px-2 pt-0.5 pb-1 text-xxs text-gray-500 cursor-pointer">
                        {qrCodeCopied ? (
                          <>
                            <Check size={12} className="text-green-600" />
                            {t('qrCodeCopied')}
                          </>
                        ) : (
                          <>
                            <Copy size={12} />
                            {t('copyQRCode')}
                          </>
                        )}
                      </span>
                    </span>
                  </span>
                </button>
              )}
              <div
                data-testid="formatter-tools"
                className={clsx(
                  'absolute top-0 right-0 z-20 flex items-center gap-1 pb-2 pointer-events-auto transition-opacity',
                  parsedData && !showQrCode
                    ? 'opacity-0 group-hover:opacity-100'
                    : showQrCode
                      ? 'opacity-0 group-has-[:hover]/qrzone:opacity-100'
                      : 'opacity-0',
                  showQrCode && 'left-0 justify-end',
                )}
              >
                {parsedData && !isSidePanel && (
                  <button
                    onClick={() => setQrCodeManualOverride(!qrCodeEnabled)}
                    className={clsx(
                      'p-1 rounded transition-colors cursor-pointer bg-toolbar hover:bg-bg-hover',
                      qrCodeEnabled
                        ? 'text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300'
                        : 'text-text-secondary hover:text-text-primary',
                    )}
                    title={qrCodeEnabled ? t('hideQRCode') : t('showQRCode')}
                  >
                    <QrCode size={12} />
                  </button>
                )}
                {parsedData && (
                  <>
                    <button
                      onClick={handleCopy}
                      className="p-1 rounded transition-colors cursor-pointer bg-toolbar text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                      title={t('copy')}
                    >
                      {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
                    </button>
                    <button
                      onClick={() => setShowSearch(true)}
                      className="p-1 rounded transition-colors cursor-pointer bg-toolbar text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                      title="Search (Ctrl/Cmd+F)"
                    >
                      <Search size={12} />
                    </button>
                    {!isStandaloneRoute && !isStandalonePage && (
                      <button
                        onClick={() => void handleOpenInTab()}
                        className="p-1 rounded transition-colors cursor-pointer bg-toolbar text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                        title={t('openInNewTab')}
                      >
                        <Maximize2 size={12} />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-auto p-3 font-mono text-xxs leading-4">
            {isInputInitialized && inputText ? (
              <JsonTree
                data={inputText}
                onParsed={setTopLevelParsed}
                searchQuery={searchQuery}
                currentMatchIndex={currentMatchIndex}
                matchNavigationVersion={matchNavigationVersion}
                expandedPaths={expandedPaths}
                pathPrefix="popup"
                editable={true}
                defaultExpandDepth={3}
                onMatchesFound={setTotalMatches}
                onInteractionChange={setJsonTreeInteraction}
                onValueChange={handleValueChange}
                onToggleExpand={handleToggleExpand}
              />
            ) : null}
          </div>
        </div>
      )}

      {/* 底部工具栏：快捷键提示 + URL query 快捷参数 */}
      {activeView === 'formatter' && (
        <div className="px-2.5 py-1.5 border-t border-border bg-toolbar flex items-center gap-2">
          <div className="flex flex-1 min-w-0 items-center gap-1 overflow-hidden">
            <div className="flex-1 min-w-0 overflow-hidden">
              <JsonKeyboardHints
                storageKey="popup-shortcuts-visible"
                compact={true}
                showUndoHint={true}
                showEnterNavigateHint={isUrlFormat && !!navigateUrl}
                onPaste={handlePaste}
                onUndo={() => undo({ ...snapshotRef.current })}
                onEnterNavigate={isUrlFormat && navigateUrl ? handleEnterNavigate : undefined}
              />
            </div>
          </div>
          {/* 识别为 URL（可生成二维码）时展示 query 快捷参数 */}
          {i18nReady && isUrlFormat && parsedData && !isSidePanel && (
            <UrlQueryPresetButton
              query={typeof parsedData.query === 'string' ? parsedData.query : ''}
              onToggle={handleToggleQueryPreset}
            />
          )}
        </div>
      )}

      {/* 错误提示：覆盖底部快捷键栏 */}
      {activeView === 'formatter' && parseError && (
        <div className="absolute bottom-0 left-0 right-0 z-30 px-2.5 py-1.5 border-t border-border bg-red-50 dark:bg-red-950 text-xs text-red-600 dark:text-red-400">
          {parseError}
        </div>
      )}

      {/* 设置弹窗 */}
      {showSettingsModal && (
        <Suspense fallback={null}>
          <SettingsModal onClose={() => setShowSettingsModal(false)} />
        </Suspense>
      )}

      {/* Agent 状态弹窗 */}
      {agentEnabled && hasOpenedAgentModal && (
        <Suspense fallback={null}>
          <AgentStatusModal
            isOpen={showAgentModal}
            onClose={() => setShowAgentModal(false)}
            agentConnected={agentConnected}
            size="fullscreen"
          />
        </Suspense>
      )}

      <PermissionDialog />
      <ToastContainer />
    </div>
  );
};
