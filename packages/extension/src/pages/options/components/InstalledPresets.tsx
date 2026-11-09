import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { PresetUninstallResult } from '@mearl/preset/installation';
import {
  PRESET_MANAGEMENT_ACTION,
  type InstalledPreset,
  type PresetAutoUpdateResult,
} from '../../../shared/presetAutoUpdate';
import { t } from '../../panel/utils/i18n';
import { showToast } from '../../panel/utils/toast';
import { Button } from './Button';

async function request<T>(operation: string, preset?: InstalledPreset): Promise<T> {
  const response = await chrome.runtime.sendMessage({
    action: PRESET_MANAGEMENT_ACTION,
    operation,
    ...(preset && {
      browserRevision: preset.browserRevision,
      nativeRevision: preset.nativeRevision,
    }),
  });
  if (!response?.success) throw new Error(response?.error);
  return response.data;
}

function showUpdateResult(result: PresetAutoUpdateResult | undefined) {
  switch (result?.status) {
    case 'current':
      return result.error
        ? showToast(t('presetInstallNativeSync'))
        : showToast(t('presetManagementCurrent'), 'info');
    case 'updated':
      return result.error
        ? showToast(t('presetInstallNativeSync'))
        : showToast(t('presetManagementUpdated'), 'success');
    case 'permission-required':
      return showToast(t('presetManagementPermission'));
    case 'waiting-native':
      return showToast(t('presetInstallNativeSync'));
    case 'untrusted':
      return showToast(t('presetManagementUpdateSource'));
    case 'skipped':
      return showToast(t('presetManagementRetry'));
    default:
      return showToast(t('presetManagementUpdateFailed'), 'error');
  }
}

function showUninstallResult({ ready, blocker }: PresetUninstallResult) {
  switch (blocker?.reason) {
    case 'browser-update-required':
      return showToast(t('presetManagementRemoveBrowserUpdate', blocker.browser), 'error');
    case 'browser-unavailable':
      return showToast(t('presetManagementRemoveBrowserReconnect', blocker.browser), 'error');
    case 'selection-changed':
      return showToast(t('presetManagementRemoveSelectionChanged'), 'error');
    default:
      return ready
        ? showToast(t('presetManagementRemoved'), 'success')
        : showToast(t('presetManagementRemovalPending'));
  }
}

export function InstalledPresets() {
  const [presets, setPresets] = useState<InstalledPreset[]>();
  const [installUrl, setInstallUrl] = useState<string>();
  const [selected, setSelected] = useState<InstalledPreset>();
  const [pending, setPending] = useState<{
    operation: 'update' | 'uninstall';
    preset?: InstalledPreset;
  }>();

  useEffect(() => {
    let active = true;
    void request<InstalledPreset[]>('status').then(
      result => {
        if (active && Array.isArray(result)) setPresets(result);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);

  const isEmpty = presets?.length === 0;
  useEffect(() => {
    if (!isEmpty) return;
    let active = true;
    void request<string | undefined>('install-url').then(
      url => {
        if (active) setInstallUrl(url);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [isEmpty]);

  async function manage(operation: 'update' | 'uninstall', preset?: InstalledPreset) {
    setPending({ operation, preset });
    setSelected(undefined);
    try {
      if (operation === 'update') {
        showUpdateResult(await request<PresetAutoUpdateResult | undefined>('update'));
      } else {
        showUninstallResult(await request<PresetUninstallResult>('uninstall', preset));
      }
    } catch {
      showToast(
        operation === 'update'
          ? t('presetManagementUpdateFailed')
          : t('presetManagementRemoveFailed'),
        'error',
      );
    } finally {
      const refreshed = await request<InstalledPreset[]>('status').catch(() => undefined);
      if (Array.isArray(refreshed)) setPresets(refreshed);
      setPending(undefined);
    }
  }

  if (!presets?.length) {
    if (!isEmpty || !installUrl) return null;
    return (
      <section
        id="installed-presets"
        aria-label={t('presetManagementTitle')}
        className="flex items-center justify-between gap-2 rounded border border-border bg-bg-secondary p-4"
      >
        <div className="min-w-0">
          <h2 className="mb-1.5 text-xs font-medium text-text-primary">
            {t('presetManagementTitle')}
          </h2>
          <p className="text-xs text-text-secondary">{t('presetManagementDescription')}</p>
        </div>
        <a
          href={installUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-14 shrink-0 rounded border border-border bg-bg-primary px-2 py-0.5 text-center text-xs text-text-primary transition-colors hover:border-blue-400"
        >
          {t('presetManagementInstall')}
        </a>
      </section>
    );
  }

  return (
    <section id="installed-presets" className="space-y-3" aria-label={t('presetManagementTitle')}>
      {presets.map((preset, index) => (
        <div
          key={preset.nativeRevision ?? preset.browserRevision}
          className="rounded border border-border bg-bg-secondary p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="mb-1.5 truncate text-xs font-medium text-text-primary">
                {index === 0 ? t('presetManagementTitle') : preset.id}
              </h2>
              <div className="flex items-baseline gap-x-1.5 text-xs text-text-secondary">
                {index === 0 && (
                  <span className="max-w-[50%] shrink-0 truncate" title={preset.id}>
                    {preset.id}
                  </span>
                )}
                {preset.version && <span className="shrink-0">v{preset.version}</span>}
                {preset.nativeRevision && (
                  <span className="min-w-0 truncate" title={t('presetManagementLocal')}>
                    {t('presetManagementLocal')}
                  </span>
                )}
                <span className="min-h-lh min-w-0 flex-1 truncate" title={preset.source}>
                  {preset.source}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
              {selected === preset ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    aria-label={t('presetManagementConfirm')}
                    title={t('presetManagementConfirm')}
                    className="relative min-w-14 text-red-600 dark:text-red-400"
                    onClick={() => void manage('uninstall', preset)}
                  >
                    <span className="invisible" aria-hidden="true">
                      {index === 0 ? t('presetManagementUpdate') : t('presetManagementRemove')}
                    </span>
                    <Check className="absolute inset-0 m-auto size-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    aria-label={t('cancel')}
                    title={t('cancel')}
                    className="relative min-w-14"
                    onClick={() => setSelected(undefined)}
                  >
                    <span className="invisible" aria-hidden="true">
                      {t('presetManagementRemove')}
                    </span>
                    <X className="absolute inset-0 m-auto size-4" aria-hidden="true" />
                  </Button>
                </>
              ) : (
                <>
                  {index === 0 && (
                    <Button
                      type="button"
                      size="sm"
                      className="min-w-14"
                      disabled={Boolean(pending || selected)}
                      loading={pending?.operation === 'update'}
                      onClick={() => void manage('update')}
                    >
                      {t('presetManagementUpdate')}
                    </Button>
                  )}
                  {preset.canUninstall && (
                    <Button
                      type="button"
                      size="sm"
                      className="min-w-14"
                      disabled={Boolean(pending || selected)}
                      loading={pending?.preset === preset}
                      onClick={() => setSelected(preset)}
                    >
                      {t('presetManagementRemove')}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
