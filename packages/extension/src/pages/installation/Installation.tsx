import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, ShieldCheck, Copy, RefreshCw } from 'lucide-react';
import { t } from '../panel/utils/i18n';
import {
  INSTALLATION_ACTION,
  INSTALLATION_CONNECT_URL,
  setupPresetCommand,
  type InstallationView,
} from '../../shared/installation';

async function call(
  operation: 'inspect' | 'install' | 'retry' | 'confirmSource',
  session: string,
  authorize = false,
  replaceSkills?: string[],
): Promise<InstallationView> {
  const result = await chrome.runtime.sendMessage({
    action: INSTALLATION_ACTION,
    operation,
    session,
    ...(authorize ? { authorize } : {}),
    ...(replaceSkills?.length ? { replaceSkills } : {}),
  });
  if (!result?.success) {
    console.warn('[Installation] Request failed', {
      operation,
      error: result?.error || 'INSTALLATION_UNAVAILABLE',
    });
    throw new Error(result?.error || 'INSTALLATION_UNAVAILABLE');
  }
  return result.data;
}

function installationError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (
    text.includes('SESSION_EXPIRED') ||
    text.includes('SOURCE_EXPIRED') ||
    text.includes('CATALOG_CHANGED') ||
    text.includes('SELECTION_CHANGED')
  )
    return t('presetInstallSessionExpired');
  if (text.includes('SOURCE_DENIED') || text.includes('SOURCE_CHANGED'))
    return t('presetInstallSourceChanged');
  if (text.includes('INVALID_PRESET_INSTALLATION_REQUEST'))
    return t('presetInstallHostUpdateRequired');
  if (text.includes('INVALID_SKILL_REPLACEMENT_SELECTION'))
    return t('presetInstallReplacementChanged');
  if (text.includes('PERMISSION')) return t('presetInstallPermissionFailed');
  if (text.includes('BUNDLE_INTEGRITY')) return t('presetInstallIntegrityFailed');
  if (
    text.includes('BUNDLE_INVALID') ||
    text.includes('PRESET_INVALID') ||
    text.includes('BUNDLE_INCOMPATIBLE') ||
    text.includes('PRESET_INCOMPATIBLE')
  )
    return t('presetInstallConfigurationFailed');
  return t('presetInstallFailed');
}

function componentReason(reason: string): string {
  switch (reason) {
    case 'SKILL_NOT_INSTALLED':
    case 'PROVIDER_INSTALL_REQUIRED':
    case 'INSTALL_REQUIRED':
      return t('presetInstallComponentMissing');
    case 'SKILL_SOURCE_CONFLICT':
    case 'PROVIDER_SOURCE_CONFLICT':
      return t('presetInstallComponentConflict');
    case 'SKILL_PLUGIN_REGISTRATION_CONFLICT':
      return t('presetInstallComponentRegistrationConflict');
    case 'SKILL_PLUGIN_REGISTRATION_REQUIRED':
      return t('presetInstallComponentRegistrationPending');
    case 'PLUGIN_CATALOG_SYNC_REQUIRED':
      return t('presetInstallCatalogPending');
    case 'HOST_SYNC_REQUIRED':
      return t('presetInstallHostPending');
    default:
      return t('presetInstallComponentPending');
  }
}

