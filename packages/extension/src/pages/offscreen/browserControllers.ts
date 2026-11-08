import {
  PROXY_PERMISSION_STORAGE_KEY,
  DISABLED_BUILTIN_ORIGINS_STORAGE_KEY,
  AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY,
} from '../../shared/proxyPermissions';
import {
  buildBrowserViewPage,
  type BrowserViewBootstrap,
  type SelectedBrowserView,
} from '@mearl/preset/bundles';
import {
  BROWSER_CONTROLLER_HOST_TARGET,
  BROWSER_CONTROLLER_EVENT_TARGET,
  BROWSER_CONTROLLER_OFFSCREEN_TARGET,
} from '../../shared/browserCapabilityMessages';
import { createBrowserViewTransports } from '../panel/components/browser-view/transports';
import { hasOffscreenWork, holdOffscreenDocument } from './offscreenLeases';

interface ControllerInput {
  id: string;
  token: string;
  selected: SelectedBrowserView;
  bootstrap: BrowserViewBootstrap;
  ownerDocumentId: string;
}
interface ResidentController {
  token: string;
  ready: Promise<void>;
  command(method: string, input?: unknown): Promise<unknown>;
  context(value: BrowserViewBootstrap['context']): void;
  close(): Promise<void>;
  invalidate(keys?: string[]): void;
  preferences(value: unknown): void;
  ownerDocumentId: string;
  ownerDisconnected(generation?: number): void;
  ownerConnected(): number;
}
const controllers = new Map<string, ResidentController>();

