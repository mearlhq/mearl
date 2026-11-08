import type { BrowserAccountItem, BrowserAccountsData } from '../../../shared/types';
import { callBrowserUiOperationResult, type BrowserUiProvider } from './browserUiSettings';
import { withSilentLogin } from './silentLogin';
export type { BrowserAccountItem, BrowserAccountsData };
export interface AccountResult<T> { success: boolean; data?: T; error?: string; silent?: boolean }
export interface AccountIdentity { value: string; watch: Array<{ name: string; domain: string }>; loginId?: string }
export interface AccountQr { url: string; alternateUrl?: string }

const ACCOUNT_LABEL_CACHE_KEY = 'mearl.account-label';
/** A synchronous, display-only snapshot; never used to select an account or issue SSO. */
export function readAccountLabelCache(scope?: string): string {
  if (!scope) return '';
  try {
    const cached = JSON.parse(localStorage.getItem(ACCOUNT_LABEL_CACHE_KEY) ?? 'null');
    return cached?.scope === scope && typeof cached.loginId === 'string' ? cached.loginId : '';
  } catch { return ''; }
}
export function writeAccountLabelCache(scope: string | undefined, loginId: string): void {
  if (!scope) return;
  try { localStorage.setItem(ACCOUNT_LABEL_CACHE_KEY, JSON.stringify({ scope, loginId })); } catch { /* Display caching must not interrupt the UI. */ }
}

export const ACCOUNT_LOGIN_REQUIRED = 'ACCOUNT_LOGIN_REQUIRED';
export const isAccountLoginError = (error?: string) => error === ACCOUNT_LOGIN_REQUIRED;
export const withAccountAutoLogin = <T extends { success: boolean; error?: string }>(operation: () => Promise<T>) => withSilentLogin({ service: 'accounts', isLoginError: result => isAccountLoginError(result.error), operation });
async function operation<T>(command: string, input: Record<string, unknown> = {}, provider?: BrowserUiProvider): Promise<AccountResult<T> & { provider?: BrowserUiProvider }> {
  try {
    const result = await callBrowserUiOperationResult<AccountResult<T>>('accounts', { ...input, command }, { provider });
    return { ...result.data, provider: result.provider };
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}
const owned = (account: BrowserAccountItem, provider?: BrowserUiProvider) => ({ ...account, provider });
export async function fetchAccounts(pageIndex = 1) {
  const result = await operation<BrowserAccountsData>('list', { pageIndex });
  return result.success && result.data ? { ...result, data: { ...result.data, accountList: result.data.accountList.map(item => owned(item, result.provider)) } } : result;
}
export async function borrowAccount(input: string) {
  const result = await operation<BrowserAccountItem>('borrow', { input });
  return result.success && result.data ? { ...result, data: owned(result.data, result.provider) } : result;
}
export const fetchAccountSso = (principalId: string | number, site: string, provider?: BrowserUiProvider) => operation<string>('sso', { principalId, site }, provider);
export const fetchAccountQr = (principalId: string | number, site: string, provider?: BrowserUiProvider) => operation<AccountQr>('qr', { principalId, site }, provider);
export async function normalizeAccounts(accounts: BrowserAccountItem[]) {
  const accepted = await operation<BrowserAccountItem[]>('normalize', { accounts: [] });
  if (!accepted.success || !accepted.provider) return accepted;
  const provider = accepted.provider;
  const matching = accounts.filter(item => !item.provider || item.provider.bundleId === provider.bundleId);
  const result = await operation<BrowserAccountItem[]>('normalize', { accounts: matching }, provider);
  return result.success && result.data ? { ...result, data: result.data.map(item => owned(item, provider)) } : result;
}
export async function fetchAccountIdentity({ cachedOnly = false }: { cachedOnly?: boolean } = {}): Promise<AccountIdentity> {
  const result = await chrome.runtime.sendMessage({ action: 'accountIdentity', ...(cachedOnly ? { cachedOnly: true } : {}) });
  if (!result?.success || !result.data) throw new Error(result?.error || 'Account identity unavailable');
  return result.data;
}
export function redirectAccountLoginPage(): void {
  const tabId = chrome.devtools?.inspectedWindow?.tabId;
  void chrome.runtime.sendMessage({ action: 'accountRedirect', ...(typeof tabId === 'number' ? { tabId } : {}) }).catch(() => {});
}
