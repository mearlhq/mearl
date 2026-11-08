import { FC, useState, useEffect, useRef } from 'react';
import { Loader } from 'lucide-react';
import { t } from '../../utils/i18n';
import { DetailRow } from './DetailRow';
import { useBrowserUiSettings, getBrowserUiSettings } from '../../utils/browserUiSettings';
import { getCachedBrowserMetadata, queryBrowserMetadata, type BrowserMetadataResult } from '../../utils/browserMetadataQuery';

type SpmResult = BrowserMetadataResult | { status: 'error' };

interface SpmQueryParamProps {
  spmValue: string;
}

export const SpmQueryParam: FC<SpmQueryParamProps> = ({ spmValue }) => {
  const settings = useBrowserUiSettings();
  const operation = settings.operations?.['tracking.spmName'];
  const ownerRef = useRef(settings); ownerRef.current = settings;
  const currentSpmRef = useRef(spmValue);
  const [spmResult, setSpmResult] = useState<SpmResult | null>(
    () => getCachedBrowserMetadata(settings, 'tracking.spmName', spmValue),
  );
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    currentSpmRef.current = spmValue;
    setSpmResult(getCachedBrowserMetadata(settings, 'tracking.spmName', spmValue));
    setIsLoading(false);
  }, [spmValue, settings]);

  const handleQuerySpm = async () => {
    if (isLoading || !operation) {
      return;
    }

    const queryValue = spmValue;

    setIsLoading(true);
    try {
      const result = await queryBrowserMetadata(settings, 'tracking.spmName', { value: queryValue });
      if (currentSpmRef.current === queryValue && ownerRef.current === settings && getBrowserUiSettings() === settings) setSpmResult(result);
    } catch (err) {
      console.error('Failed to query SPM name:', err);
      if (currentSpmRef.current === queryValue && ownerRef.current === settings && getBrowserUiSettings() === settings) {
        setSpmResult({ status: 'error' });
      }
    } finally {
      if (currentSpmRef.current === queryValue && ownerRef.current === settings && getBrowserUiSettings() === settings) {
        setIsLoading(false);
      }
    }
  };

  return (
    <DetailRow
      label={t('aplusSpmName')}
      value={
        <span>
          {spmResult?.status === 'success'
            ? spmResult.name
            : spmResult?.status === 'unknown'
              ? t('queryResultUnknown')
              : spmResult?.status === 'error'
                ? t('queryResultError')
                : '—'}
        </span>
      }
      action={operation && (
        <button
          onClick={handleQuerySpm}
          disabled={isLoading}
          className="px-2 py-0.5 rounded transition-colors cursor-pointer text-2xs bg-bg-secondary text-text-primary hover:bg-bg-hover min-w-11.25 h-5 flex items-center justify-center disabled:opacity-60 disabled:cursor-not-allowed"
          title={t('querySpmName')}
        >
          {isLoading ? <Loader size={12} className="animate-spin" /> : t('query')}
        </button>
      )}
    />
  );
};
