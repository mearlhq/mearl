import { isBrowserDocumentAlive } from './browserDocuments';
import {
  BundleError,
  type BrowserCapabilityInvocation,
  type SelectedBrowserView,
} from '@mearl/preset/bundles';
import { prepareBrowserCapabilities } from './browserCapabilities';
import { browserCapabilityRegistry } from './browserCapabilityRegistry';

type Runtime = Omit<BrowserCapabilityInvocation, 'code' | 'input' | 'handler'> & { code: string };
export interface BrowserViewInstance {
  documentId: string;
  selected: Omit<SelectedBrowserView, 'html'>;
  runtime?: Runtime;
  handlers: Record<string, string>;
  controller?: { html: string; token: string };
}
const prefix = 'browser-view-instance:';
let transition: Promise<unknown> = Promise.resolve();
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const next = transition.then(operation, operation);
  transition = next.catch(() => {});
  return next;
}
function key(id: unknown): string {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
    throw new Error('Expected a browser view instance');
  return prefix + id;
}
function owner(sender: chrome.runtime.MessageSender): string {
  if (!sender.documentId) throw new Error('Browser view requires an extension document');
  return sender.documentId;
}
function matches(instance: BrowserViewInstance, input: Record<string, unknown>) {
  if (
    instance.selected.bundleId !== input.bundleId ||
    instance.selected.revision !== input.revision ||
    instance.selected.slot !== input.slot
  )
    throw new BundleError('BUNDLE_CONFLICT', 'The browser view instance changed');
}

/** Code and metadata belong to the accepting document, including across worker restarts. */
export function openBrowserViewInstance(
  input: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
) {
  return exclusive(async () => {
    const storageKey = key(input.instanceId),
      documentId = owner(sender);
    if (!(await isBrowserDocumentAlive(documentId)))
      throw new Error('The browser view document has closed');
    const stored = await chrome.storage.session.get(null);
    const stale = (await Promise.all(Object.keys(stored).filter(name => name.startsWith(prefix) && !stored[name]?.controller).map(async name =>
      await isBrowserDocumentAlive(stored[name]?.documentId) ? null : name,
    ))).filter((name): name is string => name !== null);
    if (stale.length) await chrome.storage.session.remove(stale);
    const existing = stored[storageKey] as BrowserViewInstance | undefined;
    if (existing) {
      if (existing.documentId !== documentId)
        throw new Error('The browser view belongs to another document');
      matches(existing, input);
      return;
    }
    if (
      input.slot !== 'requestImport' &&
      input.slot !== 'requestCases' &&
      input.slot !== 'captureLauncher' &&
      input.slot !== 'captureController'
    )
      throw new Error('Unsupported browser view position');
    const selected = await browserCapabilityRegistry().view(input.slot);
    if (!selected) throw new Error('The browser view is unavailable');
    const { html: _html, ...metadata } = selected;
    matches({ documentId, selected: metadata, handlers: {} }, input);
    const hooks = [
      ...new Set(Object.values(selected.definition.actions).map(action => action.hook)),
    ];
    const accepted = await prepareBrowserCapabilities(hooks, { bundleId: selected.bundleId, bundleRevision: selected.revision });
    const first = accepted[hooks[0]]?.invocation;
    const instance: BrowserViewInstance = { documentId, selected: metadata, handlers: {} };
    if (selected.slot === 'captureController')
      instance.controller = { html: selected.html, token: crypto.randomUUID() };
    if (first) {
      const { code, handler: _handler, ...runtime } = first;
      instance.runtime = {
        ...runtime,
        code: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(code),
      };
    }
    for (const [name, action] of Object.entries(selected.definition.actions)) {
      const invocation = accepted[action.hook]?.invocation;
      if (!invocation?.handler || invocation.sha256 !== first?.sha256)
        throw new Error('The browser view runtime is unavailable');
      instance.handlers[name] = invocation.handler;
    }
    if (!(await isBrowserDocumentAlive(documentId)))
      throw new Error('The browser view document has closed');
    await chrome.storage.session.set({ [storageKey]: instance });
  });
}

export async function readBrowserViewInstance(
  input: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): Promise<BrowserViewInstance> {
  const storageKey = key(input.instanceId),
    documentId = owner(sender);
  const instance = (await chrome.storage.session.get(storageKey))[storageKey] as
    | BrowserViewInstance
    | undefined;
  if (!instance || instance.documentId !== documentId)
    throw new Error('The browser view instance is unavailable');
  matches(instance, input);
  return instance;
}

export function closeBrowserViewInstance(
  input: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
) {
  return exclusive(async () => {
    const storageKey = key(input.instanceId),
      documentId = owner(sender);
    const instance = (await chrome.storage.session.get(storageKey))[storageKey] as
      | BrowserViewInstance
      | undefined;
    if (instance && instance.documentId !== documentId)
      throw new Error('The browser view belongs to another document');
    await chrome.storage.session.remove(storageKey);
  });
}

/** Resident controllers retain their accepted actions until asynchronous cleanup finishes. */
export async function listBrowserViewControllers(): Promise<
  Array<BrowserViewInstance & { id: string }>
> {
  const stored = await chrome.storage.session.get(null);
  return Object.entries(stored).flatMap(([name, value]) =>
    name.startsWith(prefix) && value?.controller
      ? [{ ...value, id: name.slice(prefix.length) }]
      : [],
  );
}
export async function readBrowserViewController(
  id: unknown,
  token: unknown,
): Promise<BrowserViewInstance> {
  const storageKey = key(id);
  const value = (await chrome.storage.session.get(storageKey))[storageKey] as
    | BrowserViewInstance
    | undefined;
  if (!value?.controller || value.controller.token !== token)
    throw new Error('Browser controller is unavailable');
  return value;
}
export async function forgetBrowserViewController(id: string, token: string): Promise<void> {
  return exclusive(async () => {
    await readBrowserViewController(id, token);
    await chrome.storage.session.remove(key(id));
  });
}
