import { FC } from 'react';
import { ExternalLink } from 'lucide-react';
import { CapturedRequest } from '../../types';
import { getCurrentLanguage } from '../../utils/i18n';
import { browserRequestUiLink, browserUiText } from '@mearl/preset/bundles';
import { useBrowserRequestUi } from '../../hooks/useBrowserRequestUi';
import { resolveRequestVersion } from '../../utils/requestVersion';

interface RequestApiLinkProps {
  request: CapturedRequest;
}

export const RequestApiLink: FC<RequestApiLinkProps> = ({ request }) => {
  const { definition } = useBrowserRequestUi();
  if (!definition || request.source === 'requests') {
    return <>{request.apiName}</>;
  }

  const apiOverviewUrl = browserRequestUiLink(
    definition,
    request.apiName,
    resolveRequestVersion(request),
  );

  const handleClick = () => {
    window.open(apiOverviewUrl, '_blank');
  };

  return (
    <span
      onClick={handleClick}
      className="cursor-pointer border-b border-dashed border-text-secondary hover:border-solid inline-flex items-center gap-1"
      title={browserUiText(definition.apiLink.title, getCurrentLanguage())}
    >
      {request.apiName}
      <ExternalLink className="w-3 h-3 opacity-60" />
    </span>
  );
};
