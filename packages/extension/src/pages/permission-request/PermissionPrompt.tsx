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
  onDecision,
  onBusyChange,
}: PermissionPromptProps) {
  const [status, setStatus] = useState<'idle' | 'requesting' | 'browser-denied' | 'error' | 'done'>(
    'idle',
  );
  const busy = status === 'requesting' || status === 'done';

  const handleAllow = async () => {
    if (!requestPermission || busy) return;
    setStatus('requesting');
    onBusyChange?.(true);
    // Chrome requires the foreground confirmation click to request host permissions.
    try {
      if (!(await requestPermission())) {
        setStatus('browser-denied');
        return;
      }
      setStatus('done');
      onDecision(true);
    } catch {
      setStatus('error');
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
      {status === 'browser-denied' && (
        <p role="alert" className="shrink-0 px-3 pb-3 text-xs text-red-500">
          {t('agentPermRequestBrowserDenied')}
        </p>
      )}
      {status === 'error' && (
        <p role="alert" className="shrink-0 px-3 pb-3 text-xs text-red-500">
          {t('agentPermRequestFailed')}
        </p>
      )}
      <div className="flex shrink-0 gap-2 px-3 pb-3">
        <button
          type="button"
          onClick={() => onDecision(false)}
          disabled={busy}
          className="flex-1 text-xs px-4 py-2 rounded border border-border bg-bg-primary text-text-secondary hover:bg-bg-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {dismissLabel}
        </button>
        <button
          type="button"
          onClick={() => void handleAllow()}
          disabled={busy || !requestPermission}
          className="flex-1 text-xs px-4 py-2 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {status === 'requesting' ? '...' : allowLabel}
        </button>
      </div>
    </div>
  );
}
