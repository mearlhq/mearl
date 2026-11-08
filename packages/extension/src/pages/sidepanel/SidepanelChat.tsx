import { getExtensionVersion } from '../../shared/extensionVersion';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  Bot,
  Blocks,
  Bug,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Crosshair,
  Ellipsis,
  ExternalLink,
  FolderOpen,
  Loader2,
  MessageSquareText,
  MousePointer2,
  Network,
  RefreshCw,
  Route,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  SquarePen,
  X,
} from 'lucide-react';
import {
  AGENT_CHAT_MAX_IMAGES,
  AGENT_CHAT_MAX_IMAGE_BYTES,
  AGENT_CHAT_MAX_TOTAL_IMAGE_BYTES,
  AGENT_CHAT_SUPPORTED_IMAGE_MIME_TYPES,
  createBrowserAgentDeveloperInstructions,
  isQoderAuthenticationError,
} from '@mearl/browser-core';
import type { AgentChatEvent, AgentChatImageInput } from '@mearl/browser-core';
import type {
  ElementCommentStyleChanges,
  ElementPickerSelection,
} from '../content-script/elementPicker';
import { JsonTree } from '../panel/components/json-tree/JsonTree';
import { SearchableSelect } from '../panel/components/SearchableSelect';
import { ToastContainer } from '../panel/components/ToastContainer';
import { NativeHostUpdateGuide } from '../panel/components/NativeHostUpdateGuide';
import { useContentScriptUnreachableToast } from '../panel/hooks/useContentScriptUnreachableToast';
import { useElementPicker } from '../panel/hooks/useElementPicker';
import { useAutoScroll } from '../panel/hooks/useAutoScroll';
import { copyToClipboard } from '../panel/utils/clipboard';
import { getConfig, onConfigChange } from '../panel/utils/config';
import { initI18n, t } from '../panel/utils/i18n';
import { setExtensionPageTitle } from '../../shared/pageTitle';
import { QoderLoginActions } from './components/QoderLoginActions';
import { toolboxIcon } from '../../shared/toolboxIcons';
import { sendMessageSafely } from '../panel/utils/safeChrome';
import { showToast } from '../panel/utils/toast';
import {
  agentChatComposerDraftStorageKey,
  agentChatComposerDraftTabId,
} from '../../shared/agentChatComposerDraftStorage';
import { ConversationPicker } from './components/ConversationPicker';
import { ConversationApprovalCard } from './components/ConversationApprovalCard';
import { ConversationMessage } from './components/ConversationMessage';
import { ElementCommentPills } from './components/ElementCommentPills';
import { ProviderSetupGuide } from './components/ProviderSetupGuide';
import { SkillsManagerModal } from './components/SkillsManagerModal';
import { toCompactChatCards } from './compactMessages';
import {
  buildAgentChatConversationExport,
  buildAgentChatDebugExport,
  mergeAgentChatDebugEvents,
} from './debugExport';
import {
  appendPageElementCommentsContext,
  appendSelectedElementContext,
  elementCommentPickerOptions,
  pageElementCommentsDisplayMessage,
  selectedElementLabel,
} from './elementComments';
import { isMearlCommandApproval } from './approvalPolicy';
import type { PageElementComment } from './types';
import { AGENT_CHAT_MAX_RAW_EVENTS, agentRequestIdKey, useAgentChat } from './useAgentChat';
import { requestAgentChatEvents } from './nativeHostRequest';

const AUTO_APPROVE_STORAGE_KEY = 'agentChatSidepanelAutoApproveV1';
const TOOLBOX_COMPOSER_DRAFT_PREFIX = 'agentChatToolboxComposerDraftV1:';
const COMPOSER_MAX_LINES = 5;

function resizeComposerInput(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  const styles = window.getComputedStyle(input);
  const pixels = (value: string): number => Number.parseFloat(value) || 0;
  const lineHeight = pixels(styles.lineHeight) || 20;
  const paddingHeight = pixels(styles.paddingTop) + pixels(styles.paddingBottom);
  const borderHeight = pixels(styles.borderTopWidth) + pixels(styles.borderBottomWidth);
  const contentHeight = input.scrollHeight + borderHeight;
  if (contentHeight <= borderHeight) return;
  const maxHeight = lineHeight * COMPOSER_MAX_LINES + paddingHeight + borderHeight;
  input.style.height = `${Math.min(contentHeight, maxHeight)}px`;
  input.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
}

interface PastedImage extends AgentChatImageInput {
  id: string;
  size: number;
}

interface ComposerDraft {
  input: string;
  selectedElement: ElementPickerSelection | null;
  elementComments: PageElementComment[];
  pastedImages: PastedImage[];
  imageError: string | null;
}

function emptyComposerDraft(): ComposerDraft {
  return {
    input: '',
    selectedElement: null,
    elementComments: [],
    pastedImages: [],
    imageError: null,
  };
}

function hasComposerDraftContent(draft: ComposerDraft): boolean {
  return Boolean(
    draft.input ||
    draft.selectedElement ||
    draft.elementComments.length > 0 ||
    draft.pastedImages.length > 0 ||
    draft.imageError,
  );
}

function isStoredPastedImage(value: unknown): value is PastedImage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const image = value as Record<string, unknown>;
  return (
    typeof image.id === 'string' &&
    typeof image.data === 'string' &&
    typeof image.mimeType === 'string' &&
    typeof image.size === 'number' &&
    Number.isFinite(image.size) &&
    image.size >= 0
  );
}

function storedComposerDraft(value: unknown): ComposerDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  return {
    input: typeof draft.input === 'string' ? draft.input : '',
    selectedElement:
      draft.selectedElement &&
      typeof draft.selectedElement === 'object' &&
      !Array.isArray(draft.selectedElement)
        ? (draft.selectedElement as ElementPickerSelection)
        : null,
    elementComments: Array.isArray(draft.elementComments)
      ? draft.elementComments.filter((comment): comment is PageElementComment =>
          Boolean(comment && typeof comment === 'object' && !Array.isArray(comment)),
        )
      : [],
    pastedImages: Array.isArray(draft.pastedImages)
      ? draft.pastedImages.filter(isStoredPastedImage)
      : [],
    imageError: typeof draft.imageError === 'string' ? draft.imageError : null,
  };
}

const SUPPORTED_PASTED_IMAGE_TYPES = new Set<string>(AGENT_CHAT_SUPPORTED_IMAGE_MIME_TYPES);

function readImageData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const value = reader.result;
      const separator = typeof value === 'string' ? value.indexOf(',') : -1;
      if (typeof value !== 'string' || separator < 0) {
        reject(new Error('Invalid image data'));
        return;
      }
      resolve(value.slice(separator + 1));
    });
    reader.addEventListener('error', () => reject(reader.error || new Error('Image read failed')));
    reader.readAsDataURL(file);
  });
}

export function approvalResult(request: AgentChatEvent, accepted: boolean): unknown {
  if (request.method === 'acp/requestPermission') {
    const options = Array.isArray((request.params as any)?.options)
      ? (request.params as any).options
      : [];
    const preferredKinds = accepted
      ? ['allow_once', 'allow_always']
      : ['reject_once', 'reject_always'];
    const option = preferredKinds
      .map(kind => options.find((candidate: any) => candidate?.kind === kind))
      .find(Boolean);
    return option?.optionId
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }
  if (request.method === 'item/permissions/requestApproval') {
    const requested = (request.params as any)?.permissions || {};
    return {
      permissions: accepted
        ? {
            ...(requested.network ? { network: requested.network } : {}),
            ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
          }
        : {},
      scope: 'turn',
    };
  }
  if (request.method === 'execCommandApproval' || request.method === 'applyPatchApproval') {
    return { decision: accepted ? 'approved' : 'denied' };
  }
  return { decision: accepted ? 'accept' : 'decline' };
}

export function isApprovalRequest(method: string): boolean {
  return (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval' ||
    method === 'execCommandApproval' ||
    method === 'applyPatchApproval' ||
    method === 'acp/requestPermission'
  );
}

function isTextReplyRequest(method: string): boolean {
  return method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request';
}

function sessionStatusText(status: string): string {
  switch (status) {
    case 'idle':
      return t('agentChatStatusIdle');
    case 'running':
      return t('agentChatStatusRunning');
    case 'waiting':
      return t('agentChatStatusWaiting');
    case 'error':
      return t('agentChatStatusError');
    default:
      return status;
  }
}

function workspaceName(directory: string): string {
  const normalized = directory.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).at(-1) || directory;
}

function extensionVersion(): string {
  try {
    return getExtensionVersion();
  } catch {
    return 'unknown';
  }
}

function textReplyResult(request: AgentChatEvent, input: string): unknown {
  try {
    const parsed = JSON.parse(input);
    if (request.method === 'mcpServer/elicitation/request' && !parsed?.action) {
      return { action: 'accept', content: parsed, _meta: null };
    }
    return parsed;
  } catch {
    const questions = (request.params as any)?.questions;
    if (request.method === 'item/tool/requestUserInput' && Array.isArray(questions)) {
      return {
        answers: Object.fromEntries(
          questions
            .filter(question => typeof question?.id === 'string')
            .map(question => [question.id, { answers: [input] }]),
        ),
      };
    }
    if (request.method === 'mcpServer/elicitation/request') {
      const properties = (request.params as any)?.requestedSchema?.properties;
      const firstField =
        properties && typeof properties === 'object' ? Object.keys(properties)[0] : null;
      return {
        action: 'accept',
        content: firstField ? { [firstField]: input } : { value: input },
        _meta: null,
      };
    }
    return { text: input };
  }
}

