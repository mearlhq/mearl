import { DomainPermissionError, PluginPageRuntimeHost } from '@mearl/browser-core';
import type { PluginPageHostAdapter, PluginPageNativeCall } from '@mearl/browser-core';
import { isAgentDomainAuthorized } from '../../shared/proxyPermissions';
import { configurePageUserScripts } from './pageUserScripts';
import { resolveToolboxPageFrame } from './toolboxPageFrame';

function extensionAdapter(): PluginPageHostAdapter {
  return {
    session: chrome.storage.session,
    persistent: chrome.storage.local,
    async execute(instance, code) {
      const worldId = `mearl-page-${instance.plugin}`;
      const api = await configurePageUserScripts(worldId, true);
      const [result] = await api.execute({
        target: {
          tabId: instance.target.tabId,
          documentIds: [instance.target.documentId],
        },
        world: 'USER_SCRIPT',
        worldId,
        injectImmediately: true,
        js: [
          {
            code: `(async () => { try { return { ok: true, value: await (${code}\n) }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; } })()`,
          },
        ],
      });
      if (
        !result ||
        result.documentId !== instance.target.documentId ||
        result.frameId !== instance.target.frameId
      )
        throw new Error('PLUGIN_PAGE_INVALIDATED: Document changed during page execution');
      if (result.error || result.result?.ok !== true)
        throw new Error(result.error || result.result?.error || 'Plugin page returned no result');
      return result.result.value;
    },
    async resolve(tabId, frame, expectedDocumentId) {
      if (!Number.isSafeInteger(tabId) || Number(tabId) < 0)
        throw new Error('Plugin page requires an explicit tabId');
      if (
        frame !== 'main' &&
        frame !== 'business' &&
        (!Number.isSafeInteger(frame) || Number(frame) < 0)
      )
        throw new Error('Invalid plugin page frame selector');
      const frameId =
        frame === 'main'
          ? 0
          : frame === 'business'
            ? await resolveToolboxPageFrame(Number(tabId))
            : Number(frame);
      const current = await chrome.webNavigation.getFrame({ tabId: Number(tabId), frameId });
      if (!current?.documentId || current.documentLifecycle !== 'active')
        throw new Error(
          'PLUGIN_PAGE_DOCUMENT_UNAVAILABLE: Provider must expose an active document identity',
        );
      if (expectedDocumentId !== undefined && current.documentId !== expectedDocumentId)
        throw new Error('PLUGIN_PAGE_INVALIDATED: Document changed before attachment');
      const url = new URL(current.url);
      if (url.protocol === 'file:' && !url.hostname && frame === 'main') {
        if (!await chrome.extension.isAllowedFileSchemeAccess() || !await chrome.permissions.contains({ origins: ['file:///*'] }))
          throw new Error('DOMAIN_PERMISSION_REQUIRED: Allow the extension to access local file URLs');
      } else if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Plugin pages require an HTTP(S) document');
      } else if (!(await isAgentDomainAuthorized(url.hostname))) {
        throw new DomainPermissionError('page_runtime', url.hostname);
      }
      return {
        tabId: Number(tabId),
        frameId,
        documentId: current.documentId,
        url: current.url,
      };
    },
    async tabs() {
      return (await chrome.tabs.query({})).flatMap(tab => (tab.id === undefined ? [] : [tab.id]));
    },
    listen(listeners) {
      const runtime = chrome.runtime as typeof chrome.runtime & {
        onUserScriptConnect?: typeof chrome.runtime.onConnect;
      };
      runtime.onUserScriptConnect?.addListener(listeners.connect);
      chrome.webNavigation.onCommitted.addListener(listeners.committed);
      chrome.webNavigation.onCompleted.addListener(listeners.completed);
      chrome.webNavigation.onHistoryStateUpdated.addListener(listeners.navigation);
      chrome.webNavigation.onReferenceFragmentUpdated.addListener(listeners.navigation);
      chrome.tabs.onRemoved.addListener(listeners.removed);
      return () => {
        runtime.onUserScriptConnect?.removeListener(listeners.connect);
        chrome.webNavigation.onCommitted.removeListener(listeners.committed);
        chrome.webNavigation.onCompleted.removeListener(listeners.completed);
        chrome.webNavigation.onHistoryStateUpdated.removeListener(listeners.navigation);
        chrome.webNavigation.onReferenceFragmentUpdated.removeListener(listeners.navigation);
        chrome.tabs.onRemoved.removeListener(listeners.removed);
      };
    },
  };
}

export class PluginPageHost extends PluginPageRuntimeHost {
  constructor(native: PluginPageNativeCall) {
    super(native, extensionAdapter());
  }
}
let host: PluginPageHost | undefined;
export function initializePluginPageHost(native: PluginPageNativeCall): PluginPageHost {
  host ??= new PluginPageHost(native);
  return host;
}
export function handlePluginPageRuntime(data: Record<string, unknown>): Promise<unknown> {
  if (!host) throw new Error('Plugin page host is not initialized');
  return host.handle(data);
}
