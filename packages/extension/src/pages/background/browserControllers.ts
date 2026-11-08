import { isBrowserDocumentAlive } from './browserDocuments';
import { browserViewPreferenceKey } from '../../shared/browserViewPreferences';
import {
  PROXY_PERMISSION_STORAGE_KEY,
  DISABLED_BUILTIN_ORIGINS_STORAGE_KEY,
  AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY,
} from '../../shared/proxyPermissions';
import { clonePresetDefaults } from '@mearl/preset';
import {
  BROWSER_CONTROLLER_OFFSCREEN_TARGET,
  BROWSER_CONTROLLER_HOST_TARGET,
  BROWSER_CONTROLLER_EVENT_TARGET,
} from '../../shared/browserCapabilityMessages';
import { isExtensionUiSender } from './extensionMessageTrust';
import { withOffscreenDocument } from './offscreenDocument';
import {
  openBrowserViewInstance,
  readBrowserViewInstance,
  readBrowserViewController,
  listBrowserViewControllers,
  forgetBrowserViewController,
  type BrowserViewInstance,
} from './browserViewInstances';
import { handleBrowserView } from './browserViewService';

const prefix = 'mearl-browser-controller:';
const closing = new Map<string, Promise<void>>();
let initialized = false;
const identity = (id: string, instance: BrowserViewInstance) => ({
  instanceId: id,
  bundleId: instance.selected.bundleId,
  revision: instance.selected.revision,
  slot: instance.selected.slot,
});
async function offscreen(
  id: string,
  instance: BrowserViewInstance,
  operation: string,
  input: Record<string, unknown> = {},
) {
  if (!instance.controller) throw new Error('Browser controller is unavailable');
  return withOffscreenDocument(async () => {
    const response = await chrome.runtime.sendMessage({
      ...input,
      target: BROWSER_CONTROLLER_OFFSCREEN_TARGET,
      operation,
      id,
      token: instance.controller!.token,
    });
    if (!response?.success) throw new Error(response?.error || 'Browser controller failed');
    return response.data;
  });
}
async function close(id: string, instance: BrowserViewInstance): Promise<void> {
  const previous = closing.get(id);
  if (previous) return previous;
  const result = (async () => {
    try {
      await offscreen(id, instance, 'close');
    } finally {
      await forgetBrowserViewController(id, instance.controller!.token);
    }
  })();
  closing.set(id, result);
  void result
    .finally(() => {
      if (closing.get(id) === result) closing.delete(id);
    })
    .catch(() => {});
  return result;
}

/** A disconnect after worker restart only releases sessions whose document really closed. */
export async function reconcileBrowserControllers(): Promise<void> {
  const instances = await listBrowserViewControllers();
  await Promise.allSettled(instances.map(async instance => {
    if (!(await isBrowserDocumentAlive(instance.documentId))) await close(instance.id, instance);
  }));
}

