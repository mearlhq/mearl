import { accountStateStorageKeys, type AccountStateStorage } from '../../shared/browserUiSettings';
import type { BrowserAccountItem } from '../../shared/types';
import { authorizeBrowserCapabilityUrl } from './browserCapabilities';
import { invokeConfiguredBrowserOperation, prepareConfiguredBrowserOperation } from './browserUiService';
import { consumeAccountSsoInOffscreenDocument } from './accountSsoOffscreen';
import { browserCapabilityRegistry, onBrowserPresetChange } from './browserCapabilityRegistry';

const ATTEMPT_COOLDOWN_MS = 30_000;
type Provider = { bundleId: string; revision: string };
interface Identity { value: string; watch: Array<{ name: string; domain: string }> }
const isIdentity = (value: unknown): value is Identity => {
  const identity = value as Identity | undefined;
  return !!identity && typeof identity.value === 'string' && Array.isArray(identity.watch) && identity.watch.every(scope => scope && typeof scope.name === 'string' && typeof scope.domain === 'string');
};
interface LoginContext { supported: boolean; selector?: string; redirectUrl?: string }
export interface AccountAutoLoginResult { success: boolean; reason?: string }
const inFlightByTab = new Map<number, Promise<AccountAutoLoginResult>>();
const lastAttemptAtByTab = new Map<number, number>();
let identityWrite: Promise<void> = Promise.resolve();
let watch: Identity['watch'] = [];
let selectionGeneration = 0;
let identityReadSequence = 0;
interface IdentityRead { key: string; sequence: number }
const latestIdentityReads = new Map<string, number>();
const isLatestIdentityRead = (read: IdentityRead) => latestIdentityReads.get(read.key) === read.sequence;
const sameProvider = (left: Provider | undefined, right: Provider) => left?.bundleId === right.bundleId;

