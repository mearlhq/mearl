import { invokeToolboxHostCapability } from './toolboxHostCapabilities';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { flushSync } from 'react-dom';
import { ArrowLeft, Bot, LoaderCircle, Maximize2 } from 'lucide-react';
import type {
  ToolboxAgentConfig,
  ToolboxSandboxPage,
  ToolboxSkillUpdate,
} from '@mearl/browser-core';
import { getCurrentLanguage, t } from '../panel/utils/i18n';
import { showToast } from '../panel/utils/toast';
import { requestToolbox } from '../popup/toolboxRequest';
import { requestNativeHost } from '../sidepanel/nativeHostRequest';
import { SidepanelChat, type AgentChatGuide } from '../sidepanel/SidepanelChat';
import { loadToolboxPageBundle, removeCachedToolboxTool } from '../../shared/toolboxPageBundle';
import { prepareToolboxPageHtml } from '../../shared/toolboxUiRuntime';
import { TOOLBOX_SANDBOX_PERMISSIONS } from './toolboxSandboxPermissions';

const LOADING_INDICATOR_DELAY_MS = 300;

interface SandboxToolPageProps {
  agent?: ToolboxAgentConfig;
  embedded?: boolean;
  onBack?: () => void;
  onOpenInTab?: () => void;
  headerActions?: ReactNode;
  onQueryChange?: (query: Record<string, string>) => void;
  page: ToolboxSandboxPage;
  initialHtml?: string;
  query?: Record<string, string>;
  skillUpdate?: ToolboxSkillUpdate;
  title: string;
  toolId: string;
}

interface PluginInvokeMessage {
  type: 'invoke';
  requestId: string;
  command: string;
  input?: Record<string, unknown>;
}

interface PluginPageModalMessage {
  type: 'page-modal';
  open: boolean;
  positions?: { key: string; bounds: AgentPanelBounds }[];
}

type AgentPanelLayout = 'drawer' | 'workspace' | 'inline';

interface AgentPanelBounds {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface InlineAgentPanelState {
  key: string;
  cwd: string | null;
  context: string | null;
  bounds: AgentPanelBounds;
}

interface PluginAgentPanelMessage {
  type: 'agent-panel';
  requestId: string;
  visible: boolean;
  layout?: AgentPanelLayout;
  key?: string;
  cwd?: string;
  context?: string;
  bounds?: AgentPanelBounds;
}

interface PluginAgentPanelPositionMessage {
  type: 'agent-panel-position';
  key: string;
  bounds: AgentPanelBounds;
}

interface PluginAgentGuidesMessage {
  type: 'agent-guides';
  requestId: string;
  guides: unknown;
}

interface PluginAgentTaskMessage {
  type: 'agent-task';
  requestId: string;
  prompt: string;
  cwd?: string;
  ephemeral?: boolean;
  layout?: AgentPanelLayout;
  key?: string;
  bounds?: AgentPanelBounds;
}

interface PluginQueryParamMessage {
  type: 'query-param';
  requestId: string;
  name: string;
  value: string | null;
}

type PluginHostMessage =
  | PluginInvokeMessage
  | PluginPageModalMessage
  | PluginAgentGuidesMessage
  | PluginAgentPanelMessage
  | PluginAgentPanelPositionMessage
  | PluginAgentTaskMessage
  | PluginQueryParamMessage;

export interface EmbeddedAgentTask {
  id: string;
  prompt: string;
  providerId: 'codex';
  cwd?: string;
  panelKey?: string;
}

export interface EmbeddedAgentTaskResult {
  ok: boolean;
  error?: string;
}

function currentQuery(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

function currentTheme(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function agentGuideText(value: unknown, label: string, maximumLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximumLength) {
    throw new Error(
      `${label} must be a non-empty string no longer than ${maximumLength} characters`,
    );
  }
  return normalized;
}

function normalizeAgentGuides(value: unknown): AgentChatGuide[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 6) {
    throw new Error('Agent guides must contain between 1 and 6 items');
  }
  return value.map((guide, index) => {
    if (!guide || typeof guide !== 'object' || Array.isArray(guide)) {
      throw new Error(`Agent guide ${index} must be an object`);
    }
    const candidate = guide as Record<string, unknown>;
    const icon =
      candidate.icon === undefined
        ? undefined
        : agentGuideText(candidate.icon, 'Agent guide icon', 40);
    if (icon && !/^[a-z][a-z0-9-]*$/.test(icon)) {
      throw new Error('Agent guide icon must use kebab-case');
    }
    return {
      title: agentGuideText(candidate.title, 'Agent guide title', 80),
      description: agentGuideText(candidate.description, 'Agent guide description', 160),
      prompt: agentGuideText(candidate.prompt, 'Agent guide prompt', 4000),
      ...(icon ? { icon } : {}),
    };
  });
}

function isAgentPanelBounds(value: unknown): value is AgentPanelBounds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bounds = value as Partial<AgentPanelBounds>;
  return [bounds.top, bounds.left, bounds.width, bounds.height].every(
    part => typeof part === 'number' && Number.isFinite(part),
  );
}

