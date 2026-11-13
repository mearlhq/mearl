import { parseToolboxCatalogs, type ToolboxCatalogConfigs } from '@mearl/preset';
import {
  BundleError,
  type ExtensionContributions,
  type BrowserUiText,
} from '@mearl/preset/bundles';
import {
  browserUiMessages,
  parseBrowserRulePresets,
  type BrowserRulePreset,
} from './browserRulePresets';

export interface BrowserHeatmapSettings {
  measures: Array<{ id: string; label: BrowserUiText; format: 'number' | 'percent' }>;
  defaultMeasure: string;
  pathPrefix: string;
  bodySpmPrefix: string;
}
export interface AccountStateStorage {
  cacheKey: string;
  identityKey: string;
}
const DEFAULT_ACCOUNT_STATE: AccountStateStorage = {
  cacheKey: 'browser-accounts-cache',
  identityKey: 'browser-last-account-id',
};
export const accountStateStorageKeys = (settings?: BrowserUiSettings): AccountStateStorage =>
  settings?.accountState ?? DEFAULT_ACCOUNT_STATE;
export interface BrowserUiSettings extends Omit<ExtensionContributions, 'schemaVersion'> {
  toolCatalogs?: ToolboxCatalogConfigs;
  messages?: Record<string, BrowserUiText>;
  queryPresets?: Record<
    string,
    { label: BrowserUiText; params: Array<{ key: string; value: string }> }
  >;
  rulePresets?: Record<string, BrowserRulePreset>;
  heatmap?: BrowserHeatmapSettings;
  links?: Record<string, string>;
  linkTemplates?: Record<string, { template: string; title: BrowserUiText }>;
  installers?: Record<string, string>;
  accountState?: AccountStateStorage;
  captureState?: { namespace: string };
}
const namePattern = /^[a-z][a-zA-Z0-9_.-]{0,95}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function browserUiUrl(value: unknown): string {
  if (typeof value !== 'string')
    throw new BundleError('BUNDLE_INVALID', 'Expected a browser UI URL');
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw new BundleError('BUNDLE_INVALID', 'Browser UI URLs require HTTPS');
  return url.href;
}
/** Only existing host settings are applied; unknown fields stay visible as pending. */
export function parseBrowserUiSettings(input: unknown): {
  settings: BrowserUiSettings;
  pending: string[];
} {
  if (!record(input))
    throw new BundleError('BUNDLE_INVALID', 'Extension defaults must be an object');
  if (['operations', 'logins', 'preferenceAliases'].some(key => Object.hasOwn(input, key)))
    throw new BundleError(
      'BUNDLE_INVALID',
      'Settings cannot declare operations, logins, or preference aliases',
    );
  const settings: BrowserUiSettings = {};
  const pending = Object.keys(input)
    .filter(
      key =>
        ![
          'toolCatalogs',
          'links',
          'installers',
          'heatmap',
          'linkTemplates',
          'messages',
          'rulePresets',
          'queryPresets',
          'accountState',
          'captureState',
        ].includes(key),
    )
    .map(key => `extension.${key}`);
  if (input.toolCatalogs !== undefined)
    settings.toolCatalogs = parseToolboxCatalogs(input.toolCatalogs);
  if (input.captureState !== undefined) {
    const state = input.captureState;
    if (
      !record(state) ||
      Object.keys(state).length !== 1 ||
      typeof state.namespace !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(state.namespace)
    )
      throw new BundleError('BUNDLE_INVALID', 'Capture storage requires a bounded namespace');
    settings.captureState = { namespace: state.namespace };
  }
  if (input.accountState !== undefined) {
    const state = input.accountState;
    const namespace =
      record(state) && typeof state.cacheKey === 'string'
        ? /^([a-z][a-z0-9-]{0,63})-accounts-cache$/.exec(state.cacheKey)?.[1]
        : undefined;
    if (
      !record(state) ||
      Object.keys(state).some(key => !['cacheKey', 'identityKey'].includes(key)) ||
      !namespace ||
      typeof state.identityKey !== 'string' ||
      !state.identityKey.startsWith(namespace + '-last-') ||
      !/^[a-z][a-z0-9-]{0,31}-id$/.test(state.identityKey.slice(namespace.length + 6))
    )
      throw new BundleError(
        'BUNDLE_INVALID',
        'Account storage must use matching account-cache and identity keys',
      );
    settings.accountState = { cacheKey: state.cacheKey as string, identityKey: state.identityKey };
  }
  if (input.queryPresets !== undefined) {
    if (!record(input.queryPresets) || Object.keys(input.queryPresets).length > 32)
      throw new BundleError('BUNDLE_INVALID', 'Invalid query presets');
    settings.queryPresets = Object.fromEntries(
      Object.entries(input.queryPresets).map(([id, value]) => {
        if (
          !namePattern.test(id) ||
          !record(value) ||
          Object.keys(value).sort().join(',') !== 'label,params' ||
          !Array.isArray(value.params) ||
          !value.params.length ||
          value.params.length > 32 ||
          value.params.some(
            param =>
              !record(param) ||
              Object.keys(param).sort().join(',') !== 'key,value' ||
              typeof param.key !== 'string' ||
              !param.key ||
              param.key.length > 256 ||
              typeof param.value !== 'string' ||
              param.value.length > 4096,
          )
        )
          throw new BundleError('BUNDLE_INVALID', 'Invalid query preset');
        const label = browserUiMessages({ label: value.label }).label;
        return [
          id,
          { label, params: value.params.map(param => ({ key: param.key, value: param.value })) },
        ];
      }),
    );
  }
  if (input.messages !== undefined) settings.messages = browserUiMessages(input.messages);
  if (input.rulePresets !== undefined)
    settings.rulePresets = parseBrowserRulePresets(input.rulePresets);
  if (input.heatmap !== undefined) {
    const heatmap = input.heatmap;
    if (
      !record(heatmap) ||
      Object.keys(heatmap).some(
        key => !['measures', 'defaultMeasure', 'pathPrefix', 'bodySpmPrefix'].includes(key),
      ) ||
      !Array.isArray(heatmap.measures) ||
      !heatmap.measures.length ||
      heatmap.measures.length > 32 ||
      typeof heatmap.pathPrefix !== 'string' ||
      !heatmap.pathPrefix.startsWith('/') ||
      heatmap.pathPrefix.length > 512 ||
      typeof heatmap.bodySpmPrefix !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(heatmap.bodySpmPrefix)
    )
      throw new BundleError('BUNDLE_INVALID', 'Invalid heatmap settings');
    const ids = new Set<string>();
    const measures = heatmap.measures.map(measure => {
      if (
        !record(measure) ||
        Object.keys(measure).some(key => !['id', 'label', 'format'].includes(key)) ||
        typeof measure.id !== 'string' ||
        !/^[a-zA-Z0-9_.-]{1,128}$/.test(measure.id) ||
        ids.has(measure.id) ||
        !record(measure.label) ||
        typeof measure.label.en !== 'string' ||
        !measure.label.en ||
        measure.label.en.length > 256 ||
        Object.keys(measure.label).some(key => !['en', 'zh_CN'].includes(key)) ||
        (measure.label.zh_CN !== undefined &&
          (typeof measure.label.zh_CN !== 'string' || measure.label.zh_CN.length > 256)) ||
        !['number', 'percent'].includes(measure.format as string)
      )
        throw new BundleError('BUNDLE_INVALID', 'Invalid heatmap measure');
      ids.add(measure.id);
      return {
        id: measure.id,
        label: { ...measure.label } as unknown as BrowserUiText,
        format: measure.format as 'number' | 'percent',
      };
    });
    if (typeof heatmap.defaultMeasure !== 'string' || !ids.has(heatmap.defaultMeasure))
      throw new BundleError('BUNDLE_INVALID', 'Unavailable default heatmap measure');
    settings.heatmap = {
      measures,
      defaultMeasure: heatmap.defaultMeasure,
      pathPrefix: heatmap.pathPrefix,
      bodySpmPrefix: heatmap.bodySpmPrefix,
    };
  }
  for (const field of ['links', 'installers', 'linkTemplates'] as const) {
    const values = input[field];
    if (values === undefined) continue;
    if (
      !record(values) ||
      Object.keys(values).length > 64 ||
      Object.keys(values).some(key => !namePattern.test(key))
    )
      throw new BundleError('BUNDLE_INVALID', `Invalid extension ${field}`);
    const output: Record<string, any> = {};
    for (const [name, value] of Object.entries(values)) {
      if (field === 'installers') {
        if (typeof value !== 'string')
          throw new BundleError('BUNDLE_INVALID', 'Invalid installer URL');
        const url = new URL(value);
        if (
          url.protocol !== 'itms-services:' ||
          url.hostname ||
          url.pathname ||
          url.hash ||
          [...url.searchParams].length !== 2 ||
          url.searchParams.get('action') !== 'download-manifest' ||
          new URL(browserUiUrl(url.searchParams.get('url'))).protocol !== 'https:'
        )
          throw new BundleError('BUNDLE_INVALID', 'Invalid installer URL');
        output[name] = value;
        continue;
      }
      if (field === 'links') {
        output[name] = browserUiUrl(value);
        continue;
      }
      if (!record(value))
        throw new BundleError('BUNDLE_INVALID', `Invalid extension ${field} entry`);
      const title = value.title;
      if (
        Object.keys(value).some(key => !['template', 'title'].includes(key)) ||
        !record(title) ||
        Object.keys(title).some(key => !['en', 'zh_CN'].includes(key)) ||
        typeof title.en !== 'string' ||
        !title.en ||
        title.en.length > 256 ||
        (title.zh_CN !== undefined && (typeof title.zh_CN !== 'string' || title.zh_CN.length > 256))
      )
        throw new BundleError('BUNDLE_INVALID', 'Invalid browser link definition');
      if (name === 'trace')
        browserUiLink(browserUiLinkTemplate(value.template), {
          traceId: '',
          startTime: 0,
          endTime: 0,
        });
      output[name] = { template: browserUiLinkTemplate(value.template), title: { ...title } };
    }
    settings[field] = output;
  }
  return { settings, pending };
}

