import { sendCdpPageCommand } from './page-dialogs.js';
/**
 * Shared utilities for CDP backend handlers.
 *
 * Contains: HTTP helper (nodeFetch), cookie utilities, page-load waiters,
 * viewport helpers, and serialized function sources for page injection.
 */

import https from 'node:https';
import http from 'node:http';
import {
  typeIntoElement,
  clickElementViaJS,
  getClickCoordsFromNode,
  PageActionDispatchUncertainError,
  PageDialogInterruptedError,
  dispatchPairedPageInputCommands,
  PAGE_CLICK_INPUT_TIMEOUT_MS,
  type CookieCandidate,
  buildPageDragPath,
  type PageClickPointerType,
  type PageDragPoint,
  type PageDragPointerType,
} from '@mearl/browser-core';
import type { PageSession } from './cdp-session.js';
import { selectRequestCookies } from './request-cookies.js';
import {
  getCdpDeviceShellInputOffset,
  isCdpDeviceShellActive,
  sendCdpDeviceShellPageCommand,
} from './device-shell.js';

// ─── Serialized function sources for page injection ───────────────────────────

export const TYPE_INTO_ELEMENT_SRC = typeIntoElement.toString();
export const CLICK_ELEMENT_VIA_JS_SRC = clickElementViaJS.toString();
export const GET_CLICK_COORDS_FROM_NODE_SRC = getClickCoordsFromNode.toString();

// ─── Types ────────────────────────────────────────────────────────────────────

export async function readCdpCurrentUrl(session: PageSession, action: string): Promise<string> {
  const result = await sendCdpPageCommand(session, session.client, 'Runtime.evaluate', {
    expression: 'location.href',
    returnByValue: true,
  });
  const url = result.result?.value;
  if (typeof url !== 'string' || !url) {
    throw new Error(`${action}: could not read the current page URL`);
  }
  session.url = url;
  return url;
}

// ─── Node.js HTTP helper ──────────────────────────────────────────────────────

