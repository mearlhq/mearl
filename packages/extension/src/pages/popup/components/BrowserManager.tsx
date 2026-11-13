import { nativeHostServiceUpdateInfo } from '../../../shared/extensionServiceRequest';
import { ControlSessions, useControlSessions } from './ControlSessions';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  AlertTriangle,
  Check,
  ChevronRight,
  Cookie,
  ExternalLink,
  Laptop,
  Link2,
  LoaderCircle,
  LogOut,
  Power,
  QrCode,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import type {
  BrowserInfo,
  BrowserJsonValue,
  BrowserLaunchParams,
  ManagedBrowserInfo,
  BrowserProviderInputSchema,
  BrowserProviderObjectSchema,
  BrowserProviderLaunchForm,
  BrowserProviderLocales,
} from '@mearl/browser-core';
import { clsx } from 'clsx';
import { requestBrowserManager, type BrowserProviderSummary } from '../../../shared/browserManager';
import { Modal, ModalContent, ModalFooter, ModalHeader } from '../../panel/components/modal';
import {
  NativeHostUpdateGuide,
  type NativeHostUpdateInfo,
} from '../../panel/components/NativeHostUpdateGuide';
import { SearchableSelect } from '../../panel/components/SearchableSelect';
import { useAccounts } from '../../panel/hooks/useAccounts';
import { getCurrentLanguage, t } from '../../panel/utils/i18n';
import { showToast } from '../../panel/utils/toast';
import { generateQrCodeSvgMarkup } from '../../panel/utils/qrCode';
import {
  fetchAccountSso,
  isAccountLoginError,
  withAccountAutoLogin,
  type BrowserAccountItem,
} from '../../panel/utils/accounts';
import {
  CookieSyncOption,
  CookieSyncScopeEditor,
  cookieSyncPayloadToSelection,
  cookieSyncSelectionToPayload,
  isCookieSyncSelectionValid,
  persistCookieSyncSelection,
  readCookieSyncSelection,
  requestCookieSyncPermissions,
  type CookieSyncSelection,
} from './CookieSyncScope';

type LaunchMode = 'local' | `provider:${string}`;
type BrowserRowAction = 'start' | 'close' | 'cleanup' | 'detach' | 'sync' | 'access';

const PAIRING_REFRESH_INTERVAL_MS = 2_000;
const LOCAL_INSTANCE_NAME_MAX_LENGTH = 64;
const LOCAL_INSTANCE_NAME_SUFFIX_LENGTH = 6;
const LOCAL_INSTANCE_NAME_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomLocalInstanceName(account?: BrowserAccountItem): string {
  const suffix = Array.from(
    { length: LOCAL_INSTANCE_NAME_SUFFIX_LENGTH },
    () =>
      LOCAL_INSTANCE_NAME_CHARACTERS[
        Math.floor(Math.random() * LOCAL_INSTANCE_NAME_CHARACTERS.length)
      ],
  ).join('');
  const maxPrefixLength = LOCAL_INSTANCE_NAME_MAX_LENGTH - suffix.length - 1;
  const prefix = (account?.loginId.trim() || 'local')
    .replace(/[/\\\0\r\n]+/g, '-')
    .slice(0, maxPrefixLength)
    .replace(/-+$/g, '');
  return `${prefix || 'local'}-${suffix}`;
}

function isMissingProviderConfigurationError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /(?:api[ _-]?key|credential|token|configuration).*(?:missing|not found|required|configure)|(?:missing|not found|required|configure).*(?:api[ _-]?key|credential|token|configuration)/i.test(
    message,
  );
}

function providerText<Field extends string>(
  metadata: (BrowserProviderLocales<Field> & Partial<Record<Field, string>>) | null | undefined,
  field: Field,
): string | undefined {
  if (!metadata?.locales) return metadata?.[field];
  const locale = getCurrentLanguage().replaceAll('-', '_');
  const language = locale.split('_')[0].toLowerCase();
  return (
    metadata.locales[locale]?.[field] ??
    metadata.locales[locale.toLowerCase()]?.[field] ??
    metadata.locales[language]?.[field] ??
    metadata[field]
  );
}

function statusText(status: BrowserInfo['status']): string {
  switch (status) {
    case 'connected':
      return t('browserManagerStatusConnected');
    case 'pairing':
      return t('browserManagerStatusPairing');
    case 'running_disconnected':
      return t('browserManagerStatusConnecting');
    case 'stopped':
      return t('browserManagerStatusStopped');
  }
}

function BrowserBadge({ browser }: { browser: BrowserInfo }) {
  if (browser.type === 'regular') {
    return (
      <span className="rounded-sm bg-bg-hover px-1.5 py-0.5 text-3xs text-text-secondary">
        {t('browserManagerRegular')}
      </span>
    );
  }

  return (
    <>
      <span className="rounded-sm bg-blue-600/10 px-1.5 py-0.5 text-3xs text-blue-600 dark:text-blue-400">
        {browser.provider.name}
      </span>
      {browser.ownership && (
        <span className="rounded-sm bg-bg-hover px-1.5 py-0.5 text-3xs text-text-secondary">
          {browser.ownership === 'attached'
            ? t('browserManagerAttached')
            : t('browserManagerOwned')}
        </span>
      )}
      {browser.persistence === 'persistent' && browser.status === 'stopped' && (
        <span className="rounded-sm bg-bg-hover px-1.5 py-0.5 text-3xs text-text-secondary">
          {t('browserManagerProfile')}
        </span>
      )}
    </>
  );
}

interface BrowserDetailItemProps {
  label: string;
  value?: string;
  mono?: boolean;
  wide?: boolean;
  clamp?: boolean;
}

