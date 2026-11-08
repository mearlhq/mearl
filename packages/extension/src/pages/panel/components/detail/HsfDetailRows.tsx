import { FC } from 'react';
import { Loader } from 'lucide-react';
import { t } from '../../utils/i18n';
import { DetailRow } from './DetailRow';

interface HsfDetailRowsProps {
  visible?: boolean;
  loading?: boolean;
  displayValue?: string;
  maintainerDisplayValue?: string;
  maintainerTitle?: string;
  onOpenHsf?: () => void;
  interfaceLabel?: string;
  maintainerLabel?: string;
  viewTitle?: string;
}

export const HsfDetailRows: FC<HsfDetailRowsProps> = ({
  visible,
  loading,
  displayValue,
  maintainerDisplayValue,
  maintainerTitle,
  onOpenHsf,
  interfaceLabel,
  maintainerLabel,
  viewTitle,
}) => {
  if (!visible) {
    return null;
  }

  const viewButtonClassName = `px-2 py-0.5 rounded transition-colors text-2xs min-w-11.25 h-5 flex items-center justify-center ${
    displayValue
      ? 'cursor-pointer bg-bg-secondary text-text-primary hover:bg-bg-hover'
      : 'cursor-default opacity-0 pointer-events-none'
  }`;

  return (
    <>
      <div className="flex items-center py-1.5 border-b border-border text-xs">
        <div className="w-32 font-medium text-text-secondary text-xxs shrink-0">
          {interfaceLabel ?? t('hsfInterface')}
        </div>
        <div className="flex-1 flex items-center gap-2">
          <div
            className="flex-1 break-all line-clamp-2 relative text-text-primary text-xxs"
            title={loading ? t('loading') : displayValue || '-'}
          >
            {loading ? <Loader size={12} className="animate-spin" /> : displayValue || '-'}
          </div>
          <button
            onClick={displayValue ? onOpenHsf : undefined}
            disabled={!displayValue}
            title={viewTitle ?? t('viewInHsfOps')}
            aria-hidden={!displayValue}
            className={viewButtonClassName}
          >
            {t('view')}
          </button>
        </div>
      </div>
      {maintainerDisplayValue && (
        <DetailRow
          label={maintainerLabel ?? t('hsfMaintainer')}
          value={
            <span title={maintainerTitle || maintainerDisplayValue}>{maintainerDisplayValue}</span>
          }
        />
      )}
    </>
  );
};
