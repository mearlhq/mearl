import { FC, useState, useEffect, useRef } from 'react';
import { Loader } from 'lucide-react';
import { t } from '../../utils/i18n';
import { DetailRow } from './DetailRow';
import { useBrowserUiSettings, getBrowserUiSettings } from '../../utils/browserUiSettings';
import { getCachedBrowserMetadata, queryBrowserMetadata, type BrowserMetadataResult } from '../../utils/browserMetadataQuery';

type TtidResult = BrowserMetadataResult | { status: 'error' };

interface TtidQueryParamProps {
  ttidValue: string;
}

export const TtidQueryParam: FC<TtidQueryParamProps> = ({ ttidValue }) => {
  const settings = useBrowserUiSettings();
  const operation = settings.operations?.['tracking.ttidName'];
  const ownerRef = useRef(settings); ownerRef.current = settings;
  const currentTtidRef = useRef(ttidValue);
  const [ttidResult, setTtidResult] = useState<TtidResult | null>(
    () => getCachedBrowserMetadata(settings, 'tracking.ttidName', ttidValue),
  );
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    currentTtidRef.current = ttidValue;
    setTtidResult(getCachedBrowserMetadata(settings, 'tracking.ttidName', ttidValue));
    setIsLoading(false);
  }, [ttidValue, settings]);

  const handleQueryTtid = async () => {
    if (isLoading || !operation) {
      return;
    }

    const queryValue = ttidValue;

    setIsLoading(true);
    try {
      const result = await queryBrowserMetadata(settings, 'tracking.ttidName', { value: queryValue });
      if (currentTtidRef.current === queryValue && ownerRef.current === settings && getBrowserUiSettings() === settings) setTtidResult(result);
    } catch (err) {
      console.error('Failed to query TTID:', err);
      if (currentTtidRef.current === queryValue && ownerRef.current === settings && getBrowserUiSettings() === settings) {
        setTtidResult({ status: 'error' });
      }
    } finally {
      if (currentTtidRef.current === queryValue && ownerRef.current === settings && getBrowserUiSettings() === settings) {
        setIsLoading(false);
      }
    }
  };

  return (
    <DetailRow
      label="ttid"
      value={
        <span className="font-mono">
          {ttidValue}
          {ttidResult && (
            <span className="text-text-secondary">
              {' '}
              (
              {ttidResult.status === 'success'
                ? ttidResult.name
                : ttidResult.status === 'unknown'
                  ? t('queryResultUnknown')
                  : t('queryResultError')}
              )
            </span>
          )}
        </span>
      }
      action={operation && (
        <button
          onClick={handleQueryTtid}
          disabled={isLoading}
          className="px-2 py-0.5 rounded transition-colors cursor-pointer text-2xs bg-bg-secondary text-text-primary hover:bg-bg-hover min-w-11.25 h-5 flex items-center justify-center disabled:opacity-60 disabled:cursor-not-allowed"
          title={t('queryTtidName')}
        >
          {isLoading ? <Loader size={12} className="animate-spin" /> : t('query')}
        </button>
      )}
    />
  );
};
