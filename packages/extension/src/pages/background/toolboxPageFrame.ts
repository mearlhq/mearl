import { getDeviceShellForTab } from './deviceShellRules';
import { getAppProfileForTab } from './utils/appProfileRules';

/** Plugin scripts follow the interactive business WebView without attaching a debugger. */
export async function resolveToolboxPageFrame(tabId: number): Promise<number> {
  const [shell, profile] = await Promise.all([
    getDeviceShellForTab(tabId),
    getAppProfileForTab(tabId),
  ]);
  if (!shell && !profile) return 0;
  const [top] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    injectImmediately: true,
    func: () => {
      const frames = [
        ...document.querySelectorAll<HTMLIFrameElement>(
          'iframe[name="__mearl_root__"], iframe[name="__mearl_layer__"]',
        ),
      ];
      const selected = frames
        .filter(
          frame => !frame.hasAttribute('inert') && frame.getAttribute('aria-hidden') !== 'true',
        )
        .at(-1);
      if (!selected) return null;
      for (let index = 0; index < window.frames.length; index += 1) {
        if (window.frames[index] === selected.contentWindow) return index;
      }
      return null;
    },
  });
  if (typeof top?.result !== 'number') {
    if (shell?.config.phoneFrame) throw new Error('Business WebView is not ready; retry after the page finishes loading');
    return 0;
  }
  const candidates = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    injectImmediately: true,
    func: () => {
      if (window === window.top || window.parent !== window.top) return null;
      for (let index = 0; index < window.parent.frames.length; index += 1) {
        if (window.parent.frames[index] === window) return index;
      }
      return null;
    },
  });
  const selected = candidates.find(frame => frame.frameId !== 0 && frame.result === top.result);
  if (!selected)
    throw new Error('Business WebView is not ready; retry after the page finishes loading');
  return selected.frameId;
}
