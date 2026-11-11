import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { preloadToolboxUiRuntime } from '../../../shared/toolboxUiRuntime';
import {
  ArrowLeft,
  Bot,
  Braces,
  Check,
  Globe2,
  ListOrdered,
  LoaderCircle,
  Monitor,
  Plus,
  RefreshCw,
  Rotate3d,
  RotateCcw,
  Trash2,
  X,
  Power,
  PowerOff,
} from 'lucide-react';
import {
  ExtensionRpcError,
  type ToolboxPluginTool,
  type ToolboxToolOpenResult,
} from '@mearl/browser-core';
import { t } from '../../panel/utils/i18n';
import { showToast } from '../../panel/utils/toast';
import { openToolboxToolTab } from '../../../shared/toolboxTab';
import { localizeToolboxMetadata } from '../../../shared/toolboxLocale';
import {
  cacheToolboxTool,
  loadToolboxPageBundle,
  readCachedToolboxTool,
  removeCachedToolboxTool,
  sameToolboxToolMetadata,
} from '../../../shared/toolboxPageBundle';
import { ToolboxIcon, type ToolboxIconSource } from '../../../shared/toolboxIcons';
import { requestToolbox, toolboxNativeHostUpdateInfo } from '../toolboxRequest';
import { requestNativeHost } from '../../sidepanel/nativeHostRequest';
import {
  DEFAULT_PINNED_TOOL_COUNT,
  readPinnedToolCount,
  readToolOrder,
  sortToolsByOrder,
  TOOLBOX_ORDER_STORAGE_KEY,
  TOOLBOX_PINNED_COUNT_STORAGE_KEY,
} from '../toolboxOrder';
import { ToolOrderList } from './ToolOrderList';
import { useToolboxCatalog } from '../hooks/useToolboxCatalog';
import type { ToolboxInstallableTool } from '../../../shared/toolboxCatalog';
import {
  TOOLBOX_INSTALL_QUEUE_PORT,
  type ToolboxInstallJob,
  type ToolboxInstallQueueEvent,
  type ToolboxInstallQueueState,
} from '../../../shared/toolboxInstallQueue';
import { DeviceCaptureEntry } from './DeviceCaptureEntry';
import { ToolSwitcher } from './ToolSwitcher';
import { ContextMenu } from '../../panel/components/json-tree/ContextMenu';
import { Modal, ModalContent, ModalHeader } from '../../panel/components/modal';
import {
  NativeHostUpdateGuide,
  type NativeHostUpdateInfo,
} from '../../panel/components/NativeHostUpdateGuide';

type ToolIcon = ToolboxIconSource;

const LOADING_INDICATOR_DELAY_MS = 300;
const TOOLBOX_SELECTION_STORAGE_KEY = 'mearl.popup.toolbox.activeTool';
const loadSandboxToolPage = () =>
  import('../../tool-host/SandboxToolPage').then(module => ({
    default: module.SandboxToolPage,
  }));
const SandboxToolPage = lazy(loadSandboxToolPage);

interface ToolRowProps {
  description?: string;
  icon: ToolIcon;
  onClick: () => void;
  pluginActions?: {
    busy: boolean;
    canUpdate: boolean;
    updatePhase?: 'checking' | 'updating';
    uninstalling: boolean;
    skillEnabled?: boolean;
    togglingSkill: boolean;
    onToggleSkill: () => void;
    onUpdate: () => void;
    onUninstall: () => void;
  };
  title: string;
}

interface ToolboxProps {
  chatAvailable?: boolean;
  requestCasesEnabled?: boolean;
  onToolsChange?: (tools: ToolboxPluginTool[]) => void;
  onSelectionChange?: (toolId: string | null) => void;
  onSelectBuiltIn?: (view: 'formatter' | 'chat' | 'rules' | 'browsers') => void;
  onOrderChange?: (order: string[]) => void;
  onPinnedCountChange?: (count: number) => void;
  initialSelectionOverride?: StoredToolboxSelection | null;
  directEntry?: boolean;
  surface?: 'popup' | 'tab';
}

type SelectedTool =
  | { kind: 'capture' }
  | {
      kind: 'plugin';
      id: string;
      title: string;
      tool: ToolboxToolOpenResult | null;
      html?: string;
      revision?: number;
    };

export interface StoredToolboxSelection {
  kind: 'capture' | 'plugin';
  id?: string;
  title?: string;
  icon?: string;
  query?: Record<string, string>;
}

export function readStoredToolboxSelection(): StoredToolboxSelection | null {
  try {
    const raw = window.localStorage.getItem(TOOLBOX_SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.kind === 'capture') return { kind: 'capture' };
    if (
      candidate.kind !== 'plugin' ||
      typeof candidate.id !== 'string' ||
      !candidate.id ||
      typeof candidate.title !== 'string' ||
      !candidate.title
    ) {
      return null;
    }
    const query =
      candidate.query && typeof candidate.query === 'object' && !Array.isArray(candidate.query)
        ? Object.fromEntries(
            Object.entries(candidate.query).filter(
              ([name, queryValue]) =>
                /^[a-z][a-z0-9-]{0,63}$/.test(name) &&
                typeof queryValue === 'string' &&
                queryValue.length <= 512,
            ),
          )
        : {};
    return {
      kind: 'plugin',
      id: candidate.id,
      title: candidate.title,
      icon: typeof candidate.icon === 'string' ? candidate.icon : undefined,
      query,
    };
  } catch {
    return null;
  }
}

