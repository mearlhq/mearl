import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { Link2 } from 'lucide-react';
import { BROWSER_REQUEST_UI_CHANGED } from '../../../shared/browserRequestUi';
import type { InstallationOpening } from '../../../shared/installation';
import { PRESET_MANAGEMENT_ACTION, type InstalledPreset } from '../../../shared/presetAutoUpdate';
import { t } from '../../panel/utils/i18n';
import { showToast } from '../../panel/utils/toast';
import { Installation } from '../../installation/Installation';
import { Button } from './Button';

async function request<T>(
  operation: 'status' | 'install-available' | 'install',
  options?: { inline: true; presetId?: string; source?: string },
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
  const [statusFailed, setStatusFailed] = useState(false);
  const [sourceDraft, setSourceDraft] = useState<string>();
  const [canInstall, setCanInstall] = useState(false);
  const [installation, setInstallation] = useState<{
    session: string;
    previousSource?: string;
  }>();
  const [opening, setOpening] = useState(false);
  const installTrigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let mounted = true;
    let version = 0;
    const refresh = () => {
      const current = ++version;
      void request<InstalledPreset[]>('status').then(
        result => {
          if (!mounted || current !== version) return;
          setStatusFailed(!Array.isArray(result));
          if (Array.isArray(result)) setPresets(result);
        },
        () => {
          if (mounted && current === version) setStatusFailed(true);
        },
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
    if (installation) return;
    installTrigger.current?.focus({ preventScroll: true });
    installTrigger.current = null;
  }, [installation]);

  async function openInstall(
    trigger: HTMLButtonElement,
    selection: { presetId?: string; source?: string },
  ) {
    setOpening(true);
    try {
      const opened = await request<InstallationOpening>('install', {
        inline: true,
        ...selection,
      });
      if (opened.inline) {
        installTrigger.current = trigger;
        setInstallation({ session: opened.session, previousSource: presets?.[0]?.source });
      }
    } catch (error) {
      const unavailable =
        error instanceof Error && error.message.includes('INSTALLATION_PRESET_UNAVAILABLE');
      const invalid =
        error instanceof Error && error.message.includes('INSTALLATION_SOURCE_DENIED');
      if (!unavailable && !invalid)
        console.warn('[Installation] Could not open the preset selector', error);
      const message = invalid
        ? t('presetManagementInvalidLink')
        : unavailable
          ? t('presetManagementNoPresets')
          : t('presetManagementOpenFailed');
      showToast(message, 'error');
    } finally {
      setOpening(false);
    }
  }

  const currentPreset = presets?.[0];
  const installedSource = currentPreset?.source;
  const source = sourceDraft ?? (installedSource?.startsWith('https://') ? installedSource : '');
  const sourceUrl = source.trim();
  const canSubmit = Boolean(sourceUrl || currentPreset || canInstall);
  const installer =
    installation &&
    createPortal(
      <Installation
        key={installation.session}
        embeddedSession={installation.session}
        onClose={() => {
          setInstallation(undefined);
          void request<InstalledPreset[]>('status')
            .then(result => {
              if (Array.isArray(result)) {
                setPresets(result);
                setStatusFailed(false);
                if (result[0]?.source !== installation.previousSource) setSourceDraft(undefined);
              }
            })
            .catch(() => {});
        }}
      />,
      installationDialogContainer(),
    );
  return (
    <>
      <section id="installed-presets" className="space-y-3" aria-label={t('presetManagementTitle')}>
        {(presets?.length ? presets : [undefined]).map((preset, index) => (
          <div
            key={index === 0 ? 'primary' : (preset?.nativeRevision ?? preset?.browserRevision)}
            className={clsx(
              'rounded border border-border bg-bg-secondary p-4',
              index === 0 &&
                'grid gap-2 sm:min-h-18 sm:grid-cols-[minmax(0,1fr)_minmax(0,3fr)] sm:items-center sm:gap-4',
            )}
          >
            <div
              className={clsx(
                'flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5',
                index === 0 && 'sm:flex-col sm:items-start',
              )}
            >
              <h2 className="shrink-0 text-xs font-medium text-text-primary">
                {index === 0 ? t('presetManagementTitle') : preset?.id}
              </h2>
              {preset ? (
                <div className="flex min-w-0 items-baseline gap-x-1.5 text-2xs text-text-secondary">
                  {index === 0 && (
                    <span className="min-w-0 truncate" title={preset.id}>
                      {preset.id}
                    </span>
                  )}
                  {preset.version && <span className="shrink-0">v{preset.version}</span>}
                  {preset.nativeRevision && (
                    <span className="min-w-0 truncate" title={t('presetManagementLocal')}>
                      {t('presetManagementLocal')}
                    </span>
                  )}
                  {index > 0 && (
                    <span className="min-w-0 flex-1 truncate" title={preset.source}>
                      {preset.source}
                    </span>
                  )}
                </div>
              ) : (
                <p role="status" className="min-w-0 break-words text-xs text-text-secondary">
                  {statusFailed
                    ? t('presetManagementStatusFailed')
                    : isEmpty
                      ? t('presetManagementDescription')
                      : t('loading')}
                </p>
              )}
            </div>
            {index === 0 && (
              <form
                className="flex min-w-0 items-stretch gap-2"
                onSubmit={event => {
                  event.preventDefault();
                  const trigger = event.currentTarget.querySelector<HTMLButtonElement>('button');
                  if (trigger && !opening && canSubmit)
                    void openInstall(
                      trigger,
                      sourceUrl
                        ? { source: sourceUrl }
                        : currentPreset
                          ? { presetId: currentPreset.id }
                          : {},
                    );
                }}
              >
                <div className="relative flex min-w-0 flex-1">
                  <Link2
                    aria-hidden="true"
                    className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-secondary"
                  />
                  <input
                    type="url"
                    maxLength={4096}
                    aria-label={t('presetManagementLink')}
                    placeholder={t('presetManagementLink')}
                    title={source || undefined}
                    className="min-w-0 flex-1 rounded border border-border bg-bg-primary pl-8 pr-2.5 text-xs text-text-primary focus-visible:outline focus-visible:outline-accent-blue"
                    value={source}
                    onChange={event => setSourceDraft(event.currentTarget.value)}
                  />
                </div>
                <Button
                  type="submit"
                  className="min-w-16 shrink-0"
                  disabled={opening || !canSubmit}
                  loading={opening}
                >
                  {currentPreset ? t('presetManagementUpdate') : t('presetManagementInstall')}
                </Button>
              </form>
            )}
          </div>
        ))}
      </section>
      {installer}
    </>
  );
}
