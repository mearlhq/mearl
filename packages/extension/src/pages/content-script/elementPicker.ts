import type { ElementInfo } from './injected/collectElement';
import { showElementCommentOverlay, type ElementCommentOverlay } from './elementCommentOverlay';
import {
  isElementCommentMarker,
  showElementCommentMarker,
  type ElementCommentMarker,
} from './elementCommentMarker';
import {
  ELEMENT_COMMENT_STYLE_PROPERTIES,
  type ElementCommentChangeProperty,
  type ElementCommentLabels,
  type ElementCommentStyleChanges,
  type ElementCommentStyleProperty,
  type ElementPickerOptions,
  type ElementPickerPage,
  type ElementPickerSelection,
} from './elementCommentTypes';
import { canEditElementText, readElementText, writeElementText } from './elementCommentText';

export type {
  ElementCommentLabels,
  ElementCommentStyleChanges,
  ElementPickerOptions,
  ElementPickerSelection,
} from './elementCommentTypes';

export type ElementPicker = {
  startElementPicker: (options?: ElementPickerOptions) => void;
  pauseElementPicker: () => void;
  resumeElementPicker: () => void;
  setPickerFrameActive: (active: boolean) => void;
  stopElementPicker: (cancelled?: boolean) => void;
  editElementComment: (commentId: string) => void;
  removeElementComment: (commentId: string) => void;
  clearElementComments: () => void;
};

interface ElementPickerCoordinator {
  onFrameActive?: () => void;
}

interface InlineStyleValue {
  value: string;
  priority: string;
}

interface ConfirmedElementComment {
  id: string;
  target: Element;
  selection: ElementPickerSelection;
  labels: ElementCommentLabels;
  comment: string;
  styleChanges: ElementCommentStyleChanges;
  originalInlineStyles: Map<ElementCommentStyleProperty, InlineStyleValue>;
  originalText: string;
  managedStyleProperties: Set<ElementCommentChangeProperty>;
  marker: ElementCommentMarker | null;
}

const TRACE_ATTR = 'data-mtop-trace-target';
const PICKED_ELEMENT_ATTR = 'data-mtop-element-target';
const ELEMENT_COLLECTION_TIMEOUT_MS = 500;

const FALLBACK_COMMENT_LABELS: ElementCommentLabels = {
  title: 'Element comment',
  placeholder: 'Describe how this element should change…',
  edit: 'Edit element comment',
  move: 'Move comment panel',
  skip: 'Cancel',
  add: 'Add & continue',
  styleChanges: 'Style changes',
  valuePlaceholder: 'For example, 16px',
  styleProperties: {
    textContent: 'Text content',
    color: 'Text color',
    backgroundColor: 'Background',
    opacity: 'Opacity',
    fontFamily: 'Font',
    fontSize: 'Font size',
    fontWeight: 'Font weight',
    lineHeight: 'Line height',
    letterSpacing: 'Letter spacing',
    textAlign: 'Text align',
    margin: 'Margin',
    padding: 'Padding',
    borderRadius: 'Radius',
    borderColor: 'Border color',
    borderWidth: 'Border width',
    width: 'Width',
    height: 'Height',
  },
};

