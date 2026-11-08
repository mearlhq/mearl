import {
  acquireDebuggerLease,
  resolveDebuggerFrameExecutionContextId,
} from '../debuggerSessionManager';
import { frameDebuggee, getContainerTopFrame, getFrameViewportTransform } from '../utils/containerFrameTarget';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function dataUrlToBase64(dataUrl: string): string {
  return dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
}

const AGENT_SIDE_PANEL_TOGGLE_DISPLAY_PROPERTY = '--mearl-side-panel-toggle-display';
const APP_DEVICE_CUTOUT_DISPLAY_PROPERTY = '--mearl-device-cutout-display';
const SCREENSHOT_HIDDEN_PROPERTIES = {
  [AGENT_SIDE_PANEL_TOGGLE_DISPLAY_PROPERTY]: 'none',
  [APP_DEVICE_CUTOUT_DISPLAY_PROPERTY]: 'none',
};
const PHONE_FRAME_HIDDEN_PROPERTIES = {
  ...SCREENSHOT_HIDDEN_PROPERTIES,
  '--mearl-device-chrome-display': 'none',
  '--mearl-device-frame-radius': '0px',
};
const screenshotQueueTails = new Map<number, Promise<void>>();

function viewportClip(x: number, y: number, width: number, height: number, phoneFrame?: boolean) {
  if (phoneFrame) {
    // Chrome rounds clip coordinates before capture. Round inward to keep the shell outside.
    width = Math.floor(x + width) - Math.ceil(x);
    height = Math.floor(y + height) - Math.ceil(y);
    x = Math.ceil(x);
    y = Math.ceil(y);
  }
  if (width <= 0 || height <= 0) throw new Error('The page screenshot has no visible area');
  return { x, y, width, height, scale: 1 };
}

interface ScreenshotHiddenDisplayState {
  property: string;
  value: string;
  priority: string;
}

async function runScreenshotExclusive<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
  const previous = screenshotQueueTails.get(tabId) ?? Promise.resolve();
  let unlock!: () => void;
  const tail = new Promise<void>(resolve => {
    unlock = resolve;
  });
  screenshotQueueTails.set(tabId, tail);

  await previous;
  try {
    return await operation();
  } finally {
    unlock();
    if (screenshotQueueTails.get(tabId) === tail) screenshotQueueTails.delete(tabId);
  }
}

// Screenshot-only UI inherits these root-scoped properties, including elements mounted mid-capture.
async function hideScreenshotArtifacts(
  debugTarget: chrome.debugger.Debuggee,
  properties: Record<string, string>,
): Promise<ScreenshotHiddenDisplayState[]> {
  const result = (await chrome.debugger.sendCommand(debugTarget, 'Runtime.evaluate', {
    expression: `
      (() => {
        const root = document.documentElement;
        if (!root) return [];
        const properties = ${JSON.stringify(properties)};
        return Object.entries(properties).map(([property, hiddenValue]) => {
          const value = root.style.getPropertyValue(property);
          const priority = root.style.getPropertyPriority(property);
          root.style.setProperty(property, hiddenValue, 'important');
          return { property, value, priority };
        });
      })()
    `,
    returnByValue: true,
  })) as {
    result?: { value?: ScreenshotHiddenDisplayState[] };
  };

  return result.result?.value ?? [];
}

async function restoreScreenshotArtifacts(
  debugTarget: chrome.debugger.Debuggee,
  states: ScreenshotHiddenDisplayState[],
  properties: Record<string, string>,
): Promise<void> {
  if (states.length === 0) return;

  await chrome.debugger.sendCommand(debugTarget, 'Runtime.evaluate', {
    expression: `
      (() => {
        const root = document.documentElement;
        if (!root) return;
        const states = ${JSON.stringify(states)};
        const properties = ${JSON.stringify(properties)};
        for (const { property, value, priority } of states) {
          if (
            root.style.getPropertyValue(property) !== properties[property] ||
            root.style.getPropertyPriority(property) !== 'important'
          ) continue;
          if (value) {
            root.style.setProperty(property, value, priority);
          } else {
            root.style.removeProperty(property);
          }
        }
      })()
    `,
  });
}

async function withHiddenScreenshotArtifacts<T>(
  debugTarget: chrome.debugger.Debuggee,
  phoneFrame: boolean | undefined,
  capture: () => Promise<T>,
): Promise<T> {
  const properties = phoneFrame ? PHONE_FRAME_HIDDEN_PROPERTIES : SCREENSHOT_HIDDEN_PROPERTIES;
  const states = await hideScreenshotArtifacts(debugTarget, properties);
  try {
    return await capture();
  } finally {
    try {
      await restoreScreenshotArtifacts(debugTarget, states, properties);
    } catch (error) {
      console.warn('[screenshot] Failed to restore hidden screenshot UI:', error);
    }
  }
}

