import { useEffect, useReducer, useState } from 'react';
import { Globe } from 'lucide-react';
import { validateInstallationOrigin } from '@mearl/preset/installation';
import { BROWSER_REQUEST_UI_CHANGED } from '../../shared/browserRequestUi';
import { t } from '../panel/utils/i18n';
import { PermissionPrompt } from './PermissionPrompt';

interface PresetPermissions {
  presetId: string;
  pending: string[];
}

export function PresetPermissionPrompt({ revision }: { revision: string }) {
  const [state, setState] = useState<PresetPermissions | 'loading' | 'changed' | 'error'>(
    'loading',
  );
  const [refreshVersion, refresh] = useReducer((version: number) => version + 1, 0);

  useEffect(() => {
    const onPresetChanged = (message: { action?: string }) => {
      if (message?.action === BROWSER_REQUEST_UI_CHANGED) refresh();
    };
    chrome.runtime.onMessage.addListener(onPresetChanged);
    window.addEventListener('focus', refresh);
    return () => {
      chrome.runtime.onMessage.removeListener(onPresetChanged);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'browserUiService',
          data: { operation: 'presetPermissions' },
        });
        if (!active) return;
        const data = response?.data;
        if (!response?.success) throw new Error('Preset permissions unavailable');
        if (data?.revision !== revision) {
          setState('changed');
          return;
        }
        if (
          typeof data.presetId !== 'string' ||
          !Array.isArray(data.pending) ||
          data.pending.length > 64
        )
          throw new Error('Invalid preset permissions');
        setState({
          presetId: data.presetId,
          pending: data.pending.map(validateInstallationOrigin),
        });
      } catch {
        if (active) setState('error');
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [revision, refreshVersion]);

  const preset = typeof state === 'object' ? state : undefined;
  const request = preset?.pending.length
    ? async () => {
        if (!(await chrome.permissions.request({ origins: preset.pending }))) return false;
        try {
          const result = await chrome.runtime.sendMessage({
            action: 'browserUiService',
            data: { operation: 'authorizePreset', presetId: preset.presetId, revision },
          });
          if (
            !result?.success ||
            result.data?.revision !== revision ||
            result.data?.pending?.length !== 0
          )
            throw new Error('Preset permissions were not saved');
          return true;
        } catch (error) {
          refresh();
          throw error;
        }
      }
    : undefined;

  let description = t('presetPermissionPromptDesc', String(preset?.pending.length ?? 0));
  if (state === 'loading') description = t('loading');
  if (state === 'changed') description = t('presetPermissionPromptChanged');
  if (state === 'error') description = t('agentPermRequestFailed');
  if (preset && !preset.pending.length) description = t('presetPermissionPromptReady');

  return (
    <PermissionPrompt
      key={typeof state === 'string' ? state : revision}
      title={preset ? t('presetPermissionsRequired', preset.presetId) : t('agentPermRequestTitle')}
      description={description}
      allowLabel={t('presetPermissionsGrant')}
      dismissLabel={t('cancel')}
      requestPermission={request}
      onDecision={() => window.close()}
    >
      {!!preset?.pending.length && (
        <ul
          aria-label={t('presetPermissionPromptSites', String(preset.pending.length))}
          className="divide-y divide-border rounded-lg border border-border bg-bg-secondary"
        >
          {preset.pending.map(origin => (
            <li key={origin} className="flex items-start gap-2 px-3 py-2">
              <Globe
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-secondary"
              />
              <span className="min-w-0 break-all text-xs text-text-primary">{origin}</span>
            </li>
          ))}
        </ul>
      )}
    </PermissionPrompt>
  );
}
