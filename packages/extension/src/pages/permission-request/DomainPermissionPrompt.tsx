import { t } from '../panel/utils/i18n';
import {
  enableAgentAllDomains,
  normalizeDomainInputToOrigin,
  grantAgentOriginPermission,
} from '../../shared/proxyPermissions';
import { PermissionPrompt, PermissionSite } from './PermissionPrompt';

interface DomainPermissionPromptProps {
  domain: string;
  onDecision: (granted: boolean, origin?: string) => void;
  onBusyChange?: (busy: boolean) => void;
  grantPermission?: (origin: string) => Promise<boolean>;
  grantAllDomains?: () => Promise<boolean>;
}

export function DomainPermissionPrompt({
  domain,
  onDecision,
  onBusyChange,
  grantPermission = grantAgentOriginPermission,
  grantAllDomains = enableAgentAllDomains,
}: DomainPermissionPromptProps) {
  const origin = normalizeDomainInputToOrigin(domain);

  return (
    <PermissionPrompt
      title={t('agentPermRequestTitle')}
      description={t('agentPermRequestDesc')}
      allowLabel={t('agentPermRequestAllow')}
      requestPermission={() => {
        if (origin) return grantPermission(origin);
        onDecision(false);
        return Promise.resolve(false);
      }}
      requestAllSites={grantAllDomains}
      allSitesDeniedMessage={t('agentPermRequestAllBrowserDenied')}
      onDecision={granted => onDecision(granted, granted ? (origin ?? undefined) : undefined)}
      onBusyChange={onBusyChange}
    >
      <PermissionSite domain={domain} />
    </PermissionPrompt>
  );
}
