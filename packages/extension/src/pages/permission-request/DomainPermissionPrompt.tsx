import { Globe } from 'lucide-react';
import { t } from '../panel/utils/i18n';
import {
  normalizeDomainInputToOrigin,
  grantAgentOriginPermission,
} from '../../shared/proxyPermissions';
import { PermissionPrompt } from './PermissionPrompt';

interface DomainPermissionPromptProps {
  domain: string;
  onDecision: (granted: boolean, origin?: string) => void;
  onBusyChange?: (busy: boolean) => void;
  grantPermission?: (origin: string) => Promise<boolean>;
}

export function DomainPermissionPrompt({
  domain,
  onDecision,
  onBusyChange,
  grantPermission = grantAgentOriginPermission,
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
      onDecision={granted => onDecision(granted, granted ? (origin ?? undefined) : undefined)}
      onBusyChange={onBusyChange}
    >
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-secondary border border-border">
        <Globe className="w-4 h-4 text-text-secondary shrink-0" />
        <span className="text-sm font-medium text-text-primary break-all">{domain}</span>
      </div>
    </PermissionPrompt>
  );
}