function writeStoredToolboxSelection(
  selectedTool: SelectedTool | null,
  query: Record<string, string>,
  icon?: string,
): void {
  try {
    if (!selectedTool) {
      window.localStorage.removeItem(TOOLBOX_SELECTION_STORAGE_KEY);
      return;
    }
    const selection: StoredToolboxSelection =
      selectedTool.kind === 'capture'
        ? { kind: 'capture' }
        : { kind: 'plugin', id: selectedTool.id, title: selectedTool.title, icon, query };
    window.localStorage.setItem(TOOLBOX_SELECTION_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // 存储不可用时仍保留当前 Popup 内的工具状态。
  }
}

export function clearStoredToolboxSelection(): void {
  try {
    window.localStorage.removeItem(TOOLBOX_SELECTION_STORAGE_KEY);
  } catch {
    // 存储不可用时仍可直接打开顶部工具。
  }
}

function ToolRow({ description, icon, onClick, pluginActions, title }: ToolRowProps) {
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const updateLabel =
    pluginActions?.updatePhase === 'checking'
      ? t('toolboxPluginChecking')
      : pluginActions?.updatePhase === 'updating'
        ? t('toolboxSkillUpdating')
        : t('toolboxPluginUpdate', title);
  return (
    <li
      className="group relative"
      onContextMenu={event => {
        if (pluginActions?.skillEnabled === undefined) return;
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={pluginActions?.uninstalling || Boolean(pluginActions?.updatePhase)}
        className={`flex min-h-12.5 w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-hover/40 disabled:cursor-default ${confirmingUninstall || pluginActions?.uninstalling || pluginActions?.updatePhase ? 'pr-32' : pluginActions ? 'pr-14' : ''}`}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-bg-secondary text-text-secondary transition-colors group-hover:text-text-primary">
          <ToolboxIcon icon={icon} className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-xs font-medium text-text-primary">
            <span className="truncate">{title}</span>
            {pluginActions?.togglingSkill ? (
              <LoaderCircle
                className="w-3 h-3 shrink-0 animate-spin text-text-secondary"
                aria-hidden="true"
              />
            ) : pluginActions?.skillEnabled === false ? (
              <span
                role="img"
                aria-label={t('toolboxSkillDisabled')}
                title={t('toolboxSkillDisabled')}
                className="shrink-0 text-text-secondary"
              >
                <PowerOff className="w-3 h-3" aria-hidden="true" />
              </span>
            ) : null}
          </span>
          {description && (
            <span className="mt-0.5 block truncate text-3xs text-text-secondary">
              {description}
            </span>
          )}
        </span>
      </button>
      {pluginActions && (
        <div
          className={`absolute inset-y-0 right-2 flex items-center gap-1 transition-opacity ${confirmingUninstall || pluginActions.uninstalling || pluginActions.updatePhase ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'}`}
        >
          {pluginActions.uninstalling ? (
            <button
              type="button"
              disabled
              className="flex h-6 cursor-default items-center gap-1 rounded px-2 text-xxs text-text-secondary"
            >
              <LoaderCircle className="w-3 h-3 animate-spin" aria-hidden="true" />
              <span role="status">{t('toolboxUninstalling')}</span>
            </button>
          ) : confirmingUninstall && !pluginActions.busy ? (
            <>
              <span className="text-2xs text-text-secondary">
                {t('toolboxPluginUninstallConfirmInline')}
              </span>
              <button
                type="button"
                onClick={() => {
                  setConfirmingUninstall(false);
                  pluginActions.onUninstall();
                }}
                title={t('confirm')}
                aria-label={t('confirm')}
                className="cursor-pointer rounded p-0.5 text-red-600 hover:bg-red-600/10 dark:text-red-400"
              >
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setConfirmingUninstall(false)}
                title={t('cancel')}
                aria-label={t('cancel')}
                className="cursor-pointer rounded p-0.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </>
          ) : (
            <>
              {pluginActions.canUpdate && (
                <button
                  type="button"
                  onClick={pluginActions.onUpdate}
                  disabled={pluginActions.busy}
                  title={updateLabel}
                  aria-label={updateLabel}
                  className="flex items-center gap-1 cursor-pointer rounded p-1 text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:cursor-default disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${pluginActions.updatePhase ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  {pluginActions.updatePhase && (
                    <span role="status" className="text-xxs">
                      {updateLabel}
                    </span>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirmingUninstall(true)}
                disabled={pluginActions.busy}
                title={t('toolboxPluginUninstall', title)}
                aria-label={t('toolboxPluginUninstall', title)}
                className="cursor-pointer rounded p-1 text-text-secondary hover:bg-red-500/10 hover:text-red-500 disabled:cursor-default disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}
      {contextMenu && pluginActions?.skillEnabled !== undefined && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: pluginActions.skillEnabled
                ? t('toolboxSkillDisable')
                : t('toolboxSkillEnable'),
              icon: pluginActions.skillEnabled ? (
                <PowerOff className="w-3 h-3" />
              ) : (
                <Power className="w-3 h-3" />
              ),
              disabled: pluginActions.busy,
              onClick: pluginActions.onToggleSkill,
            },
          ]}
        />
      )}
    </li>
  );
}

interface InstallableToolRowProps {
  tool: ToolboxInstallableTool;
  installed: boolean;
  phase?: 'queued' | 'installing';
  disabled: boolean;
  onInstall: (job: ToolboxInstallJob) => void;
}

function InstallableToolRow({
  tool,
  installed,
  phase,
  disabled,
  onInstall,
}: InstallableToolRowProps) {
  const localized = localizeToolboxMetadata(tool);
  return (
    <li className="flex min-w-0 items-center gap-2 px-3 py-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-bg-secondary text-text-secondary">
        <ToolboxIcon icon={tool.icon} className="w-3 h-3" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <h4 className="truncate text-xs font-medium text-text-primary">{localized.title}</h4>
          {tool.repository === 'mearlhq/mearl' && (
            <span className="shrink-0 rounded bg-blue-500/10 px-1 py-0.5 text-3xs text-blue-600 dark:text-blue-400">
              {t('toolboxOfficial')}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-3xs leading-4 text-text-secondary">{localized.description}</p>
      </div>
      <button
        type="button"
        disabled={installed || Boolean(phase) || disabled}
        onClick={() =>
          onInstall({
            id: tool.id,
            plugin: tool.plugin,
            repository: tool.repository,
            skill: tool.skill,
            title: localized.title,
          })
        }
        aria-busy={!installed && phase === 'installing'}
        aria-label={
          installed
            ? t('toolboxToolInstalled', localized.title)
            : phase
              ? undefined
              : t('toolboxInstallTool', localized.title)
        }
        className={`flex h-6 min-w-12 shrink-0 cursor-pointer items-center justify-center gap-1 rounded px-2 text-xxs transition-colors disabled:cursor-default ${installed ? 'text-text-secondary/70' : 'border border-border text-text-secondary'} ${!phase && !installed ? 'enabled:hover:bg-bg-hover enabled:hover:text-text-primary disabled:opacity-40' : ''}`}
      >
        {!installed && phase === 'installing' && (
          <LoaderCircle className="w-3 h-3 animate-spin" aria-hidden="true" />
        )}
        {installed
          ? t('toolboxInstalled')
          : phase === 'installing'
            ? t('toolboxInstalling')
            : phase === 'queued'
              ? t('toolboxInstallQueued')
              : t('toolboxInstall')}
      </button>
    </li>
  );
}

function ToolOpening({
  onBack,
  title,
  headerActions,
}: {
  onBack?: () => void;
  title: string;
  headerActions?: ReactNode;
}) {
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowLoading(true), LOADING_INDICATOR_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-primary">
      <div
        className={`flex shrink-0 items-center border-b border-border bg-toolbar py-1.5 text-text-primary ${onBack ? 'px-2' : 'px-3'}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              title={t('toolboxBack')}
              aria-label={t('toolboxBack')}
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
          <h2 className="min-w-0 flex-1 truncate text-xs font-medium">{title}</h2>
        </div>
        {headerActions}
      </div>
      <div
        role={showLoading ? 'status' : undefined}
        className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-text-secondary"
      >
        {showLoading && (
          <>
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('toolboxToolOpening')}
          </>
        )}
      </div>
    </div>
  );
}

export function Toolbox({
  chatAvailable = false,
  requestCasesEnabled = false,
  onToolsChange,
  onSelectionChange,
  onSelectBuiltIn,
  onOrderChange,
  onPinnedCountChange,
  initialSelectionOverride,
  directEntry = false,
  surface = 'popup',
}: ToolboxProps) {
  const [initialSelection] = useState(() =>
    initialSelectionOverride === undefined
      ? readStoredToolboxSelection()
      : initialSelectionOverride,
  );
  const [tools, setTools] = useState<ToolboxPluginTool[]>([]);
  const [toolsLoaded, setToolsLoaded] = useState(false);
  const [toolOrder, setToolOrder] = useState(readToolOrder);
  const [pinnedCount, setPinnedCount] = useState(readPinnedToolCount);
  const [sortDialogOpen, setSortDialogOpen] = useState(false);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const catalog = useToolboxCatalog(installDialogOpen);
  const installableTools = catalog.tools ?? [];
  const installableRepositories = (
    catalog.groups ?? [
      {
        source: { id: 'official', label: 'Mearl' },
        tools: installableTools,
        pendingPriority: false,
      },
    ]
  ).flatMap(group =>
    [...new Set(group.tools.map(tool => tool.repository))].map(repository => ({
      source: group.source,
      pendingPriority: group.pendingPriority,
      repository,
      tools: group.tools.filter(tool => tool.repository === repository),
    })),
  );
  const [installQueue, setInstallQueue] = useState<ToolboxInstallQueueState | null>(null);
  const installPortRef = useRef<chrome.runtime.Port | null>(null);
  const [nativeHostUpdate, setNativeHostUpdate] = useState<NativeHostUpdateInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<SelectedTool | null>(() => {
    if (requestCasesEnabled && initialSelection?.kind === 'capture') return { kind: 'capture' };
    if (initialSelection?.kind === 'plugin') {
      return {
        kind: 'plugin',
        id: initialSelection.id!,
        title: initialSelection.title!,
        tool: null,
      };
    }
    return null;
  });
  const [selectedToolQuery, setSelectedToolQuery] = useState<Record<string, string>>(
    () => initialSelection?.query ?? {},
  );
  const [busyPlugin, setBusyPlugin] = useState<{
    id: string;
    action: 'checking' | 'updating' | 'uninstall' | 'skill';
  } | null>(null);
  const pluginActionLockRef = useRef(false);
  const loadSequenceRef = useRef(0);
  const loadingToolsRef = useRef(false);
  const refreshAfterLoadRef = useRef(false);
  const openSequenceRef = useRef(0);
  const [pendingToolUpdate, setPendingToolUpdate] = useState<{
    id: string;
    tool: ToolboxToolOpenResult;
    html: string;
  } | null>(null);
  const loadingDelayRef = useRef<number | null>(null);

  const clearLoadingDelay = useCallback(() => {
    if (loadingDelayRef.current === null) return;
    window.clearTimeout(loadingDelayRef.current);
    loadingDelayRef.current = null;
  }, []);

  const acceptTools = useCallback(
    (nextTools: ToolboxPluginTool[]) => {
      setTools(nextTools);
      setNativeHostUpdate(null);
      onToolsChange?.(nextTools);
    },
    [onToolsChange],
  );

  const loadTools = useCallback(
    async function loadTools(notify = false) {
      const sequence = ++loadSequenceRef.current;
      loadingToolsRef.current = true;
      clearLoadingDelay();
      setLoading(true);
      setShowLoading(false);
      setError(null);
      loadingDelayRef.current = window.setTimeout(() => {
        if (loadSequenceRef.current === sequence) setShowLoading(true);
      }, LOADING_INDICATOR_DELAY_MS);
      try {
        const result = await requestToolbox('toolbox_tools_list');
        if (loadSequenceRef.current !== sequence) return false;
        acceptTools(result.tools);
        if (notify) showToast(t('toolboxRefreshSuccess'), 'success');
        return result;
      } catch (loadError) {
        const update = await toolboxNativeHostUpdateInfo(loadError);
        if (loadSequenceRef.current !== sequence) return false;
        const message = loadError instanceof Error ? loadError.message : String(loadError);
        setNativeHostUpdate(update);
        setError(update ? null : message);
        if (notify && !update) showToast(t('toolboxRefreshFailed', message), 'error');
        return false;
      } finally {
        if (loadSequenceRef.current === sequence) {
          loadingToolsRef.current = false;
          clearLoadingDelay();
          setShowLoading(false);
          setLoading(false);
          setToolsLoaded(true);
          if (refreshAfterLoadRef.current) {
            refreshAfterLoadRef.current = false;
            void loadTools();
          }
        }
      }
    },
    [acceptTools, clearLoadingDelay],
  );

  const connectInstallQueue = useCallback(() => {
    if (installPortRef.current) return installPortRef.current;
    const port = chrome.runtime.connect({ name: TOOLBOX_INSTALL_QUEUE_PORT });
    installPortRef.current = port;
    port.onMessage.addListener(async (event: ToolboxInstallQueueEvent) => {
      if (event.type === 'queue') {
        setInstallQueue(event);
        return;
      }
      if (event.type === 'installed') {
        if (loadingToolsRef.current) {
          refreshAfterLoadRef.current = true;
        } else {
          setError(null);
          acceptTools(event.tools);
        }
        const listed = event.tools.some(
          tool => tool.id === event.job.id || tool.plugin === event.job.plugin,
        );
        showToast(
          listed ? t('toolboxInstallSuccess', event.job.title) : t('toolboxInstallListFailed'),
          listed ? 'success' : 'error',
        );
        return;
      }
      const cause = event.code
        ? new ExtensionRpcError(event.code, event.error)
        : new Error(event.error);
      const update = await toolboxNativeHostUpdateInfo(cause);
      if (installPortRef.current !== port) return;
      if (update) setNativeHostUpdate(update);
      else if (event.stage === 'list') showToast(t('toolboxInstallListFailed'), 'error');
      else showToast(t('toolboxInstallFailed', cause.message), 'error');
    });
    port.onDisconnect.addListener(() => {
      if (installPortRef.current !== port) return;
      installPortRef.current = null;
      setInstallQueue(null);
    });
    return port;
  }, [acceptTools]);

  useEffect(() => {
    connectInstallQueue();
    void loadTools();
    return () => {
      const port = installPortRef.current;
      installPortRef.current = null;
      port?.disconnect();
      loadSequenceRef.current += 1;
      openSequenceRef.current += 1;
      clearLoadingDelay();
    };
  }, [clearLoadingDelay, connectInstallQueue, loadTools]);

  useEffect(() => {
    if (installDialogOpen && !installPortRef.current) {
      connectInstallQueue();
      void loadTools();
    }
  }, [connectInstallQueue, installDialogOpen, loadTools]);

  const selectedToolIcon =
    selectedTool?.kind === 'plugin'
      ? (selectedTool.tool?.icon ??
        tools.find(tool => tool.id === selectedTool.id)?.icon ??
        (initialSelection?.id === selectedTool.id ? initialSelection.icon : undefined))
      : undefined;
  useEffect(() => {
    if (!directEntry)
      writeStoredToolboxSelection(selectedTool, selectedToolQuery, selectedToolIcon);
  }, [directEntry, selectedTool, selectedToolQuery, selectedToolIcon]);

  const selectedToolId = selectedTool
    ? selectedTool.kind === 'capture'
      ? 'builtin:capture'
      : selectedTool.id
    : null;
  useEffect(() => {
    onSelectionChange?.(selectedToolId);
  }, [onSelectionChange, selectedToolId]);

  const openBuiltInCapture = () => {
    if (!requestCasesEnabled) return;
    openSequenceRef.current += 1;
    setError(null);
    setSelectedToolQuery({});
    setSelectedTool({ kind: 'capture' });
  };

  const openPluginTool = useCallback(
    async (tool: Pick<ToolboxPluginTool, 'id' | 'title'>, preserveQuery = false) => {
      preloadToolboxUiRuntime();
      void loadSandboxToolPage().catch(() => {});
      const sequence = ++openSequenceRef.current;
      setPendingToolUpdate(null);
      setError(null);
      if (!preserveQuery) setSelectedToolQuery({});
      setSelectedTool({ kind: 'plugin', id: tool.id, title: tool.title, tool: null });
      const cached = await readCachedToolboxTool(tool.id);
      if (openSequenceRef.current !== sequence) return;
      const usableCache =
        cached &&
        cached.tool.displayMode !== 'tab' &&
        !(cached.tool.displayMode === 'popup' && surface === 'tab')
          ? cached
          : null;
      if (usableCache) {
        setSelectedTool({
          kind: 'plugin',
          id: tool.id,
          title: localizeToolboxMetadata(usableCache.tool).title,
          tool: usableCache.tool,
          html: usableCache.html,
        });
      }
      try {
        const result = await requestToolbox('toolbox_tool_open', { id: tool.id });
        if (openSequenceRef.current !== sequence) return;
        if (usableCache) {
          if (!sameToolboxToolMetadata(result, usableCache.tool)) {
            const html =
              result.page.hash === usableCache.tool.page.hash
                ? usableCache.html
                : await loadToolboxPageBundle(tool.id, result.page);
            if (openSequenceRef.current !== sequence) return;
            await cacheToolboxTool(tool.id, result);
            if (openSequenceRef.current !== sequence) return;
            setPendingToolUpdate({ id: tool.id, tool: result, html });
          }
          return;
        }
        if (result.displayMode === 'popup' && surface === 'tab') {
          throw new Error(t('toolboxPopupOnly'));
        }
        if (result.displayMode === 'tab') {
          await openToolboxToolTab(tool.id, preserveQuery ? (initialSelection?.query ?? {}) : {});
          if (openSequenceRef.current !== sequence) return;
          setSelectedTool(null);
          return;
        }
        const localizedResult = localizeToolboxMetadata(result);
        void cacheToolboxTool(tool.id, result);
        setSelectedTool({
          kind: 'plugin',
          id: tool.id,
          title: localizedResult.title,
          tool: result,
        });
      } catch (openError) {
        if (openSequenceRef.current !== sequence) return;
        if (usableCache) return;
        setSelectedTool(null);
        setError(openError instanceof Error ? openError.message : String(openError));
      }
    },
    [initialSelection, surface],
  );

  const restoredSelectionRef = useRef(false);
  // Start the cached tool read before the first paint.
  useLayoutEffect(() => {
    if (restoredSelectionRef.current) return;
    restoredSelectionRef.current = true;
    if (initialSelection?.kind === 'plugin') {
      void openPluginTool({ id: initialSelection.id!, title: initialSelection.title! }, true);
    }
  }, [initialSelection, openPluginTool]);

  const closeSelectedTool = () => {
    openSequenceRef.current += 1;
    writeStoredToolboxSelection(null, {});
    setError(null);
    setSelectedToolQuery({});
    setSelectedTool(null);
  };

  const openSelectedToolInTab = async (tool = selectedTool) => {
    if (tool?.kind !== 'plugin' || tool.tool?.displayMode === 'popup') return;
    setError(null);
    try {
      await openToolboxToolTab(tool.id, selectedToolQuery);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  };

  const managePlugin = async (
    tool: ToolboxPluginTool,
    action: 'update' | 'uninstall' | 'skill',
  ) => {
    if (pluginActionLockRef.current) return;
    const skill = tool.skillUpdate;
    if (action === 'update' && !skill) return;
    if (action === 'skill' && tool.skillEnabled === undefined) return;
    pluginActionLockRef.current = true;
    setBusyPlugin({ id: tool.id, action: action === 'update' ? 'checking' : action });
    setError(null);
    try {
      if (action === 'update' && skill) {
        const result = await requestNativeHost('agent_skills_check_updates', {
          providerId: 'codex',
        });
        if (
          !result.updates.some(update => update.name === skill.name && update.scope === skill.scope)
        ) {
          showToast(t('toolboxPluginUpToDate', localizeToolboxMetadata(tool).title), 'success');
          return;
        }
        setBusyPlugin({ id: tool.id, action: 'updating' });
        await requestNativeHost('agent_skills_update', {
          providerId: 'codex',
          name: skill.name,
          scope: skill.scope,
        });
      } else if (action === 'skill') {
        const result = await requestToolbox('toolbox_skill_set_enabled', {
          id: tool.id,
          enabled: !tool.skillEnabled,
        });
        setTools(current =>
          current.map(candidate =>
            candidate.id === tool.id ? { ...candidate, skillEnabled: result.enabled } : candidate,
          ),
        );
        showToast(
          result.enabled ? t('toolboxSkillEnabledSuccess') : t('toolboxSkillDisabledSuccess'),
          'success',
        );
      } else {
        await requestToolbox('toolbox_plugin_uninstall', { id: tool.id });
        await removeCachedToolboxTool(tool.id).catch(() => {});
      }
      const reloaded = await loadTools();
      if (action === 'update') {
        showToast(
          reloaded
            ? t('toolboxPluginUpdateSuccess', localizeToolboxMetadata(tool).title)
            : t('toolboxPluginUpdateListFailed'),
          reloaded ? 'success' : 'error',
        );
      }
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : String(actionError);
      setError(message);
      if (action === 'update') showToast(t('toolboxSkillUpdateFailed', message), 'error');
      if (action === 'skill') showToast(t('toolboxSkillToggleFailed', message), 'error');
    } finally {
      pluginActionLockRef.current = false;
      setBusyPlugin(null);
    }
  };

  const reconnectNativeHost = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'resetAgentBridge' });
      if (!response?.success) throw new Error(response?.error || t('toolboxReconnectFailed'));
      await loadTools();
    } catch (cause) {
      showToast(
        t('toolboxRefreshFailed', cause instanceof Error ? cause.message : String(cause)),
        'error',
      );
    }
  };

  const installTool = (job: ToolboxInstallJob) => {
    if (loading || nativeHostUpdate) return;
    try {
      connectInstallQueue().postMessage(job);
    } catch (cause) {
      showToast(
        t('toolboxInstallFailed', cause instanceof Error ? cause.message : String(cause)),
        'error',
      );
    }
  };

  const rows: Array<{
    id: string;
    title: string;
    description?: string;
    icon: ToolIcon;
    onClick: () => void;
    plugin?: ToolboxPluginTool;
  }> = [
    {
      id: 'builtin:formatter',
      title: t('popupToolFormatter'),
      description: t('toolboxFormatterDescription'),
      icon: Braces,
      onClick: () => onSelectBuiltIn?.('formatter'),
    },
    {
      id: 'builtin:chat',
      title: t('agentChatTitle'),
      description: t('toolboxChatDescription'),
      icon: Bot,
      onClick: () => onSelectBuiltIn?.('chat'),
    },
    {
      id: 'builtin:rules',
      title: t('popupToolRules'),
      description: t('toolboxRulesDescription'),
      icon: Globe2,
      onClick: () => onSelectBuiltIn?.('rules'),
    },
    {
      id: 'builtin:browsers',
      title: t('popupToolBrowsers'),
      description: t('toolboxBrowsersDescription'),
      icon: Monitor,
      onClick: () => onSelectBuiltIn?.('browsers'),
    },
    {
      id: 'builtin:capture',
      title: t('toolboxDeviceCaptureTitle'),
      description: t('toolboxDeviceCaptureDescription'),
      icon: Rotate3d,
      onClick: openBuiltInCapture,
    },
    ...tools.map(tool => {
      const localized = localizeToolboxMetadata(tool);
      return {
        id: tool.id,
        title: localized.title,
        description: localized.description,
        icon: tool.icon ?? 'blocks',
        onClick: () => void openPluginTool(localized),
        plugin: tool,
      };
    }),
  ];
  const sortedRows = sortToolsByOrder(
    rows.filter(
      row =>
        (row.id !== 'builtin:capture' || requestCasesEnabled) &&
        (row.id !== 'builtin:chat' || chatAvailable),
    ),
    toolOrder,
  );

  const updateToolOrder = (ids: string[]) => {
    setToolOrder(ids);
    onOrderChange?.(ids);
    try {
      window.localStorage.setItem(TOOLBOX_ORDER_STORAGE_KEY, JSON.stringify(ids));
    } catch {
      // 存储不可用时保留当前 Popup 内的排序。
    }
  };

  const updatePinnedCount = (count: number) => {
    setPinnedCount(count);
    onPinnedCountChange?.(count);
    try {
      window.localStorage.setItem(TOOLBOX_PINNED_COUNT_STORAGE_KEY, String(count));
    } catch {
      // 存储不可用时保留当前 Popup 内的顶部展示数量。
    }
  };

  const resetToolOrder = () => {
    setToolOrder([]);
    onOrderChange?.([]);
    setPinnedCount(DEFAULT_PINNED_TOOL_COUNT);
    onPinnedCountChange?.(DEFAULT_PINNED_TOOL_COUNT);
    try {
      window.localStorage.removeItem(TOOLBOX_ORDER_STORAGE_KEY);
      window.localStorage.removeItem(TOOLBOX_PINNED_COUNT_STORAGE_KEY);
    } catch {
      // 存储不可用时仍恢复当前 Popup 内的默认顺序。
    }
  };

  const toolSwitcher = selectedTool ? (
    <ToolSwitcher
      key={selectedTool.kind === 'capture' ? 'builtin:capture' : selectedTool.id}
      currentId={selectedTool.kind === 'capture' ? 'builtin:capture' : selectedTool.id}
      tools={sortedRows
        .slice(pinnedCount)
        .filter(row => surface !== 'tab' || row.plugin?.displayMode !== 'popup')}
    />
  ) : null;

  if (requestCasesEnabled && selectedTool?.kind === 'capture') {
    return (
      <DeviceCaptureEntry
        onBack={closeSelectedTool}
        headerActions={toolSwitcher}
        surface={surface}
      />
    );
  }

  if (selectedTool?.kind === 'plugin' && selectedTool.tool) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-primary">
        {error ? (
          <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xxs text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
            {t('toolboxUnavailable', error)}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">
          <Suspense
            fallback={
              <ToolOpening
                key={selectedTool.id}
                onBack={directEntry ? undefined : closeSelectedTool}
                title={localizeToolboxMetadata(selectedTool.tool).title}
                headerActions={toolSwitcher}
              />
            }
          >
            <SandboxToolPage
              key={`${selectedTool.id}:${selectedTool.tool.page.hash}:${selectedTool.revision ?? 0}`}
              agent={selectedTool.tool.agent}
              skillUpdate={selectedTool.tool.skillUpdate}
              embedded
              initialHtml={selectedTool.html}
              headerActions={
                <>
                  {pendingToolUpdate?.id === selectedTool.id && (
                    <button
                      type="button"
                      className="rounded p-1 text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                      title={t('toolboxPageUpdateReady')}
                      aria-label={t('toolboxPageUpdateReady')}
                      onClick={() => {
                        const updated = pendingToolUpdate.tool;
                        setPendingToolUpdate(null);
                        if (updated.displayMode === 'tab') {
                          void openSelectedToolInTab({ ...selectedTool, tool: updated });
                        } else if (updated.displayMode === 'popup' && surface === 'tab') {
                          setSelectedTool(null);
                          setError(t('toolboxPopupOnly'));
                        } else {
                          setSelectedTool({
                            ...selectedTool,
                            title: localizeToolboxMetadata(updated).title,
                            tool: updated,
                            html: pendingToolUpdate.html,
                            revision: (selectedTool.revision ?? 0) + 1,
                          });
                        }
                      }}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {toolSwitcher}
                </>
              }
              onBack={directEntry ? undefined : closeSelectedTool}
              onOpenInTab={
                selectedTool.tool.displayMode === 'popup'
                  ? undefined
                  : () => void openSelectedToolInTab()
              }
              onQueryChange={setSelectedToolQuery}
              page={selectedTool.tool.page}
              query={selectedToolQuery}
              title={localizeToolboxMetadata(selectedTool.tool).title}
              toolId={selectedTool.id}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  if (selectedTool?.kind === 'plugin') {
    return (
      <ToolOpening
        key={selectedTool.id}
        onBack={directEntry ? undefined : closeSelectedTool}
        title={selectedTool.title}
        headerActions={toolSwitcher}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-primary">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-toolbar px-2 py-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 text-xs font-medium text-text-primary">{t('toolboxTitle')}</h2>
          <p className="truncate text-3xs text-text-secondary">{t('toolboxDescription')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setInstallDialogOpen(true)}
            className="flex h-5.5 cursor-pointer items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-2xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            title={t('toolboxInstallTools')}
            aria-label={t('toolboxInstallTools')}
          >
            <Plus className="w-3 h-3" aria-hidden="true" />
            {toolsLoaded && tools.length === 0 && t('toolboxInstallTools')}
          </button>
          <button
            type="button"
            onClick={() => setSortDialogOpen(true)}
            className="cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            title={t('toolboxSort')}
            aria-label={t('toolboxSort')}
          >
            <ListOrdered className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void loadTools(true)}
            disabled={loading}
            className="cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-default disabled:opacity-50"
            title={t('toolboxRefresh')}
            aria-label={t('toolboxRefresh')}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xxs text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {t('toolboxUnavailable', error)}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <ul className="shrink-0 divide-y divide-border border-b border-border bg-bg-primary empty:border-b-0">
          {sortedRows.slice(pinnedCount).map(row => (
            <ToolRow
              key={row.id}
              title={row.title}
              description={row.description}
              icon={row.icon}
              onClick={row.onClick}
              pluginActions={
                row.plugin
                  ? {
                      busy: Boolean(busyPlugin),
                      canUpdate: Boolean(row.plugin.skillUpdate),
                      skillEnabled: row.plugin.skillEnabled,
                      togglingSkill:
                        busyPlugin?.id === row.plugin.id && busyPlugin.action === 'skill',
                      onToggleSkill: () => void managePlugin(row.plugin!, 'skill'),
                      updatePhase:
                        busyPlugin?.id === row.plugin.id &&
                        (busyPlugin.action === 'checking' || busyPlugin.action === 'updating')
                          ? busyPlugin.action
                          : undefined,
                      uninstalling:
                        busyPlugin?.id === row.plugin.id && busyPlugin?.action === 'uninstall',
                      onUpdate: () => void managePlugin(row.plugin!, 'update'),
                      onUninstall: () => void managePlugin(row.plugin!, 'uninstall'),
                    }
                  : undefined
              }
            />
          ))}
        </ul>

        {!loading && sortedRows.length <= pinnedCount && (
          <p className="flex min-h-0 flex-1 items-center justify-center px-3 py-6 text-center text-xs text-text-secondary">
            {tools.length === 0 ? t('toolboxNoInstalledTools') : t('toolboxAllToolsInHeader')}
          </p>
        )}

        {showLoading && tools.length === 0 && (
          <div
            role="status"
            className="flex items-center gap-2 border-b border-border px-3 py-2 text-3xs text-text-secondary"
          >
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {t('toolboxLoading')}
          </div>
        )}
      </div>
      <Modal
        isOpen={installDialogOpen}
        onClose={() => setInstallDialogOpen(false)}
        size="default"
        ariaLabel={t('toolboxInstallTools')}
        contentStyle={{ maxWidth: 420, maxHeight: 'min(480px, calc(100vh - 24px))' }}
      >
        <ModalHeader
          title={
            <span className="inline-flex items-center gap-2">
              {t('toolboxInstallTools')}
              <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {!nativeHostUpdate && catalog.tools !== null && catalog.loading && (
                  <span role="status" aria-label={t('toolboxCatalogRefreshing')}>
                    <LoaderCircle
                      className="h-3.5 w-3.5 animate-spin text-text-secondary"
                      aria-hidden="true"
                    />
                  </span>
                )}
              </span>
            </span>
          }
          onClose={() => setInstallDialogOpen(false)}
        />
        <ModalContent>
          {!nativeHostUpdate && catalog.tools === null && catalog.loading && (
            <p role="status" className="py-4 text-center text-xs text-text-secondary">
              {t('toolboxLoading')}
            </p>
          )}
          {!nativeHostUpdate &&
            !loading &&
            catalog.tools === null &&
            catalog.failed &&
            !catalog.issues?.length && (
              <div role="alert" className="py-4 text-center text-xs text-text-secondary">
                <p>{t('toolboxCatalogLoadFailed')}</p>
                <button
                  type="button"
                  onClick={catalog.retry}
                  className="mt-2 cursor-pointer rounded border border-border px-3 py-1 hover:bg-bg-hover"
                >
                  {t('retry')}
                </button>
              </div>
            )}
          {!nativeHostUpdate && Boolean(catalog.issues?.length) && (
            <div role="alert" className="mb-2 space-y-1 break-words text-3xs text-text-secondary">
              {catalog.issues?.map((issue, index) => (
                <p key={`${issue.source.id}:${index}`}>
                  {issue.reason === 'conflict'
                    ? t('toolboxCatalogConflict', [issue.source.label, issue.plugin ?? ''])
                    : issue.usingCache
                      ? t('toolboxCatalogSourceCached', issue.source.label)
                      : t('toolboxCatalogSourceFailed', issue.source.label)}
                </p>
              ))}
              <button
                type="button"
                onClick={catalog.retry}
                className="cursor-pointer rounded border border-border px-2 py-1 hover:bg-bg-hover"
              >
                {t('retry')}
              </button>
            </div>
          )}
          {!nativeHostUpdate && catalog.tools?.length === 0 && (
            <p className="py-4 text-center text-xs text-text-secondary">
              {t('toolboxCatalogEmpty')}
            </p>
          )}
          <div className="space-y-2">
            {installableRepositories.map(
              ({ source, pendingPriority, repository, tools: availableTools }) => (
                <section
                  key={`${source.id}:${repository}`}
                  aria-label={`${source.label} · ${repository}`}
                >
                  <h3 className="mb-1 truncate text-3xs text-text-secondary" title={repository}>
                    {source.label} · {repository}
                  </h3>
                  <ul className="divide-y divide-border rounded border border-border bg-bg-primary">
                    {availableTools.map(tool => (
                      <InstallableToolRow
                        key={tool.id}
                        tool={tool}
                        installed={tools.some(
                          candidate => candidate.id === tool.id || candidate.plugin === tool.plugin,
                        )}
                        phase={
                          installQueue?.installing === tool.id
                            ? 'installing'
                            : installQueue?.queued.includes(tool.id)
                              ? 'queued'
                              : undefined
                        }
                        disabled={loading || Boolean(nativeHostUpdate) || pendingPriority}
                        onInstall={installTool}
                      />
                    ))}
                  </ul>
                </section>
              ),
            )}
          </div>
          {nativeHostUpdate && (
            <NativeHostUpdateGuide
              context="toolbox"
              update={nativeHostUpdate}
              retry={reconnectNativeHost}
            />
          )}
        </ModalContent>
      </Modal>
      <Modal
        isOpen={sortDialogOpen}
        onClose={() => setSortDialogOpen(false)}
        size="default"
        ariaLabel={t('toolboxSort')}
        contentStyle={{ maxWidth: 420, maxHeight: 'min(480px, calc(100vh - 24px))' }}
      >
        <ModalHeader
          title={t('toolboxSort')}
          onClose={() => setSortDialogOpen(false)}
          actions={
            <button
              type="button"
              onClick={resetToolOrder}
              disabled={toolOrder.length === 0 && pinnedCount === DEFAULT_PINNED_TOOL_COUNT}
              className="cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-default disabled:opacity-40"
              title={t('toolboxSortReset')}
              aria-label={t('toolboxSortReset')}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          }
        />
        <ModalContent>
          <ToolOrderList
            tools={sortedRows}
            pinnedCount={pinnedCount}
            onOrderChange={updateToolOrder}
            onPinnedCountChange={updatePinnedCount}
          />
        </ModalContent>
      </Modal>
    </div>
  );
}