function hasAgentPresentation(
  message: {
    layout?: AgentPanelLayout;
    key?: string;
    bounds?: AgentPanelBounds;
  },
  defaultLayout: AgentPanelLayout,
): boolean {
  const layout = message.layout ?? defaultLayout;
  if (layout !== 'inline') {
    return (
      message.bounds === undefined || (layout === 'workspace' && isAgentPanelBounds(message.bounds))
    );
  }
  return (
    typeof message.key === 'string' &&
    Boolean(message.key.trim()) &&
    message.key.length <= 128 &&
    isAgentPanelBounds(message.bounds)
  );
}

function isAgentPanelKey(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 128;
}

function isAgentPanelCwd(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    value.length <= 4096 &&
    /^(?:\/|[a-zA-Z]:[\\/])/.test(value.trim())
  );
}

function isAgentPanelContext(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 65_536;
}

function canConsumeWheel(
  target: EventTarget | null,
  boundary: HTMLElement,
  axis: 'x' | 'y',
  delta: number,
): boolean {
  let element = target instanceof Element ? target : null;
  while (element && boundary.contains(element)) {
    if (element instanceof HTMLElement) {
      const style = window.getComputedStyle(element);
      const overflow = axis === 'x' ? style.overflowX : style.overflowY;
      const scrollPosition = axis === 'x' ? element.scrollLeft : element.scrollTop;
      const scrollSize = axis === 'x' ? element.scrollWidth : element.scrollHeight;
      const clientSize = axis === 'x' ? element.clientWidth : element.clientHeight;
      if (/^(auto|scroll|overlay)$/.test(overflow) && scrollSize > clientSize) {
        const maximum = scrollSize - clientSize;
        if ((delta < 0 && scrollPosition > 0) || (delta > 0 && scrollPosition < maximum - 1)) {
          return true;
        }
      }
    }
    element = element.parentElement;
  }
  return false;
}

function wheelDeltaPixels(event: ReactWheelEvent<HTMLElement>): { x: number; y: number } {
  const multiplier =
    event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? event.currentTarget.clientHeight : 1;
  const clamp = (value: number) => Math.max(-2000, Math.min(2000, value * multiplier));
  return { x: clamp(event.deltaX), y: clamp(event.deltaY) };
}

