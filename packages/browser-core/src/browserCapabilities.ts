import type { AppProfileCatalogEntry, AppProfileSetting, AppProfileUsage } from './appProfileDefinition.js';
import type { GetCapabilitiesParams } from './browserActionProtocol.js';
import { BROWSER_DEVICE_PRESET_NAMES } from './browserActionProtocol.js';

export interface AppCapability {
  id: string;
  label: string;
  source: AppProfileCatalogEntry['source'];
  plugin?: string;
  available: boolean;
  features: string[];
  usage?: AppProfileUsage;
  details?: {
    defaultAppVersion: string;
    bridges: string[];
    methods: Record<string, string[]>;
    behaviors: Record<string, string>;
    settings: AppProfileSetting[];
  };
}

export interface BrowserCapabilityCatalog {
  /** Supported operations, not a grant of page permissions or business authorization. */
  actions: string[];
  devicePresets: string[];
  apps: {
    status: 'available' | 'partial' | 'unsupported';
    entries: AppCapability[];
    issues: Array<{ plugin: string; error: string }>;
  };
  limitations: string[];
  help: { skill: string; commands: string[] };
}

/** Project validated installed metadata without scripts, global values or Mock response bodies. */
export function describeBrowserCapabilities(
  actions: readonly string[],
  catalog: { profiles: AppProfileCatalogEntry[]; errors: Array<{ plugin: string; error: string }>; offline?: boolean } | { apps: BrowserCapabilityCatalog['apps'] } | undefined,
  params: GetCapabilitiesParams = {},
): BrowserCapabilityCatalog {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid capability query');
  if (params.app !== undefined && (typeof params.app !== 'string' || !params.app || params.app.length > 161)) throw new Error('Invalid App capability ID');
  const installed = catalog && 'profiles' in catalog ? catalog : undefined;
  const projected = catalog && 'apps' in catalog ? catalog.apps : undefined;
  if (params.app && installed && !installed.offline && !installed.errors.length && !installed.profiles.some(entry => entry.id === params.app)) throw new Error(`App profile is not installed: ${params.app}`);
  if (params.app && projected?.status === 'available' && !projected.entries.some(entry => entry.id === params.app)) throw new Error(`App profile is not installed: ${params.app}`);
  const supportsApps = actions.includes('set_app_profile');
  const profiles = supportsApps ? installed?.profiles ?? [] : [];
  return {
    actions: [...new Set(actions)],
    devicePresets: actions.includes('set_device_emulation') ? [...BROWSER_DEVICE_PRESET_NAMES] : [],
    apps: supportsApps && projected ? {
      status: projected.status,
      entries: projected.entries.filter(entry => !params.app || entry.id === params.app).map(entry => ({
        id: entry.id, label: entry.label, source: entry.source,
        ...(entry.plugin ? { plugin: entry.plugin } : {}), available: entry.available,
        features: [...entry.features],
        ...(entry.usage ? { usage: structuredClone(entry.usage) } : {}),
        ...(params.app && entry.details ? { details: structuredClone(entry.details) } : {}),
      })),
      issues: projected.issues.map(({ plugin, error }) => ({ plugin, error })),
    } : {
      status: !supportsApps || !installed ? 'unsupported' : installed.offline || installed.errors.length || profiles.some(entry => entry.available === false) ? 'partial' : 'available',
      entries: profiles.filter(entry => !params.app || entry.id === params.app).map(entry => {
        const definition = entry.definition;
        const methods: Record<string, string[]> = {};
        for (const [name, values] of Object.entries(definition.actions)) {
          const names = Array.isArray(values) ? values : Object.keys(values ?? {});
          if (names.length) methods[name] = [...names];
        }
        return {
          id: entry.id, label: entry.label, source: entry.source, plugin: entry.plugin,
          available: entry.available !== false,
          features: ['userAgent', ...(definition.bridges.length ? ['jsBridge'] : []), ...Object.keys(methods), ...(definition.schemes.length ? ['schemes'] : []), ...(definition.settings?.length ? ['settings'] : [])],
          ...(definition.usage ? { usage: structuredClone(definition.usage) } : {}),
          ...(params.app ? { details: {
            defaultAppVersion: definition.defaultAppVersion,
            bridges: definition.bridges.map(bridge => bridge.global),
            methods,
            behaviors: { ...definition.actions.behaviors },
            settings: structuredClone(definition.settings ?? []),
          } } : {}),
        };
      }),
      issues: (installed?.errors ?? projected?.issues)?.map(({ plugin, error }) => ({ plugin, error })) ?? [],
    },
    limitations: [
      'Actions describe support, not current domain permissions, login state or device connectivity.',
      'App profiles simulate a WebView. Declared bridge methods, behaviors and response stubs do not guarantee real native authorization, payment or other business effects.',
      'Package usage and Skill names are guidance from the package author; referenced Skills may need separate installation. Read the relevant help only when needed.',
      ...(!catalog && supportsApps ? ['This Provider does not expose an installed App catalog.'] : []),
    ],
    help: { skill: 'mearl', commands: ['mearl get_capabilities --help', 'mearl set_device_emulation --help', 'mearl set_app_profile --help', 'mearl tab_open --help'] },
  };
}
