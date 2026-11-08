import type { ElementPickerPage } from './elementCommentTypes';
import { createElementPicker } from './elementPicker';

const RUNTIME_FLAG = '__mearlElementPickerRuntime';
const FRAME_TOKEN = `picker-frame-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function installElementPickerRuntime(): void {
  const runtimeWindow = window as typeof window & Record<string, unknown>;
  if (runtimeWindow[RUNTIME_FLAG]) return;
  runtimeWindow[RUNTIME_FLAG] = true;

  const elementPicker = createElementPicker({
    onFrameActive: () => {
      chrome.runtime
        .sendMessage({
          source: 'mearl-content-script',
          type: 'ELEMENT_PICKER_FRAME_ACTIVE',
          frameToken: FRAME_TOKEN,
        })
        .catch(() => {});
    },
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'pingElementPickerRuntime') {
      const page: ElementPickerPage = {
        url: window.location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
      };
      sendResponse({ success: true, frameToken: FRAME_TOKEN, page });
    } else if (message.action === 'startElementPicker') {
      elementPicker.startElementPicker({
        traceMode: !!message.traceMode,
        commentMode: !!message.commentMode,
        ...(message.continuousCommentMode !== undefined
          ? { continuousCommentMode: !!message.continuousCommentMode }
          : {}),
        commentLabels: message.commentLabels,
        ...(window.top !== window && message.topPage ? { topPage: message.topPage } : {}),
      });
      sendResponse({ success: true });
    } else if (message.action === 'pauseElementPicker') {
      elementPicker.pauseElementPicker();
      sendResponse({ success: true });
    } else if (message.action === 'resumeElementPicker') {
      elementPicker.resumeElementPicker();
      sendResponse({ success: true });
    } else if (message.action === 'setElementPickerFrameActive') {
      elementPicker.setPickerFrameActive(message.frameToken === FRAME_TOKEN);
      sendResponse({ success: true });
    } else if (message.action === 'stopElementPicker') {
      elementPicker.stopElementPicker(false);
      sendResponse({ success: true });
    } else if (message.action === 'editElementComment') {
      if (typeof message.commentId === 'string') {
        elementPicker.editElementComment(message.commentId);
        sendResponse({ success: true });
      }
    } else if (message.action === 'removeElementCommentMarker') {
      if (typeof message.commentId === 'string') {
        elementPicker.removeElementComment(message.commentId);
        sendResponse({ success: true });
      }
    } else if (message.action === 'clearElementCommentMarkers') {
      elementPicker.clearElementComments();
      sendResponse({ success: true });
    }
  });

  // 源码追溯协议由 picker runtime 在所有 frame 统一承接，避免顶层页面和 iframe
  // 分别维护消息桥，保证两种页面结构具有相同的选择与反向高亮能力。
  window.addEventListener('message', event => {
    if (
      event.source !== window ||
      event.data?.source !== 'mearl-injected' ||
      event.data?.type !== 'TRACE_RESULT'
    ) {
      return;
    }
    chrome.runtime
      .sendMessage({
        ...event.data,
        source: 'mearl-content-script',
      })
      .catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'traceHighlightField') {
      let settled = false;
      const finish = (count: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', responseHandler);
        sendResponse({ count });
      };
      const responseHandler = (event: MessageEvent) => {
        if (
          event.source === window &&
          event.data?.source === 'mearl-injected' &&
          event.data?.type === 'TRACE_HIGHLIGHT_RESULT'
        ) {
          finish(event.data.count ?? 0);
        }
      };
      const timer = window.setTimeout(() => finish(0), 1500);
      window.addEventListener('message', responseHandler);
      window.postMessage(
        {
          source: 'mearl-content',
          type: 'TRACE_HIGHLIGHT',
          value: message.value,
        },
        '*',
      );
      return true;
    }
    if (message.action === 'traceHighlightClear') {
      window.postMessage({ source: 'mearl-content', type: 'TRACE_HIGHLIGHT_CLEAR' }, '*');
    }
  });

  chrome.runtime
    .sendMessage({
      source: 'mearl-content-script',
      type: 'ELEMENT_PICKER_FRAME_READY',
    })
    .catch(() => {});
}
