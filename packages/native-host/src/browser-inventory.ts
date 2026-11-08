import type {
  BrowserInfo,
  BrowserListResult,
  BrowserProviderIdentity,
  ManagedBrowserInfo,
} from '@mearl/browser-core';
import type { ProviderBrowser, ProviderDescriptor, ProviderRuntime } from '@mearl/provider';
import { listRegisteredBrowsers, type BrowserRecord } from './browser-registry.js';

type BrowserInventoryResult = Omit<BrowserListResult, 'defaultBrowserId'>;

export interface CdpBrowserDiscovery {
  isPublished: () => boolean;
  isAvailable: () => Promise<boolean>;
  publish: () => boolean;
  monitor: () => void;
}

export function providerIdentity(descriptor: ProviderDescriptor): BrowserProviderIdentity {
  return {
    id: descriptor.providerId,
    name: descriptor.name,
    builtin: descriptor.builtin === true,
    version: descriptor.version,
    protocolVersion: descriptor.protocolVersion,
  };
}

export interface ProviderInventoryBrowser {
  provider: BrowserProviderIdentity;
  browser: ProviderBrowser;
}

/** Register the default CDP browser only after a live browser-level connection succeeds. */
export async function ensureDiscoverableCdpBrowser(
  discovery: CdpBrowserDiscovery,
): Promise<boolean> {
  if (discovery.isPublished()) return true;
  if (!(await discovery.isAvailable())) return false;
  if (!discovery.publish()) return false;
  discovery.monitor();
  return true;
}

function ordinaryBrowser(record: BrowserRecord): BrowserInfo {
  return {
    browserId: record.browserId,
    name: record.browserName,
    type: 'regular',
    status: record.status === 'pairing' ? 'pairing' : 'connected',
    extensionVersion: record.extensionVersion,
    nativeHostVersion: record.nativeHostVersion,
    transport: record.transport,
    pairing: record.pairing,
  };
}

function externalProviderBrowser(record: BrowserRecord): BrowserInfo {
  if (!record.provider || !record.persistence || !record.operations) {
    throw new Error(`Provider browser record is incomplete: ${record.browserId}`);
  }
  const status = record.status ?? 'connected';
  return {
    browserId: record.browserId,
    name: record.browserName,
    type: 'managed',
    status,
    extensionVersion: record.extensionVersion,
    nativeHostVersion: record.nativeHostVersion,
    transport: record.transport,
    provider: record.provider,
    ownership: record.ownership,
    persistence: record.persistence,
    operations: record.operations,
    pairing: record.pairing,
    references: record.references,
    details: record.details,
  };
}

export function providerBrowserInfo(
  entry: ProviderInventoryBrowser,
  route?: BrowserRecord,
): ManagedBrowserInfo {
  const { browser, provider } = entry;
  const status =
    route && (route.status === undefined || route.status === 'connected')
      ? 'connected'
      : browser.status;
  return {
    browserId: browser.browserId,
    name: browser.name,
    type: 'managed',
    status,
    transport:
      route?.transport ??
      (browser.control.kind === 'host'
        ? browser.control.transport
        : provider.builtin
          ? undefined
          : 'provider'),
    extensionVersion: route?.extensionVersion,
    nativeHostVersion: route?.nativeHostVersion,
    provider,
    ownership: browser.ownership,
    persistence: browser.persistence,
    operations: browser.operations,
    pairing: browser.pairing,
    references: browser.references,
    details: browser.details,
  };
}

export function mergeBrowserInventory(
  routes: BrowserRecord[],
  providerBrowsers: ProviderInventoryBrowser[],
): BrowserInventoryResult {
  const providerById = new Map(
    providerBrowsers.map(entry => [entry.browser.browserId, entry] as const),
  );
  const browsers: BrowserInfo[] = [];

  for (const route of routes) {
    const providerEntry = providerById.get(route.browserId);
    if (providerEntry) {
      providerById.delete(route.browserId);
      browsers.push(providerBrowserInfo(providerEntry, route));
    } else if (route.provider || route.transport === 'provider') {
      browsers.push(externalProviderBrowser(route));
    } else {
      browsers.push(ordinaryBrowser(route));
    }
  }

  const inactive = [...providerById.values()]
    .sort((a, b) => {
      const aCreated = String(a.browser.details?.createdAt ?? '');
      const bCreated = String(b.browser.details?.createdAt ?? '');
      return bCreated.localeCompare(aCreated);
    })
    .map(entry => providerBrowserInfo(entry));
  browsers.push(...inactive);

  return {
    count: browsers.length,
    connectedCount: browsers.filter(browser => browser.status === 'connected').length,
    browsers,
  };
}

export async function providerInventory(
  runtimes: ProviderRuntime[],
): Promise<ProviderInventoryBrowser[]> {
  const results = await Promise.all(
    runtimes.map(async runtime => {
      const provider = providerIdentity(runtime.definition.descriptor);
      return (await runtime.listBrowsers()).map(browser => ({ provider, browser }));
    }),
  );
  return results.flat();
}

export async function listBrowserInventory(
  runtimes: ProviderRuntime[],
): Promise<BrowserInventoryResult> {
  return mergeBrowserInventory(listRegisteredBrowsers(), await providerInventory(runtimes));
}
