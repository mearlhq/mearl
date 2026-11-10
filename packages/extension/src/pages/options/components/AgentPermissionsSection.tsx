import { FC, useEffect, useState, useRef } from 'react';
import { Globe, X } from 'lucide-react';
import { t } from '../../panel/utils/i18n';
import { showToast } from '../../panel/utils/toast';
import { Button } from './Button';
import { validateInstallationOrigin } from '@mearl/preset/installation';
import { BROWSER_REQUEST_UI_CHANGED } from '../../../shared/browserRequestUi';
import {
  DEFAULT_AGENT_ORIGINS,
  formatOriginHost,
  normalizeDomainInputToOrigin,
  getAllStoredAgentOrigins,
  getAgentAllowAllDomains,
  getDisabledBuiltinOrigins,
  requestAgentAllDomainsPermission,
  requestAgentOriginPermission,
  setAgentAllowAllDomains,
  setStoredAgentOrigins,
  setDisabledBuiltinOrigins,
} from '../../../shared/proxyPermissions';

const BUILTIN_ORIGINS = new Set(DEFAULT_AGENT_ORIGINS);
const isBuiltinOrigin = (origin: string) => BUILTIN_ORIGINS.has(origin);

const AgentPermissionsSection: FC = () => {
  const [preset, setPreset] = useState<{ id: string; revision: string; origins: string[] } | null>(
    null,
  );
  const [presetBusy, setPresetBusy] = useState(false);
  const presetRead = useRef(0);
  const refreshPreset = async () => {
    const read = ++presetRead.current;
    const result = await chrome.runtime.sendMessage({
      action: 'browserUiService',
      data: { operation: 'presetPermissions' },
    });
    const data = result?.data;
    if (read !== presetRead.current) return;
    if (
      result?.success &&
      typeof data?.presetId === 'string' &&
      typeof data.revision === 'string' &&
      Array.isArray(data.origins) &&
      data.origins.length <= 64 &&
      Array.isArray(data.pending)
    ) {
      setPreset(
        data.pending.length
          ? {
              id: data.presetId,
              revision: data.revision,
              origins: data.origins.map(validateInstallationOrigin),
            }
          : null,
      );
    } else setPreset(null);
  };
  const handlePresetGrant = async () => {
    if (!preset || presetBusy) return;
    const origins = preset.origins;
    const saved = chrome.runtime.sendMessage({
      action: 'browserUiService',
      data: { operation: 'authorizePreset', presetId: preset.id, revision: preset.revision },
    });
    // Start both operations in the click gesture; saving survives the popup closing.
    const request = new Promise<boolean>((resolve, reject) =>
      chrome.permissions.request({ origins }, granted => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(granted);
      }),
    );
    setPresetBusy(true);
    try {
      const [result, granted] = await Promise.all([saved, request]);
      if (!result?.success) throw new Error(result?.error || 'Preset authorization failed');
      await Promise.all([refreshPreset(), refreshDomains()]);
      if (!granted) throw new Error('Permission denied');
    } catch {
      showToast(t('agentPermissionsGrantFailed'), 'error');
    } finally {
      setPresetBusy(false);
    }
  };
  const [allDomains, setAllDomains] = useState<string[]>([]);
  const [allowAllDomains, setAllowAllDomains] = useState<boolean | null>(null);
  const [allDomainsChanging, setAllDomainsChanging] = useState(false);
  const [disabledBuiltins, setDisabledBuiltins] = useState<Set<string>>(new Set());
  const [domainInput, setDomainInput] = useState('');
  const [domainGrantStatus, setDomainGrantStatus] = useState<'idle' | 'granting' | 'failed'>(
    'idle',
  );

  const refreshDomains = async () => {
    try {
      const [stored, disabled, allowAll] = await Promise.all([
        getAllStoredAgentOrigins(),
        getDisabledBuiltinOrigins(),
        getAgentAllowAllDomains(),
      ]);
      setAllDomains(stored);
      setDisabledBuiltins(new Set(disabled));
      setAllowAllDomains(allowAll);
      void refreshPreset().catch(() => {});
    } catch {
      showToast(t('agentPermissionsGrantFailed'), 'error');
    }
  };

  useEffect(() => {
    void refreshDomains();
    const refresh = () => {
      void refreshPreset().catch(() => {});
    };
    const message = (value: { action?: string }) => {
      if (value?.action === BROWSER_REQUEST_UI_CHANGED) refresh();
    };
    const added = chrome.permissions.onAdded as
      chrome.events.Event<(permissions: chrome.permissions.Permissions) => void> | undefined;
    const removed = chrome.permissions.onRemoved as
      chrome.events.Event<(permissions: chrome.permissions.Permissions) => void> | undefined;
    chrome.runtime.onMessage?.addListener(message);
    added?.addListener(refresh);
    removed?.addListener(refresh);
    chrome.storage.onChanged?.addListener(refresh);
    return () => {
      ++presetRead.current;
      chrome.runtime.onMessage?.removeListener(message);
      added?.removeListener(refresh);
      removed?.removeListener(refresh);
      chrome.storage.onChanged?.removeListener(refresh);
    };
  }, []);

  const handleToggleAllDomains = async () => {
    if (allowAllDomains === null || allDomainsChanging) return;

    const nextEnabled = !allowAllDomains;
    setAllDomainsChanging(true);
    setAllowAllDomains(nextEnabled);
    try {
      const saved = setAgentAllowAllDomains(nextEnabled);
      const request = nextEnabled ? requestAgentAllDomainsPermission() : Promise.resolve(true);
      const [, granted] = await Promise.all([saved, request]);
      if (!granted) showToast(t('agentPermissionsAllDomainsFailed'), 'error');
    } catch {
      await refreshDomains();
      showToast(t('agentPermissionsAllDomainsFailed'), 'error');
    } finally {
      setAllDomainsChanging(false);
    }
  };

  const handleGrantDomain = async () => {
    const origin = normalizeDomainInputToOrigin(domainInput);
    if (!origin) {
      setDomainGrantStatus('failed');
      return;
    }

    setDomainGrantStatus('granting');
    try {
      const saved = chrome.runtime.sendMessage({
        action: 'browserUiService',
        data: { operation: 'authorizeOrigin', origin },
      });
      const request = requestAgentOriginPermission(origin);
      const [result, granted] = await Promise.all([saved, request]);
      if (!result?.success) throw new Error(result?.error || 'Domain authorization failed');
      setDomainGrantStatus(granted ? 'idle' : 'failed');
      setDomainInput('');
      await refreshDomains();
    } catch {
      setDomainGrantStatus('failed');
    }
  };

  const handleDeleteCustomDomain = async (origin: string) => {
    try {
      const current = await getAllStoredAgentOrigins();
      await setStoredAgentOrigins(current.filter(item => item !== origin));
      await refreshDomains();
    } catch {
      showToast(t('agentPermissionsRevokeFailed'), 'error');
    }
  };

  const handleToggleBuiltinDomain = async (origin: string) => {
    try {
      const currentDisabled = await getDisabledBuiltinOrigins();
      const isCurrentlyDisabled = currentDisabled.includes(origin);
      const updatedDisabled = isCurrentlyDisabled
        ? currentDisabled.filter(item => item !== origin)
        : [...currentDisabled, origin];
      await setDisabledBuiltinOrigins(updatedDisabled);
      await refreshDomains();
    } catch {
      showToast(t('agentPermissionsRevokeFailed'), 'error');
    }
  };

  // Split domains: builtin first, then custom
  const builtinDomains = allDomains.filter(isBuiltinOrigin);
  const customDomains = allDomains.filter(origin => !isBuiltinOrigin(origin));

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <Globe className="w-3.5 h-3.5 text-text-secondary" />
          <h3 className="text-xs font-medium text-text-primary">{t('agentPermissions')}</h3>
        </div>
        <Button
          onClick={handleToggleAllDomains}
          variant={allowAllDomains ? 'primary' : 'secondary'}
          size="sm"
          className="shrink-0"
          aria-pressed={allowAllDomains === true}
        >
          {t('agentPermissionsAllDomains')}
        </Button>
      </div>
      <p
        className={`text-xs text-text-secondary mt-1 ${allowAllDomains === false ? 'mb-2.5' : ''}`}
      >
        {t('agentPermissionsDesc')}
      </p>

      {preset && (
        <div className="my-2.5 rounded border border-border p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span>{t('presetPermissionsRequired', preset.id)}</span>
            <Button onClick={handlePresetGrant} disabled={presetBusy} size="sm">
              {t('presetPermissionsGrant')}
            </Button>
          </div>
          <p className="mt-1.5 max-h-24 overflow-auto break-all text-text-secondary">
            {preset.origins.join(', ')}
          </p>
        </div>
      )}

      {allowAllDomains === false && (
        <>
          <div className="flex flex-wrap gap-1.5 mb-2.5">
            {builtinDomains.map(origin => {
              const disabled = disabledBuiltins.has(origin);
              return (
                <span
                  key={origin}
                  onClick={() => handleToggleBuiltinDomain(origin)}
                  title={disabled ? t('agentPermissionsEnable') : t('agentPermissionsDisable')}
                  className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded cursor-pointer select-none transition-colors ${
                    disabled
                      ? 'bg-gray-50 dark:bg-gray-900/20 text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-700 line-through opacity-60 hover:opacity-80'
                      : 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/40'
                  }`}
                >
                  {formatOriginHost(origin)}
                  <span className="opacity-50">{t('agentPermissionsBuiltIn')}</span>
                </span>
              );
            })}

            {customDomains.map(origin => (
              <span
                key={origin}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800"
              >
                {formatOriginHost(origin)}
                <button
                  onClick={() => handleDeleteCustomDomain(origin)}
                  className="opacity-60 hover:opacity-100 ml-0.5"
                  title={t('agentPermissionsRevoke')}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={domainInput}
              onChange={e => {
                setDomainInput(e.target.value);
                setDomainGrantStatus('idle');
              }}
              onKeyDown={e => e.key === 'Enter' && domainInput.trim() && handleGrantDomain()}
              placeholder={t('agentPermissionsInputPlaceholder')}
              className="flex-1 text-xs bg-bg-primary border border-border rounded px-3 py-1.5 text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-blue-400"
            />
            <button
              onClick={handleGrantDomain}
              disabled={!domainInput.trim() || domainGrantStatus === 'granting'}
              className="text-xs px-3 py-1.5 rounded border border-border bg-bg-primary text-text-primary hover:border-blue-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {domainGrantStatus === 'granting' ? '...' : t('agentPermissionsGrant')}
            </button>
          </div>
          {domainGrantStatus === 'failed' && (
            <p className="text-xs text-red-500 mt-1.5">{t('agentPermissionsGrantFailed')}</p>
          )}
        </>
      )}
    </div>
  );
};

export default AgentPermissionsSection;