async function handleController(input: unknown, sender: chrome.runtime.MessageSender) {
  if (!isExtensionUiSender(sender, chrome.runtime.id) || !sender.documentId)
    return { success: false, error: 'Extension UI required' };
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Expected a browser controller operation');
    const value = input as Record<string, unknown>;
    if (value.slot !== 'captureController')
      throw new Error('Unsupported browser controller position');
    if (value.operation === 'controllerStart') {
      await reconcileBrowserControllers();
      await openBrowserViewInstance(value, sender);
    }
    const instance = await readBrowserViewInstance(value, sender);
    if (!instance.controller) throw new Error('Browser controller is unavailable');
    const id = value.instanceId as string;
    if (value.operation === 'controllerClose') {
      await close(id, instance);
      return { success: true };
    }
    if (closing.has(id)) throw new Error('Browser controller is closing');
    if (!(await isBrowserDocumentAlive(sender.documentId)))
      throw new Error('Browser controller owner closed');
    let data: unknown;
    if (value.operation === 'controllerStart') {
      const bootstrap = clonePresetDefaults(value.bootstrap);
      if (
        typeof bootstrap.locale !== 'string' ||
        !bootstrap.context ||
        typeof bootstrap.context !== 'object' ||
        Array.isArray(bootstrap.context)
      )
        throw new Error('Invalid browser controller bootstrap');
      const preferences = await handleBrowserView(
        { ...identity(id, instance), operation: 'preferences' },
        sender,
      );
      if (!preferences.success) throw new Error(preferences.error);
      try {
        data = await offscreen(id, instance, 'start', {
          selected: { ...instance.selected, html: instance.controller.html },
          ownerDocumentId: instance.documentId,
          bootstrap: { ...bootstrap, preferences: preferences.data },
        });
        if (!(await isBrowserDocumentAlive(sender.documentId))) {
          await close(id, instance);
          throw new Error('Browser controller owner closed while starting');
        }
      } catch (error) {
        await close(id, instance).catch(() => {});
        throw error;
      }
    } else if (value.operation === 'controllerCommand') {
      if (typeof value.method !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,79}$/.test(value.method))
        throw new Error('Invalid browser controller command');
      data = await offscreen(id, instance, 'command', { method: value.method, input: value.input });
    } else if (value.operation === 'controllerContext') {
      data = await offscreen(id, instance, 'context', {
        context: clonePresetDefaults(value.context),
      });
    } else throw new Error('Unknown browser controller operation');
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const starts = new Map<string, Promise<unknown>>();
/** A replacement in the same document waits for the previous resource owner to finish. */
export async function handleBrowserController(
  input: unknown,
  sender: chrome.runtime.MessageSender,
) {
  if (!isExtensionUiSender(sender, chrome.runtime.id) || !sender.documentId)
    return { success: false, error: 'Extension UI required' };
  const value = input as Record<string, unknown> | null;
  if (value?.operation !== 'controllerStart') return handleController(input, sender);
  const documentId = sender.documentId;
  const previous = starts.get(documentId) ?? Promise.resolve();
  const start = previous
    .catch(() => {})
    .then(async () => {
      const instances = await listBrowserViewControllers();
      for (const instance of instances)
        if (instance.documentId === documentId && instance.id !== value.instanceId)
          await close(instance.id, instance);
      return handleController(input, sender);
    })
    .catch(error => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  starts.set(documentId, start);
  void start
    .finally(() => {
      if (starts.get(documentId) === start) starts.delete(documentId);
    })
    .catch(() => {});
  return start;
}

export function initializeBrowserControllers(): void {
  if (initialized) return;
  initialized = true;
  const invalidate = (keys?: string[]) => {
    void chrome.offscreen
      .hasDocument()
      .then(
        exists =>
          exists &&
          chrome.runtime.sendMessage({
            target: BROWSER_CONTROLLER_OFFSCREEN_TARGET,
            operation: 'invalidate',
            keys,
          }),
      )
      .catch(console.warn);
  };
  chrome.permissions.onRemoved.addListener(() => invalidate());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === 'sync' &&
      Object.keys(changes).some(
        key =>
          key.endsWith('Enabled') ||
          [
            PROXY_PERMISSION_STORAGE_KEY,
            DISABLED_BUILTIN_ORIGINS_STORAGE_KEY,
            AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY,
          ].includes(key),
      )
    )
      invalidate(Object.keys(changes));
    if (area === 'local') {
      void listBrowserViewControllers()
        .then(async instances => {
          for (const instance of instances) {
            const values: Record<string, unknown> = {};
            for (const key of Object.keys(instance.selected.definition.preferences ?? {})) {
              const change =
                changes[browserViewPreferenceKey({ ...instance.selected, html: '' }, key)];
              if (change) values[key] = change.newValue ?? null;
            }
            if (Object.keys(values).length)
              await chrome.runtime.sendMessage({
                target: BROWSER_CONTROLLER_OFFSCREEN_TARGET,
                operation: 'preference',
                id: instance.id,
                token: instance.controller!.token,
                values,
              });
          }
        })
        .catch(console.warn);
    }
  });
  chrome.runtime.onConnect.addListener(port => {
    if (
      !port.name.startsWith(prefix) ||
      !port.sender ||
      !isExtensionUiSender(port.sender, chrome.runtime.id)
    )
      return;
    const id = port.name.slice(prefix.length);
    if (!/^[a-f0-9-]{36}$/.test(id)) return;
    port.onDisconnect.addListener(() => {
      void reconcileBrowserControllers().catch(console.warn);
    });
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      message?.target !== BROWSER_CONTROLLER_HOST_TARGET ||
      sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL('src/pages/offscreen/index.html') ||
      sender.tab !== undefined
    )
      return;
    const request = async () => {
      const instance = await readBrowserViewController(message.id, message.token);
      const owner = {
        id: chrome.runtime.id,
        documentId: instance.documentId,
        url: chrome.runtime.getURL('controller-owner'),
      };
      if (message.method === 'owner.live')
        return (
          await isBrowserDocumentAlive(instance.documentId)
        );
      if (message.method === 'closed') {
        await forgetBrowserViewController(message.id, instance.controller!.token);
        await withOffscreenDocument(async () => {});
        return null;
      }
      if (message.method === 'owner.call') {
        if (
          closing.has(message.id) ||
          !(await isBrowserDocumentAlive(instance.documentId))
        )
          throw new Error('Browser controller owner closed');
        const response = await chrome.runtime.sendMessage({
          target: BROWSER_CONTROLLER_EVENT_TARGET,
          id: message.id,
          call: message.input,
        });
        if (!response?.success)
          throw new Error(response?.error || 'Browser controller owner did not respond');
        return response.data;
      }
      const operation =
        message.method === 'invoke'
          ? 'invoke'
          : message.method === 'preference'
            ? 'preferences'
            : message.method === 'transport'
              ? 'transport'
              : undefined;
      if (!operation) throw new Error('Unknown browser controller host operation');
      const response = await handleBrowserView(
        { ...message.input, ...identity(message.id, instance), operation },
        owner,
      );
      if (!response.success) throw new Error(response.error);
      return response.data;
    };
    void request().then(
      data => sendResponse({ success: true, data }),
      error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return true;
  });
  void reconcileBrowserControllers().catch(console.warn);
}
