import {
  assertProviderProtocolVersion,
  validateProviderBrowser,
  validateProviderLaunchForm,
  type JsonObject,
  type ProviderAccess,
  type ProviderBrowser,
  type ProviderBrowserType,
  type ProviderHostContextData,
  type ProviderLaunchForm,
  type ProviderLaunchFormRequest,
} from '@mearl/provider';
import {
  ensureProviderControlHost,
  assertProviderControlSessionMode,
  listInstalledProviders,
  readProviderControlHost,
} from '@mearl/provider/host';
import {
  ensureInstalledProvidersRunning,
  providerBrowserKey,
  readLiveProvider,
} from '@mearl/provider/runtime';
import { listRegisteredBrowsers, type BrowserRecord } from './browser-registry.js';
import { requestBrowserSocket } from './browser-socket-request.js';
import { NATIVE_HOST_VERSION } from './version.js';
import { providerRequestTimeoutMs } from './provider-request-timeout.js';

export interface BrowserProviderSummary {
  provider: {
    id: string;
    name: string;
    builtin: false;
    version: string;
    protocolVersion: number;
  };
  browserType: ProviderBrowserType;
}

export function listExternalBrowserProviders(): BrowserProviderSummary[] {
  return listInstalledProviders().map(provider => ({
    provider: {
      id: provider.providerId,
      name: provider.name,
      builtin: false,
      version: provider.version,
      protocolVersion: provider.protocolVersion,
    },
    browserType: provider.browserType,
  }));
}

export async function getProviderLaunchForm(
  providerId: string,
  request: ProviderLaunchFormRequest,
): Promise<ProviderLaunchForm> {
  const provider = listInstalledProviders().find(item => item.providerId === providerId);
  if (!provider?.browserType.dynamicLaunchForm)
    throw new Error(`Provider does not support dynamic launch forms: ${providerId}`);
  const live = await requireLiveProvider(providerId);
  const form = await requestBrowserSocket(
    live.socketPath,
    'browser_providers',
    { ...request, operation: 'launch_form' },
    NATIVE_HOST_VERSION,
    120_000,
  );
  validateProviderLaunchForm(form);
  return form;
}

async function requireLiveProvider(providerId: string): Promise<{
  socketPath: string;
}> {
  const warnings = await ensureInstalledProvidersRunning([providerId]);
  const warning = warnings.find(item => item.startsWith(`provider ${providerId}:`));
  if (warning) throw new Error(warning);
  const live = readLiveProvider(providerId);
  if (!live) {
    throw new Error(`Provider did not start: ${providerId}`);
  }
  assertProviderProtocolVersion(live.providerProtocolVersion, providerId);
  return {
    socketPath: live.socketPath,
  };
}

export async function launchProviderBrowser(input: {
  provider: string;
  providerOptions: JsonObject;
  host?: ProviderHostContextData;
}): Promise<ProviderBrowser> {
  const providerId = input.provider.trim();
  const provider = listInstalledProviders().find(item => item.providerId === providerId);
  if (!provider) throw new Error(`Provider is not registered: ${providerId}`);
  const live = await requireLiveProvider(providerId);
  const result = (await (input.host
    ? requestBrowserSocket(
        live.socketPath,
        'browser_launch',
        input.providerOptions,
        NATIVE_HOST_VERSION,
        providerRequestTimeoutMs('browser_launch', input.providerOptions),
        undefined,
        input.host,
      )
    : requestBrowserSocket(
        live.socketPath,
        'browser_launch',
        input.providerOptions,
        NATIVE_HOST_VERSION,
        providerRequestTimeoutMs('browser_launch', input.providerOptions),
      ))) as ProviderBrowser;
  validateProviderBrowser(result);
  return { ...result, browserId: providerBrowserKey(providerId, result.browserId) };
}

