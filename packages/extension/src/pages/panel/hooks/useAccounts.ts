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
import { accountPermissionUrl } from '../../../shared/browserCapabilityPermissions';
import { useBrowserUiSettings } from '../utils/browserUiSettings';

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
  const permissionUrl = accountPermissionUrl(settings.logins?.accounts?.url, error);
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
              data: { operation: 'authorizeAccounts', origin },
            })
            .catch(() => null);
          if (accepted !== generation.current || !result?.success) return;
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
    [setAccounts],
  );

  const requestAccounts = useCallback(async () => {
    if (fetched) return;
    await doFetch();
  }, [fetched, doFetch]);

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
