import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAccounts,
  normalizeAccounts,
  withAccountAutoLogin,
  type BrowserAccountItem,
} from '../utils/accounts';
import { useLocalStorage } from './useLocalStorage';
import { t } from '../utils/i18n';
import { accountStateStorageKeys } from '../../../shared/browserUiSettings';
import {
  accountPermissionUrl,
  browserHostPermissionError,
} from '../../../shared/browserCapabilityPermissions';
import { useBrowserUiSettings } from '../utils/browserUiSettings';
import { missingPresetPermissions } from '../../../shared/presetPermissions';
import {
  PROXY_PERMISSION_STORAGE_KEY,
  DISABLED_BUILTIN_ORIGINS_STORAGE_KEY,
  AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY,
} from '../../../shared/proxyPermissions';

interface UseAccountsResult {
  accounts: BrowserAccountItem[];
  initialized: boolean;
  loading: boolean;
  error: string;
  requestAccounts: () => Promise<void>;
  retryAccounts: (options?: { requestPermission?: boolean }) => Promise<void>;
}

/**
 * 管理账号列表的拉取、缓存和错误状态。
 */
export function useAccounts(): UseAccountsResult {
  const settings = useBrowserUiSettings();
  const [accounts, setAccounts, storageReady] = useLocalStorage<BrowserAccountItem[]>(
    accountStateStorageKeys(settings).cacheKey,
    [],
    { sync: true },
  );
  const generation = useRef(0);
  const fetching = useRef(false);
  const [visibleAccounts, setVisibleAccounts] = useState<BrowserAccountItem[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fetched, setFetched] = useState(false);
  const accountLogin = settings.logins?.accounts?.url;
  const accountPermissionOrigins = settings.accountPermissionOrigins;
  const permissionUrl = accountPermissionUrl(accountLogin, error);
  const permissionOrigin = permissionUrl?.origin;
  useEffect(() => {
    generation.current++;
    fetching.current = false;
    setInitialized(false);
    setVisibleAccounts([]);
    setLoading(false);
    setError('');
    setFetched(false);
    return () => {
      generation.current++;
    };
  }, [settings]);
  useEffect(() => {
    if (!storageReady) return;
    let current = true;
    void normalizeAccounts(accounts)
      .then(result => {
        if (!current) return;
        const normalized = result.success && result.data ? result.data : [];
        setVisibleAccounts(normalized);
        if (
          result.success &&
          result.data &&
          JSON.stringify(normalized) !== JSON.stringify(accounts)
        )
          setAccounts(normalized);
      })
      .finally(() => {
        if (current) setInitialized(true);
      });
    return () => {
      current = false;
    };
  }, [storageReady, accounts, setAccounts, settings]);
  const doFetch = useCallback(
    async (origin?: string) => {
      if (fetching.current) return;
      const accepted = generation.current;
      fetching.current = true;
      setLoading(true);
      try {
        if (origin) {
          const result = await chrome.runtime
            .sendMessage({
              action: 'browserUiService',
              data: {
                operation: 'authorizeAccounts',
                origin,
                ...(accountPermissionOrigins ? { origins: accountPermissionOrigins } : {}),
              },
            })
            .catch(() => null);
          if (accepted !== generation.current || !result?.success) return;
        }
        if (accountLogin && accountPermissionOrigins) {
          const missing = await missingPresetPermissions(accountPermissionOrigins);
          if (accepted !== generation.current) return;
          if (missing.missingOrigins.length || missing.missingAuthorization.length) {
            setError(browserHostPermissionError(new URL(accountLogin)));
            setFetched(true);
            return;
          }
        }
        setError('');
        const { result } = await withAccountAutoLogin(() => fetchAccounts(1));
        if (accepted !== generation.current) return;
        if (result.success && result.data) {
          const accountList = Array.isArray(result.data.accountList) ? result.data.accountList : [];
          setAccounts(accountList);
          setFetched(true);
        } else {
          setError(result.error || t('accountRequestFailed'));
          setFetched(true);
        }
      } catch (requestError) {
        if (accepted !== generation.current) return;
        console.error('[Accounts] Failed to fetch accounts:', requestError);
        setError(requestError instanceof Error ? requestError.message : t('accountRequestFailed'));
        setFetched(true);
      } finally {
        if (accepted === generation.current) {
          fetching.current = false;
          setLoading(false);
        }
      }
    },
    [accountLogin, accountPermissionOrigins, setAccounts],
  );

  const requestAccounts = useCallback(async () => {
    if (fetched) return;
    await doFetch();
  }, [fetched, doFetch]);

  useEffect(() => {
    if (!permissionOrigin) return;
    let active = true;
    const recover = async () => {
      try {
        const missing = await missingPresetPermissions(
          accountPermissionOrigins ?? [`${permissionOrigin}/*`],
        );
        if (active && !missing.missingOrigins.length && !missing.missingAuthorization.length)
          await doFetch();
      } catch {
        // Keep the existing error and explicit retry when permission inspection fails.
      }
    };
    const onAdded = () => void recover();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (
        area === 'sync' &&
        [
          PROXY_PERMISSION_STORAGE_KEY,
          DISABLED_BUILTIN_ORIGINS_STORAGE_KEY,
          AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY,
        ].some(key => Object.hasOwn(changes, key))
      )
        void recover();
    };
    const added = chrome.permissions.onAdded as chrome.events.Event<
      (permissions: chrome.permissions.Permissions) => void
    >;
    added.addListener(onAdded);
    chrome.storage.onChanged.addListener(onChanged);
    // A grant can complete before the failed request reaches this mounted UI.
    void recover();
    return () => {
      active = false;
      added.removeListener(onAdded);
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [permissionOrigin, accountPermissionOrigins, doFetch]);

  const retryAccounts = useCallback(
    async ({ requestPermission = false } = {}) => {
      await doFetch(requestPermission ? permissionOrigin : undefined);
    },
    [doFetch, permissionOrigin],
  );

  return {
    accounts: visibleAccounts,
    initialized,
    loading,
    error: permissionUrl ? t('accountsPermissionRequired', permissionUrl.hostname) : error,
    requestAccounts,
    retryAccounts,
  };
}
