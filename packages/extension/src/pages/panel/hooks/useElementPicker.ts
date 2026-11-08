import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type {
  ElementCommentStyleChanges,
  ElementPickerOptions,
  ElementPickerSelection,
} from '../../content-script/elementPicker';
import { sendMessageSafely } from '../utils/safeChrome';
import {
  ELEMENT_PICKER_SESSION_STARTED_EVENT,
  announceElementPickerSession,
  createElementPickerOwnerId,
  getElementPickerSessionOwner,
} from '../utils/elementPickerSession';

export const ElementPickerTabContext = createContext<number | null | undefined>(undefined);

interface UseElementPickerOptions {
  onPicked: (text: string, selection: ElementPickerSelection) => void;
  onCommented?: (
    comment: string,
    styleChanges: ElementCommentStyleChanges,
    selection: ElementPickerSelection,
    commentId?: string,
  ) => void;
  onCancelled?: () => void;
  tabId?: number | null;
}

export function useElementPicker({
  onPicked,
  onCommented,
  onCancelled,
  tabId: explicitTabId,
}: UseElementPickerOptions) {
  const previewTabId = useContext(ElementPickerTabContext);
  const tabId = explicitTabId === undefined ? previewTabId : explicitTabId;
  const [isPicking, setIsPicking] = useState(false);
  const ownerIdRef = useRef(createElementPickerOwnerId());
  const pickingTabIdRef = useRef<number | null>(null);
  const pickerOptionsRef = useRef<ElementPickerOptions>({});

  const resolveTabId = useCallback(() => {
    if (tabId !== undefined) return tabId;
    try {
      return chrome.devtools.inspectedWindow.tabId;
    } catch {
      return null;
    }
  }, [tabId]);

  const cancel = useCallback(() => {
    setIsPicking(false);
    const targetTabId = pickingTabIdRef.current ?? resolveTabId();
    pickingTabIdRef.current = null;
    pickerOptionsRef.current = {};
    onCancelled?.();
    if (targetTabId === null) return;
    void sendMessageSafely({ action: 'cancelElementPicker', tabId: targetTabId }).catch(() => {});
  }, [onCancelled, resolveTabId]);

  const finish = useCallback(
    (selection: ElementPickerSelection) => {
      const text = selection.text.trim();
      if (text || selection.element) onPicked(text, selection);
      pickingTabIdRef.current = null;
      pickerOptionsRef.current = {};
      setIsPicking(false);
    },
    [onPicked],
  );

  const handleCancelled = useCallback(() => {
    pickingTabIdRef.current = null;
    pickerOptionsRef.current = {};
    setIsPicking(false);
    onCancelled?.();
  }, [onCancelled]);

  const handleRuntimeMessage = useCallback(
    (message: any, sender: chrome.runtime.MessageSender) => {
      const pickingTabId = pickingTabIdRef.current;
      if (message?.action === 'contentScriptUnreachable' && message.tabId === pickingTabId) {
        handleCancelled();
        return;
      }
      const isCommentMessage = message?.type === 'ELEMENT_COMMENT_CONFIRMED';
      const expectedTabId = pickingTabId ?? (isCommentMessage ? resolveTabId() : null);
      if (
        expectedTabId === null ||
        sender.tab?.id !== expectedTabId ||
        message?.source !== 'mearl-content-script'
      ) {
        return;
      }
      if (message.type === 'ELEMENT_PICKED') {
        finish({
          text: typeof message.text === 'string' ? message.text : '',
          element: message.element ?? null,
          page: message.page ?? { url: sender.tab?.url ?? '', title: sender.tab?.title ?? '' },
          ...(message.frame ? { frame: message.frame } : {}),
        });
      } else if (message.type === 'ELEMENT_COMMENT_CONFIRMED') {
        const comment = typeof message.comment === 'string' ? message.comment.trim() : '';
        const styleChanges =
          message.styleChanges && typeof message.styleChanges === 'object'
            ? (message.styleChanges as ElementCommentStyleChanges)
            : {};
        if (!comment && Object.keys(styleChanges).length === 0) return;
        onCommented?.(
          comment,
          styleChanges,
          {
            text: typeof message.text === 'string' ? message.text : '',
            element: message.element ?? null,
            page: message.page ?? { url: sender.tab?.url ?? '', title: sender.tab?.title ?? '' },
            ...(message.frame ? { frame: message.frame } : {}),
          },
          typeof message.commentId === 'string' ? message.commentId : undefined,
        );
        if (
          pickerOptionsRef.current.commentMode &&
          pickerOptionsRef.current.continuousCommentMode === false
        ) {
          pickingTabIdRef.current = null;
          pickerOptionsRef.current = {};
          setIsPicking(false);
        }
      } else if (message.type === 'ELEMENT_PICK_CANCELLED') {
        handleCancelled();
      }
    },
    [finish, handleCancelled, onCommented, resolveTabId],
  );

  const start = useCallback(
    (options: ElementPickerOptions = {}) => {
      const targetTabId = resolveTabId();
      if (targetTabId === null) return;
      announceElementPickerSession(ownerIdRef.current);
      pickingTabIdRef.current = targetTabId;
      pickerOptionsRef.current = options;
      setIsPicking(true);
      const resetFailedStart = () => {
        if (pickingTabIdRef.current !== targetTabId) return;
        pickingTabIdRef.current = null;
        pickerOptionsRef.current = {};
        setIsPicking(false);
      };
      void sendMessageSafely<{ success?: boolean }>({
        action: 'startElementPicker',
        tabId: targetTabId,
        ...(options.traceMode ? { traceMode: true } : {}),
        ...(options.commentMode ? { commentMode: true } : {}),
        ...(options.continuousCommentMode !== undefined
          ? { continuousCommentMode: options.continuousCommentMode }
          : {}),
        ...(options.commentLabels ? { commentLabels: options.commentLabels } : {}),
      })
        .then(response => {
          if (response?.success !== true) resetFailedStart();
        })
        .catch(resetFailedStart);
    },
    [resolveTabId],
  );

  const toggle = useCallback(() => {
    if (isPicking) {
      cancel();
    } else {
      start();
    }
  }, [isPicking, cancel, start]);

  useEffect(() => {
    const handleSessionStarted = (event: Event) => {
      if (getElementPickerSessionOwner(event) === ownerIdRef.current) return;
      pickingTabIdRef.current = null;
      pickerOptionsRef.current = {};
      setIsPicking(false);
    };
    window.addEventListener(ELEMENT_PICKER_SESSION_STARTED_EVENT, handleSessionStarted);
    return () =>
      window.removeEventListener(ELEMENT_PICKER_SESSION_STARTED_EVENT, handleSessionStarted);
  }, []);

  useEffect(() => {
    if (!isPicking) return;

    const handlePicked = (e: Event) => {
      const detail = (e as CustomEvent<ElementPickerSelection>).detail;
      if (detail) finish(detail);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };

    window.addEventListener('mearl-element-picked', handlePicked);
    window.addEventListener('mearl-element-pick-cancelled', handleCancelled);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('mearl-element-picked', handlePicked);
      window.removeEventListener('mearl-element-pick-cancelled', handleCancelled);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [cancel, finish, handleCancelled, isPicking]);

  useEffect(() => {
    if (tabId === undefined) return;
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    return () => chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
  }, [handleRuntimeMessage, tabId]);

  useEffect(() => {
    if (
      isPicking &&
      tabId !== undefined &&
      pickingTabIdRef.current !== null &&
      tabId !== pickingTabIdRef.current
    ) {
      cancel();
    }
  }, [cancel, isPicking, tabId]);

  useEffect(
    () => () => {
      const targetTabId = pickingTabIdRef.current;
      pickingTabIdRef.current = null;
      pickerOptionsRef.current = {};
      if (targetTabId === null) return;
      void sendMessageSafely({ action: 'cancelElementPicker', tabId: targetTabId }).catch(() => {});
    },
    [],
  );

  return { isPicking, toggle, cancel, start };
}
