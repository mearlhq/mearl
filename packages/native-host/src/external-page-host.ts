import './cdp-backend/handlers.js';
import { CdpClient, type CdpTransport } from './cdp-backend/client.js';
import { createBuffers, setupBufferListeners } from './cdp-backend/buffers.js';
import type { PageSession } from './cdp-backend/cdp-session.js';
import { getAction } from './cdp-backend/action-registry.js';
import { getCdpPageDialogs, monitorCdpPageDialogs } from './cdp-backend/page-dialogs.js';
import { initializePageSession } from './cdp-backend/page-session-initializers.js';
import { nativeCapabilities } from './native-capability-services.js';
import type { BrowserCapabilityAction } from '@mearl/browser-core';

export type { CdpTransport } from './cdp-backend/client.js';
export interface ExternalPageHostOptions {
  tabId: number;
  targetId: string;
  url: string;
  sessionId: string;
  transport: CdpTransport;
  /** Use Console.messageAdded when the transport filters Runtime console events. */
  consoleDomain?: 'Runtime' | 'Console';
  assertControl(): Promise<void>;
  onHostActivity?(active: boolean): void;
}

export const EXTERNAL_PAGE_CAPTURE_ACTIONS = [
  'tab_checkpoint',
  'get_requests',
  'get_logs',
] as const satisfies readonly BrowserCapabilityAction[];

const actions = new Set([
  ...EXTERNAL_PAGE_CAPTURE_ACTIONS,
  'page_snapshot',
  'page_frames',
  'page_eval',
  'page_click',
  'page_type',
  'page_press',
  'page_scroll',
  'page_hover',
  'page_drag',
  'page_wait',
  'page_navigate',
  'page_upload',
  'page_screenshot',
  'page_inspect',
  'set_device_emulation',
  'set_app_profile',
  'set_timezone',
]);

/** Reuses the native page host without browser discovery, tab ownership or an extension. */
export async function createExternalPageHost(options: ExternalPageHostOptions) {
  await options.assertControl();
  await nativeCapabilities.refresh();
  const root = CdpClient.fromTransport(options.transport);
  let controller = new AbortController();
  let captureReady: Promise<void> | undefined;
  const suspend = () => controller.abort(new Error('External task control ended'));
  const assertControl = async () => {
    try {
      await options.assertControl();
    } catch (error) {
      suspend();
      throw error;
    }
  };
  const session: PageSession = {
    tabId: options.tabId,
    targetId: options.targetId,
    url: options.url,
    runtimeOwner: { browser: root.identity, target: options.targetId, pid: process.pid },
    client: root.createChildSession(options.sessionId),
    buffers: createBuffers(options.tabId),
    assertHostControl: assertControl,
    hostSignal: controller.signal,
    onHostRequestActivity: options.onHostActivity,
  };
  const startCapture = () =>
    setupBufferListeners(session.client, session.buffers, options.consoleDomain, controller.signal);
  const unmonitor = monitorCdpPageDialogs(session);
  const detach = async () => {
    try {
      await options.assertControl();
      await root.sendCommand('Target.detachFromTarget', { sessionId: options.sessionId }, 2000);
    } catch {
      /* The owner may already have closed the target or handed it off. */
    } finally {
      root.close();
    }
  };
  try {
    await session.client.sendCommand('Page.enable');
    await startCapture();
    await initializePageSession(session);
  } catch (error) {
    controller.abort(error);
    unmonitor();
    await detach();
    throw error;
  }
  let disposed = false;
  let uncertain = false;
  return {
    async invoke(action: string, data: Record<string, unknown> = {}) {
      if (disposed) throw new Error('External page host is closed');
      if (uncertain)
        throw new Error('ENVIRONMENT_UNCONFIRMED: close this task page before continuing');
      if (!actions.has(action)) throw new Error(`Unsupported external page action: ${action}`);
      if (data.tabId !== undefined && data.tabId !== options.tabId)
        throw new Error('External page target mismatch');
      const previousLease = controller.signal;
      const renewing = previousLease.aborted;
      await assertControl();
      if (disposed) throw new Error('External page host is closed');
      if (!renewing) previousLease.throwIfAborted();
      if (controller.signal.aborted) {
        const renewed = new AbortController();
        controller = renewed;
        session.hostSignal = renewed.signal;
        session.buffers = createBuffers(options.tabId);
        captureReady = startCapture().catch(error => {
          renewed.abort(error);
          throw error;
        });
      }
      const lease = controller.signal;
      await captureReady;
      lease.throwIfAborted();
      const handler = getAction(action);
      if (!handler || handler.session !== 'page')
        throw new Error(`Page handler unavailable: ${action}`);
      try {
        const result = await getCdpPageDialogs(session).execute(() => {
          lease.throwIfAborted();
          return handler.handler(session, { ...data, tabId: options.tabId }, 'local');
        });
        if (EXTERNAL_PAGE_CAPTURE_ACTIONS.some(name => name === action)) lease.throwIfAborted();
        return result;
      } catch (error) {
        if (action === 'set_device_emulation' || action === 'set_app_profile') uncertain = true;
        throw error;
      }
    },
    suspend,
    async dispose() {
      if (disposed) return;
      controller.abort(new Error('External page host disposed'));
      options.onHostActivity?.(false);
      disposed = true;
      unmonitor();
      await detach();
    },
  };
}
