import { useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Loader2,
  PackagePlus,
  Copy,
  RefreshCw,
} from 'lucide-react';
import { clsx } from 'clsx';
import { browserUiText } from '@mearl/preset/bundles';
import { getCurrentLanguage, t } from '../panel/utils/i18n';
import { Modal } from '../panel/components/modal/Modal';
import {
  INSTALLATION_ACTION,
  setupPresetCommand,
  type InstallationPreview,
  type InstallationView,
} from '../../shared/installation';

async function call(
  operation: 'inspect' | 'install' | 'retry' | 'confirmSource' | 'selectPreset' | 'grant',
  session: string,
  {
    authorize,
    replaceSkills,
    presetId,
    origins,
  }: {
    authorize?: boolean;
    replaceSkills?: string[];
    presetId?: string;
    origins?: string[];
  } = {},
): Promise<InstallationView> {
  const result = await chrome.runtime.sendMessage({
    action: INSTALLATION_ACTION,
    operation,
    session,
    ...(presetId ? { presetId } : {}),
    ...(origins ? { origins } : {}),
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
  if (text === 'INSTALLATION_PERMISSION_RETRY') return t('presetInstallPermissionRetry');
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

export function Installation({
  embeddedSession,
  onClose,
}: { embeddedSession?: string; onClose?: () => void } = {}) {
  const session = embeddedSession ?? new URLSearchParams(location.search).get('session') ?? '';
  const source = new URLSearchParams(location.search).get('source');
  const explicitEntry = Boolean(embeddedSession) || source === 'website' || source === 'settings';
  const [view, setView] = useState<InstallationView>();
  const [preview, setPreview] = useState<InstallationPreview>();
  const [phase, setPhase] = useState<
    'loading' | 'source' | 'permission' | 'authorizing' | 'installing' | 'done' | 'error'
  >('loading');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [nativeSync, setNativeSync] = useState(false);
  const [confirmReplacement, setConfirmReplacement] = useState(false);
  const [switchingPreset, setSwitchingPreset] = useState(false);
  const [closing, setClosing] = useState(false);
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

  const showInstallationResult = (result: InstallationView) => {
    setView(result);
    const done = result.ready || result.browserReady || result.browserRequired === false;
    setPhase(done ? 'done' : 'error');
    if (!done) setError(t('presetInstallFailed'));
  };
  const showInstallationError = (error: unknown) => {
    const needsNative = error instanceof Error && error.message.includes('NATIVE_SYNC_REQUIRED');
    setNativeSync(needsNative);
    setError(needsNative ? t('presetInstallNativeSync') : installationError(error));
    setPhase('error');
  };
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
      const result = await call(retry ? 'retry' : 'install', selected.session, {
        authorize,
        replaceSkills,
        presetId: selected.presetId,
      });
      if (active.current) showInstallationResult(result);
    } catch (error) {
      if (active.current) showInstallationError(error);
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
        selected.presetChoices?.length ||
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
        !explicitEntry &&
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

  const previewSession =
    view?.needsInstall && !view.needsSourceConfirmation ? view.session : undefined;
  const previewSource = view?.source;
  const previewPresetId = view?.presetId;
  useEffect(() => {
    setPreview(undefined);
    if (!previewSession) return;
    let current = true;
    void chrome.runtime
      .sendMessage({
        action: INSTALLATION_ACTION,
        operation: 'preview',
        session: previewSession,
      })
      .then(result => {
        if (current && result?.success) setPreview(result.data);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [previewSession, previewSource, previewPresetId]);

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
  const choosePreset = async (presetId: string) => {
    if (!view || busy.current || presetId === view.presetId) return;
    busy.current = true;
    setSwitchingPreset(true);
    setError('');
    try {
      const result = await call('selectPreset', view.session, { presetId });
      if (active.current) {
        setPreview(undefined);
        setView(result);
      }
    } catch (error) {
      if (active.current) setError(installationError(error));
    } finally {
      busy.current = false;
      if (active.current) setSwitchingPreset(false);
    }
  };
  const cancel = async () => {
    if ((!view && !embeddedSession) || busy.current) return;
    busy.current = true;
    try {
      const result = await chrome.runtime.sendMessage({
        action: INSTALLATION_ACTION,
        operation: 'cancel',
        session: view?.session ?? session,
      });
      if (!embeddedSession) {
        if (!result?.success) throw new Error(result?.error || 'INSTALLATION_UNAVAILABLE');
        window.close();
      }
    } catch (error) {
      if (active.current && !embeddedSession) setError(installationError(error));
    } finally {
      if (active.current && embeddedSession) setClosing(true);
      else busy.current = false;
    }
  };
  const grantEmbedded = async (selected: InstallationView) => {
    busy.current = true;
    setPhase('authorizing');
    const source = selected.needsSourceConfirmation;
    try {
      const result = await call('grant', selected.session, {
        origins: selected.missingOrigins,
        presetId: source ? undefined : selected.presetId,
      });
      if (!active.current) return;
      if (source) {
        setView(result);
        setPhase('permission');
      } else {
        showInstallationResult(result);
      }
    } catch (error) {
      if (!active.current) return;
      if (source || (error instanceof Error && error.message.includes('PERMISSION'))) {
        setError(installationError(error));
        setPhase(source ? 'source' : 'permission');
      } else {
        showInstallationError(error);
      }
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
    if (embeddedSession) {
      void grantEmbedded(view);
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
    setPhase('authorizing');
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
  const purpose = preview?.purpose && browserUiText(preview.purpose, getCurrentLanguage());
  const capabilityCounts =
    preview && !purpose
      ? [
          preview.appProfileCount && t('presetInstallPreviewApps', String(preview.appProfileCount)),
          preview.packageCount && t('presetInstallPreviewPackages', String(preview.packageCount)),
          preview.skillCount && t('presetInstallPreviewSkills', String(preview.skillCount)),
          preview.providerCount &&
            t('presetInstallPreviewProviders', String(preview.providerCount)),
        ].filter(Boolean)
      : [];
  const showPreview = Boolean(previewSession && (purpose || capabilityCounts.length));
  const permissionOrigins =
    phase === 'permission' && view
      ? [...new Set([...view.missingOrigins, ...view.missingAuthorization])]
      : [];
  const sourceHost = view?.sourceRequest && new URL(view.sourceRequest.requestingPage).host;
  const presetChoices = view?.presetChoices ?? [];
  const showPresetSelector = phase === 'permission' && presetChoices.length > 1;
  let title = t('presetInstallTitle');
  if (view && !view.needsSourceConfirmation && !showPresetSelector)
    title = phase === 'done' ? view.label : t('presetInstallNamedTitle', view.label);
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
  const content = (
    <section
      className={clsx(
        'flex min-h-0 max-h-full w-full flex-col overflow-hidden bg-bg-primary',
        !embeddedSession && 'max-w-xl rounded-md border border-border shadow-xs dark:shadow-none',
      )}
    >
      <div className="min-h-0 space-y-3 overflow-y-auto p-4 sm:p-5">
        <header className="flex items-center gap-3">
          <div className="shrink-0 rounded bg-bg-hover p-2 text-accent-blue">
            <PackagePlus aria-hidden="true" className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1
              id="preset-install-title"
              className="break-words text-base font-semibold leading-snug"
            >
              {title}
            </h1>
            {sourceHost && (
              <p className="mt-1 break-all text-xs text-text-secondary">{sourceHost}</p>
            )}
          </div>
        </header>
        {showPresetSelector && view && (
          <div className="space-y-1.5">
            <h2 id="preset-install-choices" className="text-xs font-medium">
              {t('presetInstallChoose')}
            </h2>
            <div
              role="group"
              aria-labelledby="preset-install-choices"
              className="grid grid-cols-2 gap-2"
            >
              {presetChoices.map(({ id, label }) => {
                const selected = id === view.presetId;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={selected}
                    disabled={switchingPreset}
                    onClick={() => void choosePreset(id)}
                    className={clsx(
                      'flex min-h-9 min-w-0 cursor-pointer items-center justify-between gap-2 rounded border px-3 py-1.5 text-left text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent-blue disabled:cursor-wait disabled:opacity-60',
                      selected
                        ? 'border-accent-blue/60 bg-accent-blue/10 text-accent-blue'
                        : 'border-border bg-bg-secondary text-text-primary hover:bg-bg-hover',
                    )}
                  >
                    <span className="min-w-0 break-words">{label}</span>
                    <Check
                      aria-hidden="true"
                      className={clsx('size-3.5 shrink-0', !selected && 'invisible')}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {(showPresetSelector || showPreview) && (
          <div className={clsx(showPresetSelector && 'min-h-12')}>
            {showPreview && (
              <section aria-labelledby="preset-install-purpose" className="space-y-1.5">
                <h2 id="preset-install-purpose" className="text-xs font-semibold">
                  {t('presetInstallPurposeTitle')}
                </h2>
                {purpose ? (
                  <p className="break-words text-sm leading-relaxed text-text-secondary">
                    {purpose}
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm leading-relaxed text-text-secondary">
                    {capabilityCounts.map(content => (
                      <li key={content}>{content}</li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        )}
        {(phase === 'loading' || phase === 'authorizing' || phase === 'installing') && (
          <p role="status" className="flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" />
            {phase === 'loading'
              ? t('presetInstallLoading')
              : phase === 'authorizing'
                ? t('presetInstallAuthorizing')
                : t('presetInstallWorking')}
          </p>
        )}
        {phase === 'source' && (
          <p className="text-xs leading-relaxed text-text-secondary">
            {t('presetInstallReadSourceHint')}
          </p>
        )}
        {phase === 'permission' && view && (
          <>
            <p className="text-xs leading-relaxed text-text-secondary">
              {view.missingOrigins.length
                ? t('presetInstallPermissions')
                : t('presetInstallConfirmHint')}
            </p>
            {permissionOrigins.length > 0 && (
              <details className="group rounded border border-border bg-bg-secondary">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden">
                  {t('presetInstallSiteAccess', String(permissionOrigins.length))}
                  <ChevronDown
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 group-open:rotate-180"
                  />
                </summary>
                <ul className="max-h-36 space-y-1 overflow-auto border-t border-border px-3 py-2 text-xs">
                  {permissionOrigins.map(origin => (
                    <li className="break-all" key={origin}>
                      {origin}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
        {view?.sourceRequest && !confirmReplacement && (
          <details className="group text-xs text-text-secondary">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium hover:text-text-primary [&::-webkit-details-marker]:hidden">
              <ChevronDown
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 -rotate-90 group-open:rotate-0"
              />
              {t('presetInstallSourceTitle')}
            </summary>
            <dl className="mt-2 space-y-2 rounded border border-border bg-bg-secondary p-3">
              <div>
                <dt>{t('presetInstallRequestingPage')}</dt>
                <dd className="mt-1 break-all select-text text-text-primary">
                  {view.sourceRequest.requestingPage}
                </dd>
              </div>
              <div>
                <dt>{t('presetInstallCatalogSource')}</dt>
                <dd className="mt-1 break-all select-text text-text-primary">
                  {view.sourceRequest.catalogUrl}
                </dd>
              </div>
              {!view.needsSourceConfirmation && (
                <div>
                  <dt>{t('presetInstallPresetSource')}</dt>
                  <dd className="mt-1 break-all select-text text-text-primary">{view.source}</dd>
                </div>
              )}
            </dl>
          </details>
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
            <button
              type="button"
              onClick={() => {
                if (embeddedSession) {
                  void cancel();
                  return;
                }
                void chrome.tabs
                  .getCurrent()
                  .then(tab => {
                    if (tab?.id !== undefined) return chrome.tabs.remove(tab.id);
                    window.close();
                  })
                  .catch(() => window.close());
              }}
              className="rounded border border-border bg-bg-secondary px-3 py-1.5 text-xs hover:bg-bg-primary"
            >
              {t('close')}
            </button>
          </div>
        )}
      </div>
      {view && (phase === 'source' || phase === 'permission') && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-5">
          {(embeddedSession ||
            phase === 'source' ||
            view.sourceRequest ||
            presetChoices.length > 0) && (
            <button
              onClick={() => void cancel()}
              disabled={switchingPreset}
              className="min-h-8 rounded border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent-blue"
            >
              {t('presetInstallCancel')}
            </button>
          )}
          <button
            onClick={allow}
            disabled={switchingPreset}
            className="min-h-8 rounded border border-transparent bg-accent-blue px-3 py-1.5 text-xs font-medium text-white hover:brightness-90 focus-visible:ring-2 focus-visible:ring-accent-blue disabled:opacity-60 dark:border-accent-blue/40 dark:bg-accent-bg dark:text-text-primary dark:hover:brightness-125"
          >
            {phase === 'source'
              ? t('presetInstallReadSource')
              : view.missingOrigins.length
                ? t('presetInstallAllow')
                : t('presetInstallConfirmOnce')}
          </button>
        </div>
      )}
    </section>
  );
  return embeddedSession ? (
    <Modal
      isOpen={!closing}
      size="compact"
      topLayer
      ariaLabelledBy="preset-install-title"
      onClose={() => void cancel()}
      onExited={onClose}
    >
      {content}
    </Modal>
  ) : (
    <main className="flex h-dvh items-center justify-center overflow-hidden bg-bg-secondary p-4 text-text-primary sm:p-6">
      {content}
    </main>
  );
}