export function Installation() {
  const session = new URLSearchParams(location.search).get('session') ?? '';
  const websiteSource = new URLSearchParams(location.search).get('source') === 'website';
  const [view, setView] = useState<InstallationView>();
  const [phase, setPhase] = useState<
    'loading' | 'source' | 'permission' | 'installing' | 'done' | 'error'
  >('loading');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [nativeSync, setNativeSync] = useState(false);
  const [confirmReplacement, setConfirmReplacement] = useState(false);
  const active = useRef(true);
  const generation = useRef(0);
  const busy = useRef(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const replacementConfirmation = useRef<HTMLDivElement>(null);
  const replacementButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmReplacement) replacementConfirmation.current?.focus();
    else replacementButton.current?.focus();
  }, [confirmReplacement]);

  const install = async (
    selected: InstallationView,
    authorize: boolean,
    retry = false,
    replaceSkills?: string[],
  ) => {
    if (busy.current) return;
    busy.current = true;
    setPhase('installing');
    setError('');
    setNativeSync(false);
    setConfirmReplacement(false);
    try {
      const result = await call(
        retry ? 'retry' : 'install',
        selected.session,
        authorize,
        replaceSkills,
      );
      if (active.current) {
        setView(result);
        setPhase(
          result.ready || result.browserReady || result.browserRequired === false
            ? 'done'
            : 'error',
        );
        if (!result.ready && !result.browserReady && result.browserRequired !== false)
          setError(t('presetInstallFailed'));
      }
    } catch (error) {
      if (active.current) {
        const needsNative =
          error instanceof Error && error.message.includes('NATIVE_SYNC_REQUIRED');
        setNativeSync(needsNative);
        setError(needsNative ? t('presetInstallNativeSync') : installationError(error));
        setPhase('error');
      }
    } finally {
      busy.current = false;
    }
  };
  const refresh = async () => {
    const turn = ++generation.current;
    setPhase('loading');
    setError('');
    setConfirmReplacement(false);
    try {
      const selected = await call('inspect', session);
      if (!active.current || turn !== generation.current) return;
      setView(selected);
      if (selected.needsSourceConfirmation) setPhase('source');
      else if (!selected.needsInstall) {
        setPhase(
          selected.ready || selected.browserReady || selected.browserRequired === false
            ? 'done'
            : 'error',
        );
        if (!selected.ready && !selected.browserReady && selected.browserRequired !== false)
          setError(t('presetInstallSessionExpired'));
      } else if (
        selected.sourceRequest ||
        selected.missingOrigins.length ||
        selected.missingAuthorization.length
      )
        setPhase('permission');
      else await install(selected, false);
    } catch (error) {
      if (!active.current || turn !== generation.current) return;
      let refreshError = error;
      if (
        error instanceof Error &&
        error.message.includes('SESSION_EXPIRED') &&
        !websiteSource &&
        !view?.sourceRequest
      ) {
        try {
          const result = await chrome.runtime.sendMessage({
            action: INSTALLATION_ACTION,
            operation: 'restart',
          });
          if (!result?.success || typeof result.data?.session !== 'string') {
            // A failed restart reports its own error independently of the expired session.
            // eslint-disable-next-line preserve-caught-error
            throw new Error(result?.error || 'INSTALLATION_UNAVAILABLE');
          }
          if (!active.current || turn !== generation.current) return;
          const url = new URL(location.href);
          url.searchParams.set('session', result.data.session);
          location.replace(url.href);
          return;
        } catch (failure) {
          refreshError = failure;
        }
      }
      if (active.current && turn === generation.current) {
        setError(installationError(refreshError));
        setPhase('error');
      }
    }
  };
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      generation.current++;
      window.clearTimeout(copyTimer.current);
    };
  }, [session]);

  const confirmSource = async (selected: InstallationView) => {
    if (busy.current) return;
    busy.current = true;
    setPhase('loading');
    setError('');
    try {
      const result = await call('confirmSource', selected.session);
      if (active.current) {
        setView(result);
        setPhase('permission');
      }
    } catch (error) {
      if (active.current) {
        setError(installationError(error));
        setPhase('source');
      }
    } finally {
      busy.current = false;
    }
  };
  const cancel = async () => {
    if (!view || busy.current) return;
    busy.current = true;
    try {
      const result = await chrome.runtime.sendMessage({
        action: INSTALLATION_ACTION,
        operation: 'cancel',
        session: view.session,
      });
      if (!result?.success) throw new Error(result?.error || 'INSTALLATION_UNAVAILABLE');
      window.close();
    } catch (error) {
      if (active.current) setError(installationError(error));
    } finally {
      busy.current = false;
    }
  };
  const allow = () => {
    if (!view || busy.current) return;
    setError('');
    const proceed = () =>
      view.needsSourceConfirmation ? confirmSource(view) : install(view, true);
    const retryPhase = view.needsSourceConfirmation ? 'source' : 'permission';
    if (!view.missingOrigins.length) {
      void proceed();
      return;
    }
    busy.current = true;
    // Invoke directly from this foreground click before awaiting any work.
    let request: Promise<boolean>;
    try {
      request = chrome.permissions.request({ origins: view.missingOrigins });
    } catch {
      busy.current = false;
      setError(t('presetInstallPermissionFailed'));
      return;
    }
    setPhase('installing');
    void request.then(
      granted => {
        busy.current = false;
        if (!active.current) return;
        if (!granted) {
          setError(t('presetInstallPermissionFailed'));
          setPhase(retryPhase);
          return;
        }
        return proceed();
      },
      () => {
        busy.current = false;
        if (active.current) {
          setError(t('presetInstallPermissionFailed'));
          setPhase(retryPhase);
        }
      },
    );
  };
  const copyCommand = async () => {
    if (!view) return;
    try {
      await navigator.clipboard.writeText(
        setupPresetCommand(view.source, /Win/.test(navigator.platform)),
      );
      if (!active.current) return;
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      if (active.current) setError(t('presetInstallCopyFailed'));
    }
  };
  const pending = view?.localComponentCount ?? 0;
  const allReady = view?.ready === true;
  const conflictingSkills =
    view?.localIssues
      ?.filter(issue =>
        [
          'SKILL_SOURCE_CONFLICT',
          'SKILL_PLUGIN_REGISTRATION_CONFLICT',
          'SKILL_PLUGIN_REGISTRATION_REQUIRED',
        ].includes(issue.reason),
      )
      .map(issue => issue.id) ?? [];
  return (
    <main className="h-dvh overflow-hidden bg-bg-primary text-text-primary p-3 sm:px-6 sm:py-8">
      <section className="mx-auto flex h-full max-w-xl flex-col gap-4">
        <div className="min-h-0 space-y-4 overflow-y-auto">
          <header className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-blue-500" />
            <h1 className="text-sm font-semibold">{t('presetInstallTitle')}</h1>
          </header>
          {view && (
            <div>
              <h2 className="text-base font-semibold">
                {view.needsSourceConfirmation ? t('presetInstallSourceTitle') : view.label}
              </h2>
              <p className="mt-1 text-xs text-text-secondary">{t('presetInstallDescription')}</p>
            </div>
          )}
          {view?.sourceRequest && !confirmReplacement && (
            <>
              <p className="text-xs leading-relaxed text-text-secondary">
                {t('presetInstallSourceNotice')}
              </p>
              <dl className="space-y-2 rounded border border-border bg-bg-secondary p-3 text-xs">
                <div>
                  <dt className="text-text-secondary">{t('presetInstallRequestingPage')}</dt>
                  <dd className="mt-1 break-all select-text">
                    {view.sourceRequest.requestingPage}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-secondary">{t('presetInstallCatalogSource')}</dt>
                  <dd className="mt-1 break-all select-text">{view.sourceRequest.catalogUrl}</dd>
                </div>
                {!view.needsSourceConfirmation && (
                  <div>
                    <dt className="text-text-secondary">{t('presetInstallPresetSource')}</dt>
                    <dd className="mt-1 break-all select-text">{view.source}</dd>
                  </div>
                )}
              </dl>
            </>
          )}
          {(phase === 'loading' || phase === 'installing') && (
            <p role="status" className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 className="w-4 h-4 animate-spin" />
              {phase === 'loading' ? t('presetInstallLoading') : t('presetInstallWorking')}
            </p>
          )}
          {phase === 'source' && (
            <>
              <p className="text-xs leading-relaxed text-text-secondary">
                {t('presetInstallReadSourceHint')}
              </p>
            </>
          )}
          {phase === 'permission' && view && (
            <>
              <p className="text-xs leading-relaxed text-text-secondary">
                {view.sourceRequest ? t('presetInstallConfirmHint') : t('presetInstallPermissions')}
              </p>
              <ul className="max-h-56 overflow-auto rounded border border-border bg-bg-secondary p-3 text-xs space-y-1">
                {[
                  ...new Set(
                    view.sourceRequest
                      ? view.origins
                      : [...view.missingOrigins, ...view.missingAuthorization],
                  ),
                ].map(origin => (
                  <li className="break-all" key={origin}>
                    {origin.replace(/^(?:https?|\*):\/\//, '').replace(/\/\*$/, '')}
                  </li>
                ))}
              </ul>
            </>
          )}
          {phase === 'done' && !confirmReplacement && (
            <div className="flex items-start gap-2 rounded border border-border bg-bg-secondary p-3">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-green-600" />
              <div>
                <p className="text-xs font-medium">
                  {allReady
                    ? t('presetInstallAllReady')
                    : view?.browserRequired === false
                      ? t('presetInstallLocalPendingTitle')
                      : t('presetInstallBrowserReady')}
                </p>
                <p className="mt-1 text-xs text-text-secondary">
                  {allReady
                    ? t('presetInstallComplete')
                    : view?.localStatus === 'pending'
                      ? t('presetInstallLocalIncomplete')
                      : pending
                        ? t('presetInstallLocalPending')
                        : t('presetInstallComplete')}
                </p>
              </div>
            </div>
          )}
          {phase === 'done' && !confirmReplacement && !allReady && !!view?.localIssues?.length && (
            <div className="space-y-2 text-xs">
              <p className="font-medium">{t('presetInstallPendingItems')}</p>
              <ul className="space-y-1 text-text-secondary">
                {view.localIssues.map((entry, index) => (
                  <li key={`${entry.id}:${index}`}>
                    <span className="font-mono">{entry.id}</span>：{componentReason(entry.reason)}
                  </li>
                ))}
              </ul>
              {view.localIssues.some(
                entry =>
                  entry.reason === 'SKILL_SOURCE_CONFLICT' ||
                  entry.reason === 'PROVIDER_SOURCE_CONFLICT',
              ) && <p className="text-text-secondary">{t('presetInstallConflictHint')}</p>}
            </div>
          )}
          {phase === 'done' && view?.localStatus === 'pending' && (
            <>
              {!confirmReplacement && (
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void install(view, true, true)}
                    className="rounded bg-blue-500 px-3 py-2 text-xs font-medium text-white hover:bg-blue-600"
                  >
                    {t('presetInstallLocalRetry')}
                  </button>
                  {conflictingSkills.length > 0 && (
                    <button
                      ref={replacementButton}
                      onClick={() => setConfirmReplacement(true)}
                      className="rounded border border-border bg-bg-secondary px-3 py-2 text-xs hover:bg-bg-primary"
                    >
                      {t('presetInstallReplaceSources')}
                    </button>
                  )}
                </div>
              )}
              {confirmReplacement && conflictingSkills.length > 0 && (
                <div
                  ref={replacementConfirmation}
                  tabIndex={-1}
                  role="alertdialog"
                  aria-labelledby="replace-skill-sources-title"
                  className="space-y-3 rounded border border-border bg-bg-secondary p-3 text-xs"
                >
                  <h2 id="replace-skill-sources-title" className="font-semibold">
                    {t('presetInstallReplaceTitle')}
                  </h2>
                  <p className="leading-relaxed text-text-secondary">
                    {t('presetInstallReplaceHint')}
                  </p>
                  <p className="break-all select-text text-text-secondary">{view.source}</p>
                  <ul className="max-h-40 space-y-1 overflow-auto font-mono">
                    {conflictingSkills.map(id => (
                      <li key={id}>{id}</li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void install(view, true, true, conflictingSkills)}
                      className="rounded bg-red-500 px-3 py-2 font-medium text-white hover:bg-red-600"
                    >
                      {t('presetInstallReplaceConfirm')}
                    </button>
                    <button
                      onClick={() => setConfirmReplacement(false)}
                      className="rounded border border-border bg-bg-primary px-3 py-2 hover:bg-bg-secondary"
                    >
                      {t('presetInstallCancel')}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          {((phase === 'done' && pending > 0 && !allReady && view?.localStatus !== 'pending') ||
            nativeSync) &&
            view && (
              <div className="space-y-2">
                <p className="text-xs text-text-secondary">{t('presetInstallSetupHint')}</p>
                <div className="flex items-start gap-2 rounded border border-border bg-bg-secondary p-2">
                  <code className="min-w-0 flex-1 break-all text-xs">
                    {setupPresetCommand(view.source, /Win/.test(navigator.platform))}
                  </code>
                  <button
                    onClick={() => void copyCommand()}
                    className="shrink-0 rounded border border-border bg-bg-primary p-1.5 text-text-secondary hover:text-text-primary"
                    title={t('presetInstallCopy')}
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
                {copied && (
                  <p role="status" className="text-xs text-green-600">
                    {t('presetInstallCopied')}
                  </p>
                )}
              </div>
            )}
          {error && (
            <p role="alert" className="text-xs leading-relaxed text-red-500">
              {error}
            </p>
          )}
          {(phase === 'error' || phase === 'done') && !confirmReplacement && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => void refresh()}
                className="flex items-center gap-1.5 rounded border border-border bg-bg-secondary px-3 py-1.5 text-xs hover:bg-bg-primary"
              >
                <RefreshCw className="w-3 h-3" />
                {t('presetInstallRefresh')}
              </button>
              <a
                className="text-xs text-blue-500 hover:underline"
                href={`${INSTALLATION_CONNECT_URL}#preset=${encodeURIComponent(view?.presetId ?? '')}`}
                target="_blank"
                rel="noreferrer"
              >
                {t('presetInstallGuide')}
              </a>
            </div>
          )}
        </div>
        {phase === 'source' && (
          <div className="flex shrink-0 gap-2">
            <button
              onClick={allow}
              className="rounded bg-blue-500 px-3 py-2 text-xs font-medium text-white hover:bg-blue-600"
            >
              {t('presetInstallReadSource')}
            </button>
            <button
              onClick={() => void cancel()}
              className="rounded border border-border bg-bg-secondary px-3 py-2 text-xs hover:bg-bg-primary"
            >
              {t('presetInstallCancel')}
            </button>
          </div>
        )}
        {phase === 'permission' && view && (
          <div className="flex shrink-0 gap-2">
            <button
              onClick={allow}
              className="rounded bg-blue-500 px-3 py-2 text-xs font-medium text-white hover:bg-blue-600"
            >
              {view.sourceRequest ? t('presetInstallConfirmOnce') : t('presetInstallAllow')}
            </button>
            {view.sourceRequest && (
              <button
                onClick={() => void cancel()}
                className="rounded border border-border bg-bg-secondary px-3 py-2 text-xs hover:bg-bg-primary"
              >
                {t('presetInstallCancel')}
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
