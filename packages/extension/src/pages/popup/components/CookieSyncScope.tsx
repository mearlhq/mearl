import { useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Plus, X } from 'lucide-react';
import { normalizeDomainInputToOrigin, type CookieCopyScope } from '@mearl/browser-core';
import { clsx } from 'clsx';
import { t } from '../../panel/utils/i18n';

const COOKIE_SYNC_SCOPE_STORAGE_KEY = 'mearl.browserManager.cookieSyncScope';

export interface CookieSyncSelection {
  includeMearlServices: boolean;
  domains: string[];
}

export const DEFAULT_COOKIE_SYNC_SELECTION: CookieSyncSelection = {
  includeMearlServices: true,
  domains: [],
};

function normalizeDomainInput(input: string): string {
  const value = input.trim();
  if (!value) throw new Error('empty');
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
  const hostname = url.hostname.toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!hostname) throw new Error('hostname');
  return hostname;
}

function normalizeStoredSelection(value: unknown): CookieSyncSelection | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CookieSyncSelection>;
  if (typeof candidate.includeMearlServices !== 'boolean' || !Array.isArray(candidate.domains)) {
    return null;
  }
  const domains: string[] = [];
  for (const domain of candidate.domains) {
    if (typeof domain !== 'string') continue;
    try {
      const normalized = normalizeDomainInput(domain);
      if (!domains.includes(normalized)) domains.push(normalized);
    } catch {
      // Ignore stale invalid entries while retaining the rest of the selection.
    }
  }
  return { includeMearlServices: candidate.includeMearlServices, domains };
}

export function readCookieSyncSelection(): CookieSyncSelection {
  try {
    const stored = window.localStorage.getItem(COOKIE_SYNC_SCOPE_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_COOKIE_SYNC_SELECTION };
    return normalizeStoredSelection(JSON.parse(stored)) ?? { ...DEFAULT_COOKIE_SYNC_SELECTION };
  } catch {
    return { ...DEFAULT_COOKIE_SYNC_SELECTION };
  }
}

export function persistCookieSyncSelection(selection: CookieSyncSelection): void {
  try {
    window.localStorage.setItem(COOKIE_SYNC_SCOPE_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // The current interaction still works when extension-origin storage is unavailable.
  }
}

export function cookieSyncSelectionToPayload(selection: CookieSyncSelection): CookieCopyScope {
  return {
    ...(selection.includeMearlServices ? { presets: ['mearl-services' as const] } : {}),
    ...(selection.domains.length > 0 ? { domains: selection.domains } : {}),
  };
}

export function cookieSyncPayloadToSelection(value: unknown): CookieSyncSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const scope = value as Partial<CookieCopyScope>;
  if (
    (scope.presets !== undefined && !Array.isArray(scope.presets)) ||
    (scope.domains !== undefined && !Array.isArray(scope.domains))
  ) {
    return null;
  }
  return normalizeStoredSelection({
    includeMearlServices: scope.presets?.includes('mearl-services') ?? false,
    domains: scope.domains ?? [],
  });
}

export function cookieSyncSelectionSummary(selection: CookieSyncSelection): string {
  const parts: string[] = [];
  if (selection.includeMearlServices) parts.push(t('browserManagerCookiePresetMearl'));
  if (selection.domains.length === 1) parts.push(selection.domains[0]!);
  if (selection.domains.length > 1) {
    parts.push(t('browserManagerCookieSiteCount', String(selection.domains.length)));
  }
  return parts.join(' · ') || t('browserManagerCookieScopeNone');
}

export function isCookieSyncSelectionValid(selection: CookieSyncSelection): boolean {
  return selection.includeMearlServices || selection.domains.length > 0;
}

export function requestCookieSyncPermissions(selection: CookieSyncSelection): Promise<boolean> {
  const origins = selection.domains
    .map(domain => normalizeDomainInputToOrigin(domain))
    .filter((origin): origin is string => Boolean(origin));
  if (origins.length === 0) return Promise.resolve(true);
  return new Promise(resolve => {
    chrome.permissions.request({ origins }, granted => {
      resolve(!chrome.runtime.lastError && Boolean(granted));
    });
  });
}

interface CookieSyncOptionProps {
  enabled: boolean;
  value: CookieSyncSelection;
  onEnabledChange: (enabled: boolean) => void;
  onChange: (selection: CookieSyncSelection) => void;
  children?: ReactNode;
}

