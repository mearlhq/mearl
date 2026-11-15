import { useState, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { t } from '../panel/utils/i18n';

interface PermissionPromptProps {
  title: string;
  description: string;
  allowLabel: string;
  dismissLabel?: string;
  children?: ReactNode;
  requestPermission?: () => Promise<boolean>;
  alternative?: {
    label: string;
    requestPermission: () => Promise<boolean>;
    browserDeniedMessage: string;
  };
  onDecision: (granted: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}

export function PermissionPrompt({
  title,
  description,
  allowLabel,
  dismissLabel = t('agentPermRequestDeny'),
  children,
  requestPermission,
  alternative,
  onDecision,
  onBusyChange,
}: PermissionPromptProps) {
  const [status, setStatus] = useState<'idle' | 'requesting' | 'requesting-alternative' | 'done'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const busy = status !== 'idle';

  const handleAllow = async (useAlternative = false) => {
    const request = useAlternative ? alternative?.requestPermission : requestPermission;
    if (!request || busy) return;
    setError(null);
    setStatus(useAlternative ? 'requesting-alternative' : 'requesting');
    onBusyChange?.(true);
    // Chrome requires the foreground confirmation click to request host permissions.
    try {
      if (!(await request())) {
        setError(
          useAlternative && alternative
            ? alternative.browserDeniedMessage
            : t('agentPermRequestBrowserDenied'),
        );
        setStatus('idle');
        return;
      }
      setStatus('done');
      onDecision(true);
    } catch {
      setError(t('agentPermRequestFailed'));
      setStatus('idle');
    } finally {
      onBusyChange?.(false);
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
        {alternative && (
          <button
            type="button"
            onClick={() => void handleAllow(true)}
            disabled={busy}
            className="mr-auto min-h-8 cursor-pointer rounded py-1 text-left text-xs font-medium text-text-secondary hover:text-accent-blue hover:underline focus-visible:ring-2 focus-visible:ring-accent-blue disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === 'requesting-alternative' ? '...' : alternative.label}
          </button>
        )}
        <div className={`flex min-w-0 gap-2 ${alternative ? 'ml-auto' : 'flex-1 *:flex-1'}`}>
          <button
            type="button"
            onClick={() => onDecision(false)}
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
