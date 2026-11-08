import { BundleError, MAX_REQUEST_UI_BYTES, readBundleJson, readBundleText, validateBundleManifest, type PreparedBundle } from './bundle.js';
import { clonePresetDefaults, isJsonObject } from './manifest.js';
import type { JsonObject, JsonValue } from './types.js';
import { browserUiHttpUrl, validateBrowserUiText, type BrowserUiText } from './requestUi.js';

export type BrowserViewSlot = 'requestImport' | 'requestCases' | 'captureLauncher' | 'captureController';
export interface BrowserViewAction {
  hook: string;
  setting?: string;
  disabledResult?: JsonValue;
}
export interface BrowserViewTransport { kind: 'websocket' | 'eventSource'; setting: string }
export interface BrowserViewDefinition {
  schemaVersion: 1;
  entry: string;
  actions: Record<string, BrowserViewAction>;
  preferences?: Record<string, { shared?: 'editor.highlight' | 'json.viewMode' | 'json.shortcuts' | 'code.shortcuts'; area?: 'local' | 'session' }>;
  transports?: Record<string, BrowserViewTransport>;
  logins?: Record<string, { url: string; title: BrowserUiText; size?: 'default' | 'fullscreen' }>;
}
export interface SelectedBrowserView {
  bundleId: string;
  revision: string;
  slot: BrowserViewSlot;
  definition: BrowserViewDefinition;
  html: string;
}
export interface BrowserViewBootstrap {
  locale: string;
  context: JsonObject;
  preferences: JsonObject;
}

const identifier = /^[a-z][a-zA-Z0-9_.-]{0,79}$/;
function invalid(message: string): never { throw new BundleError('BUNDLE_INVALID', message); }
function fields(value: unknown, keys: string[]): asserts value is JsonObject {
  if (!isJsonObject(value) || Object.keys(value).some(key => !keys.includes(key))) invalid('Invalid browser view structure');
}
function entries(value: unknown, limit: number): Array<[string, unknown]> {
  if (!isJsonObject(value) || Object.keys(value).length > limit || Object.keys(value).some(key => !identifier.test(key))) invalid('Invalid browser view entries');
  return Object.entries(value);
}

/** Views occupy existing host positions; their code stays in an opaque sandbox. */
export function validateBrowserView(input: unknown): BrowserViewDefinition {
  const value = clonePresetDefaults(input);
  fields(value, ['schemaVersion', 'entry', 'actions', 'preferences', 'logins', 'transports']);
  if (value.schemaVersion !== 1 || typeof value.entry !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,255}$/.test(value.entry) || value.entry.split('/').some(part => !part || part === '.' || part === '..')) invalid('Invalid browser view entry');
  for (const [, action] of entries(value.actions, 32)) {
    fields(action, ['hook', 'setting', 'disabledResult']);
    if (typeof action.hook !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,127}$/.test(action.hook)) invalid('Invalid browser view hook');
    if (action.setting !== undefined && (typeof action.setting !== 'string' || !/^[a-z][a-zA-Z0-9_-]{0,72}Enabled$/.test(action.setting) || ['agentEnabled', 'sseMonitoringEnabled', 'agentFloatingButtonEnabled'].includes(action.setting))) invalid('Invalid browser view setting');
    if ((action.setting === undefined) !== (action.disabledResult === undefined)) invalid('A guarded view action requires its disabled result');
  }
  if (value.preferences !== undefined) {
    const aliases = new Set<string>();
    for (const [, preference] of entries(value.preferences, 32)) {
      fields(preference, ['shared', 'area']);
      if (preference.area !== undefined && preference.area !== 'local' && preference.area !== 'session') invalid('Invalid browser view preference area');
      if (preference.shared !== undefined) {
        if (typeof preference.shared !== 'string' || !['editor.highlight', 'json.viewMode', 'json.shortcuts', 'code.shortcuts'].includes(preference.shared) || aliases.has(preference.shared)) invalid('Invalid browser view preference alias');
        aliases.add(preference.shared);
      }
    }
  }
  if (value.transports !== undefined) {
    for (const [, transport] of entries(value.transports, 16)) {
      fields(transport, ['kind', 'setting']);
      if (transport.kind !== 'websocket' && transport.kind !== 'eventSource') invalid('Invalid browser view transport');
      if (typeof transport.setting !== 'string' || !/^[a-z][a-zA-Z0-9_-]{0,72}Enabled$/.test(transport.setting) || ['agentEnabled', 'sseMonitoringEnabled', 'agentFloatingButtonEnabled'].includes(transport.setting)) invalid('Invalid browser view transport setting');
    }
  }
  if (value.logins !== undefined) {
    for (const [, login] of entries(value.logins, 16)) {
      fields(login, ['url', 'title', 'size']);
      login.url = browserUiHttpUrl(login.url);
      validateBrowserUiText(login.title);
      if (login.size !== undefined && !['default', 'fullscreen'].includes(login.size as string)) invalid('Invalid browser view login size');
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_REQUEST_UI_BYTES) throw new BundleError('BUNDLE_QUOTA', 'Browser view definition exceeds 64 KiB');
  return value as unknown as BrowserViewDefinition;
}

