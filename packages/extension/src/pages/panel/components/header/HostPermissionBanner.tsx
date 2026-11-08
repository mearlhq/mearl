import { FC } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { t } from '../../utils/i18n';

interface HostPermissionBannerProps {
  host: string;
  onGrant: () => Promise<void>;
  onClose: () => void;
}

export const HostPermissionBanner: FC<HostPermissionBannerProps> = ({ host, onGrant, onClose }) => {
  return (
    <div className="px-3 py-2 border-b border-border bg-bg-secondary text-text-primary flex items-start justify-between gap-3">
      <div className="flex items-start gap-2 min-w-0">
        <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0">
          <div className="text-xs font-medium">{t('hostPermissionNoticeTitle')}</div>
          <div className="text-xs text-text-secondary break-all">
            {t('hostPermissionNoticeDesc', host)}
          </div>
        </div>
      </div>
      <div className="shrink-0 self-center flex items-center gap-1">
        <button
          onClick={() => void onGrant()}
          className="text-xs px-2 py-1 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/35 transition-colors cursor-pointer"
        >
          {t('hostPermissionGrant')}
        </button>
        <button
          onClick={onClose}
          className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          title={t('close')}
          aria-label={t('close')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