function createController(input: ControllerInput): ResidentController {
  const release = holdOffscreenDocument();
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.src = chrome.runtime.getURL('plugin/sandbox.html');
  const channel = new MessageChannel();
  let connected = false,
    closing = false,
    disposed = false,
    serial = 0;
  let closePromise: Promise<void> | undefined;
  let ownerGeneration = 0;
  let ownerTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const commands = new Set<Promise<unknown>>();
  let context = input.bootstrap.context;
  const host = async (method: string, value: unknown = {}) => {
    const response = await chrome.runtime.sendMessage({
      target: BROWSER_CONTROLLER_HOST_TARGET,
      id: input.id,
      token: input.token,
      method,
      input: value,
    });
    if (!response?.success) throw new Error(response?.error || 'Browser controller host failed');
    return response.data;
  };
  const transports = createBrowserViewTransports(
    async value => {
      if (closing) throw new Error('Browser controller is closing');
      const result = await host('transport', value);
      if (closing) throw new Error('Browser controller closed while preparing transport');
      return result;
    },
    event => {
      if (!disposed)
        channel.port1.postMessage({ type: 'view-event', event: { ...event, source: 'transport' } });
    },
    input.selected.definition.transports ?? {},
  );
  const notify = (event: unknown) =>
    chrome.runtime
      .sendMessage({ target: BROWSER_CONTROLLER_EVENT_TARGET, id: input.id, event })
      .catch(() => undefined);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(startup);
    clearTimeout(ownerTimer);
    transports.dispose();
    window.removeEventListener('message', onMessage);
    for (const request of pending.values()) request.reject(new Error('Browser controller closed'));
    pending.clear();
    channel.port1.close();
    channel.port2.close();
    frame.remove();
    release();
  };
  const startup = setTimeout(() => {
    rejectReady(new Error('Browser controller startup timed out'));
    dispose();
  }, 15000);
  const onMessage = (event: MessageEvent) => {
    if (disposed || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'mearl-plugin-host-ready')
      frame.contentWindow?.postMessage(
        { type: 'mearl-plugin-load', html: buildBrowserViewPage(input.selected.html) },
        '*',
      );
    if (event.data?.type === 'mearl-plugin-ready' && !connected) {
      connected = true;
      frame.contentWindow?.postMessage({ type: 'mearl-plugin-connect' }, '*', [channel.port2]);
    }
  };
  const handleCall = async (method: string, value: any) => {
    if (method === 'mounted') {
      clearTimeout(startup);
      resolveReady();
      return null;
    }
    if (method === 'notify') {
      await notify(value);
      return null;
    }
    if (method === 'transport.open') return transports.open(value);
    if (method === 'transport.close') {
      transports.close(value.id);
      return null;
    }
    if (method === 'invoke' || method === 'preference') return host(method, value);
    if (method === 'owner.call' || method === 'toast' || method === 'analytics') {
      if (closing) throw new Error('Browser controller owner closed');
      return host('owner.call', { method, input: value });
    }
    throw new Error('Unknown browser controller host call');
  };
  channel.port1.onmessage = event => {
    const value = event.data;
    if (disposed) return;
    if (value?.type === 'view-ready') {
      channel.port1.postMessage({ type: 'view-init', bootstrap: { ...input.bootstrap, context } });
      return;
    }
    if (value?.type === 'view-command-result' && Number.isSafeInteger(value.id)) {
      const request = pending.get(value.id);
      if (!request) return;
      pending.delete(value.id);
      if (value.success === true) request.resolve(value.value);
      else
        request.reject(
          new Error(
            typeof value.error === 'string' ? value.error : 'Browser controller command failed',
          ),
        );
      return;
    }
    if (value?.type !== 'view-call' || !Number.isSafeInteger(value.id)) return;
    void handleCall(value.method, value.input).then(
      result => {
        if (!disposed)
          channel.port1.postMessage({
            type: 'view-result',
            id: value.id,
            success: true,
            value: result,
          });
      },
      error => {
        if (!disposed)
          channel.port1.postMessage({
            type: 'view-result',
            id: value.id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
  };
  channel.port1.start();
  window.addEventListener('message', onMessage);
  frame.onerror = () => {
    rejectReady(new Error('Browser controller could not load'));
    dispose();
  };
  document.body.append(frame);
  const command = async (method: string, value?: unknown): Promise<unknown> => {
    await ready;
    if (disposed) throw new Error('Browser controller closed');
    const id = ++serial;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      channel.port1.postMessage({ type: 'view-command', id, method, input: value });
    });
  };
  const resident: ResidentController = {
    ownerDocumentId: input.ownerDocumentId,
    ownerConnected() {
      ownerGeneration++;
      clearTimeout(ownerTimer);
      return ownerGeneration;
    },
    ownerDisconnected(acceptedGeneration) {
      if (acceptedGeneration !== undefined && acceptedGeneration !== ownerGeneration) return;
      const generation = ++ownerGeneration;
      clearTimeout(ownerTimer);
      const check = async () => {
        if (generation !== ownerGeneration || closing || disposed) return;
        try {
          const live = await host('owner.live');
          if (generation !== ownerGeneration || closing || disposed) return;
          if (!live) {
            try {
              await resident.close();
            } finally {
              if (controllers.get(input.id) === resident) controllers.delete(input.id);
              await host('closed');
            }
          } else
            ownerTimer = setTimeout(() => {
              void check();
            }, 1000);
        } catch {
          if (!disposed && generation === ownerGeneration)
            ownerTimer = setTimeout(() => {
              void check();
            }, 1000);
        }
      };
      ownerTimer = setTimeout(() => {
        void check();
      }, 300);
    },
    token: input.token,
    ready,
    invalidate(keys) {
      if (
        !keys ||
        keys.some(key =>
          [
            PROXY_PERMISSION_STORAGE_KEY,
            DISABLED_BUILTIN_ORIGINS_STORAGE_KEY,
            AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY,
          ].includes(key),
        ) ||
        Object.values(input.selected.definition.transports ?? {}).some(value =>
          keys.includes(value.setting),
        )
      )
        transports.invalidate();
    },
    preferences(value) {
      if (!disposed && !closing)
        channel.port1.postMessage({
          type: 'view-event',
          event: { source: 'preference', values: value },
        });
    },
    command(method, value) {
      if (closing) return Promise.reject(new Error('Browser controller is closing'));
      if (method === 'dispose')
        return Promise.reject(new Error('Reserved browser controller command'));
      const result = command(method, value);
      commands.add(result);
      void result.finally(() => commands.delete(result)).catch(() => {});
      return result;
    },
    context(value) {
      if (closing || disposed) throw new Error('Browser controller closed');
      context = value;
      if (connected) channel.port1.postMessage({ type: 'view-context', context });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      transports.dispose();
      closePromise = (async () => {
        try {
          await ready;
          await Promise.allSettled([...commands]);
          await command('dispose');
        } finally {
          dispose();
        }
      })();
      return closePromise;
    },
  };
  // Covers the short gap between starting the session and attaching the UI lifetime port.
  resident.ownerDisconnected();
  return resident;
}

/** Pending commands and the accepted cleanup handler outlive the owning UI document. */
export function initializeBrowserControllersOffscreen() {
  chrome.runtime.onConnect.addListener(port => {
    const prefix = 'mearl-browser-controller:';
    if (
      !port.name.startsWith(prefix) ||
      port.sender?.id !== chrome.runtime.id ||
      !port.sender.documentId
    )
      return;
    const controller = controllers.get(port.name.slice(prefix.length));
    if (!controller || controller.ownerDocumentId !== port.sender.documentId) return;
    const generation = controller.ownerConnected();
    port.onDisconnect.addListener(() => controller.ownerDisconnected(generation));
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      message?.target !== BROWSER_CONTROLLER_OFFSCREEN_TARGET ||
      sender.id !== chrome.runtime.id ||
      sender.tab !== undefined ||
      sender.documentId !== undefined
    )
      return;
    if (message.operation === 'invalidate') {
      for (const controller of controllers.values()) controller.invalidate(message.keys);
      sendResponse({ success: true });
      return;
    }
    if (message.operation === 'held') {
      sendResponse({ held: hasOffscreenWork() });
      return;
    }
    if (
      typeof message.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(message.id) ||
      typeof message.token !== 'string'
    )
      return;
    const operation = async () => {
      let controller = controllers.get(message.id);
      if (message.operation === 'start') {
        if (!controller) {
          if (controllers.size >= 16) throw new Error('Too many browser controllers');
          controller = createController(message);
          controllers.set(message.id, controller);
          void controller.ready.catch(() => {
            if (controllers.get(message.id) === controller) controllers.delete(message.id);
          });
        }
        if (controller.token !== message.token) throw new Error('Browser controller owner changed');
        await controller.ready;
        return null;
      }
      if (!controller) {
        if (message.operation === 'close') return null;
        throw new Error('Browser controller is unavailable');
      }
      if (controller.token !== message.token) throw new Error('Browser controller owner changed');
      if (message.operation === 'preference') {
        controller.preferences(message.values);
        return null;
      }
      if (message.operation === 'context') {
        controller.context(message.context);
        return null;
      }
      if (message.operation === 'command') return controller.command(message.method, message.input);
      if (message.operation === 'close') {
        try {
          await controller.close();
        } finally {
          if (controllers.get(message.id) === controller) controllers.delete(message.id);
        }
        return null;
      }
      throw new Error('Unknown browser controller operation');
    };
    void operation().then(
      data => sendResponse({ success: true, data }),
      error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return true;
  });
}