// 后台 tab 的 requestAnimationFrame 会被 Chrome 节流到 ~1Hz 甚至完全暂停，
// 直接 awaitPromise 会一直挂到外层 15s 超时。给一个上限：到时间就强制继续，
// 反正后台 tab 的"等下一帧"对截图质量没意义。
const RAF_WAIT_TIMEOUT_MS = 500;

async function waitForTwoAnimationFrames(debugTarget: chrome.debugger.Debuggee): Promise<void> {
  const rafPromise = chrome.debugger
    .sendCommand(debugTarget, 'Runtime.evaluate', {
      expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
      awaitPromise: true,
    })
    .then(() => 'raf' as const);

  const timeoutPromise = new Promise<'timeout'>(resolve =>
    setTimeout(() => resolve('timeout'), RAF_WAIT_TIMEOUT_MS),
  );

  const winner = await Promise.race([rafPromise, timeoutPromise]);
  if (winner === 'timeout') {
    console.warn(
      `[screenshot] requestAnimationFrame did not fire within ${RAF_WAIT_TIMEOUT_MS}ms ` +
        '(tab likely throttled in background), proceeding without frame sync.',
    );
  }
}

export interface ScreenshotCapture {
  dataUrl: string;
  width: number;
  height: number;
  pageUrl?: string;
}

export async function captureScreenshotViaCDP(
  tabId: number,
  format: 'png' | 'jpeg',
  quality: number,
  businessViewport = false,
): Promise<ScreenshotCapture> {
  return runScreenshotExclusive(tabId, async () => {
    const debugTarget = { tabId };
    const debuggerLease = await acquireDebuggerLease(tabId, { consumer: 'page-screenshot' });
    try {
      const container = await getContainerTopFrame(tabId, businessViewport ? 'container' : 'phone-frame');
      return await withHiddenScreenshotArtifacts(debugTarget, container?.phoneFrame, async () => {
        // Wait two animation frames: first rAF lets layout/paint run, second ensures composite is done.
        // Capped by RAF_WAIT_TIMEOUT_MS so background-throttled tabs don't hang the request.
        await waitForTwoAnimationFrames(debugTarget);
        const metrics = (await chrome.debugger.sendCommand(debugTarget, 'Runtime.evaluate', {
          expression:
            '({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 })',
          returnByValue: true,
        })) as {
          result?: { value?: { width?: number; height?: number; dpr?: number } };
        };
        const transform = container
          ? await getFrameViewportTransform(tabId, container.frameId)
          : undefined;
        const params: Record<string, unknown> = { format };
        const clip = transform && viewportClip(
          transform.offset.x,
          transform.offset.y,
          transform.viewport.width * transform.scale.x,
          transform.viewport.height * transform.scale.y,
          container?.phoneFrame,
        );
        if (clip) {
          params.clip = clip;
          params.captureBeyondViewport = false;
        }
        if (format === 'jpeg') params.quality = clamp(quality, 0, 100);
        const result = (await chrome.debugger.sendCommand(
          debugTarget,
          'Page.captureScreenshot',
          params,
        )) as { data: string };
        const width = metrics.result?.value?.width;
        const height = metrics.result?.value?.height;
        const dpr = metrics.result?.value?.dpr;
        if (
          typeof width !== 'number' ||
          width <= 0 ||
          typeof height !== 'number' ||
          height <= 0 ||
          typeof dpr !== 'number' ||
          dpr <= 0
        ) {
          throw new Error('Unable to determine the captured viewport dimensions');
        }
        return {
          dataUrl: `data:image/${format};base64,${result.data}`,
          width: Math.round((clip?.width ?? width) * dpr),
          height: Math.round((clip?.height ?? height) * dpr),
          ...(container?.phoneFrame ? { pageUrl: container.url } : {}),
        };
      });
    } finally {
      await debuggerLease.release();
    }
  });
}