export function findProviderBrowser(selector: string): BrowserRecord | null {
  const normalized = selector.toLowerCase();
  const providers = listRegisteredBrowsers().filter(browser => browser.transport === 'provider');
  const exact = providers.filter(
    browser =>
      browser.browserId.toLowerCase() === normalized ||
      browser.providerBrowserId?.toLowerCase() === normalized ||
      browser.browserName.toLowerCase() === normalized,
  );
  if (exact.length > 1) throw new Error(`Provider browser selector is ambiguous: ${selector}`);
  if (exact[0])
    assertProviderProtocolVersion(
      exact[0].provider?.protocolVersion,
      exact[0].provider?.id ?? 'Provider',
    );
  return exact[0] ?? null;
}

function requireProviderBrowser(browser: BrowserRecord): string {
  if (browser.transport !== 'provider' || !browser.providerBrowserId) {
    throw new Error(`Browser is not managed by an external Provider: ${browser.browserId}`);
  }
  assertProviderProtocolVersion(
    browser.provider?.protocolVersion,
    browser.provider?.id ?? 'Provider',
  );
  return browser.providerBrowserId;
}

function requestControlledProvider(
  browser: BrowserRecord,
  action: string,
  data: Record<string, any>,
  host?: ProviderHostContextData,
) {
  requireProviderBrowser(browser);
  return ensureProviderControlHost().then(controlHost => {
    assertProviderControlSessionMode(controlHost, browser.capabilities?.controlSessionMode);
    return requestBrowserSocket(
      controlHost.socketPath,
      action,
      data,
      NATIVE_HOST_VERSION,
      providerRequestTimeoutMs(action, data),
      undefined,
      host,
      { providerTarget: browser.browserId },
    );
  });
}

export async function listProviderControlSessions() {
  const host = readProviderControlHost();
  if (!host) return [];
  const result = await requestBrowserSocket(
    host.socketPath,
    'browser_sessions',
    { operation: 'list' },
    NATIVE_HOST_VERSION,
  );
  return result.sessions ?? [];
}

export async function updateProviderControlSession(sessionId: string, operation: string) {
  const host = readProviderControlHost();
  if (!host) throw new Error('CONTROL_SESSION_NOT_FOUND');
  const result = await requestBrowserSocket(
    host.socketPath,
    'browser_sessions',
    { sessionId, operation },
    NATIVE_HOST_VERSION,
  );
  return result.session;
}

export function closeProviderBrowser(
  browser: BrowserRecord,
  options: { deleteProfile?: boolean } = {},
): Promise<unknown> {
  return requestControlledProvider(browser, 'browser_close', {
    deleteProfile: options.deleteProfile === true,
  });
}

export function detachProviderBrowser(browser: BrowserRecord): Promise<unknown> {
  return requestControlledProvider(browser, 'browser_instances', { operation: 'detach' });
}

export async function accessProviderBrowser(browser: BrowserRecord): Promise<ProviderAccess> {
  const result = await requestBrowserSocket(
    browser.socketPath,
    'get_browser_access_url',
    {},
    NATIVE_HOST_VERSION,
    60_000,
    requireProviderBrowser(browser),
  );
  return result.browserAccess;
}

export async function startProviderBrowser(browser: BrowserRecord): Promise<ProviderBrowser> {
  const result = await requestControlledProvider(browser, 'browser_instances', {
    operation: 'start',
  });
  validateProviderBrowser(result);
  return { ...result, browserId: browser.browserId };
}

export function syncProviderBrowserCookies(
  browser: BrowserRecord,
  scope: JsonObject,
  host?: ProviderHostContextData,
): Promise<unknown> {
  return requestControlledProvider(
    browser,
    'browser_instances',
    { operation: 'sync_cookies', scope },
    host,
  );
}

export async function configureProvider(providerId: string, options: JsonObject): Promise<unknown> {
  const provider = listInstalledProviders().find(item => item.providerId === providerId);
  if (!provider?.browserType.configuration)
    throw new Error(`Provider does not support configuration: ${providerId}`);
  const live = await requireLiveProvider(providerId);
  return requestBrowserSocket(
    live.socketPath,
    'browser_providers',
    { operation: 'configure', options },
    NATIVE_HOST_VERSION,
  );
}
