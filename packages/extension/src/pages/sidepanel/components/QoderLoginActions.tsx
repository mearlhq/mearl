import { useState } from 'react';
import { t } from '../../panel/utils/i18n';
import { requestNativeHost } from '../nativeHostRequest';

interface QoderLoginActionsProps {
  command?: string;
  hint?: string;
  onResend?: () => void;
  resendDisabled?: boolean;
}

const actionClass =
  'rounded-md border border-border bg-bg-primary px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-bg-hover disabled:opacity-60';

export function QoderLoginActions({
  command = 'qodercli',
  hint,
  onResend,
  resendDisabled,
}: QoderLoginActionsProps) {
  const [state, setState] = useState<'idle' | 'opening' | 'pending' | 'done' | 'failed'>('idle');

  const login = async () => {
    setState('opening');
    try {
      const { url } = await requestNativeHost('agent_chat_login_qoder');
      if (url) {
        await chrome.tabs.create({ url });
        setState('pending');
      } else {
        setState('done');
      }
    } catch {
      setState('failed');
    }
  };

  let status = hint;
  if (state === 'pending') status = t('agentChatQoderSignInPending');
  if (state === 'done') status = t('agentChatQoderSignInComplete');
  if (state === 'failed') status = t('agentChatQoderSignInFallback', `${command} login`);

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <span className={status ? 'min-w-0 grow basis-48 break-words text-xs leading-4' : 'sr-only'} role="status">
        {status}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {state !== 'done' ? (
          <button
            type="button"
            onClick={() => void login()}
            disabled={state === 'opening'}
            className={actionClass}
          >
            {t('agentChatQoderSignIn')}
          </button>
        ) : null}
        {onResend ? (
          <button
            type="button"
            onClick={onResend}
            disabled={resendDisabled || state === 'opening'}
            className={actionClass}
          >
            {t('agentChatResend')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
