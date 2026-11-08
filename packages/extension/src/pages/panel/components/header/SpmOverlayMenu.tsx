import { FC } from 'react';
import { Table2 } from 'lucide-react';
import { clsx } from 'clsx';
import { t } from '../../utils/i18n';

export interface SpmOverlayMenuProps {
  showAllSpm: boolean;
  onToggleShowAllSpm: () => void;
}

export const SpmOverlayMenu: FC<SpmOverlayMenuProps> = ({ showAllSpm, onToggleShowAllSpm }) => {
  return (
    <button
      onClick={onToggleShowAllSpm}
      className={clsx(
        'px-1.5 py-0.5 rounded transition-colors cursor-pointer flex items-center justify-center gap-1 @[640px]:min-w-21',
        showAllSpm
          ? 'bg-purple-500/20 text-purple-600 hover:bg-purple-500/30 dark:text-purple-400'
          : 'bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
      )}
      title={t('showAllSpmNodesTooltip')}
      aria-pressed={showAllSpm}
    >
      <Table2 size={14} />
      <span className="hidden @[640px]:inline">{t('showAllSpmNodes')}</span>
    </button>
  );
};
