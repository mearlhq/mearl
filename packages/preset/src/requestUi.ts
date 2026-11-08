import { BundleError, MAX_REQUEST_UI_BYTES, readBundleJson, validateBundleManifest, type PreparedBundle } from './bundle.js';
import { clonePresetDefaults, isJsonObject } from './manifest.js';

export interface BrowserUiText { en: string; zh_CN?: string }
/** Existing request detail, login and service-toggle positions use host-rendered controls. */
export interface BrowserRequestUi {
  schemaVersion: 1;
  service: string;
  setting: { key: string; label: BrowserUiText };
  apiLink: { url: string; query: Record<string, string>; apiParameter: string; versionParameter: string; title: BrowserUiText };
  login: { url: string; title: BrowserUiText; requiredMessage: BrowserUiText; errorIncludes: string[] };
  save?: { hook: string; setting: string };
  details: { hook: string; toggleLabel: BrowserUiText; interfaceLabel: BrowserUiText; maintainerLabel: BrowserUiText; viewTitle: BrowserUiText; notFound: BrowserUiText };
}
export interface BrowserRequestDetail { displayValue: string; jumpUrl: string; maintainerDisplayValue?: string; maintainerTitle?: string }
export interface SelectedBrowserRequestUi { bundleId: string; revision: string; definition: BrowserRequestUi }

function invalid(message: string): never { throw new BundleError('BUNDLE_INVALID', message); }
function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!isJsonObject(value) || Object.keys(value).some(key => !names.includes(key))) invalid('Invalid request UI structure');
}
export function validateBrowserUiText(value: unknown): void {
  fields(value, ['en', 'zh_CN']);
  if (typeof value.en !== 'string' || !value.en.trim() || Object.values(value).some(entry => typeof entry !== 'string' || entry.length > 1024 || !entry.trim())) invalid('Request UI text requires bounded translations');
}
export function browserUiHttpUrl(value: unknown, options: { allowFragment?: boolean } = {}): string {
  if (typeof value !== 'string' || value.length > 4096) invalid('Invalid request UI URL');
  let url: URL;
  try { url = new URL(value); } catch { invalid('Invalid request UI URL'); }
  if (url.username || url.password || !options.allowFragment && url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) invalid('Request UI requires credential-free HTTPS or loopback URLs');
  return url.href;
}

export function validateBrowserRequestUi(input: unknown): BrowserRequestUi {
  const value = clonePresetDefaults(input);
  fields(value, ['schemaVersion', 'service', 'setting', 'apiLink', 'login', 'details', 'save']);
  if (value.schemaVersion !== 1 || typeof value.service !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(value.service)) invalid('Invalid request UI identity');
  fields(value.setting, ['key', 'label']);
  if (typeof value.setting.key !== 'string' || !/^[a-z][a-zA-Z0-9_-]{0,72}Enabled$/.test(value.setting.key) || ['agentEnabled', 'sseMonitoringEnabled', 'agentFloatingButtonEnabled'].includes(value.setting.key)) invalid('Invalid request UI setting');
  validateBrowserUiText(value.setting.label);
  fields(value.apiLink, ['url', 'query', 'apiParameter', 'versionParameter', 'title']);
  value.apiLink.url = browserUiHttpUrl(value.apiLink.url);
  if (new URL(value.apiLink.url as string).search || !isJsonObject(value.apiLink.query) || Object.keys(value.apiLink.query).length > 16 || Object.entries(value.apiLink.query).some(([key, entry]) => !key || key.length > 128 || typeof entry !== 'string' || entry.length > 2048)) invalid('Invalid request UI link parameters');
  const parameters = [value.apiLink.apiParameter, value.apiLink.versionParameter];
  const query = value.apiLink.query;
  if (parameters.some(key => typeof key !== 'string' || !key || key.length > 128 || Object.hasOwn(query, key)) || parameters[0] === parameters[1]) invalid('Request UI link parameters must be distinct');
  validateBrowserUiText(value.apiLink.title);
  fields(value.login, ['url', 'title', 'requiredMessage', 'errorIncludes']);
  value.login.url = browserUiHttpUrl(value.login.url);
  validateBrowserUiText(value.login.title); validateBrowserUiText(value.login.requiredMessage);
  if (!Array.isArray(value.login.errorIncludes) || value.login.errorIncludes.length > 16 || value.login.errorIncludes.some(entry => typeof entry !== 'string' || !entry.trim() || entry.length > 256)) invalid('Invalid request UI login errors');
  fields(value.details, ['hook', 'toggleLabel', 'interfaceLabel', 'maintainerLabel', 'viewTitle', 'notFound']);
  if (typeof value.details.hook !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,127}$/.test(value.details.hook)) invalid('Invalid request UI detail hook');
  for (const name of ['toggleLabel', 'interfaceLabel', 'maintainerLabel', 'viewTitle', 'notFound']) validateBrowserUiText(value.details[name]);
  if (value.save !== undefined) {
    fields(value.save, ['hook', 'setting']);
    if (typeof value.save.hook !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,127}$/.test(value.save.hook)) invalid('Invalid request save hook');
    if (typeof value.save.setting !== 'string' || !/^[a-z][a-zA-Z0-9_-]{0,72}Enabled$/.test(value.save.setting) || ['agentEnabled', 'sseMonitoringEnabled', 'agentFloatingButtonEnabled'].includes(value.save.setting)) invalid('Invalid request save setting');
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_REQUEST_UI_BYTES) throw new BundleError('BUNDLE_QUOTA', 'Request UI exceeds 64 KiB');
  return value as unknown as BrowserRequestUi;
}

