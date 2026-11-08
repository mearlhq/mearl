import { FC } from 'react';
import { ExternalLink } from 'lucide-react';
import { browserUiText } from '@mearl/preset/bundles';
import { getCurrentLanguage } from '../../utils/i18n';
import { useBrowserUiSettings } from '../../utils/browserUiSettings';
import { browserUiLink } from '../../../../shared/browserUiSettings';

interface EagleeyeTraceidLinkProps {
  traceid: string;
  timestampMs: number; // 请求时间（毫秒）
}

export const EagleeyeTraceidLink: FC<EagleeyeTraceidLinkProps> = ({ traceid, timestampMs }) => {
  const link = useBrowserUiSettings().linkTemplates?.trace;
  const url = link && Number.isFinite(timestampMs) ? browserUiLink(link.template, { traceId: traceid, startTime: timestampMs - 60 * 60 * 1000, endTime: timestampMs + 60 * 60 * 1000 }) : undefined;
  const handleClick = url ? () => { window.open(url, '_blank'); } : undefined;

  return (
    <span
      onClick={handleClick}
      className={url ? 'cursor-pointer border-b border-dashed border-text-secondary hover:border-solid inline-flex items-center gap-1' : undefined}
      title={url && link ? browserUiText(link.title, getCurrentLanguage()) : undefined}
    >
      {traceid}
      {url && <ExternalLink className="w-3 h-3 opacity-60" />}
    </span>
  );
};
