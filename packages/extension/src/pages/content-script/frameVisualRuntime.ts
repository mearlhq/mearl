import { createHeatmapRenderer, type HeatmapPoint } from './heatmapOverlay';
import { createSpmHighlighter } from './spmHighlight';

const FRAME_VISUAL_RUNTIME_FLAG = '__mearlFrameVisualRuntime';

/**
 * 安装只依赖当前 document 的视觉调试能力。每个 frame 各自维护浮层，background
 * 按 frame 投递消息，因此 App 容器壳与业务 WebView 不需要跨域读取彼此 DOM。
 */
export function installFrameVisualRuntime(): void {
  const runtimeWindow = window as typeof window & Record<string, unknown>;
  if (runtimeWindow[FRAME_VISUAL_RUNTIME_FLAG]) return;
  runtimeWindow[FRAME_VISUAL_RUNTIME_FLAG] = true;

  const spmHighlighter = createSpmHighlighter();
  const heatmapRenderer = createHeatmapRenderer();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'highlightSpm') {
      sendResponse({ found: spmHighlighter.highlightSpmOnPage(message.spm as string) });
      return true;
    }
    if (message.action === 'inspectSpm') {
      sendResponse({ found: spmHighlighter.inspectSpmInPage(message.spm as string) });
      return true;
    }
    if (message.action === 'clearSpmHighlight') {
      spmHighlighter.clearSpmHighlight();
      sendResponse({ success: true });
      return true;
    }
    if (message.action === 'toggleSpmOverlay') {
      spmHighlighter.toggleAllSpmOverlay(Boolean(message.enabled));
      sendResponse({ success: true });
      return true;
    }
    if (message.action === 'renderHeatmap') {
      const payload = message.payload as { measure: string; points: HeatmapPoint[]; format?: 'number' | 'percent' } | undefined;
      if (payload?.measure && Array.isArray(payload.points)) {
        heatmapRenderer.start(payload.measure, payload.points, payload.format);
      }
      sendResponse({ success: true });
      return true;
    }
    if (message.action === 'stopHeatmap') {
      heatmapRenderer.stop();
      sendResponse({ success: true });
      return true;
    }
  });

  const notifyReady = () => {
    chrome.runtime
      .sendMessage({
        source: 'mearl-content-script',
        type: 'FRAME_VISUAL_RUNTIME_READY',
      })
      .catch(() => {});
  };
  if (document.body) notifyReady();
  else document.addEventListener('DOMContentLoaded', notifyReady, { once: true });
}
