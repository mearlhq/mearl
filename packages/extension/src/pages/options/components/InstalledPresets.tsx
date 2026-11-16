import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BROWSER_REQUEST_UI_CHANGED } from '../../../shared/browserRequestUi';
import type { InstallationOpening } from '../../../shared/installation';
import { PRESET_MANAGEMENT_ACTION, type InstalledPreset } from '../../../shared/presetAutoUpdate';
import { t } from '../../panel/utils/i18n';
import { showToast } from '../../panel/utils/toast';
import { Installation } from '../../installation/Installation';
import { Button } from './Button';

async function request<T>(
  operation: 'status' | 'install-available' | 'install',
  options?: { inline: true; presetId?: string },
): Promise<T> {
  const response = await chrome.runtime.sendMessage({
    action: PRESET_MANAGEMENT_ACTION,
    operation,
    ...options,
  });
  if (!response?.success) throw new Error(response?.error);
  return response.data;
}

function installationDialogContainer() {
  // The settings iframe shares the extension origin with the Popup.
  try {
    return window.parent.document.body ?? document.body;
  } catch {
    return document.body;
  }
}

export function InstalledPresets() {
  const [presets, setPresets] = useState<InstalledPreset[]>();
  const [canInstall, setCanInstall] = useState(false);
  const [installationSession, setInstallationSession] = useState<string>();
  const [opening, setOpening] = useState(false);
  const installTrigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let mounted = true;
    let version = 0;
    const refresh = () => {
      const current = ++version;
      void request<InstalledPreset[]>('status').then(
        result => {
          if (mounted && current === version && Array.isArray(result)) setPresets(result);
        },
        () => {},
      );
    };
    const onMessage = (message: { action?: string }) => {
      if (message?.action === BROWSER_REQUEST_UI_CHANGED) refresh();
    };
    refresh();
    window.addEventListener('focus', refresh);
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      mounted = false;
      window.removeEventListener('focus', refresh);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  const isEmpty = presets?.length === 0;
  useEffect(() => {
    if (!isEmpty) return;
    let active = true;
    void request<boolean>('install-available').then(
      available => {
        if (active) setCanInstall(available === true);
      },
      () => {
        if (active) setCanInstall(false);
      },
    );
    return () => {
      active = false;
    };
  }, [isEmpty]);

  useLayoutEffect(() => {
    if (installationSession) return;
    installTrigger.current?.focus({ preventScroll: true });
    installTrigger.current = null;
  }, [installationSession]);

  async function openInstall(trigger: HTMLButtonElement, presetId?: string) {
    setOpening(true);
    try {
      const opened = await request<InstallationOpening>('install', {
        inline: true,
        ...(presetId ? { presetId } : {}),
      });
      if (opened.inline) {
        installTrigger.current = trigger;
        setInstallationSession(opened.session);
      }
    } catch (error) {
      const unavailable =
        error instanceof Error && error.message.includes('INSTALLATION_PRESET_UNAVAILABLE');
      if (!unavailable) console.warn('[Installation] Could not open the preset selector', error);
      showToast(
        unavailable ? t('presetManagementNoPresets') : t('presetManagementOpenFailed'),
        'error',
      );
    } finally {
      setOpening(false);
    }
  }

  if (!presets || (isEmpty && !canInstall && !installationSession)) return null;
  const installer =
    installationSession &&
    createPortal(
      <Installation
        key={installationSession}
        embeddedSession={installationSession}
        onClose={() => {
          setInstallationSession(undefined);
          void request<InstalledPreset[]>('status')
            .then(result => {
              if (Array.isArray(result)) setPresets(result);
            })
            .catch(() => {});
        }}
      />,
      installationDialogContainer(),
    );
  const installButton = (
    <Button
      type="button"
      size="sm"
      className="min-w-14 shrink-0"
      disabled={opening}
      loading={opening}
      onClick={event => void openInstall(event.currentTarget, presets[0]?.id)}
    >
      {isEmpty ? t('presetManagementInstall') : t('presetManagementUpdate')}
    </Button>
  );
  return (
    <>
      <section id="installed-presets" className="space-y-3" aria-label={t('presetManagementTitle')}>
        {(isEmpty ? [undefined] : presets).map((preset, index) => (
          <div
            key={preset?.nativeRevision ?? preset?.browserRevision ?? 'empty'}
            className="flex items-center justify-between gap-2 rounded border border-border bg-bg-secondary p-4"
          >
            <div className="min-w-0 flex-1">
              <h2 className="mb-1.5 truncate text-xs font-medium text-text-primary">
                {index === 0 ? t('presetManagementTitle') : preset?.id}
              </h2>
              {preset ? (
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
              ) : (
                <p className="text-xs text-text-secondary">{t('presetManagementDescription')}</p>
              )}
            </div>
            {index === 0 && installButton}
          </div>
        ))}
      </section>
      {installer}
    </>
  );
}
