import { useState, type ComponentProps, type ReactNode } from 'react';
import { Globe, ShieldCheck } from 'lucide-react';
import { Modal } from '../panel/components/modal/Modal';
import { t } from '../panel/utils/i18n';

export function PermissionModal(
  props: Pick<ComponentProps<typeof Modal>, 'isOpen' | 'onClose' | 'ariaLabel' | 'children'>,
) {
  return (
    <Modal
      {...props}
      size="default"
      contentStyle={{ maxWidth: 380, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto' }}
    />
  );
}

interface PermissionPromptProps {
  title: string;
  description: string;
  allowLabel: string;
  dismissLabel?: string;
  children?: ReactNode;
  requestPermission?: () => Promise<boolean>;
  requestAllSites?: () => Promise<boolean>;
  allSitesDeniedMessage?: string;
  onDecision: (granted: boolean) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  decisionErrorMessage?: string;
}

export function PermissionSite({ domain }: { domain: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-secondary border border-border">
      <Globe className="w-4 h-4 text-text-secondary shrink-0" aria-hidden="true" />
      <span className="text-sm font-medium text-text-primary break-all">{domain}</span>
    </div>
  );
}

export function PermissionPrompt({
  title,
  description,
  allowLabel,
  dismissLabel = t('agentPermRequestDeny'),
  children,
  requestPermission,
  requestAllSites,
  allSitesDeniedMessage = t('sitePermissionAllBrowserDenied'),
  onDecision,
  onBusyChange,
  decisionErrorMessage = t('agentPermRequestFailed'),
}: PermissionPromptProps) {
  const [status, setStatus] = useState<
    'idle' | 'requesting' | 'requesting-alternative' | 'dismissing' | 'done'
  >('idle');
  const [error, setError] = useState<string | null>(null);
  const busy = status !== 'idle';

  const handleAllow = async (useAlternative = false) => {
    const request = useAlternative ? requestAllSites : requestPermission;
    if (!request || busy) return;
    setError(null);
    setStatus(useAlternative ? 'requesting-alternative' : 'requesting');
    onBusyChange?.(true);
    // Chrome requires the foreground confirmation click to request host permissions.
    try {
      if (!(await request())) {
        setError(useAlternative ? allSitesDeniedMessage : t('agentPermRequestBrowserDenied'));
        setStatus('idle');
        return;
      }
      await finishDecision(true);
    } catch {
      setError(t('agentPermRequestFailed'));
      setStatus('idle');
    } finally {
      onBusyChange?.(false);
    }
  };

  const finishDecision = async (granted: boolean) => {
    try {
      await onDecision(granted);
      setStatus('done');
    } catch {
      setError(decisionErrorMessage);
      setStatus('idle');
    }
  };

  return (
    <div className="flex min-h-0 max-h-full w-full max-w-95 flex-col">
      <div className="shrink-0 space-y-4 px-3 pt-3 pb-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-blue-500 shrink-0" />
          <h1 className="min-w-0 text-sm font-semibold text-text-primary break-words">{title}</h1>
        </div>
        <p className="text-xs text-text-secondary leading-relaxed">{description}</p>
      </div>
      {children && <div className="min-h-0 overflow-y-auto px-3 mb-4">{children}</div>}
      {error && (
        <p role="alert" className="shrink-0 px-3 pb-3 text-xs text-red-500">
          {error}
        </p>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pb-3">
        {requestAllSites && (
          <button
            type="button"
            onClick={() => void handleAllow(true)}
            disabled={busy}
            className="mr-auto min-h-8 cursor-pointer rounded py-1 text-left text-xs font-medium text-text-secondary hover:text-accent-blue hover:underline focus-visible:ring-2 focus-visible:ring-accent-blue disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === 'requesting-alternative' ? '...' : t('agentPermRequestAllowAll')}
          </button>
        )}
        <div className={`flex min-w-0 gap-2 ${requestAllSites ? 'ml-auto' : 'flex-1 *:flex-1'}`}>
          <button
            type="button"
            onClick={() => {
              if (busy) return;
              setError(null);
              setStatus('dismissing');
              onBusyChange?.(true);
              void finishDecision(false).finally(() => onBusyChange?.(false));
            }}
            disabled={busy}
            className="min-w-16 text-xs px-3 py-2 rounded border border-border bg-bg-primary text-text-secondary hover:bg-bg-secondary focus-visible:ring-2 focus-visible:ring-accent-blue disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {dismissLabel}
          </button>
          <button
            type="button"
            onClick={() => void handleAllow()}
            disabled={busy || !requestPermission}
            className="text-xs px-3 py-2 rounded bg-blue-500 text-white hover:bg-blue-600 focus-visible:ring-2 focus-visible:ring-accent-blue disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {status === 'requesting' ? '...' : allowLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
