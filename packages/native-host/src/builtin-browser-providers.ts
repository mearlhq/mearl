import {
  MEARL_PROVIDER_PROTOCOL_VERSION,
  createProviderRuntime,
  type BrowserProviderDefinition,
  type JsonObject,
  type ProviderBrowser,
  type ProviderRuntime,
} from '@mearl/provider';
import type { TransferableCookie } from './cdp-backend/cookie-transfer.js';
import {
  closeManagedBrowser,
  launchManagedBrowser,
  listManagedBrowsers,
  type ManagedBrowserSummary,
} from './managed-browser.js';
import type { BuiltinBrowserLaunchOptions } from './builtin-provider-options.js';
import { listRegisteredBrowsers } from './browser-registry.js';
import { NATIVE_HOST_VERSION } from './version.js';
import { discoverTargets } from './cdp-backend/discover.js';

const commonLaunchProperties = {
  name: { type: 'string', minLength: 1 },
  persistent: { type: 'boolean', default: true },
  copyCookieDomains: {
    type: 'object',
    component: 'cookie-sync',
    properties: {
      presets: { type: 'array', items: { type: 'string', enum: ['mearl-services'] } },
      domains: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
  },
} as const;

export interface BuiltinProviderDependencies {
  nativeHostScript: string;
  exportCookies: (domains: string[]) => Promise<TransferableCookie[]>;
  log: (...args: any[]) => void;
}

function launchOptions(options: JsonObject): BuiltinBrowserLaunchOptions {
  return options as unknown as BuiltinBrowserLaunchOptions;
}

function connectedBrowserIds(): Set<string> {
  return new Set(
    listRegisteredBrowsers()
      .filter(browser => browser.status === undefined || browser.status === 'connected')
      .map(browser => browser.browserId),
  );
}

function commonDetails(browser: ManagedBrowserSummary): JsonObject {
  return {
    headless: browser.headless,
    createdAt: browser.createdAt,
    ...(browser.copiedCookies
      ? {
          copiedCookies: {
            domains: browser.copiedCookies.domains,
            count: browser.copiedCookies.count,
          },
        }
      : {}),
  };
}

function localBrowser(
  browser: ManagedBrowserSummary,
  connected: ReadonlySet<string>,
): ProviderBrowser {
  const stopped = !browser.running;
  return {
    browserId: browser.browserId,
    name: browser.name,
    status: stopped
      ? 'stopped'
      : connected.has(browser.browserId)
        ? 'connected'
        : 'running_disconnected',
    control: stopped
      ? { kind: 'none' }
      : { kind: 'host', transport: 'cdp', browserId: browser.browserId },
    ownership: 'owned',
    persistence: browser.persistent ? 'persistent' : 'ephemeral',
    operations: stopped ? ['start', 'deleteData'] : ['close', 'deleteData', 'access'],
    references: [{ kind: 'profile', id: browser.browserId, label: 'Profile' }],
    details: {
      ...commonDetails(browser),
      cdpPort: browser.cdpPort,
    },
  };
}

function localDefinition(deps: BuiltinProviderDependencies): BrowserProviderDefinition {
  return {
    descriptor: {
      providerId: 'local',
      name: 'Local Chrome',
      version: NATIVE_HOST_VERSION,
      protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
      builtin: true,
    },
    browserType: {
      name: '本地浏览器',
      inputSchema: {
        type: 'object',
        required: ['name'],
        additionalProperties: true,
        properties: { ...commonLaunchProperties, headless: { type: 'boolean', default: true } },
      },
    },
    listBrowsers: () => {
      const connected = connectedBrowserIds();
      return listManagedBrowsers().map(browser => localBrowser(browser, connected));
    },
    launch: async options => {
      const summary = await launchManagedBrowser(launchOptions(options), {
        nativeHostScript: deps.nativeHostScript,
        exportCookies: deps.exportCookies,
        log: deps.log,
      });
      return localBrowser(summary as ManagedBrowserSummary, connectedBrowserIds());
    },
    start: async ({ browserId }) => {
      const summary = listManagedBrowsers().find(browser => browser.browserId === browserId);
      if (!summary) throw new Error(`Local browser not found: ${browserId}`);
      const launched = await launchManagedBrowser(
        { name: summary.name, persistent: summary.persistent, headless: summary.headless },
        {
          nativeHostScript: deps.nativeHostScript,
          exportCookies: deps.exportCookies,
          log: deps.log,
        },
      );
      return localBrowser(launched as ManagedBrowserSummary, connectedBrowserIds());
    },
    close: ({ browserId, deleteData }) =>
      closeManagedBrowser(browserId, { deleteProfile: deleteData }),
    getAccess: async ({ browserId }) => {
      const browser = listManagedBrowsers().find(item => item.browserId === browserId);
      if (!browser?.running) throw new Error(`Local browser is not running: ${browserId}`);
      const targets = await discoverTargets(browser.cdpPort);
      const pages = targets.filter(target => target.type === 'page');
      const page = pages.find(target => !/^(chrome|devtools):/.test(target.url)) ?? pages[0];
      if (!page) throw new Error('The local browser has no inspectable page');
      const url = new URL('devtools://devtools/bundled/inspector.html');
      url.searchParams.set('ws', `127.0.0.1:${browser.cdpPort}/devtools/page/${page.id}`);
      return { kind: 'cdp-devtools', url: url.toString(), sensitive: true };
    },
  };
}

export function createBuiltinBrowserProviders(
  deps: BuiltinProviderDependencies,
): ProviderRuntime[] {
  return [createProviderRuntime(localDefinition(deps))];
}
