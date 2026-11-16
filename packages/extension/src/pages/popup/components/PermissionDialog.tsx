import { useEffect, useRef, useState } from 'react';
import { DomainPermissionPrompt } from '../../permission-request/DomainPermissionPrompt';
import { PermissionModal } from '../../permission-request/PermissionPrompt';
import { t } from '../../panel/utils/i18n';
import {
  POPUP_PERMISSION_REQUEST,
  POPUP_PERMISSION_CANCEL,
  POPUP_PERMISSION_ALLOW,
  type DomainPermissionDecision,
} from '../../../shared/permissionRequest';

interface PendingPermission {
  requestId: string;
  domain: string;
  respond: (decision: DomainPermissionDecision) => void;
}

/** Only the toolbar popup handles these requests; tabs and side panels remain passive. */
export function PermissionDialog() {
  const [pending, setPending] = useState<PendingPermission[]>([]);
  const busyRequest = useRef<string | null>(null);

  useEffect(() => {
    if (!chrome.extension?.getViews({ type: 'popup' }).includes(window)) return;
    const listener = (
      message: { type?: string; requestId?: string; domain?: string },
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: DomainPermissionDecision) => void,
    ) => {
      if (sender.id !== chrome.runtime.id || sender.tab || typeof message?.requestId !== 'string')
        return;
      if (message.type === POPUP_PERMISSION_CANCEL) {
        setPending(current => current.filter(item => item.requestId !== message.requestId));
        return;
      }
      if (message.type !== POPUP_PERMISSION_REQUEST || typeof message.domain !== 'string') return;
      const { requestId, domain } = message;
      setPending(current => [...current, { requestId, domain, respond: sendResponse }]);
      // Keep the response channel open until the user decides or the popup closes.
      return true;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const request = pending[0];
  const grant = async (requestId: string, allSites: boolean) => {
    const result: DomainPermissionDecision = await chrome.runtime.sendMessage({
      type: POPUP_PERMISSION_ALLOW,
      requestId,
      ...(allSites ? { allSites: true } : {}),
    });
    if (result.error) throw new Error(result.error);
    return result.granted;
  };
  const decide = (granted: boolean, origin?: string) => {
    if (!request) return;
    request.respond({ granted, origin });
    setPending(current => current.filter(item => item.requestId !== request.requestId));
  };

  return (
    <PermissionModal
      isOpen={Boolean(request)}
      onClose={() => {
        if (busyRequest.current !== request?.requestId) decide(false);
      }}
      ariaLabel={t('agentPermRequestTitle')}
    >
      {request && (
        <DomainPermissionPrompt
          key={request.requestId}
          domain={request.domain}
          grantPermission={() => grant(request.requestId, false)}
          grantAllDomains={() => grant(request.requestId, true)}
          onDecision={decide}
          onBusyChange={busy => {
            if (busy) busyRequest.current = request.requestId;
            else if (busyRequest.current === request.requestId) busyRequest.current = null;
          }}
        />
      )}
    </PermissionModal>
  );
}