function generateTagId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function cssPropertyName(property: ElementCommentStyleProperty): string {
  return property.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`);
}

function captureInlineStyles(target: Element): Map<ElementCommentStyleProperty, InlineStyleValue> {
  const styledTarget =
    target instanceof HTMLElement || target instanceof SVGElement ? target : null;
  return new Map(
    ELEMENT_COMMENT_STYLE_PROPERTIES.map(property => {
      const name = cssPropertyName(property);
      return [
        property,
        {
          value: styledTarget?.style.getPropertyValue(name) || '',
          priority: styledTarget?.style.getPropertyPriority(name) || '',
        },
      ];
    }),
  );
}

function restoreInlineStyles(
  record: ConfirmedElementComment,
  properties: Iterable<ElementCommentChangeProperty>,
) {
  const styledTarget =
    record.target instanceof HTMLElement || record.target instanceof SVGElement
      ? record.target
      : null;
  if (!styledTarget) return;
  for (const property of properties) {
    if (property === 'textContent') {
      if (canEditElementText(record.target)) writeElementText(record.target, record.originalText);
      continue;
    }
    const name = cssPropertyName(property);
    const original = record.originalInlineStyles.get(property);
    if (original?.value) styledTarget.style.setProperty(name, original.value, original.priority);
    else styledTarget.style.removeProperty(name);
  }
}

// 提取元素的"用户可见文本"——表单类元素读 value/选中项，非表单读 innerText/textContent
function getDisplayText(target: Element): string {
  if (target instanceof HTMLInputElement) {
    if (target.type === 'checkbox' || target.type === 'radio') return target.checked ? '✓' : '';
    if (target.type === 'password') return '';
    return target.value || target.placeholder || '';
  }
  if (target instanceof HTMLTextAreaElement) return target.value || target.placeholder || '';
  if (target instanceof HTMLSelectElement) {
    const opt = target.options[target.selectedIndex];
    return opt?.text || opt?.value || '';
  }
  const html = target as HTMLElement;
  return html.innerText?.trim() || target.textContent?.trim() || '';
}

function collectPickedElement(
  target: Element,
  clientX?: number,
  clientY?: number,
): Promise<ElementInfo | null> {
  const requestId = generateTagId();
  try {
    target.setAttribute(PICKED_ELEMENT_ATTR, requestId);
  } catch {
    return Promise.resolve(null);
  }

  let x = clientX;
  let y = clientY;
  if (x == null || y == null) {
    const rect = target.getBoundingClientRect();
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 2;
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = (element: ElementInfo | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', handleResult);
      if (target.getAttribute(PICKED_ELEMENT_ATTR) === requestId) {
        target.removeAttribute(PICKED_ELEMENT_ATTR);
      }
      resolve(element);
    };
    const handleResult = (event: MessageEvent) => {
      if (
        event.source === window &&
        event.data?.source === 'mearl-injected' &&
        event.data?.type === 'PICKED_ELEMENT_RESULT' &&
        event.data?.requestId === requestId
      ) {
        finish(event.data.element ?? null);
      }
    };
    const timer = setTimeout(() => finish(null), ELEMENT_COLLECTION_TIMEOUT_MS);
    window.addEventListener('message', handleResult);
    window.postMessage(
      {
        source: 'mearl-content',
        type: 'COLLECT_PICKED_ELEMENT',
        requestId,
        x,
        y,
      },
      '*',
    );
  });
}

async function getSelection(
  target: Element,
  text: string,
  clientX?: number,
  clientY?: number,
  topPage?: ElementPickerPage,
): Promise<ElementPickerSelection> {
  const currentDocument = {
    url: window.location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  };
  return {
    text,
    element: await collectPickedElement(target, clientX, clientY),
    page: topPage ?? currentDocument,
    ...(topPage ? { frame: currentDocument } : {}),
  };
}

function sendPickedElement(
  target: Element,
  text: string,
  clientX?: number,
  clientY?: number,
  topPage?: ElementPickerPage,
): void {
  void getSelection(target, text, clientX, clientY, topPage).then(selection =>
    chrome.runtime
      .sendMessage({
        source: 'mearl-content-script',
        type: 'ELEMENT_PICKED',
        ...selection,
      })
      .catch(() => {}),
  );
}

export function createElementPicker(coordinator: ElementPickerCoordinator = {}): ElementPicker {
  let pickAbortController: AbortController | null = null;
  let pickerHighlight: HTMLDivElement | null = null;
  let pickerHint: HTMLDivElement | null = null;
  let pickerFrameActive = false;
  let activeTraceMode = false;
  let activeOptions: ElementPickerOptions = {};
  let commentOverlay: ElementCommentOverlay | null = null;
  let commentGeneration = 0;
  let commentSequence = 0;
  let editingCommentId: string | null = null;
  const confirmedComments = new Map<string, ConfirmedElementComment>();

  function isTouchPrimary() {
    return window.matchMedia('(pointer: coarse)').matches;
  }

  function removePickerNodesById(id: string) {
    document.querySelectorAll(`[id="${id}"]`).forEach(node => node.remove());
  }

  function removePickerSurface() {
    pickAbortController?.abort();
    pickAbortController = null;
    pickerHighlight?.remove();
    pickerHighlight = null;
    pickerHint?.remove();
    pickerHint = null;
    pickerFrameActive = false;
    removePickerNodesById('mearl-pick-style');
    removePickerNodesById('mearl-pick-hint');
    removePickerNodesById('mearl-pick-highlight');
  }

  function notifyPickerCoordinator(type: 'ELEMENT_PICKER_PAUSED' | 'ELEMENT_PICKER_RESUMED') {
    chrome.runtime
      .sendMessage({
        source: 'mearl-content-script',
        type,
      })
      .catch(() => {});
  }

  function nextCommentId(): string {
    commentSequence += 1;
    return `element-comment-${Date.now().toString(36)}-${commentSequence}`;
  }

  function showCommentMarker(record: ConfirmedElementComment) {
    record.marker?.destroy();
    record.marker = showElementCommentMarker({
      id: record.id,
      target: record.target,
      label: record.labels.edit,
      onEdit: () => editElementComment(record.id),
    });
  }

  function removeElementComment(commentId: string) {
    const record = confirmedComments.get(commentId);
    if (!record) return;
    const resumeOptions =
      editingCommentId === commentId &&
      activeOptions.commentMode &&
      activeOptions.continuousCommentMode !== false
        ? activeOptions
        : null;
    if (editingCommentId === commentId) {
      commentGeneration += 1;
      editingCommentId = null;
      commentOverlay?.destroy();
      commentOverlay = null;
    }
    restoreInlineStyles(record, record.managedStyleProperties);
    record.marker?.destroy();
    confirmedComments.delete(commentId);
    if (resumeOptions) {
      startElementPicker(resumeOptions);
      notifyPickerCoordinator('ELEMENT_PICKER_RESUMED');
    }
  }

  function clearElementComments() {
    commentGeneration += 1;
    editingCommentId = null;
    commentOverlay?.destroy();
    commentOverlay = null;
    for (const record of confirmedComments.values()) {
      restoreInlineStyles(record, record.managedStyleProperties);
      record.marker?.destroy();
    }
    confirmedComments.clear();
  }

  function stopElementPicker(cancelled = false) {
    removePickerSurface();
    commentGeneration += 1;
    commentOverlay?.destroy();
    commentOverlay = null;
    if (editingCommentId) {
      const record = confirmedComments.get(editingCommentId);
      if (record) showCommentMarker(record);
      editingCommentId = null;
    }
    const wasTrace = activeTraceMode;
    activeTraceMode = false;
    activeOptions = {};
    if (wasTrace) {
      window.postMessage({ source: 'mearl-content', type: 'HIDE_COMPONENT_OVERLAY' }, '*');
    }
    if (cancelled) {
      chrome.runtime
        .sendMessage({
          source: 'mearl-content-script',
          type: 'ELEMENT_PICK_CANCELLED',
        })
        .catch(() => {});
    }
  }

  function openElementComment(
    record: ConfirmedElementComment,
    resumeOptions: ElementPickerOptions | null,
    isNewComment: boolean,
  ) {
    const generation = commentGeneration;
    const singleUseComment =
      activeOptions.commentMode && activeOptions.continuousCommentMode === false;
    editingCommentId = isNewComment ? null : record.id;

    const resume = () => {
      if (generation !== commentGeneration) return;
      commentOverlay = null;
      editingCommentId = null;
      if (confirmedComments.has(record.id) && !record.marker) showCommentMarker(record);
      if (resumeOptions?.commentMode && activeOptions.commentMode) {
        startElementPicker(resumeOptions);
        notifyPickerCoordinator('ELEMENT_PICKER_RESUMED');
      } else if (activeOptions.commentMode) {
        activeOptions = {};
      }
    };

    commentOverlay = showElementCommentOverlay({
      target: record.target,
      selection: record.selection,
      labels: record.labels,
      initialComment: record.comment,
      initialStyleChanges: record.styleChanges,
      onCancel: () => {
        if (isNewComment || singleUseComment) stopElementPicker(true);
        else resume();
      },
      onSkip: () => {
        if (singleUseComment) stopElementPicker(true);
        else resume();
      },
      onConfirm: (comment, styleChanges) => {
        const previousProperties = Object.keys(
          record.styleChanges,
        ) as ElementCommentChangeProperty[];
        const nextProperties = new Set(Object.keys(styleChanges) as ElementCommentChangeProperty[]);
        restoreInlineStyles(
          record,
          previousProperties.filter(property => !nextProperties.has(property)),
        );
        record.managedStyleProperties = nextProperties;
        record.comment = comment;
        record.styleChanges = styleChanges;
        confirmedComments.set(record.id, record);
        showCommentMarker(record);
        chrome.runtime
          .sendMessage({
            source: 'mearl-content-script',
            type: 'ELEMENT_COMMENT_CONFIRMED',
            commentId: record.id,
            ...record.selection,
            comment,
            styleChanges,
          })
          .catch(() => {});
        resume();
      },
    });
  }

  function editElementComment(commentId: string) {
    const record = confirmedComments.get(commentId);
    if (!record || (commentOverlay && editingCommentId === commentId)) return;
    const resumeOptions =
      activeOptions.commentMode && activeOptions.continuousCommentMode !== false
        ? activeOptions
        : null;
    if (resumeOptions) notifyPickerCoordinator('ELEMENT_PICKER_PAUSED');
    if (commentOverlay) {
      commentGeneration += 1;
      commentOverlay.destroy();
      commentOverlay = null;
      if (editingCommentId) {
        const previousRecord = confirmedComments.get(editingCommentId);
        if (previousRecord && !previousRecord.marker) showCommentMarker(previousRecord);
      }
      editingCommentId = null;
    }
    removePickerSurface();
    commentGeneration += 1;
    record.marker?.destroy();
    record.marker = null;
    openElementComment(record, resumeOptions, false);
  }

  function pauseElementPicker() {
    removePickerSurface();
  }

  function resumeElementPicker() {
    if (pickAbortController || commentOverlay || !activeOptions.commentMode) return;
    startElementPicker(activeOptions);
  }

  function setPickerFrameActive(active: boolean) {
    const changed = pickerFrameActive !== active;
    pickerFrameActive = active;
    if (pickerHighlight) pickerHighlight.style.visibility = active ? 'visible' : 'hidden';
    if (pickerHint) pickerHint.style.visibility = active ? 'visible' : 'hidden';
    if (changed && activeTraceMode) {
      window.postMessage(
        {
          source: 'mearl-content',
          type: active ? 'SHOW_COMPONENT_OVERLAY' : 'HIDE_COMPONENT_OVERLAY',
        },
        '*',
      );
    }
  }

  function activatePickerFrame() {
    if (pickerFrameActive) return;
    setPickerFrameActive(true);
    coordinator.onFrameActive?.();
  }

  function startElementPicker(options: ElementPickerOptions = {}) {
    // Prevent duplicated startup.
    if (pickAbortController || commentOverlay) stopElementPicker(false);
    removePickerNodesById('mearl-pick-style');
    removePickerNodesById('mearl-pick-hint');
    removePickerNodesById('mearl-pick-highlight');
    activeOptions = options;
    activeTraceMode = !!options.traceMode;

    const ac = new AbortController();
    pickAbortController = ac;

    // Inject crosshair cursor and prevent touch scrolling while picking.
    const style = document.createElement('style');
    style.id = 'mearl-pick-style';
    style.textContent = [
      '* { cursor: crosshair !important; }',
      'html, body { touch-action: none !important; }',
      '#mearl-pick-hint { top: calc(env(safe-area-inset-top, 0px) + 12px) !important; }',
    ].join('\n');
    document.head.appendChild(style);

    // Touch UI hint.
    if (isTouchPrimary()) {
      const hint = document.createElement('div');
      hint.id = 'mearl-pick-hint';
      hint.textContent = chrome.i18n.getMessage('pickTouchHint') || '轻点选择元素 · 拖动预览高亮';
      hint.style.cssText = [
        'position: fixed',
        'top: 12px',
        'left: 50%',
        'transform: translateX(-50%)',
        'z-index: 2147483647',
        'pointer-events: none',
        'visibility: hidden',
        'background: rgba(0,0,0,0.72)',
        'color: #fff',
        'font-size: 13px',
        'font-family: system-ui, sans-serif',
        'line-height: 1.4',
        'padding: 8px 16px',
        'border-radius: 20px',
        'white-space: nowrap',
        'box-shadow: 0 2px 12px rgba(0,0,0,0.3)',
        'opacity: 0',
        'transition: opacity 0.25s ease',
      ].join(';');
      document.documentElement.appendChild(hint);
      pickerHint = hint;
      requestAnimationFrame(() => {
        hint.style.opacity = '1';
      });
    }

    // Fixed overlay to avoid clipping under overflow contexts.
    const highlight = document.createElement('div');
    highlight.id = 'mearl-pick-highlight';
    highlight.style.cssText = [
      'position: fixed',
      'pointer-events: none',
      'z-index: 2147483647',
      'box-sizing: border-box',
      'border: 2px solid #3b82f6',
      'border-radius: 2px',
      'background: rgba(59,130,246,0.08)',
      'transition: top 120ms, left 120ms, width 120ms, height 120ms',
      'display: none',
    ].join(';');
    document.documentElement.appendChild(highlight);
    pickerHighlight = highlight;

    const isOwn = (el: Element) => el === highlight || isElementCommentMarker(el);

    let hoveredElement: Element | null = null;
    let rafPending = false;
    let pendingTarget: Element | null = null;

    const flushHighlight = () => {
      rafPending = false;
      const el = pendingTarget;
      if (!el) return;
      hoveredElement = el;
      const r = el.getBoundingClientRect();
      highlight.style.top = `${r.top}px`;
      highlight.style.left = `${r.left}px`;
      highlight.style.width = `${r.width}px`;
      highlight.style.height = `${r.height}px`;
      highlight.style.display = 'block';
    };

    const updateHighlight = (el: Element) => {
      pendingTarget = el;
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(flushHighlight);
      }
    };

    const selectElement = (target: Element, clientX?: number, clientY?: number) => {
      const text = getDisplayText(target);
      const wasTraceMode = activeTraceMode;
      const selectionOptions = activeOptions;
      removePickerSurface();

      if (wasTraceMode) {
        activeTraceMode = false;
        activeOptions = {};
        window.postMessage({ source: 'mearl-content', type: 'HIDE_COMPONENT_OVERLAY' }, '*');
        // 兜底坐标：tag 属性是同步设的，但 MAIN world 端要等下一个 task 才 querySelector，
        // 这中间 React 若重渲染/重挂了这棵子树，新 DOM 节点上没有该属性 → 查不到。
        // 把点选坐标一起带过去，让 MAIN world 在属性丢失时用 elementFromPoint 重新定位。
        let x = clientX;
        let y = clientY;
        if (x == null || y == null) {
          const r = target.getBoundingClientRect();
          x = r.left + r.width / 2;
          y = r.top + r.height / 2;
        }
        // 给目标节点打标签，让 MAIN world 端 sourceTracer 能定位到它
        const tagId = generateTagId();
        try {
          target.setAttribute(TRACE_ATTR, tagId);
        } catch {
          // 极少数情况下 setAttribute 受限，回退到普通 ELEMENT_PICKED
          sendPickedElement(target, text, clientX, clientY, selectionOptions.topPage);
          return;
        }
        window.postMessage(
          {
            source: 'mearl-content',
            type: 'TRACE_ELEMENT',
            tagId,
            x,
            y,
          },
          '*',
        );
        // MAIN world (sourceTracer) 自身有 try/catch 兜底，异常会回 ok:false 的 TRACE_RESULT
        return;
      }

      if (selectionOptions.commentMode) {
        const existingComment = Array.from(confirmedComments.values()).find(
          record => record.target === target,
        );
        if (existingComment) {
          editElementComment(existingComment.id);
          return;
        }
        notifyPickerCoordinator('ELEMENT_PICKER_PAUSED');
        const generation = ++commentGeneration;
        void getSelection(target, text, clientX, clientY, selectionOptions.topPage).then(
          selection => {
            if (generation !== commentGeneration || !activeOptions.commentMode) return;
            openElementComment(
              {
                id: nextCommentId(),
                target,
                selection,
                labels: selectionOptions.commentLabels || FALLBACK_COMMENT_LABELS,
                comment: '',
                styleChanges: {},
                originalInlineStyles: captureInlineStyles(target),
                originalText: readElementText(target),
                managedStyleProperties: new Set(),
                marker: null,
              },
              selectionOptions.continuousCommentMode === false ? null : selectionOptions,
              true,
            );
          },
        );
        return;
      }

      activeOptions = {};
      sendPickedElement(target, text, clientX, clientY, selectionOptions.topPage);
    };

    document.addEventListener(
      'pointermove',
      (e: PointerEvent) => {
        activatePickerFrame();
        const target = document.elementFromPoint(e.clientX, e.clientY);
        if (target && !isOwn(target)) updateHighlight(target);
      },
      { capture: true, signal: ac.signal },
    );

    document.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        activatePickerFrame();
        const touch = e.touches[0] || e.changedTouches[0];
        if (!touch) return;
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        if (target && !isOwn(target)) updateHighlight(target);
      },
      { capture: true, passive: true, signal: ac.signal } as AddEventListenerOptions,
    );

    document.addEventListener(
      'touchmove',
      (e: TouchEvent) => {
        e.preventDefault();
        activatePickerFrame();
        const touch = e.touches[0];
        if (!touch) return;
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        if (target && !isOwn(target)) updateHighlight(target);
      },
      { capture: true, passive: false, signal: ac.signal } as AddEventListenerOptions,
    );

    document.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        activatePickerFrame();
        if (
          e.composedPath().some(node => node instanceof Element && isElementCommentMarker(node))
        ) {
          return;
        }
        const touchedPoint = e.changedTouches[0];
        const touchedTarget = touchedPoint
          ? document.elementFromPoint(touchedPoint.clientX, touchedPoint.clientY)
          : null;
        if (touchedTarget && isElementCommentMarker(touchedTarget)) return;
        const target = touchedTarget && !isOwn(touchedTarget) ? touchedTarget : hoveredElement;
        if (!target || isOwn(target)) return;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        selectElement(target, touchedPoint?.clientX, touchedPoint?.clientY);
      },
      { capture: true, passive: false, signal: ac.signal } as AddEventListenerOptions,
    );

    document.addEventListener(
      'contextmenu',
      e => {
        e.preventDefault();
        e.stopPropagation();
        if (activeOptions.commentMode) stopElementPicker(true);
      },
      { capture: true, signal: ac.signal },
    );

    document.addEventListener(
      'click',
      (e: MouseEvent) => {
        if (
          e.composedPath().some(node => node instanceof Element && isElementCommentMarker(node))
        ) {
          return;
        }
        const target = document.elementFromPoint(e.clientX, e.clientY);
        if (!target || isOwn(target)) return;
        e.preventDefault();
        e.stopPropagation();
        selectElement(target, e.clientX, e.clientY);
      },
      { capture: true, signal: ac.signal },
    );

    document.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key === 'Escape') stopElementPicker(true);
      },
      { capture: true, signal: ac.signal },
    );
  }

  return {
    startElementPicker,
    pauseElementPicker,
    resumeElementPicker,
    setPickerFrameActive,
    stopElementPicker,
    editElementComment,
    removeElementComment,
    clearElementComments,
  };
}