/** Substitutions are data in a query or fragment; the destination stays fixed. */
export function browserUiLinkTemplate(input: unknown): string {
  if (typeof input !== 'string' || /[{}]/.test(input.split(/[?#]/, 1)[0]))
    throw new BundleError('BUNDLE_INVALID', 'Link variables require a query or fragment');
  const template = browserUiUrl(input);
  const firstData = template.search(/[?#]/);
  if (
    /[{}]/.test(firstData < 0 ? template : template.slice(0, firstData)) ||
    /[{}]/.test(template.replace(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g, ''))
  )
    throw new BundleError('BUNDLE_INVALID', 'Link variables require a query or fragment');
  return template;
}
export function browserUiLink(template: string, values: Record<string, string | number>): string {
  const accepted = browserUiLinkTemplate(template);
  return accepted.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_token, key: string) => {
    if (
      !Object.hasOwn(values, key) ||
      !['string', 'number'].includes(typeof values[key]) ||
      (typeof values[key] === 'number' && !Number.isFinite(values[key]))
    )
      throw new BundleError('BUNDLE_INVALID', 'Missing link value');
    return encodeURIComponent(String(values[key]).toWellFormed());
  });
}

export function captureStorageKeys(settings?: BrowserUiSettings) {
  const namespace = settings?.captureState?.namespace ?? 'capture';
  return {
    modification: namespace + '-modification-enabled',
    allRequests: namespace + '-all-requests-enabled',
    subMode: namespace + '-request-sub-mode',
    listWidth: namespace + '-request-list-width',
  };
}