export async function captureNodeScreenshotViaCDP(
  tabId: number,
  selector: string,
  format: 'png' | 'jpeg',
  quality: number,
): Promise<ScreenshotCapture> {
  return runScreenshotExclusive(tabId, async () => {
    const debugTarget = { tabId };
    const debuggerLease = await acquireDebuggerLease(tabId, {
      consumer: 'node-screenshot',
      domains: ['Page', 'Runtime'],
    });
    try {
      const containerFrame = await getContainerTopFrame(tabId);
      return await withHiddenScreenshotArtifacts(debugTarget, containerFrame?.phoneFrame, async () => {
        const contextId = containerFrame
          ? await resolveDebuggerFrameExecutionContextId(tabId, containerFrame.frameId, false, containerFrame.sessionId)
          : undefined;
        const useViewportCoordinates = containerFrame !== undefined;
        // Use Runtime.evaluate to get the element's visible bounds, clipped to any ancestor
        // with overflow:hidden. DOM.getBoxModel returns the element's full border box which
        // may exceed the visible area when a parent has overflow:hidden (e.g. carousels,
        // tab panels), causing the screenshot to capture adjacent off-screen content.
        const evalResult = (await chrome.debugger.sendCommand(frameDebuggee(tabId, containerFrame), 'Runtime.evaluate', {
          expression: `
            (() => {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return null;
              const rect = el.getBoundingClientRect();
              const scrollX = ${useViewportCoordinates ? '0' : 'window.scrollX'};
              const scrollY = ${useViewportCoordinates ? '0' : 'window.scrollY'};
              let x = rect.left + scrollX;
              let y = rect.top + scrollY;
              let right = rect.right + scrollX;
              let bottom = rect.bottom + scrollY;
              // Walk up the ancestor chain and clip to any overflow:hidden parent
              let parent = el.parentElement;
              while (parent && parent !== document.documentElement) {
                const style = window.getComputedStyle(parent);
                const clipX = style.overflow === 'hidden' || style.overflowX === 'hidden';
                const clipY = style.overflow === 'hidden' || style.overflowY === 'hidden';
                if (clipX || clipY) {
                  const pr = parent.getBoundingClientRect();
                  if (clipX) {
                    x = Math.max(x, pr.left + scrollX);
                    right = Math.min(right, pr.right + scrollX);
                  }
                  if (clipY) {
                    y = Math.max(y, pr.top + scrollY);
                    bottom = Math.min(bottom, pr.bottom + scrollY);
                  }
                }
                parent = parent.parentElement;
              }
              return { x, y, width: right - x, height: bottom - y };
            })()
          `,
          returnByValue: true,
          ...(contextId !== undefined ? { contextId } : {}),
        })) as {
          result: { value: { x: number; y: number; width: number; height: number } | null };
        };

        const bounds = evalResult.result.value;
        if (!bounds) throw new Error(`Element not found: ${selector}`);
        let { x, y, width, height } = bounds;
        if (width <= 0 || height <= 0)
          throw new Error(`Element matched by "${selector}" has no visible size`);

        if (containerFrame) {
          const transform = await getFrameViewportTransform(tabId, containerFrame.frameId);
          if (containerFrame.phoneFrame) {
            const right = Math.min(x + width, transform.viewport.width);
            const bottom = Math.min(y + height, transform.viewport.height);
            x = Math.max(0, x);
            y = Math.max(0, y);
            width = right - x;
            height = bottom - y;
            if (width <= 0 || height <= 0)
              throw new Error(`Element matched by "${selector}" is outside the visible page`);
          }
          x = transform.offset.x + x * transform.scale.x;
          y = transform.offset.y + y * transform.scale.y;
          width *= transform.scale.x;
          height *= transform.scale.y;
        }

        const clip = viewportClip(x, y, width, height, containerFrame?.phoneFrame);
        const params: Record<string, unknown> = {
          format,
          clip,
          captureBeyondViewport: !containerFrame?.phoneFrame,
        };
        if (format === 'jpeg') params.quality = clamp(quality, 0, 100);

        const [result, scale] = await Promise.all([
          chrome.debugger.sendCommand(debugTarget, 'Page.captureScreenshot', params) as Promise<{ data: string }>,
          containerFrame?.phoneFrame
            ? chrome.debugger.sendCommand(debugTarget, 'Runtime.evaluate', {
                expression: 'window.devicePixelRatio || 1',
                returnByValue: true,
              }) as Promise<{ result?: { value?: number } }>
            : undefined,
        ]);
        const dpr = scale?.result?.value ?? 1;

        return {
          dataUrl: `data:image/${format};base64,${result.data}`,
          width: Math.round(clip.width * dpr),
          height: Math.round(clip.height * dpr),
          ...(containerFrame?.phoneFrame ? { pageUrl: containerFrame.url } : {}),
        };
      });
    } finally {
      await debuggerLease.release();
    }
  });
}