async function operation<T>(command: string, input: Record<string, unknown> = {}, provider?: Provider) {
  const result = await invokeConfiguredBrowserOperation(command === 'identity' ? 'accountIdentity' : 'accounts', { ...input, command }, { provider });
  const response = result.data as { success: boolean; data?: T; error?: string; identity?: string };
  if (!response || typeof response.success !== 'boolean') throw new Error('Invalid account response');
  return { ...response, provider: result.provider };
}
function rememberIdentity(identity: Identity, provider: Provider, generation: number, read: IdentityRead) {
  if (generation !== selectionGeneration || !isLatestIdentityRead(read)) return identityWrite;
  watch = identity.watch;
  identityWrite = identityWrite.then(async () => {
    if (generation !== selectionGeneration || !isLatestIdentityRead(read)) return;
    const identityKey = read.key;
    const previous = (await chrome.storage.local.get(identityKey))[identityKey];
    if (generation !== selectionGeneration || !isLatestIdentityRead(read)) return;
    if (!identity.value) {
      // Keep the last account for automatic login, but never restore its expired display label.
      if (sameProvider(previous?.provider, provider) && previous.displayValid !== false) await chrome.storage.local.set({ [identityKey]: { ...previous, displayValid: false } });
    } else if (previous?.value !== identity.value || !sameProvider(previous?.provider, provider) || previous?.provider?.revision !== provider.revision || previous.displayValid === false) {
      await chrome.storage.local.set({ [identityKey]: { value: identity.value, provider } });
    }
  }).catch(() => {});
  return identityWrite;
}
async function readIdentity(provider?: Provider, storage?: AccountStateStorage): Promise<Identity & { provider?: Provider; cacheKey: string; read: IdentityRead; error?: string }> {
  const generation = selectionGeneration;
  const sequence = ++identityReadSequence;
  const keys = storage ?? accountStateStorageKeys((await browserCapabilityRegistry().settings()).extension);
  const read = { key: keys.identityKey, sequence };
  latestIdentityReads.set(read.key, Math.max(latestIdentityReads.get(read.key) ?? 0, sequence));
  const result = await operation<Identity>('identity', {}, provider);
  const confirmed = result.success && isIdentity(result.data);
  const identity = confirmed ? result.data! : { value: '', watch: [] };
  const error = confirmed ? undefined : result.error || 'Account identity unavailable';
  if (!error || error === 'ACCOUNT_LOGIN_REQUIRED') await rememberIdentity(identity, result.provider, generation, read);
  return generation === selectionGeneration ? { ...identity, provider: result.provider, cacheKey: keys.cacheKey, read, error } : { value: '', watch: [], cacheKey: keys.cacheKey, read };
}
function cachedAccountLabel(cached: unknown, value: string, provider?: Provider): string | undefined {
  if (!value || !provider || !Array.isArray(cached)) return undefined;
  return cached.find(item => item?.provider?.bundleId === provider.bundleId && item.provider.revision === provider.revision && String(item.principalId ?? '') === value && typeof item.loginId === 'string')?.loginId;
}
/** Cached labels are display-only; current-account markers and SSO still require a fresh identity. */
export async function getAccountIdentity({ cachedOnly = false }: { cachedOnly?: boolean } = {}): Promise<Identity & { loginId?: string }> {
  const generation = selectionGeneration;
  if (cachedOnly) {
    const keys = accountStateStorageKeys((await browserCapabilityRegistry().settings()).extension);
    const provider = await prepareConfiguredBrowserOperation('accountIdentity');
    const stored = await chrome.storage.local.get([keys.cacheKey, keys.identityKey]);
    if (generation !== selectionGeneration) return { value: '', watch: [] };
    const saved = stored[keys.identityKey];
    const loginId = saved?.displayValid !== false && sameProvider(saved?.provider, provider) && saved.provider.revision === provider.revision
      ? cachedAccountLabel(stored[keys.cacheKey], saved.value, provider) : undefined;
    return { value: '', watch: [], ...(loginId ? { loginId } : {}) };
  }
  const identity = await readIdentity();
  if (generation !== selectionGeneration) return { value: '', watch: [] };
  if (!isLatestIdentityRead(identity.read)) throw new Error('Account identity changed');
  if (identity.error) throw new Error(identity.error);
  const stored = await chrome.storage.local.get(identity.cacheKey);
  if (generation !== selectionGeneration) return { value: '', watch: [] };
  if (!isLatestIdentityRead(identity.read)) throw new Error('Account identity changed');
  const loginId = cachedAccountLabel(stored[identity.cacheKey], identity.value, identity.provider);
  return { value: identity.value, watch: identity.watch, ...(loginId !== undefined ? { loginId } : {}) };
}
export function initializeAccountTracking() {
  chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
    if (!removed && watch.some(scope => cookie.name === scope.name && (cookie.domain.replace(/^\./, '') === scope.domain || cookie.domain.endsWith('.' + scope.domain)))) void getAccountIdentity().catch(() => {});
  });
  onBrowserPresetChange(() => { selectionGeneration++; latestIdentityReads.clear(); watch = []; void getAccountIdentity().catch(() => {}); });
  void getAccountIdentity().catch(() => {});
}
async function currentAccount(provider: Provider) {
  const generation = selectionGeneration;
  const keys = accountStateStorageKeys((await browserCapabilityRegistry().settings()).extension);
  const { read } = await readIdentity(provider, keys);
  await identityWrite;
  if (generation !== selectionGeneration || !isLatestIdentityRead(read)) return null;
  const stored = await chrome.storage.local.get([keys.cacheKey, keys.identityKey]);
  if (generation !== selectionGeneration || !isLatestIdentityRead(read)) return null;
  let accounts: BrowserAccountItem[] = Array.isArray(stored[keys.cacheKey]) ? stored[keys.cacheKey].filter((item: BrowserAccountItem) => !item.provider || sameProvider(item.provider, provider)) : [];
  const saved = stored[keys.identityKey];
  // A legacy identity is usable only after its account has acquired a provider owner.
  let fallbackIdentity = sameProvider(saved?.provider, provider) ? saved.value : typeof saved === 'string' && accounts.some(item => sameProvider(item.provider, provider) && String(item.principalId) === saved) ? saved : undefined;
  if (typeof saved === 'string' && !fallbackIdentity) {
    const normalized = await operation<BrowserAccountItem[]>('normalize', { accounts: accounts.filter(item => !item.provider), legacyIdentity: saved }, provider);
    if (generation !== selectionGeneration || !isLatestIdentityRead(read)) return null;
    if (normalized.success && normalized.data) {
      accounts = [...accounts.filter(item => item.provider), ...normalized.data];
      fallbackIdentity = normalized.identity;
      if (fallbackIdentity) await rememberIdentity({ value: fallbackIdentity, watch }, provider, generation, read);
    }
  }
  if (generation !== selectionGeneration || !isLatestIdentityRead(read)) return null;
  const result = await operation<Identity & { account: BrowserAccountItem | null; accounts: BrowserAccountItem[] }>('current', { accounts, fallbackIdentity }, provider);
  if (generation !== selectionGeneration || !isLatestIdentityRead(read) || !result.success || !result.data) return null;
  await rememberIdentity(result.data, result.provider, generation, read);
  if (generation !== selectionGeneration || !isLatestIdentityRead(read)) return null;
  await chrome.storage.local.set({ [keys.cacheKey]: result.data.accounts.map(item => ({ ...item, provider: result.provider })) });
  if (generation !== selectionGeneration || !isLatestIdentityRead(read)) return null;
  return result.data.account;
}
async function loginContext(href: string, provider?: Provider) {
  const result = await operation<LoginContext>('loginContext', { url: href }, provider);
  if (!result.success || !result.data) return { supported: false, provider: result.provider };
  return { ...result.data, provider: result.provider };
}
function safeRedirect(value?: string) {
  if (!value) return undefined;
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
}
export async function redirectAccountLoginTab(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url) return;
  const context = await loginContext(tab.url);
  const target = safeRedirect(context.redirectUrl);
  if (target) await chrome.scripting.executeScript({ target: { tabId }, func: (url: string) => location.replace(url), args: [target] });
}
export async function accountAutoLoginAvailability(tabId: number, href: string) {
  if (inFlightByTab.has(tabId) || Date.now() - (lastAttemptAtByTab.get(tabId) ?? 0) < ATTEMPT_COOLDOWN_MS) return { available: false };
  const context = await loginContext(href);
  if (!context.supported || typeof context.selector !== 'string' || !context.selector || context.selector.length > 512) return { available: false };
  return { available: Boolean(await currentAccount(context.provider)), selector: context.selector };
}
async function runAutoLogin(tabId: number, pageUrl: string): Promise<AccountAutoLoginResult> {
  const context = await loginContext(pageUrl);
  if (!context.supported) return { success: false, reason: 'unsupported-page' };
  const account = await currentAccount(context.provider);
  if (!account?.principalId || !account.site) return { success: false, reason: 'no-account' };
  lastAttemptAtByTab.set(tabId, Date.now());
  const ticket = await operation<string>('sso', { principalId: account.principalId, site: account.site }, context.provider);
  if (!ticket.success || typeof ticket.data !== 'string' || !ticket.data) return { success: false, reason: ticket.error === 'INVALID_SSO_URL' ? 'invalid-ticket' : 'ticket-failed' };
  let destination: URL;
  try { destination = await authorizeBrowserCapabilityUrl(ticket.data); } catch { return { success: false, reason: 'invalid-ticket' }; }
  if (destination.protocol !== 'https:') return { success: false, reason: 'invalid-ticket' };
  if (!(await consumeAccountSsoInOffscreenDocument(destination.href).catch(() => false))) return { success: false, reason: 'navigation-failed' };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !(await loginContext(tab.url, context.provider)).supported) return { success: true, reason: 'page-left' };
  const redirect = safeRedirect(context.redirectUrl);
  if (redirect) await chrome.tabs.update(tabId, { url: redirect }); else await chrome.tabs.reload(tabId);
  return { success: true };
}
export function startAccountAutoLogin(tabId: number, href: string): Promise<AccountAutoLoginResult> {
  const current = inFlightByTab.get(tabId);
  if (current) return current;
  if (Date.now() - (lastAttemptAtByTab.get(tabId) ?? 0) < ATTEMPT_COOLDOWN_MS) return Promise.resolve({ success: false, reason: 'cooldown' });
  const task = runAutoLogin(tabId, href).finally(() => { if (inFlightByTab.get(tabId) === task) inFlightByTab.delete(tabId); });
  inFlightByTab.set(tabId, task);
  return task;
}
export function clearAccountAutoLoginTab(tabId: number) { inFlightByTab.delete(tabId); lastAttemptAtByTab.delete(tabId); }