export function CookieSyncOption({
  enabled,
  value,
  onEnabledChange,
  onChange,
  children,
}: CookieSyncOptionProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="divide-y divide-border rounded border border-border bg-bg-primary px-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={t('browserManagerSyncLogin')}
        onClick={() => {
          if (enabled) setExpanded(false);
          onEnabledChange(!enabled);
        }}
        className="flex w-full min-w-0 cursor-pointer items-center justify-between gap-3 py-2 text-left"
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-2xs font-medium text-text-primary">
            {t('browserManagerSyncLogin')}
          </span>
          <span className="truncate text-3xs text-text-secondary/70">
            {t('browserManagerSyncLoginHint')}
          </span>
        </span>
        <span
          aria-hidden="true"
          className={clsx(
            'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
            enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600',
          )}
        >
          <span
            className={clsx(
              'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
              enabled ? 'translate-x-3.5' : 'translate-x-0.5',
            )}
          />
        </span>
      </button>

      {enabled && (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(current => !current)}
            className="flex w-full cursor-pointer items-center justify-between gap-3 py-2 text-left"
          >
            <span className="text-2xs font-medium text-text-primary">
              {t('browserManagerCookieScope')}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-2xs text-text-secondary">
              <span className="truncate">{cookieSyncSelectionSummary(value)}</span>
              <ChevronRight
                className={clsx(
                  'h-3.5 w-3.5 shrink-0 transition-transform',
                  expanded && 'rotate-90',
                )}
              />
            </span>
          </button>
          {expanded && (
            <div className="py-2.5">
              <CookieSyncScopeEditor value={value} onChange={onChange} compact />
            </div>
          )}
        </>
      )}
      {children && <div className="py-2.5">{children}</div>}
    </div>
  );
}

interface CookieSyncScopeEditorProps {
  value: CookieSyncSelection;
  onChange: (selection: CookieSyncSelection) => void;
  compact?: boolean;
}