function BrowserDetailItem({
  label,
  value,
  mono = false,
  wide = false,
  clamp = false,
}: BrowserDetailItemProps) {
  if (!value) return null;

  return (
    <div className={clsx('min-w-0', wide && 'col-span-2')}>
      <div className="text-3xs text-text-secondary">{label}</div>
      <div
        className={clsx(
          'mt-0.5 select-text break-all text-2xs text-text-primary',
          mono && 'font-mono',
          clamp && 'line-clamp-2 leading-4',
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

const COMMON_BROWSER_DETAIL_KEYS = new Set(['headless', 'cdpPort', 'createdAt', 'copiedCookies']);

interface ProviderDetailItem {
  key: string;
  value: string;
  wide: boolean;
}

function providerDetailItems(details: BrowserInfo['details']): ProviderDetailItem[] {
  return Object.entries(details ?? {})
    .filter(([key]) => !COMMON_BROWSER_DETAIL_KEYS.has(key))
    .map(([key, value]) => {
      const formatted = typeof value === 'string' ? value : JSON.stringify(value);
      return {
        key,
        value: formatted,
        wide: typeof value === 'object' || /url/i.test(key) || formatted.length > 80,
      };
    })
    .sort((left, right) => Number(left.wide) - Number(right.wide));
}

function BrowserDetails({ browser }: { browser: BrowserInfo }) {
  const managed = browser.type === 'managed' ? browser : null;
  const details = browser.details;
  const source = browser.source;
  const sourceText =
    source?.kind === 'remote'
      ? [t('browserManagerSourceRemote'), source.connectorName || source.connectorId]
          .filter(Boolean)
          .join(' · ')
      : t('browserManagerSourceLocal');
  const transportText =
    browser.transport === 'extension'
      ? t('browserManagerTransportExtension')
      : browser.transport === 'cdp'
        ? t('browserManagerTransportCdp')
        : browser.transport === 'provider'
          ? t('browserManagerTransportProvider')
          : undefined;
  const providerName = managed?.provider.name;
  const createdAt = details?.createdAt ? new Date(details.createdAt).toLocaleString() : undefined;
  const copiedCookies = details?.copiedCookies
    ? `${details.copiedCookies.count} · ${details.copiedCookies.domains.join(', ')}`
    : undefined;
  const providerDetails = providerDetailItems(details);
  const providerReferences =
    browser.references?.filter(reference => reference.id !== browser.pairing?.code) ?? [];
  const compactProviderReferences = providerReferences.filter(
    reference => reference.id.length <= 80,
  );
  const wideProviderReferences = providerReferences.filter(reference => reference.id.length > 80);
  const pairingQrSvg = browser.pairing?.url
    ? generateQrCodeSvgMarkup(browser.pairing.url, { border: 0 })
    : '';

  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-2 border-t border-border bg-bg-secondary/50 px-11 py-2.5">
      {browser.pairing?.url && (
        <div className="col-span-2 flex items-center gap-3 rounded border border-border bg-bg-primary p-3">
          <div
            className="h-24 w-24 shrink-0 bg-white p-1 [&_svg]:h-full [&_svg]:w-full"
            dangerouslySetInnerHTML={{ __html: pairingQrSvg }}
          />
          <div className="min-w-0">
            <div className="text-xs font-medium text-text-primary">
              {providerText(browser.pairing, 'label') || t('browserManagerPairingScan')}
            </div>
            {browser.pairing.code && (
              <div className="mt-1 break-all font-mono text-2xs text-text-secondary">
                {t('browserManagerPairingCode')}: {browser.pairing.code}
              </div>
            )}
            <div className="mt-1 select-text break-all text-3xs text-text-secondary">
              {browser.pairing.url}
            </div>
          </div>
        </div>
      )}
      <BrowserDetailItem
        label={t('browserManagerBrowserId')}
        value={browser.browserId}
        mono={true}
        wide={true}
      />
      <BrowserDetailItem label={t('browserManagerSource')} value={sourceText} />
      <BrowserDetailItem label={t('browserManagerTransport')} value={transportText} />
      <BrowserDetailItem label={t('browserManagerProvider')} value={providerName} />
      <BrowserDetailItem
        label={t('browserManagerProviderVersion')}
        value={managed?.provider.version}
      />
      <BrowserDetailItem
        label={t('browserManagerPersistent')}
        value={
          managed
            ? managed.persistence === 'persistent'
              ? t('browserManagerYes')
              : t('browserManagerNo')
            : undefined
        }
      />
      <BrowserDetailItem
        label={t('browserManagerHeadless')}
        value={
          managed && typeof details?.headless === 'boolean'
            ? details?.headless
              ? t('browserManagerYes')
              : t('browserManagerNo')
            : undefined
        }
      />
      <BrowserDetailItem
        label={t('browserManagerCdpPort')}
        value={details?.cdpPort === undefined ? undefined : String(details.cdpPort)}
        mono={true}
      />
      {compactProviderReferences.map(reference => (
        <BrowserDetailItem
          key={`${reference.kind}:${reference.id}`}
          label={providerText(reference, 'label') || reference.kind}
          value={reference.id}
          mono
        />
      ))}
      {providerDetails
        .filter(item => !item.wide)
        .map(item => (
          <BrowserDetailItem key={item.key} label={item.key} value={item.value} />
        ))}
      <BrowserDetailItem label={t('browserManagerCreatedAt')} value={createdAt} />
      <BrowserDetailItem
        label={t('browserManagerExtensionVersion')}
        value={browser.extensionVersion}
      />
      <BrowserDetailItem
        label={t('browserManagerNativeHostVersion')}
        value={browser.nativeHostVersion}
      />
      {wideProviderReferences.map(reference => (
        <BrowserDetailItem
          key={`${reference.kind}:${reference.id}`}
          label={providerText(reference, 'label') || reference.kind}
          value={reference.id}
          mono
          wide
          clamp
        />
      ))}
      {providerDetails
        .filter(item => item.wide)
        .map(item => (
          <BrowserDetailItem key={item.key} label={item.key} value={item.value} wide clamp />
        ))}
      <BrowserDetailItem
        label={t('browserManagerCopiedCookies')}
        value={copiedCookies}
        wide={true}
      />
    </div>
  );
}

interface BrowserRowProps {
  browser: BrowserInfo;
  busyAction: BrowserRowAction | null;
  onAction: (action: BrowserRowAction, browser: BrowserInfo) => void;
  controlSessions: ReturnType<typeof useControlSessions>;
}

function BrowserRow({ browser, busyAction, onAction, controlSessions }: BrowserRowProps) {
  const sessions = controlSessions.sessions.filter(
    session => session.browserId === browser.browserId,
  );
  const [expanded, setExpanded] = useState(browser.status === 'pairing');
  const [confirmingAction, setConfirmingAction] = useState<'close' | 'cleanup' | null>(null);
  const managed = browser.type === 'managed' ? browser : null;
  const operations = managed?.operations ?? [];
  const canStart = operations.includes('start');
  const canClose = operations.includes('close');
  const canCleanup = browser.status === 'stopped' && operations.includes('deleteData');
  const canDetach = operations.includes('detach');
  const canSync = operations.includes('syncCookies');
  const canCopyAccess = operations.includes('access');
  const summaryReference = browser.references?.find(item => item.summary);
  const summaryReferenceId = summaryReference?.id ?? browser.pairing?.code;
  const detailId = `browser-manager-details-${browser.browserId}`;
  const detailAction = expanded ? t('browserManagerHideDetails') : t('browserManagerShowDetails');
  const actionDisabled = busyAction !== null;
  const actionButtonClass =
    'cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-50';

  return (
    <section aria-label={browser.name}>
      <div
        className="flex min-h-12.5 cursor-pointer items-center transition-colors hover:bg-bg-hover/40"
        onClick={() => setExpanded(value => !value)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-bg-secondary text-text-secondary">
            {browser.status === 'pairing' ? (
              <QrCode className="h-3.5 w-3.5" />
            ) : (
              <Laptop className="h-3.5 w-3.5" />
            )}
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-medium text-text-primary">{browser.name}</span>
              <BrowserBadge browser={browser} />
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-3xs text-text-secondary">
              <span
                className={clsx(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  browser.status === 'connected'
                    ? 'bg-green-500'
                    : browser.status === 'running_disconnected' || browser.status === 'pairing'
                      ? 'bg-amber-500'
                      : 'bg-gray-400',
                )}
              />
              <span>{statusText(browser.status)}</span>
              {summaryReferenceId && (
                <span className="min-w-0 truncate font-mono" title={summaryReferenceId}>
                  · {summaryReferenceId}
                </span>
              )}
            </span>
          </span>
        </div>

        {managed && (
          <div
            className="flex shrink-0 items-center gap-1"
            onClick={event => event.stopPropagation()}
          >
            {confirmingAction && !busyAction ? (
              <div className="flex items-center gap-1">
                <span className="text-2xs text-text-secondary">
                  {confirmingAction === 'close'
                    ? t('browserManagerCloseConfirmInline')
                    : t('browserManagerCleanupConfirmInline')}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const action = confirmingAction;
                    setConfirmingAction(null);
                    onAction(action, browser);
                  }}
                  className="cursor-pointer rounded p-0.5 text-red-600 transition-colors hover:bg-red-600/10 dark:text-red-400"
                  title={t('confirm')}
                  aria-label={t('confirm')}
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingAction(null)}
                  className="cursor-pointer rounded p-0.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                  title={t('cancel')}
                  aria-label={t('cancel')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <>
                {canCopyAccess && (
                  <button
                    type="button"
                    onClick={() => onAction('access', managed)}
                    disabled={actionDisabled}
                    className={actionButtonClass}
                    title={t('browserManagerCopyAccess')}
                    aria-label={t('browserManagerCopyAccess')}
                  >
                    {busyAction === 'access' ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Link2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
                {canSync && (
                  <button
                    type="button"
                    onClick={() => onAction('sync', managed)}
                    disabled={actionDisabled}
                    className={actionButtonClass}
                    title={t('browserManagerSyncLogin')}
                    aria-label={t('browserManagerSyncLogin')}
                  >
                    <Cookie className="h-3.5 w-3.5" />
                  </button>
                )}
                {canStart && (
                  <button
                    type="button"
                    onClick={() => onAction('start', managed)}
                    disabled={actionDisabled}
                    className="cursor-pointer rounded p-1 text-blue-600 transition-colors hover:bg-blue-600/10 disabled:cursor-wait disabled:opacity-50 dark:text-blue-400"
                    title={t('browserManagerStart')}
                    aria-label={t('browserManagerStart')}
                  >
                    {busyAction === 'start' ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
                {canClose && (
                  <button
                    type="button"
                    onClick={() => setConfirmingAction('close')}
                    disabled={actionDisabled}
                    className="cursor-pointer rounded p-1 text-red-600 transition-colors hover:bg-red-600/10 disabled:cursor-wait disabled:opacity-50 dark:text-red-400"
                    title={t('browserManagerClose')}
                    aria-label={t('browserManagerClose')}
                  >
                    {busyAction === 'close' ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Power className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
                {canCleanup && (
                  <button
                    type="button"
                    onClick={() => setConfirmingAction('cleanup')}
                    disabled={actionDisabled}
                    className="cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-red-600/10 hover:text-red-600 disabled:cursor-wait disabled:opacity-50 dark:hover:text-red-400"
                    title={t('browserManagerCleanup')}
                    aria-label={t('browserManagerCleanup')}
                  >
                    {busyAction === 'cleanup' ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
                {canDetach && (
                  <button
                    type="button"
                    onClick={() => onAction('detach', managed)}
                    disabled={actionDisabled}
                    className={actionButtonClass}
                    title={t('browserManagerDetach')}
                    aria-label={t('browserManagerDetach')}
                  >
                    {busyAction === 'detach' ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <LogOut className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={event => {
            event.stopPropagation();
            setExpanded(value => !value);
          }}
          aria-expanded={expanded}
          aria-controls={detailId}
          aria-label={`${detailAction}: ${browser.name}`}
          title={detailAction}
          className="mr-2 cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <ChevronRight
            className={clsx('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')}
          />
        </button>
      </div>

      <ControlSessions
        sessions={sessions}
        busy={controlSessions.busy}
        onUpdate={controlSessions.update}
        onView={controlSessions.view}
      />

      {expanded && (
        <div id={detailId}>
          <BrowserDetails browser={browser} />
        </div>
      )}
    </section>
  );
}

interface LaunchFormProps {
  busy: boolean;
  accountsEnabled: boolean;
  providers: BrowserProviderSummary[];
  onCancel: () => void;
  onLaunch: (params: BrowserLaunchParams) => Promise<void>;
  onConfigure: (provider: string, options: Record<string, BrowserJsonValue>) => Promise<void>;
}

function initialProviderLaunchForm(
  provider: BrowserProviderSummary | undefined,
  variantId?: string,
): BrowserProviderLaunchForm | null {
  const form = provider?.browserType.dynamicLaunchForm
    ? provider.browserType.launchForm
    : undefined;
  if (!form) return null;
  const variant = form.variants?.find(item => item.id === (variantId ?? form.variant));
  return {
    ...form,
    variant: variant?.id ?? form.variant,
    inputSchema: variant?.inputSchema ?? form.inputSchema,
    values: variant?.values ?? form.values,
    refreshOn: variant?.refreshOn ?? form.refreshOn,
    dynamicFields: variant?.dynamicFields ?? form.dynamicFields,
  };
}

function initialProviderFieldValue(
  schema: BrowserProviderInputSchema,
  required: boolean,
): string | undefined {
  const initialValue = schema.formDefault ?? schema.default;
  if (initialValue !== undefined) {
    return schema.type === 'array' || schema.type === 'object'
      ? JSON.stringify(initialValue)
      : String(initialValue);
  }
  if (schema.type === 'string' && required && schema.enum?.[0]) return schema.enum[0];
  return schema.type === 'boolean' && required ? 'false' : undefined;
}

function initialProviderOptions(
  inputSchema: BrowserProviderObjectSchema | undefined,
): Record<string, string | undefined> {
  if (!inputSchema) return {};
  const required = new Set(inputSchema.required ?? []);
  return Object.fromEntries(
    Object.entries(inputSchema.properties)
      .filter(([, schema]) => !schema.formHidden)
      .map(([key, schema]) => [key, initialProviderFieldValue(schema, required.has(key))])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function visibleProviderFields(
  fields: Array<[string, BrowserProviderInputSchema]>,
  values: Record<string, string | undefined>,
): Array<[string, BrowserProviderInputSchema]> {
  return fields.filter(([, schema]) => {
    if (schema.formHidden) return false;
    if (!schema.formVisibleWhen) return true;
    const controllingValue = values[schema.formVisibleWhen.field];
    const empty = controllingValue === undefined || !controllingValue.trim();
    return empty === schema.formVisibleWhen.empty;
  });
}

function parseProviderOptions(
  fields: Array<[string, BrowserProviderInputSchema]>,
  values: Record<string, string | undefined>,
): Record<string, BrowserJsonValue> {
  return Object.fromEntries(
    fields.flatMap(([key, schema]) => {
      const raw = values[key];
      if (raw === undefined || (schema.type !== 'boolean' && !raw.trim())) return [];
      if (schema.type === 'string') return [[key, raw.trim()]];
      if (schema.type === 'number') return [[key, Number(raw)]];
      if (schema.type === 'boolean') return [[key, raw === 'true']];
      return [[key, JSON.parse(raw) as BrowserJsonValue]];
    }),
  );
}

function parseProviderQueryOptions(
  fields: Array<[string, BrowserProviderInputSchema]>,
  values: Record<string, string | undefined>,
): Record<string, BrowserJsonValue> {
  return Object.fromEntries(
    fields.flatMap(field => {
      try {
        return Object.entries(parseProviderOptions([field], values));
      } catch {
        // Queries can run while structured input is incomplete; launch still validates every field.
        return [];
      }
    }),
  );
}

function providerValueMatchesSchema(
  schema: BrowserProviderInputSchema,
  value: BrowserJsonValue,
): boolean {
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    if (schema.enum && !schema.enum.includes(value)) return false;
    if (
      schema.options &&
      !schema.options.some(option => option.value === value && !option.disabled)
    )
      return false;
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  if (schema.type === 'number') {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (!schema.integer || Number.isInteger(value)) &&
      (schema.minimum === undefined || value >= schema.minimum) &&
      (schema.maximum === undefined || value <= schema.maximum)
    );
  }
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') {
    return (
      Array.isArray(value) &&
      (schema.minItems === undefined || value.length >= schema.minItems) &&
      (schema.maxItems === undefined || value.length <= schema.maxItems) &&
      value.every(item => providerValueMatchesSchema(schema.items, item))
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const objectValue = value as Record<string, BrowserJsonValue>;
  if ((schema.required ?? []).some(key => objectValue[key] === undefined)) return false;
  if (
    schema.additionalProperties === false &&
    Object.keys(objectValue).some(key => schema.properties[key] === undefined)
  ) {
    return false;
  }
  if (
    Object.entries(schema.properties).some(
      ([key, child]) =>
        objectValue[key] !== undefined && !providerValueMatchesSchema(child, objectValue[key]),
    )
  ) {
    return false;
  }
  if (schema.not && providerValueMatchesSchema(schema.not, objectValue)) return false;
  if (schema.oneOf) {
    return (
      schema.oneOf.filter(option => providerValueMatchesSchema(option, objectValue)).length === 1
    );
  }
  return true;
}

function providerOptionsAreValid(
  inputSchema: BrowserProviderObjectSchema | undefined,
  fields: Array<[string, BrowserProviderInputSchema]>,
  values: Record<string, string | undefined>,
): boolean {
  if (!inputSchema) return false;
  if (
    (inputSchema.required ?? []).some(key => {
      const value = values[key];
      return value === undefined || !value.trim();
    })
  ) {
    return false;
  }
  try {
    const options = parseProviderOptions(fields, values);
    return (
      providerValueMatchesSchema(inputSchema, options) &&
      fields.every(([key, schema]) => {
        if (schema.component !== 'cookie-sync' || values[key] === undefined) return true;
        const selection = cookieSyncSelectionFromValue(values[key]);
        return selection !== null && isCookieSyncSelectionValid(selection);
      })
    );
  } catch {
    return false;
  }
}

function cookieSyncSelectionFromValue(value: string): CookieSyncSelection | null {
  try {
    return cookieSyncPayloadToSelection(JSON.parse(value));
  } catch {
    return null;
  }
}

interface ProviderCookieSyncFieldProps {
  value?: string;
  onChange: (value: string | undefined) => void;
  children?: ReactNode;
}

function ProviderCookieSyncField({ value, onChange, children }: ProviderCookieSyncFieldProps) {
  const storedSelection = readCookieSyncSelection();
  const selection = value === undefined ? storedSelection : cookieSyncSelectionFromValue(value);
  const effectiveSelection = selection ?? storedSelection;

  return (
    <CookieSyncOption
      enabled={value !== undefined}
      value={effectiveSelection}
      onEnabledChange={enabled =>
        onChange(
          enabled ? JSON.stringify(cookieSyncSelectionToPayload(effectiveSelection)) : undefined,
        )
      }
      onChange={next => onChange(JSON.stringify(cookieSyncSelectionToPayload(next)))}
    >
      {children}
    </CookieSyncOption>
  );
}

interface ProviderSwitchFieldProps {
  fieldKey: string;
  schema: BrowserProviderInputSchema;
  value?: string;
  onChange: (value: string) => void;
}

function ProviderSwitchField({ fieldKey, schema, value, onChange }: ProviderSwitchFieldProps) {
  const enabled = value === 'true';
  const label = providerText(schema, 'title') || fieldKey;
  const description = providerText(schema, 'description');
  return (
    <div className="divide-y divide-border rounded border border-border bg-bg-primary px-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        onClick={() => onChange(String(!enabled))}
        className="flex w-full min-w-0 cursor-pointer items-center justify-between gap-3 py-1.5 text-left"
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-2xs font-medium text-text-primary">{label}</span>
          {description && (
            <span className="truncate text-3xs text-text-secondary/70">{description}</span>
          )}
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
    </div>
  );
}

interface ProviderFieldsProps {
  schema: BrowserProviderObjectSchema;
  fields?: Array<[string, BrowserProviderInputSchema]>;
  values: Record<string, string | undefined>;
  onChange: (key: string, value: string | undefined) => void;
  cookieSyncFooter?: ReactNode;
  loadingFields?: readonly string[];
}

function ProviderFields({
  schema: objectSchema,
  fields: providedFields,
  values,
  onChange,
  cookieSyncFooter,
  loadingFields = [],
}: ProviderFieldsProps) {
  const required = new Set(objectSchema.required ?? []);
  const fields =
    providedFields ??
    (Object.entries(objectSchema.properties) as Array<[string, BrowserProviderInputSchema]>);
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {fields.map(([key, schema]) => {
        const fieldLoading = loadingFields.includes(key);
        const widthClass = schema.formWidth === 'half' ? 'col-span-1' : 'col-span-2';
        if (schema.component === 'cookie-sync') {
          return (
            <fieldset key={key} disabled={fieldLoading} className={clsx(widthClass, 'self-end')}>
              <ProviderCookieSyncField value={values[key]} onChange={value => onChange(key, value)}>
                {cookieSyncFooter}
              </ProviderCookieSyncField>
            </fieldset>
          );
        }
        if (schema.component === 'switch') {
          return (
            <fieldset key={key} disabled={fieldLoading} className={clsx(widthClass, 'self-end')}>
              <ProviderSwitchField
                fieldKey={key}
                schema={schema}
                value={values[key]}
                onChange={value => onChange(key, value)}
              />
            </fieldset>
          );
        }
        const FieldContainer =
          schema.type === 'string' && (schema.enum || schema.options) ? 'div' : 'label';
        const optional = !required.has(key) && !schema.formHideOptional;
        const label = providerText(schema, 'title') || key;
        const description = providerText(schema, 'description');
        return (
          <FieldContainer key={key} className={clsx('block min-w-0', widthClass)}>
            <span className="mb-1 flex items-baseline gap-1.5 text-3xs">
              <span className="font-medium text-text-secondary">{label}</span>
              {required.has(key) && (
                <span className="text-red-500">{t('browserManagerRequired')}</span>
              )}
            </span>
            {schema.type === 'boolean' ? (
              <input
                type="checkbox"
                disabled={fieldLoading}
                checked={values[key] === 'true'}
                onChange={event => onChange(key, String(event.target.checked))}
                className="h-4 w-4 rounded border-border text-blue-600"
              />
            ) : schema.type === 'string' && (schema.enum || schema.options) ? (
              <SearchableSelect
                options={[
                  ...(optional && values[key]
                    ? [{ value: '', label: t('browserManagerOptional') }]
                    : []),
                  ...(schema.options?.map(option => ({
                    ...option,
                    label: providerText(option, 'label') ?? option.label,
                    description: providerText(option, 'description'),
                  })) ?? schema.enum!.map(value => ({ value, label: value }))),
                ]}
                value={fieldLoading ? '' : (values[key] ?? '')}
                onChange={value => onChange(key, value || undefined)}
                disabled={fieldLoading}
                placeholder={providerText(schema, 'placeholder') ?? t('browserManagerSelectOption')}
                searchPlaceholder={t('browserManagerSearchOptions')}
                noDataText={t('browserManagerNoOptions')}
                searchable={Boolean(schema.options && schema.options.length > 5)}
                minWidth=""
                triggerClassName="flex w-full cursor-pointer items-center gap-1 rounded border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary outline-none transition-colors hover:bg-bg-hover focus-visible:border-blue-500"
                panelClassName="w-full"
                ariaLabel={label}
              />
            ) : schema.type === 'array' || schema.type === 'object' ? (
              <textarea
                disabled={fieldLoading}
                value={values[key] ?? ''}
                onChange={event => onChange(key, event.target.value)}
                placeholder={
                  providerText(schema, 'placeholder') ??
                  JSON.stringify(schema.type === 'array' ? [] : {})
                }
                rows={3}
                className="w-full rounded border border-border bg-bg-primary px-2 py-1.5 font-mono text-xs text-text-primary outline-none transition-colors placeholder:text-text-secondary/60 focus:border-blue-500"
              />
            ) : (
              <input
                type={
                  schema.type === 'number'
                    ? 'number'
                    : schema.type === 'string' && schema.secret
                      ? 'password'
                      : 'text'
                }
                disabled={fieldLoading}
                step={schema.type === 'number' && schema.integer ? 1 : undefined}
                min={schema.type === 'number' ? schema.minimum : undefined}
                max={schema.type === 'number' ? schema.maximum : undefined}
                value={values[key] ?? ''}
                onChange={event => onChange(key, event.target.value)}
                placeholder={providerText(schema, 'placeholder')}
                autoComplete={schema.type === 'string' && schema.secret ? 'off' : undefined}
                className="w-full rounded border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary outline-none transition-colors placeholder:text-text-secondary/60 focus:border-blue-500"
              />
            )}
            {description && (
              <span className="mt-1 block text-3xs text-text-secondary/70">{description}</span>
            )}
          </FieldContainer>
        );
      })}
    </div>
  );
}

function selectedCookieSyncSelections(
  fields: Array<[string, BrowserProviderInputSchema]>,
  values: Record<string, string | undefined>,
): CookieSyncSelection[] | null {
  const selections: CookieSyncSelection[] = [];
  for (const [key, schema] of fields) {
    if (schema.component !== 'cookie-sync' || values[key] === undefined) continue;
    const selection = cookieSyncSelectionFromValue(values[key]!);
    if (!selection || !isCookieSyncSelectionValid(selection)) return null;
    selections.push(selection);
  }
  return selections;
}

interface AccountPickerProps {
  accounts: BrowserAccountItem[];
  loading: boolean;
  error: string;
  value: string;
  onChange: (accountId: string) => void;
  onRetry: () => Promise<void>;
}

function AccountPicker({ accounts, loading, error, value, onChange, onRetry }: AccountPickerProps) {
  const availableAccounts = accounts.filter(account => account.site);
  const optionClass = (selected: boolean) =>
    clsx(
      'flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded border px-2 text-left transition-colors',
      selected
        ? 'border-blue-500 bg-blue-600/10 text-blue-700 dark:text-blue-300'
        : 'border-border bg-bg-secondary text-text-primary hover:bg-bg-hover',
    );

  return (
    <div>
      <div className="mb-1 flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 text-2xs font-medium text-text-primary">
          {t('browserManagerAccount')}
        </span>
        <span className="truncate text-3xs text-text-secondary/70">
          {t('browserManagerAccountHint')}
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label={t('browserManagerAccount')}
        className="grid max-h-24 grid-cols-2 gap-1 overflow-y-auto sm:grid-cols-3"
      >
        <button
          type="button"
          role="radio"
          aria-checked={value === ''}
          aria-label={t('browserManagerAccountNone')}
          onClick={() => onChange('')}
          className={optionClass(value === '')}
        >
          <span className="min-w-0 flex-1 truncate text-2xs font-medium">
            {t('browserManagerAccountNone')}
          </span>
          {value === '' && <Check className="h-3 w-3 shrink-0" />}
        </button>
        {availableAccounts.map(account => {
          const accountId = String(account.id);
          const selected = value === accountId;
          return (
            <button
              key={accountId}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={account.loginId}
              title={account.loginId}
              onClick={() => onChange(accountId)}
              className={optionClass(selected)}
            >
              <span className="min-w-0 flex-1 truncate text-2xs font-medium">
                {account.loginId}
              </span>
              {selected && <Check className="h-3 w-3 shrink-0" />}
            </button>
          );
        })}
      </div>
      {loading && availableAccounts.length === 0 && (
        <div className="mt-1.5 flex items-center gap-1 text-3xs text-text-secondary">
          <LoaderCircle className="h-3 w-3 animate-spin" />
          {t('requestCasesLoading')}
        </div>
      )}
      {!loading && !error && availableAccounts.length === 0 && (
        <div className="mt-1.5 text-3xs text-text-secondary">{t('requestCasesNoData')}</div>
      )}
      {error && (
        <div className="mt-1.5 flex items-center justify-between gap-2 text-3xs text-red-500">
          <span className="truncate">{t('accountsLoadFailed', error)}</span>
          <button
            type="button"
            disabled={loading}
            onClick={() => void onRetry()}
            className="shrink-0 cursor-pointer text-blue-600 hover:underline dark:text-blue-400 disabled:opacity-50"
          >
            {t('requestCasesRetry')}
          </button>
        </div>
      )}
    </div>
  );
}

function LaunchForm({
  busy,
  accountsEnabled,
  providers,
  onCancel,
  onLaunch,
  onConfigure,
}: LaunchFormProps) {
  const [mode, setMode] = useState<LaunchMode>('local');
  const externalProviders = providers.filter(provider => !provider.provider.builtin);
  const [name, setName] = useState('');
  const [persistent, setPersistent] = useState(false);
  const [headless, setHeadless] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [accountLoginBusy, setAccountLoginBusy] = useState(false);
  const [configurationRequired, setConfigurationRequired] = useState(false);
  const [cookiePermissionError, setCookiePermissionError] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [providerOptions, setProviderOptions] = useState<Record<string, string | undefined>>({});
  const [dynamicForm, setDynamicForm] = useState<BrowserProviderLaunchForm | null>(null);
  const [formReady, setFormReady] = useState(false);
  const [formProviderId, setFormProviderId] = useState<string | undefined>();
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const formRequest = useRef(0);
  const [configurationOptions, setConfigurationOptions] = useState<
    Record<string, string | undefined>
  >({});
  const {
    accounts: accounts,
    loading: accountsLoading,
    error: accountsError,
    requestAccounts: requestAccounts,
    retryAccounts: retryAccounts,
  } = useAccounts();
  const localProvider = providers.find(provider => provider.provider.id === 'local');
  const externalProvider = providers.find(provider => mode === `provider:${provider.provider.id}`);
  const selectedProvider = externalProvider ?? localProvider;
  const launchForm =
    formProviderId === externalProvider?.provider.id
      ? dynamicForm
      : initialProviderLaunchForm(externalProvider);
  const externalSchema = launchForm?.inputSchema ?? externalProvider?.browserType.inputSchema;
  const externalFields = visibleProviderFields(
    Object.entries(externalSchema?.properties ?? {}) as Array<[string, BrowserProviderInputSchema]>,
    providerOptions,
  );
  const localComponentFields = visibleProviderFields(
    Object.entries(localProvider?.browserType.inputSchema.properties ?? {}) as Array<
      [string, BrowserProviderInputSchema]
    >,
    providerOptions,
  ).filter(([, schema]) => schema.component !== undefined);
  const configurationSchema = externalProvider?.browserType.configuration?.inputSchema;
  const configurationFields = visibleProviderFields(
    Object.entries(configurationSchema?.properties ?? {}) as Array<
      [string, BrowserProviderInputSchema]
    >,
    configurationOptions,
  );

  const loadLaunchForm = async (
    variant?: string,
    values: Record<string, BrowserJsonValue> = {},
  ) => {
    if (!externalProvider?.browserType.dynamicLaunchForm) return;
    const requestId = ++formRequest.current;
    setFormLoading(true);
    setFormReady(false);
    setFormError(null);
    setLaunchError(null);
    try {
      const form = await requestBrowserManager('launchForm', {
        provider: externalProvider.provider.id,
        variant,
        values,
      });
      if (requestId !== formRequest.current) return;
      setDynamicForm(form);
      setFormReady(true);
      setProviderOptions(current => {
        const defaults = initialProviderOptions(form.inputSchema);
        for (const [key, schema] of Object.entries(form.inputSchema.properties)) {
          const raw = current[key];
          if (schema.formHidden) continue;
          if (raw === undefined) {
            if (Object.prototype.hasOwnProperty.call(current, key)) defaults[key] = undefined;
            continue;
          }
          try {
            const value = parseProviderOptions([[key, schema]], { [key]: raw })[key];
            if (
              value === undefined ||
              schema.type !== 'string' ||
              (!schema.options && !schema.enum) ||
              providerValueMatchesSchema(schema, value)
            )
              defaults[key] = raw;
          } catch {
            // Incomplete user input is retained while its field remains in the form.
            if (schema.type !== 'string' || (!schema.options && !schema.enum)) defaults[key] = raw;
          }
        }
        return defaults;
      });
    } catch (cause) {
      if (requestId === formRequest.current)
        setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestId === formRequest.current) setFormLoading(false);
    }
  };

  const selectLaunchVariant = (variant: string) => {
    const initialForm = initialProviderLaunchForm(externalProvider, variant);
    const initialValues = initialProviderOptions(initialForm?.inputSchema);
    if (initialForm) {
      setDynamicForm(initialForm);
      setProviderOptions(initialValues);
    } else {
      setProviderOptions({});
    }
    const fields = visibleProviderFields(
      Object.entries(initialForm?.inputSchema.properties ?? {}),
      initialValues,
    );
    void loadLaunchForm(variant, parseProviderQueryOptions(fields, initialValues));
  };

  const updateProviderOption = (key: string, value: string | undefined) => {
    setLaunchError(null);
    const next = { ...providerOptions, [key]: value };
    if (launchForm?.refreshOn?.includes(key)) {
      for (const [field, schema] of externalFields) {
        if (field !== key && schema.type === 'string' && schema.options) delete next[field];
      }
      void loadLaunchForm(launchForm.variant, parseProviderQueryOptions(externalFields, next));
    }
    setProviderOptions(next);
  };

  useEffect(() => {
    setConfigurationRequired(false);
    setCookiePermissionError(false);
    setLaunchError(null);
    const initialForm = initialProviderLaunchForm(externalProvider);
    const initialSchema = initialForm?.inputSchema ?? selectedProvider?.browserType.inputSchema;
    const initialValues = initialProviderOptions(initialSchema);
    setProviderOptions(initialValues);
    setConfigurationOptions(initialProviderOptions(configurationSchema));
    setFormProviderId(externalProvider?.provider.id);
    setDynamicForm(initialForm);
    setFormReady(false);
    setFormError(null);
    setFormLoading(false);
    const fields = visibleProviderFields(
      Object.entries(initialSchema?.properties ?? {}),
      initialValues,
    );
    void loadLaunchForm(initialForm?.variant, parseProviderQueryOptions(fields, initialValues));
    return () => {
      formRequest.current++;
    };
  }, [selectedProvider?.provider.id]);

  useEffect(() => {
    if (accountsEnabled && mode === 'local') void requestAccounts();
  }, [mode, requestAccounts, accountsEnabled]);

  useEffect(() => {
    if (!accountsEnabled) setAccountId('');
  }, [accountsEnabled]);

  const submit = async () => {
    const launchFields = externalProvider ? externalFields : localComponentFields;
    const cookieSelections = selectedCookieSyncSelections(launchFields, providerOptions);
    if (!cookieSelections) return;
    for (const selection of cookieSelections) {
      if (!(await requestCookieSyncPermissions(selection))) {
        setCookiePermissionError(true);
        return;
      }
    }
    setCookiePermissionError(false);
    cookieSelections.forEach(persistCookieSyncSelection);
    setLaunchError(null);
    const effectiveAccountId = accountsEnabled ? accountId : '';
    setAccountLoginBusy(Boolean(effectiveAccountId));
    try {
      if (externalProvider) {
        if (configurationRequired && configurationSchema) {
          await onConfigure(
            externalProvider.provider.id,
            parseProviderOptions(configurationFields, configurationOptions),
          );
        }
        await onLaunch({
          provider: externalProvider.provider.id,
          providerOptions: {
            ...parseProviderOptions(externalFields, providerOptions),
            ...launchForm?.values,
          },
        });
        return;
      }
      const account = effectiveAccountId
        ? accounts.find(account => String(account.id) === effectiveAccountId)
        : undefined;
      if (effectiveAccountId && (!account || !account.site)) {
        throw new Error(t('browserManagerAccountUnavailable'));
      }
      const instanceName = name.trim() || randomLocalInstanceName(account);
      let loginUrl: string | undefined;
      if (account?.site) {
        const { result } = await withAccountAutoLogin(() =>
          fetchAccountSso(account.principalId ?? account.id, account.site!, account.provider),
        );
        if (!result.success || !result.data) {
          throw new Error(
            isAccountLoginError(result.error)
              ? t('accountLoginRequired')
              : result.error || t('browserManagerAccountLoginFailed'),
          );
        }
        loginUrl = result.data;
      }
      await onLaunch({
        provider: 'local',
        providerOptions: {
          name: instanceName,
          persistent,
          headless,
          ...(loginUrl ? { url: loginUrl } : {}),
          ...parseProviderOptions(localComponentFields, providerOptions),
        },
      });
    } catch (cause) {
      if (
        externalProvider &&
        configurationSchema &&
        !configurationRequired &&
        isMissingProviderConfigurationError(cause)
      ) {
        setConfigurationRequired(true);
        setLaunchError(cause instanceof Error ? cause.message : String(cause));
      } else {
        setLaunchError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setAccountLoginBusy(false);
    }
  };

  const launchValid = externalProvider
    ? providerOptionsAreValid(externalSchema, externalFields, providerOptions) &&
      (!externalProvider.browserType.dynamicLaunchForm ||
        Boolean(
          launchForm &&
          formReady &&
          !formLoading &&
          !formError &&
          !launchForm.blocked &&
          providerValueMatchesSchema(externalProvider.browserType.inputSchema, {
            ...parseProviderOptions(externalFields, providerOptions),
            ...launchForm.values,
          }),
        ))
    : selectedCookieSyncSelections(localComponentFields, providerOptions) !== null;
  const configurationValid =
    !configurationRequired ||
    providerOptionsAreValid(configurationSchema, configurationFields, configurationOptions);
  const valid = launchValid && configurationValid;
  const launchOptions: Array<{
    id: string;
    enabled: boolean;
    label: string;
    hint: string;
    onToggle: () => void;
  }> = [];
  if (!externalProvider) {
    launchOptions.push({
      id: 'persistent',
      enabled: persistent,
      label: t('browserManagerPersistent'),
      hint: t('browserManagerPersistentHint'),
      onToggle: () => setPersistent(value => !value),
    });
  }
  if (mode === 'local') {
    launchOptions.push({
      id: 'headless',
      enabled: headless,
      label: t('browserManagerHeadless'),
      hint: t('browserManagerHeadlessHint'),
      onToggle: () => setHeadless(value => !value),
    });
  }

  return (
    <Modal
      isOpen={true}
      onClose={onCancel}
      size="default"
      contentStyle={{
        maxWidth: 560,
        maxHeight: 'min(520px, calc(100vh - 24px))',
      }}
    >
      <ModalHeader
        title={t('browserManagerCreate')}
        actions={
          externalProvider?.browserType.documentationUrl ? (
            <a
              href={externalProvider.browserType.documentationUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-3xs font-normal text-blue-600 hover:underline dark:text-blue-400"
            >
              {externalProvider.provider.name}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : undefined
        }
        onClose={onCancel}
      />
      <ModalContent>
        <div
          className="grid gap-0.5 rounded-lg bg-bg-hover p-px"
          style={{ gridTemplateColumns: `repeat(${1 + externalProviders.length}, minmax(0, 1fr))` }}
        >
          {[
            { id: 'local' as const, label: t('browserManagerLocal') },
            ...externalProviders.map(provider => ({
              id: `provider:${provider.provider.id}` as const,
              label: providerText(provider.browserType, 'name') ?? provider.browserType.name,
            })),
          ].map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => setMode(item.id)}
              className={clsx(
                'cursor-pointer rounded-md px-2 py-1 text-2xs transition-colors',
                mode === item.id
                  ? 'bg-bg-primary font-medium text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="mt-2.5 space-y-2.5">
          {!externalProvider && (
            <div className="grid gap-2">
              <label className="block min-w-0">
                <span className="mb-1 flex min-w-0 items-baseline gap-1.5 text-3xs">
                  <span className="shrink-0 font-medium text-text-secondary">
                    {t('browserManagerName')}
                  </span>
                </span>
                <input
                  value={name}
                  onChange={event => setName(event.target.value)}
                  placeholder={t('browserManagerNamePlaceholder')}
                  className="w-full rounded border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary outline-none transition-colors placeholder:text-text-secondary/60 focus:border-blue-500"
                />
              </label>
            </div>
          )}

          {externalProvider?.browserType.dynamicLaunchForm && (
            <div className="space-y-2">
              {launchForm?.variants && (
                <fieldset disabled={busy}>
                  <legend className="mb-1 text-3xs font-medium text-text-secondary">
                    {t('browserManagerConnectionMode')}
                  </legend>
                  <div className="grid grid-cols-2 gap-2">
                    {launchForm.variants.map(variant => {
                      const description = providerText(variant, 'description');
                      return (
                        <label
                          key={variant.id}
                          className={clsx(
                            'cursor-pointer rounded border p-2',
                            variant.id === launchForm.variant
                              ? 'border-blue-600 bg-blue-600/5'
                              : 'border-border',
                          )}
                        >
                          <span className="flex items-center gap-1.5 text-2xs text-text-primary">
                            <input
                              type="radio"
                              name="providerLaunchVariant"
                              checked={variant.id === launchForm.variant}
                              onChange={() => selectLaunchVariant(variant.id)}
                            />
                            {providerText(variant, 'title')}
                          </span>
                          {description && (
                            <p className="mt-1 text-3xs text-text-secondary">{description}</p>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              )}
              <div className="flex items-start justify-between gap-2">
                <div
                  role="status"
                  aria-live="polite"
                  className={clsx('text-3xs', formError ? 'text-red-500' : 'text-text-secondary')}
                >
                  {formLoading
                    ? t('browserManagerLoadingOptions')
                    : (formError ?? providerText(launchForm, 'message'))}
                </div>
                <button
                  type="button"
                  disabled={formLoading || busy}
                  onClick={() =>
                    void loadLaunchForm(
                      launchForm?.variant,
                      parseProviderQueryOptions(externalFields, providerOptions),
                    )
                  }
                  className="flex shrink-0 items-center gap-1 text-3xs text-blue-600 disabled:opacity-50"
                >
                  <RefreshCw className={clsx('h-3 w-3', formLoading && 'animate-spin')} />
                  {t('browserManagerRefreshOptions')}
                </button>
              </div>
            </div>
          )}
          {externalProvider &&
            externalSchema &&
            externalFields.length > 0 &&
            (!externalProvider.browserType.dynamicLaunchForm || launchForm) && (
              <fieldset disabled={busy || (formLoading && !launchForm?.dynamicFields)}>
                <ProviderFields
                  schema={externalSchema}
                  fields={externalFields}
                  values={providerOptions}
                  onChange={updateProviderOption}
                  loadingFields={formLoading ? launchForm?.dynamicFields : undefined}
                />
              </fieldset>
            )}

          {externalProvider && configurationRequired && configurationSchema && (
            <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2.5">
              <div className="mb-2 text-3xs font-medium text-text-primary">
                {t('browserManagerProviderConfigure')}
              </div>
              <ProviderFields
                schema={configurationSchema}
                fields={configurationFields}
                values={configurationOptions}
                onChange={(key, value) => {
                  setConfigurationOptions(current => ({ ...current, [key]: value }));
                  setLaunchError(null);
                }}
              />
            </div>
          )}

          {launchOptions.length > 0 && (
            <div className="divide-y divide-border rounded border border-border bg-bg-primary px-2.5">
              {launchOptions.map(option => (
                <button
                  key={option.id}
                  type="button"
                  role="switch"
                  aria-checked={option.enabled}
                  aria-label={option.label}
                  onClick={option.onToggle}
                  className="flex w-full min-w-0 cursor-pointer items-center justify-between gap-3 py-2 text-left"
                >
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="shrink-0 text-2xs font-medium text-text-primary">
                      {option.label}
                    </span>
                    <span className="truncate text-3xs text-text-secondary/70">{option.hint}</span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={clsx(
                      'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
                      option.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600',
                    )}
                  >
                    <span
                      className={clsx(
                        'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
                        option.enabled ? 'translate-x-3.5' : 'translate-x-0.5',
                      )}
                    />
                  </span>
                </button>
              ))}
            </div>
          )}
          {!externalProvider && localProvider && localComponentFields.length > 0 && (
            <ProviderFields
              schema={localProvider.browserType.inputSchema}
              fields={localComponentFields}
              values={providerOptions}
              onChange={(key, value) =>
                setProviderOptions(current => ({ ...current, [key]: value }))
              }
              cookieSyncFooter={
                accountsEnabled ? (
                  <AccountPicker
                    accounts={accounts}
                    loading={accountsLoading}
                    error={accountsError}
                    value={accountId}
                    onChange={setAccountId}
                    onRetry={() => retryAccounts({ requestPermission: true })}
                  />
                ) : undefined
              }
            />
          )}
          {cookiePermissionError && (
            <div className="text-3xs text-red-500">{t('browserManagerCookiePermissionDenied')}</div>
          )}
          {launchError && <div className="text-3xs text-red-500">{launchError}</div>}
        </div>
      </ModalContent>
      <ModalFooter>
        <div className="flex w-full justify-end gap-1.5 px-1">
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded border border-border bg-bg-primary px-2.5 py-1 text-2xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            {t('browserManagerCancel')}
          </button>
          <button
            type="button"
            disabled={!valid || busy || accountLoginBusy}
            onClick={() => void submit()}
            className="flex cursor-pointer items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-2xs font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {(busy || accountLoginBusy) && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
            {externalProvider ? t('browserManagerAdd') : t('browserManagerLaunch')}
          </button>
        </div>
      </ModalFooter>
    </Modal>
  );
}

interface CookieSyncModalProps {
  browser: ManagedBrowserInfo;
  busy: boolean;
  onCancel: () => void;
  onSync: (selection: CookieSyncSelection) => Promise<void>;
}

function CookieSyncModal({ browser, busy, onCancel, onSync }: CookieSyncModalProps) {
  const [selection, setSelection] = useState(readCookieSyncSelection);
  const [permissionError, setPermissionError] = useState(false);

  const submit = async () => {
    if (!(await requestCookieSyncPermissions(selection))) {
      setPermissionError(true);
      return;
    }
    setPermissionError(false);
    persistCookieSyncSelection(selection);
    await onSync(selection);
  };

  return (
    <Modal
      isOpen={true}
      onClose={onCancel}
      size="default"
      contentStyle={{ maxWidth: 480, height: 'min(340px, calc(100vh - 24px))' }}
    >
      <ModalHeader
        title={
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0">{t('browserManagerCookieScopeTitle')}</span>
            <span
              className="truncate text-3xs font-normal text-text-secondary"
              title={browser.name}
            >
              {browser.name}
            </span>
          </span>
        }
        onClose={onCancel}
      />
      <ModalContent>
        <CookieSyncScopeEditor value={selection} onChange={setSelection} />
        {permissionError && (
          <div className="mt-1.5 text-3xs text-red-500">
            {t('browserManagerCookiePermissionDenied')}
          </div>
        )}
      </ModalContent>
      <ModalFooter>
        <div className="flex w-full justify-end gap-1.5 px-1">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="cursor-pointer rounded border border-border bg-bg-primary px-2.5 py-1 text-2xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-50"
          >
            {t('browserManagerCancel')}
          </button>
          <button
            type="button"
            disabled={busy || !isCookieSyncSelectionValid(selection)}
            onClick={() => void submit()}
            className="flex cursor-pointer items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-2xs font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
            {t('browserManagerSyncLogin')}
          </button>
        </div>
      </ModalFooter>
    </Modal>
  );
}

interface BrowserManagerProps {
  onBack?: () => void;
  headerActions?: ReactNode;
  accountsEnabled?: boolean;
}

export function BrowserManager({
  accountsEnabled = false,
  onBack,
  headerActions,
}: BrowserManagerProps) {
  const controlSessions = useControlSessions();
  const [browsers, setBrowsers] = useState<BrowserInfo[]>([]);
  const [providers, setProviders] = useState<BrowserProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoading(true), 300);
    return () => window.clearTimeout(timer);
  }, [loading]);
  const [busyAction, setBusyAction] = useState<{
    browserId: string;
    action: BrowserRowAction | 'launch';
  } | null>(null);
  const [showLaunchForm, setShowLaunchForm] = useState(false);
  const [syncTarget, setSyncTarget] = useState<ManagedBrowserInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [nativeHostUpdate, setNativeHostUpdate] = useState<NativeHostUpdateInfo | null>(null);

  const refresh = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const result = await requestBrowserManager('list', {});
      setBrowsers(result.browsers);
      setWarnings(result.warnings ?? []);
      setNativeHostUpdate(null);
    } catch (cause) {
      const update = await nativeHostServiceUpdateInfo(cause);
      if (update) {
        setNativeHostUpdate(update);
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!browsers.some(browser => browser.status === 'pairing')) return;

    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void refresh({ silent: true }).finally(() => {
        refreshing = false;
      });
    }, PAIRING_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [browsers, refresh]);

  const retryNativeHost = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await chrome.runtime.sendMessage({ action: 'resetAgentBridge' });
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to reset Native Host');
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    }
  }, [refresh]);

  const launch = async (params: BrowserLaunchParams) => {
    setBusyAction({ browserId: 'launch', action: 'launch' });
    setError(null);
    try {
      const { provider, providerOptions, ...options } = params;
      const launchOptions = (providerOptions ?? options) as Record<string, BrowserJsonValue>;
      await requestBrowserManager('launch', {
        operation:
          providers.find(item => item.provider.id === provider)?.browserType.openOperation ??
          'launch',
        provider: provider ?? 'local',
        providerOptions: launchOptions,
      });
      setShowLaunchForm(false);
      showToast(
        launchOptions.copyCookieDomains
          ? t('browserManagerSyncLoginDone')
          : t('browserManagerLaunchDone'),
        'success',
      );
      await refresh();
    } finally {
      setBusyAction(null);
    }
  };

  const configureProvider = async (provider: string, options: Record<string, BrowserJsonValue>) => {
    await requestBrowserManager('configure', { provider, options });
  };

  const openLaunchForm = async () => {
    setShowLaunchForm(true);
    setError(null);
    try {
      const result = await requestBrowserManager('providers', {});
      setProviders(result.providers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleAction = async (action: BrowserRowAction, browser: BrowserInfo) => {
    if (action === 'sync') {
      if (browser.type === 'managed') setSyncTarget(browser);
      return;
    }
    if (action === 'detach' && !window.confirm(t('browserManagerDetachConfirm'))) return;

    setBusyAction({ browserId: browser.browserId, action });
    setError(null);
    try {
      if (browser.type !== 'managed') {
        return;
      } else if (action === 'close') {
        await requestBrowserManager('close', { browser: browser.browserId });
        showToast(t('browserManagerCloseDone'), 'success');
      } else if (action === 'cleanup') {
        await requestBrowserManager('close', {
          browser: browser.browserId,
          deleteProfile: true,
        });
        showToast(t('browserManagerCleanupDone'), 'success');
      } else if (action === 'detach') {
        await requestBrowserManager('detach', { browser: browser.browserId });
        showToast(t('browserManagerDetachDone'), 'success');
      } else if (action === 'access') {
        const result = await requestBrowserManager('access', { browser: browser.browserId });
        await navigator.clipboard.writeText(result.browserAccess.url);
        showToast(t('browserManagerCopyAccessDone'), 'success');
      } else {
        await requestBrowserManager('start', { browser: browser.browserId });
        showToast(t('browserManagerLaunchDone'), 'success');
      }
      if (action !== 'access') await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const syncBrowser = async (selection: CookieSyncSelection) => {
    if (!syncTarget) return;
    setBusyAction({ browserId: syncTarget.browserId, action: 'sync' });
    setError(null);
    try {
      await requestBrowserManager('syncCookies', {
        browser: syncTarget.browserId,
        scope: cookieSyncSelectionToPayload(selection),
      });
      showToast(t('browserManagerSyncLoginDone'), 'success');
      setSyncTarget(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg-primary">
      <div className="flex items-center justify-between border-b border-border bg-toolbar px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              title={t('toolboxBack')}
              aria-label={t('toolboxBack')}
              className="shrink-0 cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="shrink-0 text-xs font-medium text-text-primary">
              {t('browserManagerTitle')}
            </h2>
            <p className="truncate text-3xs text-text-secondary">
              {t('browserManagerDescription')}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerActions}
          <button
            type="button"
            disabled={loading}
            onClick={() => void Promise.all([refresh(), controlSessions.refresh()])}
            className="cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-50"
            title={t('browserManagerRefresh')}
            aria-label={t('browserManagerRefresh')}
          >
            <RefreshCw
              className={clsx(
                'h-3.5 w-3.5',
                loading && showLoading && browsers.length > 0 && 'animate-spin',
              )}
            />
          </button>
          <button
            type="button"
            disabled={Boolean(nativeHostUpdate)}
            onClick={() => void openLaunchForm()}
            className="flex cursor-pointer items-center gap-1 rounded bg-blue-600 px-1.5 py-0.5 text-2xs font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('browserManagerNew')}
          </button>
        </div>
      </div>

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xxs text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      {controlSessions.error && !nativeHostUpdate && (
        <div
          role="alert"
          className="border-b border-border px-3 py-1.5 text-3xs text-red-600 dark:text-red-400"
        >
          {controlSessions.error}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xxs text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          {warnings.map(warning => (
            <div key={warning} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="select-text break-all">{warning}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {nativeHostUpdate ? (
          <NativeHostUpdateGuide
            context="browser-manager"
            update={nativeHostUpdate}
            retry={retryNativeHost}
          />
        ) : loading && browsers.length === 0 ? (
          showLoading ? (
            <div
              role="status"
              className="flex h-full items-center justify-center gap-2 text-xs text-text-secondary"
            >
              <LoaderCircle className="h-4 w-4 animate-spin" />
              {t('browserManagerLoading')}
            </div>
          ) : null
        ) : browsers.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <Laptop className="mb-1.5 h-6 w-6 text-text-secondary/40" />
            <div className="text-xs text-text-primary">{t('browserManagerEmpty')}</div>
            <div className="mt-1 max-w-xs text-3xs leading-4 text-text-secondary">
              {t('browserManagerEmptyHint')}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border border-b border-border bg-bg-primary">
            {browsers.map(browser => (
              <BrowserRow
                key={browser.browserId}
                browser={browser}
                controlSessions={controlSessions}
                busyAction={
                  busyAction?.browserId === browser.browserId
                    ? (busyAction.action as BrowserRowAction)
                    : null
                }
                onAction={(action, target) => void handleAction(action, target)}
              />
            ))}
          </div>
        )}
      </div>

      {showLaunchForm && (
        <LaunchForm
          busy={busyAction?.browserId === 'launch'}
          accountsEnabled={accountsEnabled}
          providers={providers}
          onCancel={() => setShowLaunchForm(false)}
          onLaunch={launch}
          onConfigure={configureProvider}
        />
      )}
      {syncTarget && (
        <CookieSyncModal
          browser={syncTarget}
          busy={busyAction?.browserId === syncTarget.browserId && busyAction.action === 'sync'}
          onCancel={() => setSyncTarget(null)}
          onSync={syncBrowser}
        />
      )}
    </div>
  );
}
