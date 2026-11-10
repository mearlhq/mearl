import './cdp-backend/handlers.js';
import { CdpClient, type CdpTransport } from './cdp-backend/client.js';
import { createBuffers, setupBufferListeners } from './cdp-backend/buffers.js';
import type { PageSession } from './cdp-backend/cdp-session.js';
import { getAction } from './cdp-backend/action-registry.js';
import { getCdpPageDialogs, monitorCdpPageDialogs } from './cdp-backend/page-dialogs.js';
import { initializePageSession } from './cdp-backend/page-session-initializers.js';
import { nativeCapabilities } from './native-capability-services.js';

export type { CdpTransport } from './cdp-backend/client.js';
export interface ExternalPageHostOptions {
  tabId: number;
  targetId: string;
  url: string;
  sessionId: string;
  transport: CdpTransport;
  assertControl(): Promise<void>;
  onHostActivity?(active: boolean): void;
}

const actions = new Set([
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
  const session: PageSession = {
    tabId: options.tabId,
    targetId: options.targetId,
    url: options.url,
    runtimeOwner: { browser: root.identity, target: options.targetId, pid: process.pid },
    client: root.createChildSession(options.sessionId),
    buffers: createBuffers(),
    assertHostControl: options.assertControl,
    hostSignal: controller.signal,
    onHostRequestActivity: options.onHostActivity,
  };
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
    await setupBufferListeners(session.client, session.buffers);
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
      await options.assertControl();
      if (controller.signal.aborted) {
        controller = new AbortController();
        session.hostSignal = controller.signal;
      }
      const handler = getAction(action);
      if (!handler || handler.session !== 'page')
        throw new Error(`Page handler unavailable: ${action}`);
      try {
        return await getCdpPageDialogs(session).execute(() =>
          handler.handler(session, { ...data, tabId: options.tabId }, 'local'),
        );
      } catch (error) {
        if (action === 'set_device_emulation' || action === 'set_app_profile') uncertain = true;
        throw error;
      }
    },
    suspend() {
      controller.abort(new Error('External task control ended'));
    },
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
