import { useCallback, useEffect, useRef, useState } from 'react';
import { CapturedRequest } from '../types';
import { getCurrentLanguage } from '../utils/i18n';
import { browserUiText } from '@mearl/preset/bundles';
import { BROWSER_REQUEST_UI_ACTION } from '../../../shared/browserRequestUi';
import { useBrowserRequestUi } from './useBrowserRequestUi';
import { resolveRequestVersion } from '../utils/requestVersion';
import { showToast } from '../utils/toast';
import { useRequestMetadataLogin, isRequestMetadataLoginError } from './useRequestMetadataLogin';

interface HsfInfo {
  displayValue: string;
  jumpUrl: string;
  maintainerDisplayValue?: string;
  maintainerTitle?: string;
}

function getHsfCacheKey(req: CapturedRequest | null, revision: string): string | null {
  if (!req?.apiName) return null;
  return `${revision}@@${req.apiName}@@${resolveRequestVersion(req)}`;
}

export function useHsfState(request: CapturedRequest | null, enabled = true) {
  const { selected, definition } = useBrowserRequestUi();
  const revision = selected?.revision ?? 'builtin';
  const [hsfEnabled, setHsfEnabled] = useState(false);
  const [hsfLoading, setHsfLoading] = useState(false);
  const [hsfInfo, setHsfInfo] = useState<HsfInfo | null>(null);
  const { openLoginModal: openRequestMetadataLogin } = useRequestMetadataLogin();

  const hsfInfoCacheRef = useRef<Map<string, HsfInfo>>(new Map());
  const activeRequestKeyRef = useRef<string | null>(null);
  const hsfLoadingRef = useRef(false);
  const hsfFetchSeqRef = useRef(0);

  const fetchHsfInfo = useCallback(
    async (req: CapturedRequest): Promise<HsfInfo> => {
      if (!definition || !selected) throw new Error('CAPABILITY_NOT_INSTALLED');
      const version = resolveRequestVersion(req);
      const result: any = await chrome.runtime.sendMessage({
        action: BROWSER_REQUEST_UI_ACTION,
        data: {
          operation: 'details',
          api: req.apiName,
          version,
          revision: selected?.revision ?? null,
        },
      });
      if (!result?.success || !result?.data) {
        throw new Error(
          result?.error || browserUiText(definition.details.notFound, getCurrentLanguage()),
        );
      }
      return result.data;
    },
    [selected?.revision, definition],
  );

  const ensureHsfLoaded = useCallback(
    async (req: CapturedRequest) => {
      const cacheKey = getHsfCacheKey(req, revision);
      if (!definition || !selected || !cacheKey || hsfLoadingRef.current) return;

      const cached = hsfInfoCacheRef.current.get(cacheKey);
      if (cached) {
        if (activeRequestKeyRef.current === cacheKey) {
          setHsfInfo(cached);
        }
        return;
      }

      hsfLoadingRef.current = true;
      setHsfLoading(true);
      const fetchSeq = ++hsfFetchSeqRef.current;
      try {
        const info = await fetchHsfInfo(req);
        hsfInfoCacheRef.current.set(cacheKey, info);
        if (activeRequestKeyRef.current === cacheKey && hsfFetchSeqRef.current === fetchSeq) {
          setHsfInfo(info);
        }
      } catch (err) {
        if (activeRequestKeyRef.current !== cacheKey || hsfFetchSeqRef.current !== fetchSeq) return;
        setHsfEnabled(false);
        console.error('[HSF] Failed to get HSF info:', err);
        const msg = err instanceof Error ? err.message : String(err);
        if (isRequestMetadataLoginError(msg)) {
          showToast(browserUiText(definition.login.requiredMessage, getCurrentLanguage()), 'error');
          openRequestMetadataLogin();
        } else {
          showToast(
            msg || browserUiText(definition.details.notFound, getCurrentLanguage()),
            'error',
          );
        }
      } finally {
        if (activeRequestKeyRef.current === cacheKey && hsfFetchSeqRef.current === fetchSeq) {
          hsfLoadingRef.current = false;
          setHsfLoading(false);
        }
      }
    },
    [fetchHsfInfo, openRequestMetadataLogin, revision, definition],
  );

  useEffect(() => {
    const nextCacheKey = getHsfCacheKey(request, revision);
    activeRequestKeyRef.current = nextCacheKey;
    ++hsfFetchSeqRef.current;
    hsfLoadingRef.current = false;

    if (!nextCacheKey) {
      setHsfInfo(null);
      setHsfLoading(false);
      return;
    }

    const cached = hsfInfoCacheRef.current.get(nextCacheKey);
    setHsfInfo(cached ?? null);
    setHsfLoading(false);
  }, [request?.id, revision]);

  const onToggleHsf = useCallback(async () => {
    if (!request || !enabled || !selected) return;

    if (hsfEnabled) {
      setHsfEnabled(false);
      return;
    }

    setHsfEnabled(true);
    await ensureHsfLoaded(request);
  }, [request, enabled, hsfEnabled, ensureHsfLoaded]);

  useEffect(() => {
    if (!request || !hsfEnabled || !enabled || request.source === 'requests') return;
    void ensureHsfLoaded(request);
  }, [request?.id, hsfEnabled, enabled, revision]);

  const onOpenHsf = useCallback(() => {
    if (!hsfInfo?.jumpUrl) return;
    window.open(hsfInfo.jumpUrl, '_blank');
  }, [hsfInfo]);

  return {
    hsfEnabled,
    hsfLoading,
    hsfDisplayValue: hsfInfo?.displayValue,
    hsfMaintainerDisplayValue: hsfInfo?.maintainerDisplayValue,
    hsfMaintainerTitle: hsfInfo?.maintainerTitle,
    onToggleHsf,
    onOpenHsf,
  };
}
