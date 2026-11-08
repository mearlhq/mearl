import { useState } from 'react';
import { ShieldCheck, Globe } from 'lucide-react';
import { t } from '../panel/utils/i18n';
import {
  normalizeDomainInputToOrigin,
  grantAgentOriginPermission,
} from '../../shared/proxyPermissions';

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
  const [status, setStatus] = useState<'idle' | 'requesting' | 'browser-denied' | 'error' | 'done'>(
    'idle',
  );

  const handleAllow = async () => {
    const origin = normalizeDomainInputToOrigin(domain);
    if (!origin) {
      onDecision(false);
      return;
    }
    setStatus('requesting');
    onBusyChange?.(true);
    // Chrome requires the foreground confirmation click to request host permissions.
    try {
      const chromeGranted = await grantPermission(origin);
      if (!chromeGranted) {
        setStatus('browser-denied');
        return;
      }
      setStatus('done');
      onDecision(true, origin);
    } catch {
      setStatus('error');
    } finally {
      onBusyChange?.(false);
    }
  };

  const handleDeny = () => {
    onDecision(false);
  };

  return (
    <div className="flex min-h-0 max-h-full w-full max-w-95 flex-col">
      <div className="min-h-0 space-y-4 overflow-y-auto p-3 pb-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-blue-500 shrink-0" />
          <h1 className="text-sm font-semibold text-text-primary">{t('agentPermRequestTitle')}</h1>
        </div>

        <p className="text-xs text-text-secondary leading-relaxed">{t('agentPermRequestDesc')}</p>

        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-secondary border border-border">
          <Globe className="w-4 h-4 text-text-secondary shrink-0" />
          <span className="text-sm font-medium text-text-primary break-all">{domain}</span>
        </div>

        {status === 'browser-denied' && (
          <p className="text-xs text-red-500 mb-3">{t('agentPermRequestBrowserDenied')}</p>
        )}

        {status === 'error' && (
          <p role="alert" className="text-xs text-red-500">
            {t('agentPermRequestFailed')}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2 px-3 pb-3">
        <button
          onClick={handleDeny}
          disabled={status === 'requesting' || status === 'done'}
          className="flex-1 text-xs px-4 py-2 rounded border border-border bg-bg-primary text-text-secondary hover:bg-bg-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {t('agentPermRequestDeny')}
        </button>
        <button
          onClick={handleAllow}
          disabled={status === 'requesting' || status === 'done'}
          className="flex-1 text-xs px-4 py-2 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {status === 'requesting' ? '...' : t('agentPermRequestAllow')}
        </button>
      </div>
    </div>
  );
}
