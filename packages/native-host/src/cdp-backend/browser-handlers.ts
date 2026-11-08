/**
 * CDP browser-level handlers: screenshots.
 */

import type { PageScreenshotParams } from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import { registerActions } from './action-registry.js';
import { getCdpDeviceShellInputOffset, sendCdpDeviceShellPageCommand } from './device-shell.js';

const SCREENSHOT_HIDDEN_DISPLAY_PROPERTIES = [
  '--mearl-side-panel-toggle-display',
  '--mearl-device-cutout-display',
] as const;
const screenshotQueueTails = new WeakMap<PageSession, Promise<void>>();

interface ScreenshotHiddenDisplayState {
  property: string;
  value: string;
  priority: string;
}

async function runScreenshotExclusive<T>(
  session: PageSession,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = screenshotQueueTails.get(session) ?? Promise.resolve();
  let unlock!: () => void;
  const tail = new Promise<void>(resolve => {
    unlock = resolve;
  });
  screenshotQueueTails.set(session, tail);

  await previous;
  try {
    return await operation();
  } finally {
    unlock();
    if (screenshotQueueTails.get(session) === tail) screenshotQueueTails.delete(session);
  }
}

async function hideScreenshotArtifacts(
  session: PageSession,
): Promise<ScreenshotHiddenDisplayState[]> {
  const result = await session.client.sendCommand('Runtime.evaluate', {
    expression: `
      (() => {
        const root = document.documentElement;
        if (!root) return [];
        const properties = ${JSON.stringify(SCREENSHOT_HIDDEN_DISPLAY_PROPERTIES)};
        return properties.map(property => {
          const value = root.style.getPropertyValue(property);
          const priority = root.style.getPropertyPriority(property);
          root.style.setProperty(property, 'none', 'important');
          return { property, value, priority };
        });
      })()
    `,
    returnByValue: true,
  });
  return result.result?.value ?? [];
}

async function restoreScreenshotArtifacts(
  session: PageSession,
  states: ScreenshotHiddenDisplayState[],
): Promise<void> {
  if (states.length === 0) return;
  await session.client.sendCommand('Runtime.evaluate', {
    expression: `
      (() => {
        const root = document.documentElement;
        if (!root) return;
        const states = ${JSON.stringify(states)};
        for (const { property, value, priority } of states) {
          if (
            root.style.getPropertyValue(property) !== 'none' ||
            root.style.getPropertyPriority(property) !== 'important'
          ) continue;
          if (value) root.style.setProperty(property, value, priority);
          else root.style.removeProperty(property);
        }
      })()
    `,
  });
}

async function withHiddenScreenshotArtifacts<T>(
  session: PageSession,
  capture: () => Promise<T>,
): Promise<T> {
  const states = await hideScreenshotArtifacts(session);
  try {
    return await capture();
  } finally {
    await restoreScreenshotArtifacts(session, states).catch(() => {});
  }
}

async function capturePageScreenshot(
  session: PageSession,
  data: PageScreenshotParams,
): Promise<any> {
  const format = data.format === 'jpeg' ? 'jpeg' : 'png';
  const quality = typeof data.quality === 'number' ? Math.min(Math.max(data.quality, 0), 100) : 80;

  const params: Record<string, any> = { format };
  if (format === 'jpeg') params.quality = quality;

  const pageInfo = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
    expression: `JSON.stringify({ url: location.href, title: document.title, w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 })`,
    returnByValue: true,
  });
  const info = JSON.parse(pageInfo.result?.value ?? '{}');

  if (data.selector) {
    params.captureBeyondViewport = true;
    const selector: string = data.selector;
    const evalResult = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
      expression: `(function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: 'Element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        var r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          devicePixelRatio: window.devicePixelRatio || 1
        };
      })()`,
      returnByValue: true,
    });

    const rect = evalResult.result?.value;
    if (!rect || rect.error) {
      throw new Error(rect?.error ?? `Element not found: ${selector}`);
    }
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error(`Element matched by "${selector}" has no visible size`);
    }

    const offset = await getCdpDeviceShellInputOffset(session);
    params.clip = {
      x: rect.x + offset.x,
      y: rect.y + offset.y,
      width: rect.width,
      height: rect.height,
      scale: rect.devicePixelRatio,
    };

    const result = await session.client.sendCommand('Page.captureScreenshot', params);
    const base64Data: string = result.data;
    const width = Math.round(rect.width * rect.devicePixelRatio);
    const height = Math.round(rect.height * rect.devicePixelRatio);
    return {
      meta: {
        format,
        width,
        height,
        size: Math.ceil((base64Data.length * 3) / 4),
        url: info.url ?? '',
        title: info.title ?? '',
      },
      data: base64Data,
    };
  }

  const result = await session.client.sendCommand('Page.captureScreenshot', params);
  const base64Data: string = result.data;
  const width = Math.round((info.w ?? 1920) * (info.dpr ?? 1));
  const height = Math.round((info.h ?? 1080) * (info.dpr ?? 1));

  return {
    meta: {
      format,
      width,
      height,
      size: Math.ceil((base64Data.length * 3) / 4),
      url: info.url ?? '',
      title: info.title ?? '',
    },
    data: base64Data,
  };
}

export async function cdpPageScreenshot(
  session: PageSession,
  data: PageScreenshotParams,
): Promise<any> {
  return runScreenshotExclusive(session, () =>
    withHiddenScreenshotArtifacts(session, () => capturePageScreenshot(session, data)),
  );
}

// ─── Registration ─────────────────────────────────────────────────────────────

registerActions([{ name: 'page_screenshot', session: 'page', handler: cdpPageScreenshot }]);
