import { useEffect, useSyncExternalStore } from 'react';
import { parseBrowserUiSettings, type BrowserUiSettings } from '../../../shared/browserUiSettings';
import { BROWSER_REQUEST_UI_CHANGED } from '../../../shared/browserRequestUi';
import { BROWSER_UI_OPERATION_PORT } from '../../../shared/browserCapabilityMessages';
import { validateBrowserControl, validateExtensionContributions, type SelectedBrowserControl } from '@mearl/preset/bundles';
import { parseAppProfileMenu, type AppProfileMenuEntry } from '../../../shared/appProfileMenu';

let settings: BrowserUiSettings = {};
let cacheScope: string | undefined;
let browserControl: SelectedBrowserControl | undefined;
let appProfiles: AppProfileMenuEntry[] = [];
let loaded = false;
let inFlight: Promise<BrowserUiSettings> | undefined;
let dirty = false;
let listening = false;
const listeners = new Set<() => void>();
export function getBrowserUiSettings() { return settings; }
export function getBrowserUiSettingsCacheScope(value: BrowserUiSettings) { return value === settings ? cacheScope : undefined; }
export function refreshBrowserUiSettings(): Promise<BrowserUiSettings> {
  if (inFlight) { dirty = true; return inFlight; }
  inFlight = (async () => {
    do {
      dirty = false;
      const response = await chrome.runtime.sendMessage({ action: 'browserUiService', data: { operation: 'settings' } });
      if (!response?.success) throw new Error(response?.error || 'Browser UI settings unavailable');
      const { schemaVersion, ...contributions } = validateExtensionContributions(response.contributions ?? { schemaVersion: 1 });
      const nextSettings = { ...parseBrowserUiSettings(response.data).settings, ...contributions };
      const nextProfiles = parseAppProfileMenu(response.appProfiles ?? []).filter(profile => profile.available !== false);
      let nextControl: SelectedBrowserControl | undefined;
      if (response.browserControl) {
        if (typeof response.browserControl.bundleId !== 'string' || typeof response.browserControl.revision !== 'string') throw new Error('Invalid browser control owner');
        nextControl = { ...response.browserControl, definition: validateBrowserControl(response.browserControl.definition) };
      }
      settings = nextSettings;
      cacheScope = typeof response.cacheScope === 'string' ? response.cacheScope : undefined;
      browserControl = nextControl;
      appProfiles = nextProfiles;
      loaded = true;
      for (const listener of listeners) listener();
    } while (dirty);
    return settings;
  })().finally(() => { inFlight = undefined; });
  return inFlight;
}
function listen() {
  if (listening) return;
  listening = true;
  chrome.runtime.onMessage.addListener(message => {
    if (message?.action === BROWSER_REQUEST_UI_CHANGED) void refreshBrowserUiSettings().catch(console.warn);
  });
}
export function ensureBrowserUiSettings() {
  listen();
  return loaded ? Promise.resolve(settings) : inFlight ?? refreshBrowserUiSettings();
}
export function useBrowserUiSettings() {
  const value = useSyncExternalStore(listener => {
    listeners.add(listener); listen();
    return () => { listeners.delete(listener); };
  }, getBrowserUiSettings);
  useEffect(() => { void ensureBrowserUiSettings().catch(console.warn); }, []);
  return value;
}
export function useBrowserControl(text: (key: string) => string) {
  const current = useBrowserUiSettings();
  return browserControl;
}
export function useBrowserAppProfiles() {
  useBrowserUiSettings();
  return appProfiles;
}
export interface BrowserUiProvider { bundleId: string; revision: string }
export function callBrowserUiOperationResult<T>(name: string, input?: unknown, options: { provider?: BrowserUiProvider; signal?: AbortSignal } = {}): Promise<{ data: T; provider: BrowserUiProvider }> {
  const { signal, provider } = options;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: BROWSER_UI_OPERATION_PORT });
    let settled = false;
    const finish = (error?: Error, result?: any) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', aborted);
      clearTimeout(deadline);
      port.disconnect();
      if (error) reject(error); else resolve(result);
    };
    const aborted = () => finish(new DOMException('Browser UI operation aborted', 'AbortError'));
    const deadline = setTimeout(() => finish(new Error('Browser UI operation timed out')), 135000);
    signal?.addEventListener('abort', aborted, { once: true });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; finish(new Error('Browser UI operation disconnected')); });
    port.onMessage.addListener(result => {
      if (!result?.success) { finish(new Error(result?.error || 'Browser UI operation failed')); return; }
      if (typeof result.provider?.bundleId !== 'string' || typeof result.provider?.revision !== 'string') { finish(new Error('Invalid browser UI provider')); return; }
      finish(undefined, { data: result.data, provider: result.provider });
    });
    try { port.postMessage({ operation: 'invoke', name, input, provider }); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
export async function callBrowserUiOperation<T = any>(name: string, input?: unknown, provider?: BrowserUiProvider): Promise<T> {
  return (await callBrowserUiOperationResult<T>(name, input, { provider })).data;
}
