import { DomainPermissionPrompt } from './DomainPermissionPrompt';
import { PresetPermissionPrompt } from './PresetPermissionPrompt';
import { PRESET_PERMISSION_REVISION_PARAM } from '../../shared/permissionRequest';

export function PermissionRequest() {
  const params = new URLSearchParams(window.location.search);
  const revision = params.get(PRESET_PERMISSION_REVISION_PARAM);
  const domain = params.get('domain') ?? '';
  const requestId = params.get('requestId') ?? '';
  if (!revision && (!domain || !requestId)) return null;

  return (
    <div className="flex h-dvh items-center justify-center overflow-hidden bg-bg-primary px-2">
      {revision ? (
        <PresetPermissionPrompt revision={revision} />
      ) : (
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
      )}
    </div>
  );
}