export function nodeFetch(
  urlStr: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    timeoutMs?: number;
  } = {},
): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyBuffer: Buffer;
  setCookies: string[];
}> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const { method = 'GET', headers = {}, body, timeoutMs = 30000 } = options;

    const req = lib.request(
      {
        host: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      },
      res => {
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') responseHeaders[key] = value;
          else if (Array.isArray(value)) responseHeaders[key] = value.join(', ');
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
            body: bodyBuffer.toString('utf-8'),
            bodyBuffer,
            setCookies: res.headers['set-cookie'] ?? [],
          });
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timeout: ${urlStr}`));
    });

    if (body) req.write(body);
    req.end();
  });
}

// ─── Cookie utilities ─────────────────────────────────────────────────────────

export async function getCookiesForUrl(
  session: PageSession,
  targetUrl: string,
): Promise<CookieCandidate[]> {
  // URL queries use the attached page's partition; proxy credentials follow the request site.
  const result = await sendCdpPageCommand(session, session.client, 'Network.getAllCookies');
  return selectRequestCookies(result.cookies ?? [], targetUrl);
}

export function buildMultipartFormBody(fields: Record<string, string>): {
  contentType: string;
  body: string;
} {
  const boundary = `----mearl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = [
    ...Object.entries(fields).map(
      ([name, value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
    `--${boundary}--\r\n`,
  ].join('');

  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

// ─── Page load waiter ─────────────────────────────────────────────────────────

export class CdpPageLoadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Page load timeout after ${timeoutMs}ms`);
  }
}

export async function waitForPageLoad(
  session: PageSession,
  timeoutMs: number,
  options: { probeReadyState?: boolean; waitUntil?: 'domcontentloaded' } = {},
): Promise<void> {
  const domReady = options.waitUntil === 'domcontentloaded';
  const isReady = (state: unknown) => state === 'complete' || (domReady && state === 'interactive');
  if (options.probeReadyState !== false && isCdpDeviceShellActive(session)) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await sendCdpDeviceShellPageCommand(session, 'Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      }).catch(() => null);
      if (isReady(result?.result?.value)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new CdpPageLoadTimeoutError(timeoutMs);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    let removeLoadListener = () => {};
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(probeTimer);
      removeLoadListener();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new CdpPageLoadTimeoutError(timeoutMs));
    }, timeoutMs);

    removeLoadListener = session.client.on(
      domReady ? 'Page.domContentEventFired' : 'Page.loadEventFired',
      () => finish(),
    );
    if (options.probeReadyState === false) return;
    const probe = async () => {
      try {
        const result = await sendCdpPageCommand(
          session,
          session.client,
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          domReady ? 1000 : undefined,
        );
        if (isReady(result.result?.value)) finish();
      } catch (error) {
        if (error instanceof PageDialogInterruptedError) finish(error);
      }
      // Deferred scripts can delay DOMContentLoaded after the document becomes readable.
      if (domReady && !settled) probeTimer = setTimeout(probe, 200);
    };
    void probe();
  });
}

export async function toCdpInputPoint(
  session: PageSession,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  if (isCdpDeviceShellActive(session)) {
    const offset = await getCdpDeviceShellInputOffset(session);
    return { x: x + offset.x, y: y + offset.y };
  }
  // DOM client rects and CDP Input commands both use main-frame CSS viewport pixels. Layout and
  // visual viewport widths may legitimately differ under zoom or emulation and must not rescale input.
  return { x, y };
}

export async function dispatchCdpClick(
  session: PageSession,
  x: number,
  y: number,
  pointerType: PageClickPointerType,
): Promise<void> {
  const point = await toCdpInputPoint(session, x, y);

  if (pointerType === 'touch') {
    await dispatchPairedPageInputCommands(
      () =>
        sendCdpInputCommand(session, 'Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [point],
        }),
      () =>
        sendCdpInputCommand(session, 'Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        }),
    );
    return;
  }

  await sendCdpInputCommand(session, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
  });
  await dispatchPairedPageInputCommands(
    () =>
      sendCdpInputCommand(session, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      }),
    () =>
      sendCdpInputCommand(session, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      }),
  );
}

export async function dispatchCdpDrag(
  session: PageSession,
  from: PageDragPoint,
  to: PageDragPoint,
  pointerType: PageDragPointerType,
  durationMs: number,
): Promise<{ steps: number }> {
  const [start, end] = await Promise.all([
    toCdpInputPoint(session, from.x, from.y),
    toCdpInputPoint(session, to.x, to.y),
  ]);
  const path = buildPageDragPath(start, end, durationMs);
  let steps = 0;
  const moveAlongPath = async (move: (point: PageDragPoint) => Promise<void>): Promise<void> => {
    const startedAt = performance.now();
    for (let index = 0; index < path.points.length; index += 1) {
      // Input acknowledgements can take seconds even while the renderer remains responsive.
      // Skip overdue samples so their latency does not multiply the gesture duration.
      if (path.intervalMs > 0) {
        const elapsed = performance.now() - startedAt;
        index = Math.min(
          path.points.length - 1,
          Math.max(index, Math.floor(elapsed / path.intervalMs) - 1),
        );
        const remaining = (index + 1) * path.intervalMs - elapsed;
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      }
      await move(path.points[index]!);
      steps += 1;
    }
  };

  if (pointerType === 'touch') {
    let primaryError: unknown;
    try {
      await sendCdpInputCommand(session, 'Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [start],
      });
      await moveAlongPath(async point => {
        await sendCdpInputCommand(session, 'Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [point],
        });
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await sendCdpInputCommand(session, 'Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      }).catch(error => {
        if (primaryError === undefined) throw error;
      });
    }
    return { steps };
  }

  await sendCdpInputCommand(session, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: start.x,
    y: start.y,
  });
  let primaryError: unknown;
  let lastPoint = start;
  try {
    await sendCdpInputCommand(session, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await moveAlongPath(async point => {
      await sendCdpInputCommand(
        session,
        'Input.dispatchMouseEvent',
        {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
          button: 'left',
          buttons: 1,
        },
        () => {
          lastPoint = point;
        },
      );
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await sendCdpInputCommand(session, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: lastPoint.x,
      y: lastPoint.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    }).catch(error => {
      if (primaryError === undefined) throw error;
    });
  }
  return { steps };
}

async function sendCdpInputCommand(
  session: PageSession,
  method: 'Input.dispatchTouchEvent' | 'Input.dispatchMouseEvent',
  params: Record<string, unknown>,
  onDispatch?: () => void,
): Promise<void> {
  try {
    await sendCdpPageCommand(
      session,
      session.client,
      method,
      params,
      PAGE_CLICK_INPUT_TIMEOUT_MS,
      onDispatch,
    );
  } catch (error) {
    if (error instanceof Error && error.message === `CDP command timeout: ${method}`) {
      const eventType = typeof params.type === 'string' ? ` (${params.type})` : '';
      const targetHint =
        method === 'Input.dispatchTouchEvent'
          ? 'Touch input can stall on a hidden, background, or headless target; use clickMode "auto" or make the target visible. '
          : '';
      const message =
        `CDP ${method}${eventType} timed out after ${PAGE_CLICK_INPUT_TIMEOUT_MS}ms. ` +
        targetHint +
        'The page may already have changed; verify its current state before retrying.';
      const inputMayHaveBeenDelivered = /^(mousePressed|mouseReleased|touchStart|touchEnd)$/.test(
        String(params.type ?? ''),
      );
      throw inputMayHaveBeenDelivered
        ? new PageActionDispatchUncertainError(message, {
            cause: error,
            attempt: {
              inputCommand: {
                method,
                type: String(params.type ?? ''),
              },
            },
          })
        : new Error(message, { cause: error });
    }
    throw error;
  }
}

export async function resolveBackendNodeObjectId(
  session: PageSession,
  backendNodeId: number,
): Promise<string> {
  const resolved = await sendCdpDeviceShellPageCommand(session, 'DOM.resolveNode', {
    backendNodeId,
  });
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    throw new Error(`Cannot resolve element for backendNodeId ${backendNodeId}`);
  }
  return objectId;
}