export function CookieSyncScopeEditor({
  value,
  onChange,
  compact = false,
}: CookieSyncScopeEditorProps) {
  const [domainInput, setDomainInput] = useState('');
  const [domainError, setDomainError] = useState<string | null>(null);
  const [currentDomain, setCurrentDomain] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then(tabs => {
        if (!active) return;
        const url = tabs[0]?.url;
        if (!url) return;
        try {
          const domain = normalizeDomainInput(url);
          setCurrentDomain(domain);
        } catch {
          setCurrentDomain(null);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const addDomains = (input: string) => {
    const candidates = input.split(/[\s,;]+/).filter(Boolean);
    if (candidates.length === 0) return;
    try {
      const domains = [...value.domains];
      for (const candidate of candidates) {
        const normalized = normalizeDomainInput(candidate);
        if (!domains.includes(normalized)) domains.push(normalized);
      }
      onChange({ ...value, domains });
      setDomainInput('');
      setDomainError(null);
    } catch {
      setDomainError(t('browserManagerCookieDomainInvalid'));
    }
  };

  const removeDomain = (domain: string) => {
    onChange({ ...value, domains: value.domains.filter(item => item !== domain) });
  };

  if (compact) {
    return (
      <div className="space-y-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <label className="flex min-w-0 cursor-pointer items-center gap-2 text-left">
            <input
              type="checkbox"
              checked={value.includeMearlServices}
              onChange={() =>
                onChange({ ...value, includeMearlServices: !value.includeMearlServices })
              }
              className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded accent-blue-600"
            />
            <span className="shrink-0 text-2xs font-medium text-text-primary">
              {t('browserManagerCookiePresetMearl')}
            </span>
            <span className="truncate text-3xs text-text-secondary">
              {t('browserManagerCookiePresetMearlHint')}
            </span>
          </label>
          {currentDomain && !value.domains.includes(currentDomain) && (
            <button
              type="button"
              onClick={() => addDomains(currentDomain)}
              className="shrink-0 cursor-pointer text-3xs text-blue-600 hover:underline dark:text-blue-400"
            >
              {t('browserManagerCookieCurrentSite', currentDomain)}
            </button>
          )}
        </div>

        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2">
          <span className="shrink-0 text-2xs font-medium text-text-primary">
            {t('browserManagerCookieOtherSites')}
          </span>
          <input
            value={domainInput}
            onChange={event => {
              setDomainInput(event.target.value);
              setDomainError(null);
            }}
            onKeyDown={event => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              addDomains(domainInput);
            }}
            placeholder={t('browserManagerCookieDomainPlaceholder')}
            className="min-w-0 flex-1 rounded border border-border bg-bg-primary px-2 py-1 font-mono text-2xs text-text-primary outline-none transition-colors placeholder:font-sans placeholder:text-text-secondary/60 focus:border-blue-500"
          />
          <button
            type="button"
            disabled={!domainInput.trim()}
            onClick={() => addDomains(domainInput)}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-border bg-bg-primary px-2 py-1 text-2xs text-text-secondary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('browserManagerCookieAdd')}
          </button>
          {value.domains.length > 0 && (
            <div className="col-start-2 col-end-4 flex flex-wrap gap-1">
              {value.domains.map(domain => (
                <span
                  key={domain}
                  className="flex min-w-0 items-center gap-1 rounded bg-bg-secondary px-1.5 py-0.5 font-mono text-3xs text-text-primary"
                >
                  <span className="max-w-52 truncate" title={domain}>
                    {domain}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeDomain(domain)}
                    className="cursor-pointer text-text-secondary transition-colors hover:text-red-500"
                    title={t('delete')}
                    aria-label={`${t('delete')} ${domain}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {domainError && (
            <div className="col-start-2 col-end-4 text-3xs text-red-500">{domainError}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <button
        type="button"
        role="checkbox"
        aria-checked={value.includeMearlServices}
        onClick={() => onChange({ ...value, includeMearlServices: !value.includeMearlServices })}
        className="flex w-full cursor-pointer items-center gap-2 rounded border border-border bg-bg-primary px-2.5 py-2 text-left transition-colors hover:bg-bg-hover/60"
      >
        <span
          className={clsx(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
            value.includeMearlServices
              ? 'border-blue-600 bg-blue-600 text-white'
              : 'border-border bg-bg-primary text-transparent',
          )}
        >
          <Check className="h-3 w-3" />
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-medium text-text-primary">
            {t('browserManagerCookiePresetMearl')}
          </span>
          <span className="mt-0.5 block text-3xs text-text-secondary">
            {t('browserManagerCookiePresetMearlHint')}
          </span>
        </span>
      </button>

      <div className="rounded border border-border bg-bg-primary p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-text-primary">
            {t('browserManagerCookieOtherSites')}
          </span>
          {currentDomain && !value.domains.includes(currentDomain) && (
            <button
              type="button"
              onClick={() => addDomains(currentDomain)}
              className="flex cursor-pointer items-center gap-1 rounded bg-blue-600/10 px-1.5 py-0.5 text-3xs text-blue-600 transition-colors hover:bg-blue-600/15 dark:text-blue-400"
            >
              <Plus className="h-3 w-3" />
              {t('browserManagerCookieCurrentSite', currentDomain)}
            </button>
          )}
        </div>

        {value.domains.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {value.domains.map(domain => (
              <span
                key={domain}
                className="flex min-w-0 items-center gap-1 rounded bg-bg-secondary px-1.5 py-0.5 font-mono text-3xs text-text-primary"
              >
                <span className="max-w-52 truncate" title={domain}>
                  {domain}
                </span>
                <button
                  type="button"
                  onClick={() => removeDomain(domain)}
                  className="cursor-pointer text-text-secondary transition-colors hover:text-red-500"
                  title={t('delete')}
                  aria-label={`${t('delete')} ${domain}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="mt-2 flex gap-1.5">
          <input
            value={domainInput}
            onChange={event => {
              setDomainInput(event.target.value);
              setDomainError(null);
            }}
            onKeyDown={event => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              addDomains(domainInput);
            }}
            placeholder={t('browserManagerCookieDomainPlaceholder')}
            className="min-w-0 flex-1 rounded border border-border bg-bg-secondary/40 px-2 py-1.5 font-mono text-xs text-text-primary outline-none transition-colors placeholder:font-sans placeholder:text-text-secondary/60 focus:border-blue-500"
          />
          <button
            type="button"
            disabled={!domainInput.trim()}
            onClick={() => addDomains(domainInput)}
            className="flex cursor-pointer items-center gap-1 rounded border border-border bg-bg-primary px-2 text-2xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('browserManagerCookieAdd')}
          </button>
        </div>
        <div
          className={clsx('mt-1 text-3xs', domainError ? 'text-red-500' : 'text-text-secondary')}
        >
          {domainError ?? t('browserManagerCookieDomainHint')}
        </div>
      </div>

      <p className="text-3xs text-text-secondary">{t('browserManagerCookieOverwriteHint')}</p>
    </div>
  );
}