export function selectBrowserView(bundles: PreparedBundle[], slot: BrowserViewSlot, apiVersion: string): SelectedBrowserView | undefined {
  if (slot !== 'requestImport' && slot !== 'requestCases' && slot !== 'captureLauncher' && slot !== 'captureController') invalid('Unsupported browser view position');
  let selected: SelectedBrowserView | undefined;
  for (const bundle of bundles) {
    const manifest = validateBundleManifest(bundle.manifest, apiVersion);
    const resource = manifest.contributions?.browserViews?.[slot];
    if (!resource) continue;
    if (selected) invalid('Browser view position has multiple providers');
    const definition = validateBrowserView(readBundleJson(bundle, resource));
    const bindings = manifest.contributions?.browserRuntimes?.extension?.bindings ?? {};
    if (Object.values(definition.actions).some(action => !Object.hasOwn(bindings, action.hook))) invalid('View actions must belong to their own browser runtime');
    if (!Object.hasOwn(manifest.resources, definition.entry)) invalid('Browser view entry must be a declared resource');
    const html = readBundleText(bundle, definition.entry);
    if (!html.trim()) invalid('Browser view entry must not be empty');
    selected = { bundleId: manifest.id, revision: bundle.revision, slot, definition, html };
  }
  return selected;
}

/** Serialized before the view bundle; only its parent receives this private port. */
function installBrowserViewBridge() {
  let connected = false;
  let closed = false;
  let serial = 0;
  let port: MessagePort;
  let resolveReady: (value: unknown) => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const listeners = new Set<(value: unknown) => void>();
  const eventListeners = new Set<(value: unknown) => void>();
  const handlers = new Map<string, (input: unknown) => unknown>();
  const call = async (method: string, input: unknown = {}) => {
    await ready;
    if (!connected) throw new Error('Browser view is closed');
    const value = JSON.parse(JSON.stringify(input));
    const id = ++serial;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { port.postMessage({ type: 'view-call', id, method, input: value }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  };
  Object.defineProperty(window, 'mearlView', { value: Object.freeze({
    ready: () => ready,
    call,
    handle: (method: string, handler: (input: unknown) => unknown) => {
      if (typeof method !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,79}$/.test(method) || typeof handler !== 'function' || handlers.has(method)) throw new Error('Invalid or duplicate browser view command');
      handlers.set(method, handler);
      return () => { if (handlers.get(method) === handler) handlers.delete(method); };
    },
    onEvent: (listener: (value: unknown) => void) => { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    onContext: (listener: (value: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  }) });
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'mearl-plugin-connect' || !event.ports[0] || connected || closed) return;
    connected = true;
    port = event.ports[0];
    port.onmessage = event => {
      const value = event.data;
      if (value?.type === 'view-command' && Number.isSafeInteger(value.id) && value.id > 0) {
        const handler = handlers.get(value.method);
        void Promise.resolve().then(() => {
          if (!handler) throw new Error('Unknown browser view command');
          return handler(value.input);
        }).then(result => {
          if (connected) port.postMessage({ type: 'view-command-result', id: value.id, success: true, value: result });
        }, error => {
          if (connected) port.postMessage({ type: 'view-command-result', id: value.id, success: false, error: error instanceof Error ? error.message : String(error) });
        });
        return;
      }
      if (value?.type === 'view-init') { resolveReady(value.bootstrap); return; }
      if (value?.type === 'view-event') { for (const listener of eventListeners) listener(value.event); return; }
      if (value?.type === 'view-context') { for (const listener of listeners) listener(value.context); return; }
      if (value?.type === 'view-key' && value.key === 'Escape') { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return; }
      if (value?.type === 'view-close') {
        connected = false; closed = true;
        rejectReady(new Error('Browser view is closed'));
        for (const request of pending.values()) request.reject(new Error('Browser view is closed'));
        pending.clear(); port.close(); return;
      }
      if (value?.type !== 'view-result' || !Number.isSafeInteger(value.id)) return;
      const request = pending.get(value.id);
      if (!request) return;
      pending.delete(value.id);
      if (value.success === true) request.resolve(value.value);
      else request.reject(new Error(typeof value.error === 'string' ? value.error : 'Browser view request failed'));
    };
    port.start();
    port.postMessage({ type: 'view-ready' });
  });
  window.parent.postMessage({ type: 'mearl-plugin-ready' }, '*');
}

export function buildBrowserViewPage(html: string): string {
  if (typeof html !== 'string' || !html.trim()) invalid('Browser view entry must not be empty');
  const policy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><script>(${installBrowserViewBridge.toString()})();</script>${html}<style data-mearl-view-surface>html,body{background:transparent!important}</style>`;
}