interface RequestActionsProps {
  request: AgentChatEvent;
  respond: (request: AgentChatEvent, result: unknown) => Promise<void>;
  setReplyRequest: (request: AgentChatEvent) => void;
}

function RequestActions({ request, respond, setReplyRequest }: RequestActionsProps) {
  if (isApprovalRequest(request.method)) {
    return (
      <>
        <button
          onClick={() => respond(request, approvalResult(request, false))}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-text-secondary hover:bg-bg-hover cursor-pointer"
        >
          <ShieldX className="w-3 h-3" />
          {t('agentChatDecline')}
        </button>
        <button
          onClick={() => respond(request, approvalResult(request, true))}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
        >
          <ShieldCheck className="w-3 h-3" />
          {t('agentChatApprove')}
        </button>
      </>
    );
  }

  if (isTextReplyRequest(request.method)) {
    return (
      <>
        {request.method === 'mcpServer/elicitation/request' ? (
          <button
            onClick={() => respond(request, { action: 'decline', content: null, _meta: null })}
            className="px-2 py-1 text-xs rounded border border-border text-text-secondary hover:bg-bg-hover cursor-pointer"
          >
            {t('agentChatDecline')}
          </button>
        ) : null}
        <button
          onClick={() => setReplyRequest(request)}
          className="px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
        >
          {t('agentChatReply')}
        </button>
      </>
    );
  }

  return null;
}

function RequestCard({ request, respond, setReplyRequest }: RequestActionsProps) {
  return (
    <section className="rounded-md border border-border bg-bg-secondary overflow-hidden">
      <div className="px-2 py-1 border-b border-border bg-toolbar font-mono text-3xs text-text-secondary truncate">
        {request.method}
      </div>
      <div className="p-2 overflow-x-auto font-mono text-xxs leading-4">
        <JsonTree
          data={request.params}
          pathPrefix={`agent-chat.request.${request.id}`}
          defaultExpandDepth={2}
          editable={false}
        />
      </div>
      <div className="flex justify-end gap-2 px-2 py-1.5 border-t border-border">
        <RequestActions request={request} respond={respond} setReplyRequest={setReplyRequest} />
      </div>
    </section>
  );
}

export interface AgentChatGuide {
  title: string;
  description: string;
  prompt: string;
  icon?: string;
}

interface SidepanelChatProps {
  windowId: number | null;
  embedded?: boolean;
  compact?: boolean;
  headerAction?: (flushDraft: () => void) => ReactNode;
  pageElementActions?: boolean;
  showOpenInApp?: boolean;
  toolboxToolId?: string;
  toolboxConversationKey?: string;
  toolboxContext?: string;
  initialCwd?: string;
  agentGuides?: AgentChatGuide[];
  agentTask?: {
    id: string;
    prompt: string;
    providerId: string;
    cwd?: string;
  } | null;
  onAgentTaskSettled?: (taskId: string, result: { ok: boolean; error?: string }) => void;
  onClose?: () => void;
}

