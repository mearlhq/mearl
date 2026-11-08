import { DomainPermissionPrompt } from './DomainPermissionPrompt';

export function PermissionRequest() {
  const params = new URLSearchParams(window.location.search);
  const domain = params.get('domain') ?? '';
  const requestId = params.get('requestId') ?? '';
  if (!domain || !requestId) return null;

  return (
    <div className="flex h-dvh items-center justify-center overflow-hidden bg-bg-primary px-2">
      <DomainPermissionPrompt
        domain={domain}
        onDecision={(granted, origin) => {
          chrome.runtime.sendMessage(
            { type: 'permission_decision', requestId, granted, origin },
            () => {
              void chrome.runtime.lastError;
              window.close();
            },
          );
        }}
      />
    </div>
  );
}
