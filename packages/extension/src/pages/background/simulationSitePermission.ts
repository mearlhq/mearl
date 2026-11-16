import {
  getSimulationSitePattern,
  PERMISSION_REQUEST_PAGE,
  SIMULATION_PERMISSION_PARAM,
} from '../../shared/permissionRequest';
import { reconcileContentScriptsForOrigins } from './contentScriptRegistrar';

interface PendingPermission {
  id: string;
  destination: string;
}

const storageKey = (tabId: number) => `simulationSitePermission:${tabId}`;

function permissionPageUrl(id: string): string {
  return chrome.runtime.getURL(PERMISSION_REQUEST_PAGE) + `?${SIMULATION_PERMISSION_PARAM}=${id}`;
}

export function hasSimulationSitePermission(pattern: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [pattern] });
}

export async function showSimulationSitePermission(
  tabId: number,
  destination: URL,
  cancelNavigation: () => Promise<unknown>,
): Promise<void> {
  // A 204 leaves the old document in place. Superseded requests fail without replacing the prompt.
  await cancelNavigation();
  try {
    const request = { id: crypto.randomUUID(), destination: destination.href };
    await chrome.storage.session.set({ [storageKey(tabId)]: request });
    await chrome.tabs.update(tabId, { url: permissionPageUrl(request.id) });
  } catch (error) {
    console.warn('[DeviceShell] Could not open the site permission page:', error);
  }
}

export function clearSimulationSitePermission(tabId: number): Promise<void> {
  return chrome.storage.session.remove(storageKey(tabId));
}

export async function resolveSimulationSitePermission(
  sender: chrome.runtime.MessageSender,
  decision: unknown,
  disableSimulation: (tabId: number) => Promise<unknown>,
): Promise<{ host?: string; pattern?: string; destination?: string }> {
  const tabId = sender.tab?.id;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || tabId === undefined) return {};

  const key = storageKey(tabId);
  const request = (await chrome.storage.session.get(key))[key] as PendingPermission | undefined;
  if (!request || sender.url !== permissionPageUrl(request.id)) return {};
  const url = new URL(request.destination);
  const pattern = getSimulationSitePattern(url);
  if (!pattern) return {};

  if (decision === undefined) return { host: url.host, pattern };
  if (decision === 'allow') {
    if (!(await hasSimulationSitePermission(pattern))) return {};
    // Wait for document_start registration before reloading the destination into the shell.
    const { origins = [] } = await chrome.permissions.getAll();
    await reconcileContentScriptsForOrigins(origins);
  } else if (decision === 'skip') {
    await disableSimulation(tabId);
  } else {
    return {};
  }
  await clearSimulationSitePermission(tabId);
  return { destination: url.href };
}