export function SidepanelChat({
  windowId,
  embedded = false,
  compact = false,
  headerAction,
  pageElementActions = true,
  showOpenInApp = true,
  toolboxToolId,
  toolboxConversationKey,
  toolboxContext,
  initialCwd,
  agentGuides,
  agentTask,
  onAgentTaskSettled,
  onClose,
}: SidepanelChatProps) {
  const toolboxComposerDraftPrefix =
    toolboxToolId && toolboxConversationKey
      ? `${TOOLBOX_COMPOSER_DRAFT_PREFIX}${encodeURIComponent(toolboxToolId)}:${encodeURIComponent(toolboxConversationKey)}:`
      : null;
  const [i18nReady, setI18nReady] = useState(false);
  const [installedProviderId, setInstalledProviderId] = useState<string>();
  const [composerDraftsReady, setComposerDraftsReady] = useState(false);
  const [, forceUpdate] = useState({});
  const [input, setInput] = useState('');
  const [autoApprove, setAutoApprove] = useState(false);
  const [messageHistoryIndex, setMessageHistoryIndex] = useState<number | null>(null);
  const [selectedElement, setSelectedElement] = useState<ElementPickerSelection | null>(null);
  const [elementComments, setElementComments] = useState<PageElementComment[]>([]);
  const [commentSelectionMode, setCommentSelectionMode] = useState<'single' | 'continuous' | null>(
    null,
  );
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [skillsManagerOpen, setSkillsManagerOpen] = useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const commentMode = commentSelectionMode !== null;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputValueRef = useRef('');
  const composerDraftsRef = useRef(new Map<number, ComposerDraft>());
  const composerSnapshotRef = useRef<ComposerDraft>(emptyComposerDraft());
  const composerPersistTimerRef = useRef<number | null>(null);
  const moreActionsRef = useRef<HTMLDivElement>(null);
  const messageHistoryDraftRef = useRef('');
  const autoApprovingRequestIdsRef = useRef(new Set<string>());
  const pastedImagesRef = useRef<PastedImage[]>([]);
  const imageSelectionGenerationRef = useRef(0);
  const commentSelectionModeRef = useRef<'single' | 'continuous' | null>(null);
  const pickerModeRef = useRef<'element' | 'comment' | null>(null);
  const elementCommentIdRef = useRef(0);
  const handledAgentTaskIdsRef = useRef(new Set<string>());
  const preparingAgentTaskIdsRef = useRef(new Set<string>());
  const [preparedAgentTaskId, setPreparedAgentTaskId] = useState<string | null>(null);
  const composerTabIdRef = useRef<number | null>(null);
  const removedComposerTabIdsRef = useRef(new Set<number>());
  const composerDraftStorageKey = useCallback(
    (tabId: number) =>
      toolboxComposerDraftPrefix
        ? `${toolboxComposerDraftPrefix}${tabId}`
        : agentChatComposerDraftStorageKey(tabId),
    [toolboxComposerDraftPrefix],
  );
  const composerDraftTabId = useCallback(
    (key: string) => {
      if (!toolboxComposerDraftPrefix) return agentChatComposerDraftTabId(key);
      if (!key.startsWith(toolboxComposerDraftPrefix)) return null;
      const tabId = Number(key.slice(toolboxComposerDraftPrefix.length));
      return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
    },
    [toolboxComposerDraftPrefix],
  );
  const persistComposerDraft = useCallback(
    (tabId: number, draft: ComposerDraft) => {
      if (!chrome.storage?.session) return;
      const key = composerDraftStorageKey(tabId);
      if (!hasComposerDraftContent(draft)) {
        void chrome.storage.session.remove(key).catch(() => {});
        return;
      }
      void chrome.storage.session.set({ [key]: draft }).catch(() => {
        if (draft.pastedImages.length === 0) return;
        const fallback = { ...draft, pastedImages: [], imageError: null };
        return chrome.storage.session.set({ [key]: fallback }).catch(() => {});
      });
    },
    [composerDraftStorageKey],
  );
  const updateInput = useCallback((value: string) => {
    inputValueRef.current = value;
    setInput(value);
  }, []);
  const updateCommentSelectionMode = useCallback((mode: 'single' | 'continuous' | null) => {
    commentSelectionModeRef.current = mode;
    setCommentSelectionMode(mode);
  }, []);
  const {
    providers,
    providerId,
    setProviderId,
    installProvider,
    workspaceDirectory,
    selectingWorkspace,
    selectWorkspace,
    clearWorkspace,
    resumingSession,
    refreshingSession,
    switchingProvider,
    listSessions,
    resumeSession,
    refreshSession,
    activeTabId,
    conversationTabId,
    hasConversationBinding,
    ephemeral,
    session,
    events,
    conversationEvents,
    initializing,
    nativeHostUpdate,
    submitting,
    error,
    replyRequest,
    setReplyRequest,
    respondedRequestIds,
    send,
    interrupt,
    openInApp,
    newChat,
    retryNativeHost,
    respond,
  } = useAgentChat(windowId, {
    toolboxToolId,
    toolboxConversationKey,
    toolboxContext,
    initialCwd,
  });
  const chatReady = i18nReady && composerDraftsReady && !initializing;
  const scrollContentVersion = useMemo(
    () => ({ events, conversationEvents }),
    [events, conversationEvents],
  );
  const [chatContent, setChatContent] = useState<HTMLDivElement | null>(null);
  const setChatScrollContainerRef = useAutoScroll(scrollContentVersion, {
    enabled: chatReady,
    contextKey: conversationTabId === null ? null : `${conversationTabId}:${providerId}`,
    contentElement: chatContent,
  });
  const handleElementPicked = useCallback((_text: string, selection: ElementPickerSelection) => {
    pickerModeRef.current = null;
    setSelectedElement(selection);
  }, []);
  const handleElementCommented = useCallback(
    (
      comment: string,
      styleChanges: ElementCommentStyleChanges,
      selection: ElementPickerSelection,
      commentId?: string,
    ) => {
      let resolvedId = commentId;
      if (!resolvedId) {
        elementCommentIdRef.current += 1;
        resolvedId = `element-comment-${elementCommentIdRef.current}`;
      }
      setElementComments(current => {
        const nextComment = { id: resolvedId, selection, comment, styleChanges };
        const existingIndex = current.findIndex(item => item.id === resolvedId);
        if (existingIndex < 0) return [...current, nextComment];
        return current.map((item, index) => (index === existingIndex ? nextComment : item));
      });
      if (commentSelectionModeRef.current === 'single') {
        pickerModeRef.current = null;
        updateCommentSelectionMode(null);
      }
    },
    [updateCommentSelectionMode],
  );
  const handleElementPickCancelled = useCallback(() => {
    if (pickerModeRef.current === 'comment') updateCommentSelectionMode(null);
    pickerModeRef.current = null;
  }, [updateCommentSelectionMode]);
  const {
    isPicking: isPickingElement,
    toggle: toggleElementPicker,
    cancel: cancelElementPicker,
    start: startElementPicker,
  } = useElementPicker({
    tabId: activeTabId,
    onPicked: handleElementPicked,
    onCommented: handleElementCommented,
    onCancelled: handleElementPickCancelled,
  });
  const elementSelectionActive = isPickingElement && !commentMode;
  useContentScriptUnreachableToast(activeTabId);

  useLayoutEffect(() => {
    const inputElement = inputRef.current;
    if (!inputElement) return;
    resizeComposerInput(inputElement);
  }, [compact, composerDraftsReady, input, replyRequest]);

  useLayoutEffect(() => {
    const inputElement = inputRef.current;
    if (!inputElement || typeof ResizeObserver !== 'function') return;
    let width = inputElement.getBoundingClientRect().width;
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width ?? inputElement.getBoundingClientRect().width;
      if (Math.abs(nextWidth - width) < 0.5) return;
      width = nextWidth;
      resizeComposerInput(inputElement);
    });
    observer.observe(inputElement);
    return () => observer.disconnect();
  }, [composerDraftsReady]);

  const clearElementCommentMarkers = useCallback((tabId: number | null) => {
    if (tabId === null) return;
    void sendMessageSafely({ action: 'clearElementCommentMarkers', tabId }).catch(() => {});
  }, []);

  const removeElementComment = useCallback(
    (commentId: string) => {
      setElementComments(current => current.filter(comment => comment.id !== commentId));
      if (activeTabId === null) return;
      void sendMessageSafely({
        action: 'removeElementCommentMarker',
        tabId: activeTabId,
        commentId,
      }).catch(() => {});
    },
    [activeTabId],
  );

  const editElementComment = useCallback(
    (commentId: string) => {
      if (activeTabId === null) return;
      void sendMessageSafely({
        action: 'editElementComment',
        tabId: activeTabId,
        commentId,
      }).catch(() => {});
    },
    [activeTabId],
  );

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      try {
        const config = await getConfig();
        await initI18n(config.language);
      } catch {
        await initI18n();
      }
      if (!active) return;
      if (!embedded) setExtensionPageTitle(t('agentChatTitle'));
      setI18nReady(true);
    };
    void initialize();
    const unsubscribe = onConfigChange(async changes => {
      if (!changes.language) return;
      await initI18n(changes.language);
      if (!embedded) setExtensionPageTitle(t('agentChatTitle'));
      forceUpdate({});
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [embedded]);

  useEffect(() => {
    if (!moreActionsOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!moreActionsRef.current?.contains(event.target as Node)) setMoreActionsOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMoreActionsOpen(false);
    };
    const handleResize = () => setMoreActionsOpen(false);
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [moreActionsOpen]);

  useEffect(() => {
    chrome.storage.local.get([AUTO_APPROVE_STORAGE_KEY]).then(stored => {
      setAutoApprove(stored[AUTO_APPROVE_STORAGE_KEY] === true);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!chrome.storage?.session) {
      setComposerDraftsReady(true);
      return;
    }
    chrome.storage.session
      .get(null)
      .then(stored => {
        if (cancelled) return;
        for (const [key, value] of Object.entries(stored)) {
          const tabId = composerDraftTabId(key);
          const draft = storedComposerDraft(value);
          if (tabId !== null && draft && hasComposerDraftContent(draft)) {
            composerDraftsRef.current.set(tabId, draft);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setComposerDraftsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [composerDraftTabId]);

  useEffect(() => {
    const draft: ComposerDraft = {
      input,
      selectedElement,
      elementComments,
      pastedImages,
      imageError,
    };
    composerSnapshotRef.current = draft;
    if (!composerDraftsReady || activeTabId === null || composerTabIdRef.current !== activeTabId) {
      return;
    }
    if (hasComposerDraftContent(draft)) composerDraftsRef.current.set(activeTabId, draft);
    else composerDraftsRef.current.delete(activeTabId);
    if (composerPersistTimerRef.current !== null) {
      window.clearTimeout(composerPersistTimerRef.current);
    }
    composerPersistTimerRef.current = window.setTimeout(() => {
      composerPersistTimerRef.current = null;
      persistComposerDraft(activeTabId, draft);
    }, 150);
  }, [
    activeTabId,
    composerDraftsReady,
    elementComments,
    imageError,
    input,
    pastedImages,
    persistComposerDraft,
    selectedElement,
  ]);

  useLayoutEffect(() => {
    if (!composerDraftsReady) return;
    const previousTabId = composerTabIdRef.current;
    if (previousTabId === activeTabId) return;
    if (composerPersistTimerRef.current !== null) {
      window.clearTimeout(composerPersistTimerRef.current);
      composerPersistTimerRef.current = null;
    }
    if (previousTabId !== null && !removedComposerTabIdsRef.current.delete(previousTabId)) {
      const previousDraft = composerSnapshotRef.current;
      if (hasComposerDraftContent(previousDraft)) {
        composerDraftsRef.current.set(previousTabId, previousDraft);
      } else {
        composerDraftsRef.current.delete(previousTabId);
      }
      persistComposerDraft(previousTabId, previousDraft);
    }
    composerTabIdRef.current = activeTabId;
    const nextDraft = activeTabId === null ? undefined : composerDraftsRef.current.get(activeTabId);
    imageSelectionGenerationRef.current += 1;
    pastedImagesRef.current = nextDraft?.pastedImages ?? [];
    updateInput(nextDraft?.input ?? '');
    setSelectedElement(nextDraft?.selectedElement ?? null);
    setElementComments(nextDraft?.elementComments ?? []);
    updateCommentSelectionMode(null);
    pickerModeRef.current = null;
    setPastedImages(nextDraft?.pastedImages ?? []);
    setImageError(nextDraft?.imageError ?? null);
    setMessageHistoryIndex(null);
    messageHistoryDraftRef.current = '';
  }, [
    activeTabId,
    composerDraftsReady,
    persistComposerDraft,
    updateCommentSelectionMode,
    updateInput,
  ]);

  const flushComposerDraft = useCallback(() => {
    if (composerPersistTimerRef.current !== null) {
      window.clearTimeout(composerPersistTimerRef.current);
      composerPersistTimerRef.current = null;
    }
    const tabId = composerTabIdRef.current;
    if (tabId === null || removedComposerTabIdsRef.current.has(tabId)) return;
    persistComposerDraft(tabId, {
      ...composerSnapshotRef.current,
      input: inputValueRef.current,
      pastedImages: pastedImagesRef.current,
    });
  }, [persistComposerDraft]);

  useEffect(() => () => {
    imageSelectionGenerationRef.current += 1;
    flushComposerDraft();
  }, [flushComposerDraft]);

  useEffect(() => {
    const handleTabUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (changeInfo.status !== 'loading') return;
      const savedDraft = composerDraftsRef.current.get(updatedTabId);
      if (savedDraft && (savedDraft.selectedElement || savedDraft.elementComments.length > 0)) {
        const nextDraft = {
          ...savedDraft,
          selectedElement: null,
          elementComments: [],
        };
        composerDraftsRef.current.set(updatedTabId, nextDraft);
        persistComposerDraft(updatedTabId, nextDraft);
        clearElementCommentMarkers(updatedTabId);
      }
      if (updatedTabId !== activeTabId) return;
      if (!isPickingElement && !commentMode && !selectedElement && elementComments.length === 0) {
        return;
      }
      if (isPickingElement) cancelElementPicker();
      clearElementCommentMarkers(updatedTabId);
      pickerModeRef.current = null;
      setSelectedElement(null);
      setElementComments([]);
      updateCommentSelectionMode(null);
    };
    chrome.tabs.onUpdated.addListener(handleTabUpdated);
    return () => chrome.tabs.onUpdated.removeListener(handleTabUpdated);
  }, [
    activeTabId,
    cancelElementPicker,
    clearElementCommentMarkers,
    commentMode,
    elementComments.length,
    isPickingElement,
    persistComposerDraft,
    selectedElement,
    updateCommentSelectionMode,
  ]);

  useEffect(() => {
    const handleTabRemoved = (tabId: number) => {
      composerDraftsRef.current.delete(tabId);
      if (composerTabIdRef.current === tabId) {
        removedComposerTabIdsRef.current.add(tabId);
        if (composerPersistTimerRef.current !== null) {
          window.clearTimeout(composerPersistTimerRef.current);
          composerPersistTimerRef.current = null;
        }
      }
      if (chrome.storage?.session) {
        void chrome.storage.session.remove(composerDraftStorageKey(tabId)).catch(() => {});
      }
    };
    chrome.tabs.onRemoved.addListener(handleTabRemoved);
    return () => chrome.tabs.onRemoved.removeListener(handleTabRemoved);
  }, [composerDraftStorageKey]);

  const selectedProvider = providers.find(provider => provider.id === providerId);
  const showingInstalledSetup = selectedProvider?.available && installedProviderId === providerId;
  const emptyStateGuides = agentGuides?.length
    ? agentGuides.map((guide, index) => ({
        ...guide,
        key: `toolbox-${index}`,
        icon: toolboxIcon(guide.icon),
      }))
    : [
        {
          key: 'page',
          icon: MousePointer2,
          title: t('agentChatGuidePageTitle'),
          description: t('agentChatGuidePageDescription'),
          prompt: t('agentChatGuidePagePrompt'),
        },
        {
          key: 'request',
          icon: Network,
          title: t('agentChatGuideRequestTitle'),
          description: t('agentChatGuideRequestDescription'),
          prompt: t('agentChatGuideRequestPrompt'),
        },
        {
          key: 'log',
          icon: ScrollText,
          title: t('agentChatGuideLogTitle'),
          description: t('agentChatGuideLogDescription'),
          prompt: t('agentChatGuideLogPrompt'),
        },
        {
          key: 'mock',
          icon: Route,
          title: t('agentChatGuideMockTitle'),
          description: t('agentChatGuideMockDescription'),
          prompt: t('agentChatGuideMockPrompt'),
        },
      ];
  const currentModel = session?.activeModel ?? session?.model;
  const currentModelLabel = currentModel?.displayName || currentModel?.id;
  const canInterrupt = Boolean(session?.activeTurnId);
  const active = session?.status === 'running' || session?.status === 'waiting' || submitting;
  const canRefreshConversation = Boolean(
    session &&
    hasConversationBinding &&
    !ephemeral &&
    selectedProvider?.capabilities.refreshHistory,
  );
  const statusDotClass =
    nativeHostUpdate || !selectedProvider?.available || session?.status === 'error'
      ? 'bg-red-500 ring-red-500/15'
      : session?.status === 'waiting'
        ? 'bg-amber-500 ring-amber-500/15'
        : session?.status === 'running' || submitting
          ? 'bg-blue-500 ring-blue-500/15 animate-pulse'
          : 'bg-green-500 ring-green-500/15';
  const providerStatusLabel = selectedProvider?.available
    ? switchingProvider
      ? t('agentChatSwitchingProvider')
      : resumingSession
        ? t('agentChatResumingConversation')
        : refreshingSession
          ? t('agentChatRefreshingConversation')
          : submitting
            ? t('agentChatStatusRunning')
            : session?.status
              ? sessionStatusText(session.status)
              : t('agentChatReady')
    : nativeHostUpdate
      ? nativeHostUpdate.reason === 'not-connected'
        ? t('agentChatNativeHostInstallStatus')
        : t('agentChatNativeHostUpdateStatus')
      : selectedProvider
        ? t('agentChatNotInstalled')
        : t('agentChatUnavailable');
  const canSendToProvider =
    Boolean(selectedProvider?.available) &&
    !showingInstalledSetup &&
    (session?.providerId === providerId || selectedProvider?.acceptsNewSessions !== false) &&
    !initializing &&
    !resumingSession &&
    !refreshingSession;
  const canOpenCodexApp =
    showOpenInApp &&
    providerId === 'codex' &&
    (Boolean(workspaceDirectory) || (hasConversationBinding && !ephemeral));
  const openCodexAppTitle =
    hasConversationBinding && !ephemeral
      ? t('agentChatOpenCodexApp')
      : t('agentChatOpenCodexWorkspace');

  useEffect(() => {
    if (
      !agentTask ||
      handledAgentTaskIdsRef.current.has(agentTask.id) ||
      initializing ||
      submitting ||
      resumingSession ||
      refreshingSession ||
      switchingProvider ||
      replyRequest ||
      session?.status === 'running' ||
      session?.status === 'waiting'
    ) {
      return;
    }
    if (activeTabId === null) {
      handledAgentTaskIdsRef.current.add(agentTask.id);
      onAgentTaskSettled?.(agentTask.id, {
        ok: false,
        error: t('agentChatTaskNoActiveTab'),
      });
      return;
    }
    const targetProvider = providers.find(provider => provider.id === agentTask.providerId);
    if (!targetProvider?.available) {
      handledAgentTaskIdsRef.current.add(agentTask.id);
      onAgentTaskSettled?.(agentTask.id, {
        ok: false,
        error: t('agentChatTaskProviderUnavailable'),
      });
      return;
    }
    if (preparedAgentTaskId !== agentTask.id) {
      if (preparingAgentTaskIdsRef.current.has(agentTask.id)) return;
      if (
        toolboxConversationKey &&
        providerId === agentTask.providerId &&
        (!agentTask.cwd || workspaceDirectory === agentTask.cwd)
      ) {
        setPreparedAgentTaskId(agentTask.id);
        return;
      }
      preparingAgentTaskIdsRef.current.add(agentTask.id);
      void (async () => {
        try {
          const prepared = await newChat({
            providerId: agentTask.providerId,
            ...(agentTask.cwd ? { cwd: agentTask.cwd } : {}),
          });
          if (prepared) {
            setPreparedAgentTaskId(agentTask.id);
          } else {
            handledAgentTaskIdsRef.current.add(agentTask.id);
            onAgentTaskSettled?.(agentTask.id, {
              ok: false,
              error: t('agentChatTaskCreateFailed'),
            });
          }
        } catch (cause) {
          handledAgentTaskIdsRef.current.add(agentTask.id);
          onAgentTaskSettled?.(agentTask.id, {
            ok: false,
            error: cause instanceof Error ? cause.message : t('agentChatTaskCreateFailed'),
          });
        } finally {
          preparingAgentTaskIdsRef.current.delete(agentTask.id);
        }
      })();
      return;
    }
    if (providerId !== agentTask.providerId) {
      setProviderId(agentTask.providerId);
      return;
    }
    handledAgentTaskIdsRef.current.add(agentTask.id);
    void (async () => {
      const result = await send(agentTask.prompt, {
        ...(agentTask.providerId === 'codex' ? { ephemeral: false } : {}),
      });
      onAgentTaskSettled?.(agentTask.id, {
        ok: result.submitted,
        ...(!result.submitted ? { error: result.error || t('agentChatTaskSubmitFailed') } : {}),
      });
    })();
  }, [
    activeTabId,
    agentTask,
    initializing,
    newChat,
    onAgentTaskSettled,
    preparedAgentTaskId,
    providerId,
    providers,
    refreshingSession,
    replyRequest,
    resumingSession,
    send,
    session?.status,
    setProviderId,
    submitting,
    switchingProvider,
    toolboxConversationKey,
    workspaceDirectory,
  ]);

  const pendingRequests = useMemo(
    () =>
      !session || session.status === 'error'
        ? []
        : events.filter(
            event =>
              event.kind === 'request' &&
              event.requestId !== undefined &&
              !respondedRequestIds.has(agentRequestIdKey(event.requestId)),
          ),
    [events, respondedRequestIds, session],
  );
  const sessionReconnectedMessage = t('agentChatQoderSessionReconnected');
  const chatMessages = useMemo(
    () => toCompactChatCards(conversationEvents, sessionReconnectedMessage),
    [conversationEvents, sessionReconnectedMessage],
  );
  const lastChatMessage = chatMessages.at(-1);
  const qoderNeedsSignIn =
    providerId === 'qoder' &&
    (isQoderAuthenticationError(error) ||
      ((!error || error === t('agentChatSessionUnavailable')) &&
        lastChatMessage?.role === 'system' &&
        isQoderAuthenticationError(lastChatMessage.message)));
  const canSend =
    canSendToProvider &&
    (Boolean(input.trim()) ||
      (!replyRequest && (pastedImages.length > 0 || elementComments.length > 0))) &&
    (pastedImages.length === 0 || selectedProvider?.capabilities.imageInput !== false) &&
    (session?.status !== 'error' || qoderNeedsSignIn) &&
    (replyRequest !== null || !active);
  const failedUserMessage = qoderNeedsSignIn
    ? conversationEvents.findLast(event => event.method === 'chat/userMessage')?.params as
        { text?: unknown; imageCount?: number; hasAdditionalContext?: boolean } | undefined
    : undefined;
  const resendText =
    typeof failedUserMessage?.text === 'string' &&
    !failedUserMessage.imageCount && !failedUserMessage.hasAdditionalContext &&
    (session?.tabId ?? conversationTabId) === activeTabId
      ? failedUserMessage.text.trim()
      : '';
  const hideLatestAuthMessage = qoderNeedsSignIn && lastChatMessage?.role === 'system' &&
    isQoderAuthenticationError(lastChatMessage.message);
  const visibleChatMessages = hideLatestAuthMessage ? chatMessages.slice(0, -1) : chatMessages;
  const canExportConversation = Boolean(
    session &&
    !active &&
    chatMessages.some(message => ['user', 'assistant', 'system'].includes(message.role)),
  );
  const sentMessageHistory = useMemo(
    () =>
      conversationEvents.flatMap(event => {
        if (event.method !== 'chat/userMessage') return [];
        const text = (event.params as { text?: unknown })?.text;
        return typeof text === 'string' && text ? [text] : [];
      }),
    [conversationEvents],
  );
  const manualPendingRequests = pendingRequests.filter(
    request =>
      !isApprovalRequest(request.method) || (!autoApprove && !isMearlCommandApproval(request)),
  );
  const actionableRequests = manualPendingRequests.filter(
    request => isTextReplyRequest(request.method) || isApprovalRequest(request.method),
  );

  useEffect(() => {
    for (const request of pendingRequests) {
      if (!isApprovalRequest(request.method) || request.requestId === undefined) continue;
      if (!autoApprove && !isMearlCommandApproval(request)) continue;
      const key = `${request.sessionId}:${agentRequestIdKey(request.requestId)}`;
      if (autoApprovingRequestIdsRef.current.has(key)) continue;
      autoApprovingRequestIdsRef.current.add(key);
      void respond(request, approvalResult(request, true)).finally(() => {
        autoApprovingRequestIdsRef.current.delete(key);
      });
    }
  }, [autoApprove, pendingRequests, respond]);

  const handleCopyConversation = async () => {
    const success = await copyToClipboard(buildAgentChatConversationExport(conversationEvents));
    showToast(
      success ? t('agentChatConversationCopied') : t('agentChatCopyFailed'),
      success ? 'success' : 'error',
    );
  };

  const handleCopyDebugTrace = async () => {
    if (!session) return;
    try {
      const boundTabId = session.tabId ?? activeTabId ?? undefined;
      const [replayResult, tabResult, runtimeResult] = await Promise.allSettled([
        requestAgentChatEvents(session.id),
        boundTabId === undefined ? Promise.resolve(null) : chrome.tabs.get(boundTabId),
        chrome.runtime.sendMessage({ action: 'getAgentStatus' }),
      ]);

      const replayEvents =
        replayResult.status === 'fulfilled' && Array.isArray(replayResult.value.events)
          ? replayResult.value.events
          : [];
      const runtimeStatus =
        runtimeResult.status === 'fulfilled' &&
        runtimeResult.value?.success &&
        runtimeResult.value.status
          ? runtimeResult.value.status
          : null;
      const browserTab =
        tabResult.status === 'fulfilled' && tabResult.value
          ? {
              id: tabResult.value.id ?? boundTabId!,
              ...(tabResult.value.url ? { url: tabResult.value.url } : {}),
              ...(tabResult.value.title ? { title: tabResult.value.title } : {}),
            }
          : undefined;
      const debugEvents = mergeAgentChatDebugEvents(replayEvents, events);
      const developerInstructionsSource = session.developerInstructions
        ? ('session' as const)
        : boundTabId !== undefined
          ? ('reconstructed' as const)
          : undefined;
      const success = await copyToClipboard(
        buildAgentChatDebugExport(debugEvents, conversationEvents, {
          sessionId: session.id,
          providerId,
          providerName: selectedProvider?.name || providerId,
          provider: selectedProvider,
          sessionStatus: session.status,
          providerSessionId: session.providerSessionId,
          model: session.model,
          activeModel: session.activeModel,
          workspaceDirectory: session.cwd || workspaceDirectory || undefined,
          ephemeral,
          tabId: boundTabId,
          initialPageUrl: session.initialPageUrl,
          initialPageTitle: session.initialPageTitle,
          developerInstructions:
            session.developerInstructions ??
            (boundTabId !== undefined
              ? createBrowserAgentDeveloperInstructions(boundTabId, {
                  ...(browserTab?.url ? { url: browserTab.url } : {}),
                  ...(browserTab?.title ? { title: browserTab.title } : {}),
                })
              : undefined),
          developerInstructionsSource,
          extensionVersion: runtimeStatus?.extensionVersion || extensionVersion(),
          nativeHostVersion: runtimeStatus?.nativeHostVersion,
          browserTab,
          clientSettings: {
            autoApprove,
            saveToCodexHistory: true,
          },
          liveEventCount: events.length,
          liveEventLimit: AGENT_CHAT_MAX_RAW_EVENTS,
          replayEventCount: replayEvents.length,
          replayRetention:
            replayResult.status === 'fulfilled' ? replayResult.value.retention : undefined,
          replayError: replayResult.status === 'rejected' ? String(replayResult.reason) : undefined,
        }),
      );
      showToast(
        success ? t('agentChatDebugTraceCopied') : t('agentChatCopyFailed'),
        success ? 'success' : 'error',
      );
    } catch (copyError) {
      console.error('[Agent Chat] Failed to prepare debug trace:', copyError);
      showToast(t('agentChatCopyFailed'), 'error');
    }
  };

  const handleAutoApproveChange = (enabled: boolean) => {
    setAutoApprove(enabled);
    chrome.storage.local.set({ [AUTO_APPROVE_STORAGE_KEY]: enabled }).catch(() => {});
  };

  const resetMessageHistoryNavigation = () => {
    setMessageHistoryIndex(null);
    messageHistoryDraftRef.current = '';
  };

  const handleGuidePrompt = (prompt: string) => {
    updateInput(prompt);
    resetMessageHistoryNavigation();
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items).flatMap(item => {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) return [];
      const file = item.getAsFile();
      return file ? [file] : [];
    });
    if (files.length === 0) return;

    event.preventDefault();
    if (replyRequest) {
      setImageError(t('agentChatReplyImageUnsupported'));
      return;
    }
    if (selectedProvider?.capabilities.imageInput === false) {
      setImageError(t('agentChatProviderImageUnsupported'));
      return;
    }

    const currentImages = pastedImagesRef.current;
    const remainingSlots = AGENT_CHAT_MAX_IMAGES - currentImages.length;
    if (remainingSlots <= 0) {
      setImageError(t('agentChatTooManyImages', String(AGENT_CHAT_MAX_IMAGES)));
      return;
    }

    let validationError: string | null = null;
    const currentBytes = currentImages.reduce((total, image) => total + image.size, 0);
    let nextBytes = currentBytes;
    const acceptedFiles: File[] = [];
    for (const file of files) {
      if (acceptedFiles.length >= remainingSlots) {
        validationError = t('agentChatTooManyImages', String(AGENT_CHAT_MAX_IMAGES));
        break;
      }
      if (!SUPPORTED_PASTED_IMAGE_TYPES.has(file.type)) {
        validationError = t('agentChatUnsupportedImage');
        continue;
      }
      if (file.size > AGENT_CHAT_MAX_IMAGE_BYTES) {
        validationError = t(
          'agentChatImageTooLarge',
          String(AGENT_CHAT_MAX_IMAGE_BYTES / 1024 / 1024),
        );
        continue;
      }
      if (nextBytes + file.size > AGENT_CHAT_MAX_TOTAL_IMAGE_BYTES) {
        validationError = t(
          'agentChatImagesTooLarge',
          String(AGENT_CHAT_MAX_TOTAL_IMAGE_BYTES / 1024 / 1024),
        );
        continue;
      }
      acceptedFiles.push(file);
      nextBytes += file.size;
    }
    setImageError(validationError);
    if (acceptedFiles.length === 0) return;
    const generation = imageSelectionGenerationRef.current;

    void Promise.all(
      acceptedFiles.map(
        async (file, index): Promise<PastedImage> => ({
          id: `pasted-image-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
          data: await readImageData(file),
          mimeType: file.type,
          ...(file.name ? { name: file.name } : {}),
          size: file.size,
        }),
      ),
    )
      .then(images => {
        if (imageSelectionGenerationRef.current !== generation) return;
        const current = pastedImagesRef.current;
        const next = [...current];
        let totalBytes = current.reduce((total, image) => total + image.size, 0);
        let limitError = validationError;
        for (const image of images) {
          if (next.length >= AGENT_CHAT_MAX_IMAGES) {
            limitError = t('agentChatTooManyImages', String(AGENT_CHAT_MAX_IMAGES));
            continue;
          }
          if (totalBytes + image.size > AGENT_CHAT_MAX_TOTAL_IMAGE_BYTES) {
            limitError = t(
              'agentChatImagesTooLarge',
              String(AGENT_CHAT_MAX_TOTAL_IMAGE_BYTES / 1024 / 1024),
            );
            continue;
          }
          next.push(image);
          totalBytes += image.size;
        }
        pastedImagesRef.current = next;
        setPastedImages(next);
        setImageError(limitError);
      })
      .catch(() => {
        if (imageSelectionGenerationRef.current === generation) {
          setImageError(t('agentChatImageReadFailed'));
        }
      });
  };

  const handleNewChat = async () => {
    if (!session && selectedProvider?.acceptsNewSessions === false) return;
    if (isPickingElement) cancelElementPicker();
    clearElementCommentMarkers(activeTabId);
    pickerModeRef.current = null;
    imageSelectionGenerationRef.current += 1;
    pastedImagesRef.current = [];
    if (activeTabId !== null) {
      composerDraftsRef.current.delete(activeTabId);
      if (composerPersistTimerRef.current !== null) {
        window.clearTimeout(composerPersistTimerRef.current);
        composerPersistTimerRef.current = null;
      }
      persistComposerDraft(activeTabId, emptyComposerDraft());
    }
    updateInput('');
    setSelectedElement(null);
    setElementComments([]);
    updateCommentSelectionMode(null);
    setPastedImages([]);
    setImageError(null);
    resetMessageHistoryNavigation();
    await newChat();
  };

  const stopCommentSelection = () => {
    pickerModeRef.current = null;
    updateCommentSelectionMode(null);
    if (isPickingElement) cancelElementPicker();
  };

  const handleToggleElementPicker = () => {
    if (commentMode) {
      stopCommentSelection();
      pickerModeRef.current = 'element';
      startElementPicker();
      return;
    }
    pickerModeRef.current = isPickingElement ? null : 'element';
    toggleElementPicker();
  };

  const handleCommentModeClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.detail > 1) return;
    if (commentMode) {
      stopCommentSelection();
      return;
    }
    if (isPickingElement) cancelElementPicker();
    pickerModeRef.current = 'comment';
    updateCommentSelectionMode('single');
    startElementPicker(elementCommentPickerOptions(false));
  };

  const handleCommentModeDoubleClick = () => {
    if (isPickingElement) cancelElementPicker();
    pickerModeRef.current = 'comment';
    updateCommentSelectionMode('continuous');
    startElementPicker(elementCommentPickerOptions(true));
  };

  const handleSubmit = async () => {
    const text = input.trim();
    if (!canSend) return;
    if (isPickingElement) cancelElementPicker();
    if (activeTabId !== null) {
      composerDraftsRef.current.delete(activeTabId);
      if (composerPersistTimerRef.current !== null) {
        window.clearTimeout(composerPersistTimerRef.current);
        composerPersistTimerRef.current = null;
      }
      persistComposerDraft(activeTabId, emptyComposerDraft());
    }
    updateInput('');
    resetMessageHistoryNavigation();
    if (replyRequest) {
      await respond(replyRequest, textReplyResult(replyRequest, text));
      return;
    }
    const images = pastedImages.map(({ id: _id, size: _size, ...image }) => image);
    const elementMessage = selectedElement
      ? appendSelectedElementContext(text, selectedElement)
      : text;
    const outgoingMessage = appendPageElementCommentsContext(
      elementMessage,
      elementComments,
      selectedProvider?.name,
    );
    const displayMessage = pageElementCommentsDisplayMessage(text, elementComments);
    setSelectedElement(null);
    clearElementCommentMarkers(activeTabId);
    setElementComments([]);
    updateCommentSelectionMode(null);
    pickerModeRef.current = null;
    imageSelectionGenerationRef.current += 1;
    pastedImagesRef.current = [];
    setPastedImages([]);
    setImageError(null);
    await send(outgoingMessage, {
      ...(providerId === 'codex' ? { ephemeral: false } : {}),
      ...(selectedElement || elementComments.length > 0 || images.length > 0
        ? { displayMessage }
        : {}),
      ...(images.length > 0 ? { images } : {}),
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;

    if (
      !replyRequest &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.key === 'ArrowUp' &&
      sentMessageHistory.length > 0
    ) {
      const textarea = event.currentTarget;
      const selectionCollapsed = textarea.selectionStart === textarea.selectionEnd;
      const caretOnFirstLine = !textarea.value.slice(0, textarea.selectionStart).includes('\n');
      if (messageHistoryIndex !== null || (selectionCollapsed && caretOnFirstLine)) {
        event.preventDefault();
        if (messageHistoryIndex === null) messageHistoryDraftRef.current = input;
        const nextIndex =
          messageHistoryIndex === null
            ? sentMessageHistory.length - 1
            : Math.max(0, messageHistoryIndex - 1);
        setMessageHistoryIndex(nextIndex);
        updateInput(sentMessageHistory[nextIndex]!);
      }
      return;
    }

    if (
      !replyRequest &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.key === 'ArrowDown' &&
      messageHistoryIndex !== null
    ) {
      event.preventDefault();
      const nextIndex = messageHistoryIndex + 1;
      if (nextIndex < sentMessageHistory.length) {
        setMessageHistoryIndex(nextIndex);
        updateInput(sentMessageHistory[nextIndex]!);
      } else {
        setMessageHistoryIndex(null);
        updateInput(messageHistoryDraftRef.current);
      }
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  if (!i18nReady || !composerDraftsReady) {
    return <div className={`${embedded ? 'h-full w-full' : 'h-screen w-screen'} bg-bg-primary`} />;
  }

  return (
    <div
      className={`flex flex-col bg-bg-primary text-text-primary ${embedded ? 'h-full w-full' : 'h-screen w-screen'}`}
    >
      {!initializing || headerAction ? (
        <header
          className={`@container relative flex items-center justify-between gap-2 border-b border-border/50 bg-bg-secondary pr-[9px] pl-[10px] ${compact ? 'min-h-12 py-1' : embedded ? 'min-h-14 py-[7px]' : 'min-h-[54px] py-[7px]'}`}
        >
          <span className="sr-only">{t('agentChatTitle')}</span>
          <div className={`flex min-w-0 flex-1 items-center gap-2 ${initializing ? 'invisible' : ''}`}>
            {embedded && onClose ? (
              <button
                type="button"
                onClick={onClose}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
                title={t('agentChatCloseToolPanel')}
                aria-label={t('agentChatCloseToolPanel')}
              >
                <X className="h-4 w-4 stroke-[1.6]" aria-hidden="true" />
              </button>
            ) : null}
            <div className="flex min-w-0 w-full max-w-44 flex-1 items-center gap-2">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border bg-transparent text-text-secondary">
                <Bot className="h-4 w-4 stroke-[1.7]" aria-hidden="true" />
              </span>
              <SearchableSelect
                className="min-w-0 flex-1"
                options={providers.map(provider => ({
                  value: provider.id,
                  label: provider.name,
                  description: provider.available
                    ? t('agentChatReady')
                    : t('agentChatNotInstalled'),
                }))}
                value={providerId}
                onChange={nextProviderId => {
                  setInstalledProviderId(undefined);
                  setProviderId(nextProviderId);
                }}
                searchable={false}
                disabled={
                  Boolean(nativeHostUpdate) ||
                  active ||
                  resumingSession ||
                  refreshingSession ||
                  switchingProvider
                }
                align="left"
                panelClassName="w-44"
                ariaLabel={t('agentChatProvider')}
                triggerTitle={
                  !selectedProvider?.available && selectedProvider?.error
                    ? selectedProvider.error
                    : t('agentChatProvider')
                }
                triggerClassName="flex h-10 w-full min-w-0 items-center rounded-lg border-0 bg-transparent px-2.5 text-text-primary transition-colors hover:bg-bg-hover disabled:hover:bg-transparent"
                triggerContent={
                  <span className="grid min-w-0 flex-1 gap-px text-left">
                    <span className="flex min-w-0 items-center gap-0.5">
                      <span className="truncate text-xs font-semibold tracking-[-0.01em]">
                        {selectedProvider?.name || t('agentChatTitle')}
                      </span>
                      {!nativeHostUpdate ? (
                        <ChevronDown className="h-3 w-3 shrink-0 text-text-secondary" />
                      ) : null}
                    </span>
                    <span
                      className="flex min-w-0 items-center gap-1.5 text-3xs leading-3 text-text-secondary"
                      title={!selectedProvider?.available ? selectedProvider?.error : undefined}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ring-2 ${qoderNeedsSignIn ? 'bg-amber-500 ring-amber-500/20' : statusDotClass}`}
                      />
                      {currentModel && currentModelLabel ? (
                        <>
                          <span
                            className="max-w-24 shrink truncate"
                            title={t('agentChatCurrentModel', currentModel.id)}
                          >
                            {currentModelLabel}
                          </span>
                          <span className="shrink-0" aria-hidden="true">
                            ·
                          </span>
                        </>
                      ) : null}
                      <span className="min-w-0 truncate">
                        {qoderNeedsSignIn ? t('agentChatQoderSignInRequired') : providerStatusLabel}
                      </span>
                    </span>
                  </span>
                }
              />
            </div>
          </div>
          {!initializing && !nativeHostUpdate ? (
            <div className="flex shrink-0 items-center gap-[3px]">
              <button
                onClick={handleNewChat}
                disabled={resumingSession || refreshingSession || (!session && selectedProvider?.acceptsNewSessions === false)}
                className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                title={t('agentChatNew')}
                aria-label={t('agentChatNew')}
              >
                <SquarePen className="h-[15px] w-[15px] stroke-[1.4]" />
              </button>
              {selectedProvider?.capabilities.listSessions ? (
                <ConversationPicker
                  provider={selectedProvider}
                  currentSessionId={session?.providerSessionId}
                  disabled={active || resumingSession || refreshingSession || selectedProvider?.acceptsNewSessions === false}
                  listSessions={listSessions}
                  resumeSession={resumeSession}
                />
              ) : null}
              <button
                type="button"
                onClick={() => setSkillsManagerOpen(true)}
                className="hidden h-[30px] w-[30px] shrink-0 place-items-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer @[360px]:grid"
                title={t('agentSkillsManage')}
                aria-label={t('agentSkillsManage')}
              >
                <Blocks className="h-[15px] w-[15px] stroke-[1.4]" />
              </button>
              {canOpenCodexApp ? (
                <button
                  type="button"
                  onClick={openInApp}
                  className="hidden h-[30px] w-[30px] shrink-0 place-items-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer @[360px]:grid"
                  title={openCodexAppTitle}
                  aria-label={openCodexAppTitle}
                >
                  <ExternalLink className="h-[15px] w-[15px] stroke-[1.4]" />
                </button>
              ) : null}
              <div ref={moreActionsRef} className="relative @[360px]:hidden">
                <button
                  type="button"
                  onClick={() => setMoreActionsOpen(open => !open)}
                  className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
                  title={t('agentChatMoreActions')}
                  aria-label={t('agentChatMoreActions')}
                  aria-controls="agent-chat-more-actions"
                  aria-expanded={moreActionsOpen}
                  aria-haspopup="menu"
                >
                  <Ellipsis className="h-[15px] w-[15px] stroke-[1.4]" />
                </button>
                {moreActionsOpen ? (
                  <div
                    id="agent-chat-more-actions"
                    role="menu"
                    className="absolute right-0 top-10 z-50 mt-1 w-48 overflow-hidden rounded-lg border border-border bg-bg-primary p-1 shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setSkillsManagerOpen(true);
                        setMoreActionsOpen(false);
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-text-primary transition-colors hover:bg-bg-hover cursor-pointer"
                    >
                      <Blocks className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                      <span className="truncate">{t('agentSkillsManage')}</span>
                    </button>
                    {canOpenCodexApp ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          openInApp();
                          setMoreActionsOpen(false);
                        }}
                        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-text-primary transition-colors hover:bg-bg-hover cursor-pointer"
                        title={openCodexAppTitle}
                        aria-label={openCodexAppTitle}
                      >
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                        <span className="truncate">{openCodexAppTitle}</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          {headerAction?.(flushComposerDraft)}
        </header>
      ) : null}

      <div className="@container relative min-h-0 flex-1">
        <main
          ref={setChatScrollContainerRef}
          className={`h-full overflow-auto p-2 ${canExportConversation ? 'pb-2' : 'pb-11'}`}
        >
          {initializing ? (
            <div
              role="status"
              aria-label={t('agentChatConnecting')}
              className="h-full flex items-center justify-center"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-secondary opacity-60 animate-pulse">
                <Bot className="w-6 h-6 text-text-secondary" aria-hidden="true" />
              </div>
            </div>
          ) : nativeHostUpdate ? (
            <NativeHostUpdateGuide
              context="sidepanel"
              update={nativeHostUpdate}
              retry={retryNativeHost}
            />
          ) : selectedProvider?.setup && (!selectedProvider.available || showingInstalledSetup) ? (
            <ProviderSetupGuide
              key={selectedProvider.id}
              provider={selectedProvider}
              installed={Boolean(showingInstalledSetup)}
              onContinue={() => setInstalledProviderId(undefined)}
              onInstall={async () => {
                await installProvider(selectedProvider.id);
                setInstalledProviderId(selectedProvider.id);
              }}
            />
          ) : chatMessages.length === 0 &&
            actionableRequests.length === 0 &&
            selectedProvider?.available ? (
            <div
              className={`h-full flex flex-col items-center justify-center text-center text-text-secondary ${compact ? 'gap-2 px-3' : 'gap-3 px-4'}`}
            >
              <div
                className={`flex items-center justify-center bg-blue-500/10 text-blue-600 dark:text-blue-400 ${compact ? 'h-10 w-10 rounded-lg' : 'h-12 w-12 rounded-xl'}`}
              >
                <Bot className={compact ? 'h-5 w-5' : 'h-6 w-6'} />
              </div>
              <div className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-text-primary`}>
                {t('agentChatEmptyTitle', selectedProvider.name)}
              </div>
              <div
                className={`grid w-full max-w-sm grid-cols-1 gap-1.5 @[520px]:max-w-xl @[520px]:grid-cols-2 ${compact ? 'mt-1' : 'mt-2'}`}
              >
                {emptyStateGuides.map(guide => {
                  const Icon = guide.icon;
                  return (
                    <button
                      key={guide.key}
                      type="button"
                      onClick={() => handleGuidePrompt(guide.prompt)}
                      aria-label={guide.title}
                      className={`group/guide flex items-center rounded-lg border border-border/40 bg-bg-secondary/40 text-left transition-colors hover:border-blue-500/20 hover:bg-blue-500/[0.04] cursor-pointer ${compact ? 'min-h-10 gap-2 px-2 py-1.5' : 'min-h-12 gap-2.5 px-2.5 py-2'}`}
                    >
                      <span
                        className={`flex shrink-0 items-center justify-center rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 ${compact ? 'h-6 w-6' : 'h-7 w-7'}`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium leading-4 text-text-primary">
                          {guide.title}
                        </span>
                        <span className="mt-0.5 block truncate text-3xs leading-4 text-text-secondary">
                          {guide.description}
                        </span>
                      </span>
                      <ChevronRight className="h-3 w-3 shrink-0 text-text-secondary opacity-30 transition-opacity group-hover/guide:opacity-80" />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div ref={setChatContent} className="space-y-2 py-1">
              {visibleChatMessages.map((message, index) => (
                <ConversationMessage
                  key={`conversation-message-${index}`}
                  message={
                    providerId === 'qoder' && message.role === 'system' && isQoderAuthenticationError(message.message)
                      ? { ...message, message: t('agentChatQoderSignInRequired') }
                      : message
                  }
                  providerName={selectedProvider?.name || providerId}
                />
              ))}
              {actionableRequests.map(request =>
                isApprovalRequest(request.method) ? (
                  <ConversationApprovalCard
                    key={request.id}
                    request={request}
                    onDecision={accepted =>
                      void respond(request, approvalResult(request, accepted))
                    }
                  />
                ) : (
                  <RequestCard
                    key={request.id}
                    request={request}
                    respond={respond}
                    setReplyRequest={setReplyRequest}
                  />
                ),
              )}
            </div>
          )}
          {canExportConversation ? (
            <div className="mt-3 flex items-center justify-center gap-1.5 pb-1">
              <span className="h-px min-w-4 flex-1 bg-border/60" />
              <button
                type="button"
                onClick={() => void handleCopyConversation()}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg-secondary px-2.5 text-3xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
                title={t('agentChatCopyConversationDescription')}
                aria-label={t('agentChatCopyConversation')}
              >
                <ClipboardCopy className="h-3.5 w-3.5" />
                {t('agentChatCopyConversation')}
              </button>
              <button
                type="button"
                onClick={() => void handleCopyDebugTrace()}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg-secondary px-2.5 text-3xs text-text-secondary transition-colors hover:border-blue-500/30 hover:bg-blue-500/5 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer"
                title={t('agentChatCopyDebugTraceDescription')}
                aria-label={t('agentChatCopyDebugTrace')}
              >
                <Bug className="h-3.5 w-3.5" />
                {t('agentChatCopyDebugTrace')}
              </button>
              {canRefreshConversation ? (
                <button
                  type="button"
                  onClick={() => void refreshSession()}
                  disabled={active || resumingSession || refreshingSession}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-bg-secondary text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                  title={
                    refreshingSession
                      ? t('agentChatRefreshingConversation')
                      : t('agentChatRefreshConversation')
                  }
                  aria-label={
                    refreshingSession
                      ? t('agentChatRefreshingConversation')
                      : t('agentChatRefreshConversation')
                  }
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshingSession ? 'animate-spin' : ''}`} />
                </button>
              ) : null}
              <span className="h-px min-w-4 flex-1 bg-border/60" />
            </div>
          ) : null}
        </main>
        {!nativeHostUpdate && canRefreshConversation && !canExportConversation ? (
          <button
            type="button"
            onClick={() => void refreshSession()}
            disabled={active || resumingSession || refreshingSession}
            className="absolute bottom-2 right-2 z-20 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-bg-primary/95 text-text-secondary shadow-sm backdrop-blur transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            title={
              refreshingSession
                ? t('agentChatRefreshingConversation')
                : t('agentChatRefreshConversation')
            }
            aria-label={
              refreshingSession
                ? t('agentChatRefreshingConversation')
                : t('agentChatRefreshConversation')
            }
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshingSession ? 'animate-spin' : ''}`} />
          </button>
        ) : null}
      </div>

      {manualPendingRequests.length > 0 && !replyRequest ? (
        <div className="px-3 py-1 text-3xs text-amber-700 dark:text-amber-400 border-t border-border bg-amber-50 dark:bg-amber-950/40">
          {t('agentChatRequestPending', String(manualPendingRequests.length))}
        </div>
      ) : null}
      {qoderNeedsSignIn ? (
        <div className="border-t border-border bg-warning-bg px-3 py-2 text-warning-text">
          <QoderLoginActions
            key={session?.id ?? providerId}
            command={selectedProvider?.setup?.loginCommand}
            hint={t('agentChatQoderSignInHint')}
            onResend={resendText ? () => void send(resendText) : undefined}
            resendDisabled={!canSendToProvider || active || Boolean(replyRequest)}
          />
        </div>
      ) : error ? (
        <div className="px-3 py-1.5 text-xs text-red-600 dark:text-red-400 border-t border-border bg-red-50 dark:bg-red-950">
          {error}
        </div>
      ) : null}

      {!initializing && !nativeHostUpdate ? (
        <footer
          className={`${compact ? 'p-1.5' : 'p-2'} border-t border-border/50 bg-bg-secondary`}
        >
          {replyRequest ? (
            <div className="flex items-center justify-between gap-2 pb-1.5 text-3xs text-blue-600 dark:text-blue-400">
              <span className="truncate">{t('agentChatReplyingTo', replyRequest.method)}</span>
              <button
                onClick={() => setReplyRequest(null)}
                className="text-text-secondary hover:text-text-primary cursor-pointer"
              >
                {t('cancel')}
              </button>
            </div>
          ) : null}
          {pastedImages.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pb-1.5">
              {pastedImages.map(image => (
                <div
                  key={image.id}
                  className="group/image relative h-12 w-12 overflow-hidden rounded-md border border-border bg-bg-primary"
                  title={image.name}
                >
                  <img
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={t('agentChatPastedImage', image.name || '')}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const next = pastedImagesRef.current.filter(item => item.id !== image.id);
                      pastedImagesRef.current = next;
                      setPastedImages(next);
                      setImageError(null);
                    }}
                    className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/65 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover/image:opacity-100 focus:opacity-100 cursor-pointer"
                    title={t('agentChatRemoveImage', image.name || '')}
                    aria-label={t('agentChatRemoveImage', image.name || '')}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {imageError ? (
            <div className="pb-1.5 text-3xs text-red-600 dark:text-red-400">{imageError}</div>
          ) : null}
          {!replyRequest ? (
            <ElementCommentPills
              comments={elementComments}
              onEdit={editElementComment}
              onRemove={removeElementComment}
            />
          ) : null}
          {selectedElement && !replyRequest ? (
            <div className="mb-1.5 flex items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/5 px-2 py-1.5 text-3xs">
              <MousePointer2 className="h-3.5 w-3.5 shrink-0 text-blue-500" />
              <div className="min-w-0 flex-1">
                <div
                  className="truncate font-mono text-text-primary"
                  title={selectedElementLabel(selectedElement)}
                >
                  {selectedElementLabel(selectedElement)}
                </div>
                <div className="truncate text-text-secondary">
                  {selectedElement.text || selectedElement.page.title || selectedElement.page.url}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedElement(null)}
                className="rounded p-0.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
                title={t('agentChatRemoveSelectedElement')}
                aria-label={t('agentChatRemoveSelectedElement')}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
          <div className="flex items-start gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={event => {
                const nextInput = event.target.value;
                updateInput(nextInput);
                resetMessageHistoryNavigation();
              }}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={
                !selectedProvider?.available ||
                showingInstalledSetup ||
                initializing ||
                resumingSession ||
                refreshingSession ||
                (session?.status === 'error' && !qoderNeedsSignIn)
              }
              placeholder={
                replyRequest ? t('agentChatReplyPlaceholder') : t('agentChatInputPlaceholder')
              }
              className={`min-w-0 flex-1 resize-none overflow-y-hidden px-2.5 text-xs leading-5 rounded-md border border-border bg-bg-primary text-text-primary placeholder:text-text-secondary/70 focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-60 ${compact ? 'py-1.5' : 'py-2'}`}
            />
            <button
              onClick={() => {
                if (canInterrupt) {
                  interrupt();
                  return;
                }
                void handleSubmit();
              }}
              disabled={!canInterrupt && !canSend}
              className={`h-6.5 mt-0.5 px-3 inline-flex shrink-0 items-center justify-center rounded text-xs font-medium text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
                canInterrupt ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-600 hover:bg-blue-700'
              }`}
              title={canInterrupt ? t('agentChatStop') : t('agentChatSend')}
              aria-label={canInterrupt ? t('agentChatStop') : t('agentChatSend')}
            >
              {canInterrupt ? t('agentChatStop') : t('agentChatSend')}
            </button>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1 text-3xs text-text-secondary">
            <span className="min-w-0 truncate">{t('agentChatInputHint')}</span>
            <div className="flex shrink-0 items-center gap-1">
              {pageElementActions ? (
                <>
                  <button
                    type="button"
                    onClick={handleToggleElementPicker}
                    disabled={activeTabId === null || Boolean(replyRequest)}
                    className={`rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      elementSelectionActive
                        ? 'bg-blue-500/15 text-blue-600 hover:bg-blue-500/25 dark:text-blue-400'
                        : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                    } ${activeTabId !== null && !replyRequest ? 'cursor-pointer' : ''}`}
                    title={
                      elementSelectionActive
                        ? t('agentChatCancelElementPicker')
                        : t('agentChatSelectElement')
                    }
                    aria-label={
                      elementSelectionActive
                        ? t('agentChatCancelElementPicker')
                        : t('agentChatSelectElement')
                    }
                  >
                    <Crosshair className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={handleCommentModeClick}
                    onDoubleClick={handleCommentModeDoubleClick}
                    disabled={activeTabId === null || Boolean(replyRequest)}
                    aria-pressed={commentMode}
                    className={`rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      commentMode
                        ? 'bg-blue-500/15 text-blue-600 hover:bg-blue-500/25 dark:text-blue-400'
                        : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                    } ${activeTabId !== null && !replyRequest ? 'cursor-pointer' : ''}`}
                    title={
                      commentMode
                        ? t('agentChatDisableElementComments')
                        : t('agentChatElementCommentModeHint')
                    }
                    aria-label={
                      commentMode
                        ? t('agentChatDisableElementComments')
                        : t('agentChatEnableElementComments')
                    }
                  >
                    <MessageSquareText className="w-3.5 h-3.5" />
                  </button>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => handleAutoApproveChange(!autoApprove)}
                className={`p-1 rounded shrink-0 transition-colors cursor-pointer ${
                  autoApprove
                    ? 'bg-amber-500/20 text-amber-600 hover:bg-amber-500/30 dark:text-amber-400'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                }`}
                title={
                  autoApprove ? t('agentChatDisableAutoApprove') : t('agentChatEnableAutoApprove')
                }
                aria-label={
                  autoApprove ? t('agentChatDisableAutoApprove') : t('agentChatEnableAutoApprove')
                }
              >
                <ShieldAlert className="w-3.5 h-3.5" />
              </button>
              <div className="flex min-w-0 items-center rounded border border-border bg-bg-primary">
                <button
                  type="button"
                  onClick={() => void selectWorkspace()}
                  disabled={hasConversationBinding || selectingWorkspace}
                  className="flex h-6 min-w-0 max-w-36 items-center gap-1 px-1.5 text-3xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:hover:bg-transparent cursor-pointer"
                  title={
                    workspaceDirectory
                      ? hasConversationBinding
                        ? t('agentChatContextDirectoryBound', workspaceDirectory)
                        : t('agentChatContextDirectorySelected', workspaceDirectory)
                      : t('agentChatNoContextDirectory')
                  }
                  aria-label={
                    workspaceDirectory
                      ? t('agentChatContextDirectorySelected', workspaceDirectory)
                      : t('agentChatSelectContextDirectory')
                  }
                >
                  {selectingWorkspace ? (
                    <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
                  ) : workspaceDirectory ? (
                    <FolderOpen className="w-3.5 h-3.5 shrink-0 text-blue-500" />
                  ) : (
                    <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span className="truncate">
                    {workspaceDirectory
                      ? workspaceName(workspaceDirectory)
                      : t('agentChatNoContextDirectoryLabel')}
                  </span>
                </button>
                {workspaceDirectory && !hasConversationBinding ? (
                  <button
                    type="button"
                    onClick={clearWorkspace}
                    className="flex h-6 items-center border-l border-border px-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
                    title={t('agentChatClearContextDirectory')}
                    aria-label={t('agentChatClearContextDirectory')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </footer>
      ) : null}
      <SkillsManagerModal
        isOpen={skillsManagerOpen}
        onClose={() => setSkillsManagerOpen(false)}
        providerId={providerId}
        providerLabel={selectedProvider?.name}
        cwd={workspaceDirectory || undefined}
      />
      {!embedded ? <ToastContainer /> : null}
    </div>
  );
}
