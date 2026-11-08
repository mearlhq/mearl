import { isBrowserDocumentAlive, resolveBrowserDocumentSender } from './browserDocuments';
import {
  BROWSER_REQUEST_LOGIN_PORT,
  BROWSER_REQUEST_LOGIN_RULE_START,
  BROWSER_REQUEST_LOGIN_RULE_END,
  isBrowserRequestLoginRule,
} from '../../shared/browserRequestUi';
import { isExtensionUiSender } from './extensionMessageTrust';
import { authorizeBrowserCapabilityUrl } from './browserCapabilities';
import { iframeLoginRule } from './utils/iframeLoginRule';

interface LoginLease {
  id: string;
  documentId: string;
  origin: string;
  ruleId: number;
}
const STORAGE_KEY = 'browser-request-login-leases';
let transition: Promise<unknown> = Promise.resolve();
let initialized = false;
const ports = new Map<string, chrome.runtime.Port>();
const portOwners = new WeakMap<chrome.runtime.Port, string>();
const portOwner = (port: chrome.runtime.Port | undefined) => port && (portOwners.get(port) ?? port.sender?.documentId);
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const next = transition.then(operation, operation);
  transition = next.catch(() => {});
  return next;
}
function owner(sender: chrome.runtime.MessageSender): string {
  if (
    !isExtensionUiSender(sender, chrome.runtime.id) ||
    typeof sender.documentId !== 'string' ||
    !sender.documentId
  )
    throw new Error('Login requires an extension document');
  return sender.documentId;
}
function validId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
}
function rules(leases: LoginLease[]) {
  return [...new Map(leases.map(lease => [lease.ruleId, lease.origin])).entries()].map(
    ([id, origin]) => iframeLoginRule(id, `|${origin}/`),
  );
}
async function replace(next: LoginLease[], previous: LoginLease[]) {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = existing
    .filter(rule => isBrowserRequestLoginRule(rule.id))
    .map(rule => rule.id);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: rules(next) });
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: next });
  } catch (error) {
    await chrome.declarativeNetRequest
      .updateSessionRules({
        removeRuleIds: rules(next).map(rule => rule.id),
        addRules: rules(previous),
      })
      .catch(() => {});
    throw error;
  }
}
/** Accepted records can be released even when permission services are unavailable. */
async function acceptedLeases(): Promise<LoginLease[]> {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  const values: unknown[] = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  const leases: LoginLease[] = [];
  const ids = new Set<string>(),
    bindings = new Map<number, string>();
  for (const value of values.slice(0, 128)) {
    const lease = value as LoginLease;
    if (
      !lease ||
      !validId(lease.id) ||
      ids.has(lease.id) ||
      typeof lease.documentId !== 'string' ||
      !lease.documentId ||
      !Number.isSafeInteger(lease.ruleId) ||
      !isBrowserRequestLoginRule(lease.ruleId)
    )
      continue;
    if (typeof lease.origin !== 'string') continue;
    let parsed: URL;
    try {
      parsed = new URL(lease.origin);
    } catch {
      continue;
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.origin !== lease.origin ||
      (bindings.has(lease.ruleId) && bindings.get(lease.ruleId) !== lease.origin)
    )
      continue;
    ids.add(lease.id);
    bindings.set(lease.ruleId, lease.origin);
    leases.push({
      id: lease.id,
      documentId: lease.documentId,
      origin: lease.origin,
      ruleId: lease.ruleId,
    });
  }
  return leases;
}
/** Session records retain accepted origins across worker restarts, independently of package updates. */
async function reconcile(): Promise<LoginLease[]> {
  const accepted = await acceptedLeases();
  const leases: LoginLease[] = [];
  for (const lease of accepted) {
    if (!(await isBrowserDocumentAlive(lease.documentId))) continue;
    try {
      if ((await authorizeBrowserCapabilityUrl(lease.origin)).origin === lease.origin)
        leases.push(lease);
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 'BROWSER_PERMISSION_REQUIRED') throw error;
    }
  }
  await replace(leases, accepted);
  return leases;
}
export function openBrowserRequestLogin(
  url: string,
  sender: chrome.runtime.MessageSender,
  id: string,
): Promise<string> {
  const documentId = owner(sender);
  if (!validId(id)) throw new Error('Expected a login lease');
  return exclusive(async () => {
    const connected = () => portOwner(ports.get(id)) === documentId;
    const origin = (await authorizeBrowserCapabilityUrl(url)).origin;
    const leases = await reconcile();
    if (!connected() || !(await isBrowserDocumentAlive(documentId)))
      throw new Error('The login document has closed');
    const current = leases.find(lease => lease.id === id);
    if (current) {
      if (current.documentId !== documentId || current.origin !== origin)
        throw new Error('The login lease is already in use');
      return id;
    }
    if (leases.length >= 128) throw new Error('Too many active login documents');
    const shared = leases.find(lease => lease.origin === origin);
    let ruleId = shared?.ruleId ?? BROWSER_REQUEST_LOGIN_RULE_START;
    if (!shared)
      while (
        leases.some(lease => lease.ruleId === ruleId) &&
        ruleId <= BROWSER_REQUEST_LOGIN_RULE_END
      )
        ruleId++;
    if (ruleId > BROWSER_REQUEST_LOGIN_RULE_END) throw new Error('Too many active login origins');
    await replace([...leases, { id, documentId, origin, ruleId }], leases);
    if (!connected() || !(await isBrowserDocumentAlive(documentId))) {
      await replace(leases, leases);
      throw new Error('The login document has closed');
    }
    return id;
  });
}
async function release(id: string, documentId: string) {
  const leases = await acceptedLeases();
  if (leases.some(lease => lease.id === id && lease.documentId !== documentId))
    throw new Error('The login belongs to another extension document');
  await replace(
    leases.filter(lease => lease.id !== id),
    leases,
  );
}
export function closeBrowserRequestLogin(
  id: string,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const documentId = owner(sender);
  return exclusive(() => release(id, documentId));
}
export function initializeBrowserRequestLogins() {
  if (initialized) return;
  initialized = true;
  void exclusive(reconcile).catch(error =>
    console.warn('[Request UI] Login reconciliation failed', error),
  );
  chrome.runtime.onConnect.addListener(port => {
    if (!port.name.startsWith(BROWSER_REQUEST_LOGIN_PORT)) return;
    const [id, token] = port.name.slice(BROWSER_REQUEST_LOGIN_PORT.length).split(':');
    if (
      !validId(id) ||
      !port.sender ||
      !isExtensionUiSender(port.sender, chrome.runtime.id)
    )
      return;
    let closed = false;
    port.onDisconnect.addListener(() => { closed = true; });
    const register = (sender: chrome.runtime.MessageSender) => {
      if (closed) return;
      const previous = ports.get(id);
      if (previous && portOwner(previous) !== sender.documentId) {
        port.disconnect();
        return;
      }
      ports.set(id, port);
      portOwners.set(port, sender.documentId!);
      port.onDisconnect.addListener(() => {
        if (ports.get(id) !== port) return;
        ports.delete(id);
        void exclusive(async () => {
          if (!ports.has(id)) await release(id, owner(sender));
        }).catch(() => {});
      });
      try {
        port.postMessage({ ready: true });
      } catch {
        ports.delete(id);
        void exclusive(async () => {
          if (!ports.has(id)) await release(id, owner(sender));
        }).catch(() => {});
      }
    };
    if (port.sender.documentId) register(port.sender);
    else void resolveBrowserDocumentSender(port.sender, token).then(register, () => port.disconnect());
  });
}