export function SandboxToolPage({
  agent,
  embedded = false,
  onBack,
  onOpenInTab,
  headerActions,
  onQueryChange,
  page,
  initialHtml,
  query,
  skillUpdate,
  title,
  toolId,
}: SandboxToolPageProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const agentTaskSequenceRef = useRef(0);
  // Port requests can arrive before React commits the latest panel key.
  const activeAgentPanelKeyRef = useRef<string | null>(null);
  const pendingAgentTaskRequestsRef = useRef(
    new Map<string, { port: MessagePort; requestId: string }>(),
  );
  const queryRef = useRef(query);
  const onQueryChangeRef = useRef(onQueryChange);
  queryRef.current = query;
  onQueryChangeRef.current = onQueryChange;
  const defaultAgentPanelLayout = agent?.layout ?? 'drawer';
  const configuredWorkspaceAgent = defaultAgentPanelLayout === 'workspace';
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsUserScripts, setNeedsUserScripts] = useState(false);
  const [pageRevision, setPageRevision] = useState(0);
  const [showLoading, setShowLoading] = useState(false);
  const [agentPanelVisible, setAgentPanelVisible] = useState(false);
  const [pageModalOpen, setPageModalOpen] = useState(false);
  const [agentPanelMounted, setAgentPanelMounted] = useState(false);
  const [agentPanelLayout, setAgentPanelLayout] =
    useState<AgentPanelLayout>(defaultAgentPanelLayout);
  const [agentPanelKey, setAgentPanelKey] = useState<string | null>(null);
  const [agentPanelCwd, setAgentPanelCwd] = useState<string | null>(null);
  const [agentPanelContext, setAgentPanelContext] = useState<string | null>(null);
  const [workspaceAgentAnchor, setWorkspaceAgentAnchor] = useState<{
    key: string;
    bounds: AgentPanelBounds;
  } | null>(null);
  const [inlineAgentPanels, setInlineAgentPanels] = useState<Record<string, InlineAgentPanelState>>(
    {},
  );
  const [agentGuides, setAgentGuides] = useState<AgentChatGuide[] | undefined>();
  const [agentTasks, setAgentTasks] = useState<EmbeddedAgentTask[]>([]);
  const [windowId, setWindowId] = useState<number | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(currentTheme);
  const locale = getCurrentLanguage();
  const [skillUpdateState, setSkillUpdateState] = useState<
    'none' | 'available' | 'updating' | 'updated' | 'refreshing'
  >('none');

  useEffect(() => {
    if (!skillUpdate) {
      setSkillUpdateState('none');
      return;
    }
    let active = true;
    setSkillUpdateState('none');
    void requestNativeHost('agent_skills_check_updates', { providerId: 'codex' })
      .then(result => {
        if (
          active &&
          result.updates.some(
            update => update.name === skillUpdate.name && update.scope === skillUpdate.scope,
          )
        ) {
          setSkillUpdateState('available');
        }
      })
      .catch(() => {
        // 更新检查不影响工具页面的正常使用。
      });
    return () => {
      active = false;
    };
  }, [skillUpdate?.name, skillUpdate?.scope]);

  const refreshUpdatedSkill = async () => {
    if (skillUpdateState !== 'updated') return;
    setSkillUpdateState('refreshing');
    try {
      await removeCachedToolboxTool(toolId);
      window.location.reload();
    } catch (refreshError) {
      setSkillUpdateState('updated');
      showToast(
        t(
          'toolboxRefreshFailed',
          refreshError instanceof Error ? refreshError.message : String(refreshError),
        ),
        'error',
      );
    }
  };

  const updateSkill = async () => {
    if (!skillUpdate || skillUpdateState !== 'available') return;
    setSkillUpdateState('updating');
    try {
      await requestNativeHost('agent_skills_update', {
        providerId: 'codex',
        name: skillUpdate.name,
        scope: skillUpdate.scope,
      });
      setSkillUpdateState('updated');
      showToast(t('toolboxSkillRefreshToApply'), 'success');
    } catch (updateError) {
      setSkillUpdateState('available');
      showToast(
        t(
          'toolboxSkillUpdateFailed',
          updateError instanceof Error ? updateError.message : String(updateError),
        ),
        'error',
      );
    }
  };

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => setTheme(mediaQuery.matches ? 'dark' : 'light');
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    portRef.current?.postMessage({ type: 'context', context: { theme, locale, title } });
  }, [theme, locale, title]);

  useEffect(() => {
    let active = true;
    const loadCurrentWindow = async () => {
      try {
        const currentWindow = await chrome.windows.getCurrent();
        if (active) setWindowId(typeof currentWindow.id === 'number' ? currentWindow.id : null);
      } catch {
        if (active) setWindowId(null);
      }
    };
    void loadCurrentWindow();
    return () => {
      active = false;
    };
  }, []);

  useLayoutEffect(() => {
    let active = true;
    setNeedsUserScripts(false);
    setAgentPanelVisible(false);
    setAgentPanelMounted(false);
    setPageModalOpen(false);
    setAgentPanelLayout(defaultAgentPanelLayout);
    setAgentPanelKey(null);
    activeAgentPanelKeyRef.current = null;
    setAgentPanelCwd(null);
    setAgentPanelContext(null);
    setWorkspaceAgentAnchor(null);
    setInlineAgentPanels({});
    setAgentGuides(undefined);
    setAgentTasks([]);
    const timer = window.setTimeout(() => setShowLoading(true), LOADING_INDICATOR_DELAY_MS);
    const load = async () => {
      try {
        const content = initialHtml ?? (await loadToolboxPageBundle(toolId, page));
        const preparedContent = await prepareToolboxPageHtml(content, page.runtime);
        if (active) setHtml(preparedContent);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        window.clearTimeout(timer);
        if (active) setShowLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
      window.clearTimeout(timer);
      portRef.current?.close();
      portRef.current = null;
    };
  }, [defaultAgentPanelLayout, initialHtml, page, toolId]);

  useEffect(() => {
    if (!agentPanelVisible || agentPanelLayout !== 'drawer') return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setAgentPanelVisible(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [agentPanelLayout, agentPanelVisible]);

  const handleInlineAgentPanelWheel = useCallback(
    (key: string, event: ReactWheelEvent<HTMLElement>) => {
      if (event.ctrlKey) return;
      const delta = wheelDeltaPixels(event);
      const axis = Math.abs(delta.y) >= Math.abs(delta.x) ? 'y' : 'x';
      const dominantDelta = axis === 'y' ? delta.y : delta.x;
      if (
        !dominantDelta ||
        canConsumeWheel(event.target, event.currentTarget, axis, dominantDelta)
      ) {
        return;
      }
      event.preventDefault();
      portRef.current?.postMessage({
        type: 'agent-panel-wheel',
        key,
        deltaX: axis === 'x' ? dominantDelta : 0,
        deltaY: axis === 'y' ? dominantDelta : 0,
      });
    },
    [],
  );

  const loadPage = useCallback(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow || !html) return;
    frameWindow.postMessage({ type: 'mearl-plugin-load', html }, '*');
  }, [html]);

  // The sandbox host and HTML load in parallel; either may become ready first.
  useLayoutEffect(() => {
    loadPage();
  }, [loadPage, pageRevision]);

  const settleAgentTask = useCallback((taskId: string, result: EmbeddedAgentTaskResult) => {
    const request = pendingAgentTaskRequestsRef.current.get(taskId);
    if (!request) return;
    pendingAgentTaskRequestsRef.current.delete(taskId);
    setAgentTasks(current => current.filter(task => task.id !== taskId));
    request.port.postMessage({
      type: 'result',
      requestId: request.requestId,
      ok: result.ok,
      ...(result.ok ? { result: null } : { error: result.error || 'Agent task was not submitted' }),
    });
  }, []);

  const connect = useCallback(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow) return;
    portRef.current?.close();
    const channel = new MessageChannel();
    const postReply = (reply: Record<string, unknown>) => {
      if (portRef.current !== channel.port1) return;
      if (
        reply.type === 'result' &&
        reply.ok === false &&
        typeof reply.error === 'string' &&
        reply.error.includes('USER_SCRIPTS_DISABLED:')
      ) {
        setNeedsUserScripts(true);
        reply.handledByHost = true;
      }
      channel.port1.postMessage(reply);
    };
    portRef.current = channel.port1;
    setPageModalOpen(false);
    channel.port1.onmessage = event => {
      const message = event.data as Partial<PluginHostMessage> | undefined;
      if (message?.type === 'page-modal' && typeof message.open === 'boolean') {
        const open = message.open;
        const positions = Array.isArray(message.positions)
          ? message.positions.filter(
              position =>
                position && isAgentPanelKey(position.key) && isAgentPanelBounds(position.bounds),
            )
          : [];
        // Visibility and restored anchor bounds must reach the DOM in the same commit.
        flushSync(() => {
          if (!open && positions.length) {
            setWorkspaceAgentAnchor(current => {
              const position = positions.find(item => item.key === current?.key);
              return current && position ? { ...current, bounds: position.bounds } : current;
            });
            setInlineAgentPanels(current => {
              const next = { ...current };
              for (const position of positions) {
                const panel = next[position.key];
                if (panel) next[position.key] = { ...panel, bounds: position.bounds };
              }
              return next;
            });
          }
          setPageModalOpen(open);
        });
        return;
      }
      if (
        message?.type === 'agent-panel-position' &&
        isAgentPanelKey(message.key) &&
        isAgentPanelBounds(message.bounds)
      ) {
        setWorkspaceAgentAnchor(current =>
          current && current.key === message.key
            ? { ...current, bounds: message.bounds! }
            : current,
        );
        setInlineAgentPanels(current => {
          const panel = current[message.key!];
          return panel
            ? { ...current, [message.key!]: { ...panel, bounds: message.bounds! } }
            : current;
        });
        return;
      }
      if (
        message?.type === 'query-param' &&
        typeof message.requestId === 'string' &&
        typeof message.name === 'string' &&
        /^[a-z][a-z0-9-]{0,63}$/.test(message.name) &&
        (message.value === null ||
          (typeof message.value === 'string' && message.value.length <= 512))
      ) {
        let nextQuery: Record<string, string>;
        if (queryRef.current !== undefined) {
          nextQuery = { ...queryRef.current };
          if (message.value === null) delete nextQuery[message.name];
          else nextQuery[message.name] = message.value;
          queryRef.current = nextQuery;
          onQueryChangeRef.current?.(nextQuery);
        } else {
          const url = new URL(window.location.href);
          if (message.value === null) url.searchParams.delete(message.name);
          else url.searchParams.set(message.name, message.value);
          window.history.replaceState(window.history.state, '', url);
          nextQuery = currentQuery();
        }
        postReply({
          type: 'result',
          requestId: message.requestId,
          ok: true,
          result: nextQuery,
        });
        return;
      }
      if (message?.type === 'agent-guides' && typeof message.requestId === 'string') {
        if (!agent) {
          postReply({
            type: 'result',
            requestId: message.requestId,
            ok: false,
            error: 'Agent panel is not enabled for this tool',
          });
          return;
        }
        try {
          setAgentGuides(normalizeAgentGuides(message.guides));
          postReply({
            type: 'result',
            requestId: message.requestId,
            ok: true,
            result: null,
          });
        } catch (guideError) {
          postReply({
            type: 'result',
            requestId: message.requestId,
            ok: false,
            error: guideError instanceof Error ? guideError.message : String(guideError),
          });
        }
        return;
      }
      if (
        message?.type === 'agent-panel' &&
        typeof message.requestId === 'string' &&
        typeof message.visible === 'boolean' &&
        (message.layout === undefined ||
          message.layout === 'drawer' ||
          message.layout === 'workspace' ||
          message.layout === 'inline') &&
        (message.key === undefined || isAgentPanelKey(message.key)) &&
        (message.cwd === undefined || isAgentPanelCwd(message.cwd)) &&
        (message.context === undefined || isAgentPanelContext(message.context)) &&
        (!message.visible || hasAgentPresentation(message, defaultAgentPanelLayout))
      ) {
        if (!agent) {
          postReply({
            type: 'result',
            requestId: message.requestId,
            ok: false,
            error: 'Agent panel is not enabled for this tool',
          });
          return;
        }
        if (message.visible) {
          const layout = message.layout ?? defaultAgentPanelLayout;
          const panelKey = typeof message.key === 'string' ? message.key.trim() : null;
          setWorkspaceAgentAnchor(
            layout === 'workspace' && message.bounds
              ? { key: panelKey ?? 'toolbox-workspace', bounds: message.bounds }
              : null,
          );
          if (layout === 'inline') {
            const key = panelKey!;
            setAgentPanelVisible(false);
            setInlineAgentPanels(current => ({
              ...current,
              [key]: {
                key,
                cwd: typeof message.cwd === 'string' ? message.cwd.trim() : null,
                context: typeof message.context === 'string' ? message.context.trim() : null,
                bounds: message.bounds!,
              },
            }));
          } else {
            setInlineAgentPanels({});
            setAgentPanelLayout(layout);
            setAgentPanelKey(panelKey);
            activeAgentPanelKeyRef.current = panelKey;
            setAgentPanelCwd(typeof message.cwd === 'string' ? message.cwd.trim() : null);
            setAgentPanelContext(
              typeof message.context === 'string' ? message.context.trim() : null,
            );
            setAgentPanelMounted(true);
            setAgentPanelVisible(true);
          }
        } else if (typeof message.key === 'string') {
          const key = message.key.trim();
          if (activeAgentPanelKeyRef.current === key) {
            setAgentPanelVisible(false);
            setWorkspaceAgentAnchor(null);
          }
          setInlineAgentPanels(current => {
            if (!current[key]) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
        } else {
          setInlineAgentPanels({});
          setAgentPanelVisible(false);
          setWorkspaceAgentAnchor(null);
        }
        window.setTimeout(() => {
          postReply({
            type: 'result',
            requestId: message.requestId,
            ok: true,
            result: null,
          });
        });
        return;
      }
      if (
        message?.type === 'agent-task' &&
        typeof message.requestId === 'string' &&
        message.ephemeral === true
      ) {
        postReply({
          type: 'result',
          requestId: message.requestId,
          ok: false,
          error: t('agentChatTemporaryUnsupported'),
        });
        return;
      }
      if (
        message?.type === 'agent-task' &&
        typeof message.requestId === 'string' &&
        typeof message.prompt === 'string' &&
        Boolean(message.prompt.trim()) &&
        message.prompt.length <= 16000 &&
        (message.cwd === undefined ||
          (typeof message.cwd === 'string' &&
            Boolean(message.cwd.trim()) &&
            message.cwd.length <= 4096 &&
            /^(?:\/|[a-zA-Z]:[\\/])/.test(message.cwd.trim()))) &&
        (message.ephemeral === undefined || message.ephemeral === false) &&
        (message.layout === undefined ||
          message.layout === 'drawer' ||
          message.layout === 'workspace' ||
          message.layout === 'inline') &&
        (message.key === undefined || isAgentPanelKey(message.key)) &&
        hasAgentPresentation(message, defaultAgentPanelLayout)
      ) {
        if (!agent) {
          postReply({
            type: 'result',
            requestId: message.requestId,
            ok: false,
            error: 'Agent panel is not enabled for this tool',
          });
          return;
        }
        const layout = message.layout ?? defaultAgentPanelLayout;
        const panelKey = typeof message.key === 'string' ? message.key.trim() : null;
        setWorkspaceAgentAnchor(
          layout === 'workspace' && message.bounds
            ? { key: panelKey ?? 'toolbox-workspace', bounds: message.bounds }
            : null,
        );
        if (layout === 'inline') {
          const key = panelKey!;
          setAgentPanelVisible(false);
          setInlineAgentPanels(current => ({
            ...current,
            [key]: {
              key,
              cwd: typeof message.cwd === 'string' ? message.cwd.trim() : null,
              context: null,
              bounds: message.bounds!,
            },
          }));
        } else {
          setInlineAgentPanels({});
          setAgentPanelLayout(layout);
          setAgentPanelKey(panelKey);
          activeAgentPanelKeyRef.current = panelKey;
          setAgentPanelCwd(typeof message.cwd === 'string' ? message.cwd.trim() : null);
          setAgentPanelContext(null);
          setAgentPanelMounted(true);
          setAgentPanelVisible(true);
        }
        agentTaskSequenceRef.current += 1;
        const task: EmbeddedAgentTask = {
          id: `${agentTaskSequenceRef.current}:${message.requestId}`,
          prompt: message.prompt.trim(),
          providerId: 'codex',
          ...(message.cwd ? { cwd: message.cwd.trim() } : {}),
          ...(panelKey ? { panelKey } : {}),
        };
        pendingAgentTaskRequestsRef.current.set(task.id, {
          port: channel.port1,
          requestId: message.requestId,
        });
        setAgentTasks(current => [...current, task]);
        return;
      }
      if (
        message?.type !== 'invoke' ||
        typeof message.requestId !== 'string' ||
        typeof message.command !== 'string'
      ) {
        return;
      }
      void (async () => {
        try {
          if (!message.input || typeof message.input !== 'object' || Array.isArray(message.input)) {
            if (message.input !== undefined) throw new Error('Plugin input must be an object');
          }
          if (message.command!.startsWith('host.')) {
            const result = await invokeToolboxHostCapability(
              toolId,
              message.command!,
              message.input ?? {},
            );
            postReply({ type: 'result', requestId: message.requestId, ok: true, result });
            return;
          }
          const response = await requestToolbox('toolbox_tool_invoke', {
            id: toolId,
            command: message.command!,
            input: message.input ?? {},
          });
          postReply({
            type: 'result',
            requestId: message.requestId,
            ok: true,
            result: response.result,
          });
        } catch (invokeError) {
          postReply({
            type: 'result',
            requestId: message.requestId,
            ok: false,
            error: invokeError instanceof Error ? invokeError.message : String(invokeError),
          });
        }
      })();
    };
    channel.port1.start();
    frameWindow.postMessage(
      {
        type: 'mearl-plugin-connect',
        context: {
          locale: getCurrentLanguage(),
          theme,
          title,
          fontSize: window.getComputedStyle(document.documentElement).fontSize,
          query: queryRef.current ?? currentQuery(),
        },
      },
      '*',
      [channel.port2],
    );
  }, [agent, defaultAgentPanelLayout, theme, title, toolId]);

  useLayoutEffect(() => {
    const handlePageReady = (event: MessageEvent) => {
      if (event.source && event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === 'mearl-plugin-host-ready') loadPage();
      if (event.data?.type === 'mearl-plugin-ready') connect();
    };
    window.addEventListener('message', handlePageReady);
    return () => window.removeEventListener('message', handlePageReady);
  }, [connect, loadPage]);

  return (
    <div
      className={`flex flex-col overflow-hidden bg-bg-primary text-text-primary ${embedded ? 'h-full w-full' : 'h-screen w-screen'}`}
    >
      {agent || onBack || onOpenInTab || headerActions || skillUpdate ? (
        <header
          className={`flex shrink-0 items-center justify-between border-b border-border bg-toolbar py-1.5 text-text-primary ${embedded && !onBack ? 'px-3' : 'px-2'}`}
        >
          <div className="flex min-h-5.5 min-w-0 flex-1 items-center gap-1">
            {onBack ? (
              <button
                type="button"
                onClick={() => onBack()}
                className="cursor-pointer self-center rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                title={t('toolboxBack')}
                aria-label={t('toolboxBack')}
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
            <strong className="min-w-0 flex-1 truncate text-xs font-medium">{title}</strong>
          </div>
          <div className="flex shrink-0 items-center gap-1 text-2xs">
            {skillUpdateState !== 'none' ? (
              <button
                type="button"
                disabled={skillUpdateState !== 'available' && skillUpdateState !== 'updated'}
                onClick={() =>
                  void (skillUpdateState === 'updated' ? refreshUpdatedSkill() : updateSkill())
                }
                className="flex h-5.5 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-blue-500/40 bg-blue-500/10 px-1.5 text-2xs leading-none font-medium text-blue-600 transition-colors hover:bg-blue-500/20 disabled:cursor-default disabled:opacity-60 dark:text-blue-400"
              >
                {skillUpdateState === 'updating' || skillUpdateState === 'refreshing' ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : null}
                {skillUpdateState === 'available'
                  ? t('toolboxSkillUpdate')
                  : skillUpdateState === 'updating'
                    ? t('toolboxSkillUpdating')
                    : t('toolboxSkillRefreshToApply')}
              </button>
            ) : null}
            {agent && !configuredWorkspaceAgent ? (
              <button
                type="button"
                aria-controls="toolbox-agent-panel"
                aria-expanded={agentPanelVisible}
                title={
                  agentPanelVisible ? t('agentChatCloseToolPanel') : t('agentChatOpenToolPanel')
                }
                onClick={() => {
                  if (!agentPanelVisible) setAgentPanelMounted(true);
                  setAgentPanelVisible(visible => !visible);
                }}
                className={`flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded border px-2 text-2xs font-medium transition-colors ${agentPanelVisible ? 'border-blue-600 bg-blue-600 text-white' : 'border-border bg-bg-primary text-text-secondary hover:border-blue-500/40 hover:bg-blue-500/10 hover:text-blue-500'}`}
              >
                <Bot className="h-3.5 w-3.5 stroke-[1.7]" aria-hidden="true" />
                <span>{t('agentChatTitle')}</span>
              </button>
            ) : null}
            {headerActions}
            {onOpenInTab ? (
              <button
                type="button"
                onClick={() => onOpenInTab()}
                className="cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                title={t('openInNewTab')}
                aria-label={t('openInNewTab')}
              >
                <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </header>
      ) : null}
      {error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-bg-primary p-8 text-text-primary">
          <p className="max-w-lg rounded-lg border border-red-500/30 bg-red-500/5 p-5 text-center text-xs text-red-500">
            {error}
          </p>
        </div>
      ) : (
        <main className="@container relative min-h-0 flex-1 overflow-hidden">
          <iframe
            key={pageRevision}
            ref={iframeRef}
            inert={needsUserScripts}
            aria-hidden={needsUserScripts}
            src={chrome.runtime.getURL('plugin/sandbox.html')}
            title={title}
            className="block h-full w-full border-0 bg-bg-primary"
            style={{ colorScheme: theme }}
            sandbox={TOOLBOX_SANDBOX_PERMISSIONS}
            referrerPolicy="no-referrer"
            onLoad={() => {
              loadPage();
            }}
          />
          {!html && showLoading && (
            <div
              role="status"
              className="absolute inset-0 flex items-center justify-center gap-2 bg-bg-primary text-xs text-text-secondary"
            >
              <LoaderCircle className="h-4 w-4 animate-spin" />
              {t('toolboxToolOpening')}
            </div>
          )}
          {needsUserScripts ? (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg-primary p-4">
              <section
                role="alert"
                className="w-full max-w-sm space-y-3 rounded border border-border bg-bg-secondary p-4 text-xs"
              >
                <p className="font-medium text-text-primary">{t('toolboxUserScriptsTitle')}</p>
                <p className="leading-relaxed text-text-secondary">{t('toolboxUserScriptsHint')}</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="h-8 cursor-pointer rounded bg-action-primary px-3 text-action-primary-text hover:bg-action-primary-hover"
                    onClick={() => {
                      void chrome.tabs
                        .create({
                          url: `chrome://extensions/?id=${chrome.runtime.id}`,
                          active: true,
                        })
                        .catch(openError => showToast(String(openError), 'error'));
                    }}
                  >
                    {t('toolboxUserScriptsOpen')}
                  </button>
                  <button
                    type="button"
                    className="h-8 cursor-pointer rounded border border-border px-3 text-text-secondary hover:bg-bg-hover"
                    onClick={() => {
                      portRef.current?.close();
                      portRef.current = null;
                      setNeedsUserScripts(false);
                      setPageRevision(revision => revision + 1);
                    }}
                  >
                    {t('retry')}
                  </button>
                </div>
              </section>
            </div>
          ) : null}
          {agent && agentPanelMounted ? (
            <aside
              id="toolbox-agent-panel"
              aria-label={t('agentChatTitle')}
              aria-hidden={!agentPanelVisible || pageModalOpen}
              inert={!agentPanelVisible || pageModalOpen ? true : undefined}
              className={
                agentPanelLayout === 'workspace'
                  ? `absolute z-20 overflow-hidden bg-bg-primary ${agentPanelVisible ? 'visible' : 'invisible pointer-events-none'}`
                  : `absolute inset-y-0 right-0 z-20 w-full max-w-[28rem] overflow-hidden border-l border-border bg-bg-primary shadow-2xl transition-[translate,opacity] duration-200 ease-out motion-reduce:transition-none motion-reduce:animate-none ${agentPanelVisible ? 'animate-toolbox-agent-drawer translate-x-0 opacity-100' : 'translate-x-full pointer-events-none opacity-0'}`
              }
              style={{
                colorScheme: theme,
                visibility: pageModalOpen ? 'hidden' : undefined,
                ...(agentPanelLayout === 'workspace'
                  ? workspaceAgentAnchor
                    ? workspaceAgentAnchor.bounds
                    : { inset: 0 }
                  : {}),
              }}
            >
              <SidepanelChat
                key={agentPanelKey ?? 'toolbox-agent'}
                agentGuides={agentGuides}
                agentTask={
                  agentTasks.find(task => task.panelKey === (agentPanelKey ?? undefined)) ?? null
                }
                compact={embedded}
                embedded
                initialCwd={agentPanelCwd ?? undefined}
                pageElementActions={agent.pageElementActions}
                onAgentTaskSettled={settleAgentTask}
                onClose={
                  agentPanelLayout === 'drawer' ? () => setAgentPanelVisible(false) : undefined
                }
                toolboxToolId={toolId}
                toolboxConversationKey={agentPanelKey ?? undefined}
                toolboxContext={agentPanelContext ?? undefined}
                windowId={windowId}
              />
            </aside>
          ) : null}
          {agent
            ? Object.values(inlineAgentPanels).map(panel => (
                <aside
                  key={panel.key}
                  aria-label={t('agentChatTitle')}
                  aria-hidden={pageModalOpen}
                  inert={pageModalOpen ? true : undefined}
                  onWheel={event => handleInlineAgentPanelWheel(panel.key, event)}
                  className="absolute z-20 overflow-hidden bg-bg-primary"
                  style={{
                    colorScheme: theme,
                    visibility: pageModalOpen ? 'hidden' : undefined,
                    top: panel.bounds.top,
                    left: panel.bounds.left,
                    width: panel.bounds.width,
                    height: panel.bounds.height,
                  }}
                >
                  <SidepanelChat
                    agentGuides={agentGuides}
                    agentTask={agentTasks.find(task => task.panelKey === panel.key) ?? null}
                    compact={embedded}
                    embedded
                    initialCwd={panel.cwd ?? undefined}
                    pageElementActions={agent.pageElementActions}
                    onAgentTaskSettled={settleAgentTask}
                    toolboxToolId={toolId}
                    toolboxConversationKey={panel.key}
                    toolboxContext={panel.context ?? undefined}
                    windowId={windowId}
                  />
                </aside>
              ))
            : null}
        </main>
      )}
    </div>
  );
}