/** Contribution validation is pure; factories and UI side effects belong to the host. */
export function selectBrowserRequestUi(bundles: PreparedBundle[], apiVersion: string): SelectedBrowserRequestUi | undefined {
  let selected: SelectedBrowserRequestUi | undefined;
  for (const bundle of bundles) {
    const manifest = validateBundleManifest(bundle.manifest, apiVersion);
    if (!manifest.contributions?.requestUi) continue;
    if (selected) invalid('Request UI has multiple providers');
    const definition = validateBrowserRequestUi(readBundleJson(bundle, manifest.contributions.requestUi));
    const bindings = manifest.contributions.browserRuntimes?.extension?.bindings ?? {};
    if ([definition.details.hook, ...(definition.save ? [definition.save.hook] : [])].some(hook => !Object.hasOwn(bindings, hook))) invalid('Request UI hook must belong to its own browser runtime');
    selected = { bundleId: manifest.id, revision: bundle.revision, definition };
  }
  return selected;
}

export function browserUiText(value: BrowserUiText, locale: string): string {
  return /^zh(?:[-_]CN)?$/i.test(locale) && value.zh_CN ? value.zh_CN : value.en;
}
export function browserRequestUiLink(value: BrowserRequestUi, api: string, version: string): string {
  const entries = [...Object.entries(value.apiLink.query), [value.apiLink.apiParameter, api], [value.apiLink.versionParameter, version]];
  return value.apiLink.url + '?' + entries.map(([key, entry]) => `${encodeURIComponent(key)}=${encodeURIComponent(entry)}`).join('&');
}
export function browserRequestLoginError(value: BrowserRequestUi, message: string): boolean {
  const lower = message.toLowerCase();
  return value.login.errorIncludes.some(fragment => lower.includes(fragment.toLowerCase()));
}
export function validateBrowserRequestDetail(input: unknown): BrowserRequestDetail {
  const value = clonePresetDefaults(input);
  fields(value, ['displayValue', 'jumpUrl', 'maintainerDisplayValue', 'maintainerTitle']);
  if (typeof value.displayValue !== 'string' || !value.displayValue || value.displayValue.length > 16384 || ['maintainerDisplayValue', 'maintainerTitle'].some(key => value[key] !== undefined && (typeof value[key] !== 'string' || (value[key] as string).length > 16384))) invalid('Invalid request detail value');
  value.jumpUrl = browserUiHttpUrl(value.jumpUrl);
  return value as unknown as BrowserRequestDetail;
}
