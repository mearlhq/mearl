import type { CloudConnectorInfo, CloudConnectorListResult } from '@mearl/cloud-types';
import { inspectNativeHostInstallation, type NativeHostDiagnostic } from './nativeHost.js';
import type {
  BrowserCapabilities,
  BrowserProviderIdentity,
  BrowserProviderOperation,
} from '@mearl/browser-core';
import {
  UnifiedClient,
  normalizeBrowserSelector,
  type UnifiedClientOptions,
  type UnifiedInvokeOptions,
} from './unified.js';

export interface UnifiedCheckVersions {
  nativeHost?: string;
  extension?: string | null;
  browser?: string | null;
  provider?: ProviderVersionInfo;
}

export interface ProviderVersionInfo {
  id: string;
  name: string;
  builtin: boolean;
  version: string;
  protocolVersion: number;
}

export interface BrowserAccessCapability {
  kind: string;
  label?: string;
  environment?: string;
  port?: number;
}

export type BrowserAccess = BrowserAccessCapability & { url: string };

interface VersionInfo extends UnifiedCheckVersions {
  extensionId?: string;
  setupManagedPath?: string | null;
  browserAccess?: BrowserAccessCapability;
  capabilities?: BrowserCapabilities;
}

interface BrowserInfo {
  browserId: string;
  extensionVersion?: string;
  name: string;
  nativeHostVersion?: string;
  originalBrowserId?: string;
  originalName?: string;
  status: string;
  type?: string;
  provider?: BrowserProviderIdentity;
  ownership?: 'owned' | 'attached';
  persistence?: 'ephemeral' | 'persistent';
  operations?: BrowserProviderOperation[];
  transport?: 'extension' | 'cdp' | 'provider';
}

interface BrowserAccessInfo {
  browserAccess?: BrowserAccess;
}

interface BrowserListResult {
  connectedCount?: number;
  defaultBrowserId?: string | null;
  browsers?: BrowserInfo[];
  warnings?: string[];
}

interface CheckItem {
  status: 'ok' | 'warning' | 'error';
  label: string;
  details?: string[];
}

export interface ExtensionInstallationInfo {
  extensionId: string;
  setupManagedPath: string | null;
}

export interface UnifiedCheckBrowserResult extends BrowserInfo {
  browserAccess?: BrowserAccess;
  capabilities?: BrowserCapabilities;
  check?: {
    errors?: string[];
    label: string;
    status: CheckItem['status'];
    warnings?: string[];
  };
  extensionInstallation?: ExtensionInstallationInfo;
  selected: boolean;
  versions?: UnifiedCheckVersions;
}

export interface UnifiedCheckResult {
  browsers: UnifiedCheckBrowserResult[];
  clientVersion: string;
  connectors: CloudConnectorInfo[];
  environment: CheckItem[];
  ok: boolean;
  updates?: UnifiedCheckUpdate[];
}

export interface UnifiedCheckUpdate {
  component: string;
  installed: string;
  latest?: string;
  status: 'current' | 'available' | 'unavailable';
}

interface CheckClient {
  invoke(action: string, data?: Record<string, any>, options?: UnifiedInvokeOptions): Promise<any>;
  disconnect(): void;
}

export interface UnifiedCheckOptions {
  clientVersion: string;
  serverUrl?: string;
  serverUrlSource?: string;
  timeoutSec?: number;
  browser?: string;
  connector?: string;
  local?: boolean;
  json?: boolean;
  checkUpdates?: boolean;
}

export interface UnifiedCheckDependencies {
  createClient?: (options: UnifiedClientOptions) => CheckClient;
  writeJson?: (json: string) => void;
  writeLine?: (line: string) => void;
  fetchLatestVersion?: (component: string) => Promise<string>;
  inspectNativeHostInstallation?: () => NativeHostDiagnostic[];
}

const UPDATE_SOURCES = {
  client: 'https://registry.npmjs.org/@mearl%2Fclient/latest',
  'native-host': 'https://registry.npmjs.org/@mearl%2Fnative-host/latest',
  'cloud-connector': 'https://registry.npmjs.org/@mearl%2Fcloud-connector/latest',
  extension: 'https://mearlhq.github.io/mearl/config.json',
} as const;

type UpdateComponent = keyof typeof UPDATE_SOURCES;

export function parseReleaseVersion(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.exec(value);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
  if (!parts.every(Number.isSafeInteger)) return null;
  return [...parts.slice(0, 3), match[4] === undefined ? 1 : 0, parts[3]!];
}

export function isNewerRelease(latest: string, installed: string): boolean {
  const latestParts = parseReleaseVersion(latest);
  const installedParts = parseReleaseVersion(installed);
  if (!latestParts || !installedParts) return false;
  for (let index = 0; index < latestParts.length; index++) {
    if (latestParts[index]! !== installedParts[index]!) {
      return latestParts[index]! > installedParts[index]!;
    }
  }
  return false;
}

async function fetchLatestVersion(component: string): Promise<string> {
  const source =
    component === 'extension'
      ? process.env.MEARL_EXTENSION_CONFIG_URL || UPDATE_SOURCES.extension
      : UPDATE_SOURCES[component as UpdateComponent];
  const response = await fetch(source, {
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { version?: unknown; latestVersion?: unknown };
  const version =
    component === 'extension' ? (payload.latestVersion ?? payload.version) : payload.version;
  if (!parseReleaseVersion(version)) throw new Error('Invalid release version');
  return version as string;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function browserAccessLabel(access: BrowserAccessCapability): string {
  return access.label || access.kind;
}

async function getBrowserAccess(
  client: CheckClient,
  browser: BrowserInfo,
  capability: BrowserAccessCapability | undefined,
  timeoutSec: number,
): Promise<BrowserAccess> {
  const result = (await client.invoke(
    'get_browser_access_url',
    {},
    { timeoutSec, browser: browser.browserId },
  )) as BrowserAccessInfo;
  if (!result.browserAccess?.url) throw new Error('Browser host did not return an access URL');
  if (capability && result.browserAccess.kind !== capability.kind) {
    throw new Error('Browser host returned an unexpected access URL type');
  }
  return result.browserAccess;
}

function redactServerUrl(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl);
    for (const key of parsed.searchParams.keys()) {
      if (key.toLowerCase().includes('token')) parsed.searchParams.set(key, 'redacted');
    }
    return parsed.toString();
  } catch {
    return serverUrl.replace(/([?&][^=&\s]*token[^=&\s]*=)[^&\s]*/gi, '$1redacted');
  }
}

function browserMatches(browser: BrowserInfo, selector: string): boolean {
  const normalized = normalizeBrowserSelector(selector);
  return (
    browser.browserId.toLowerCase() === normalized ||
    browser.originalBrowserId?.toLowerCase() === normalized ||
    browser.name.toLowerCase() === normalized ||
    browser.originalName?.toLowerCase() === normalized
  );
}

function findBrowsers(browsers: BrowserInfo[], selector: string): BrowserInfo[] {
  const exact = browsers.filter(browser => browserMatches(browser, selector));
  if (exact.length > 0) return exact;
  const normalized = normalizeBrowserSelector(selector);
  return browsers.filter(
    browser =>
      browser.browserId.toLowerCase().includes(normalized) ||
      browser.originalBrowserId?.toLowerCase().includes(normalized) ||
      browser.name.toLowerCase().includes(normalized) ||
      browser.originalName?.toLowerCase().includes(normalized),
  );
}

function shortBrowserId(browserId: string): string {
  const parts = browserId.split(':');
  const raw = decodeURIComponent(parts.at(-1) ?? browserId);
  return raw.length > 12 ? `${raw.slice(0, 8)}…` : raw;
}

function formatBrowser(browser: BrowserInfo, isDefault: boolean): string {
  const transport =
    browser.transport === 'cdp'
      ? ' [CDP]'
      : browser.transport === 'extension'
        ? ' [Extension]'
        : browser.transport === 'provider'
          ? ` [Provider: ${browser.provider?.name || browser.provider?.id || 'external'}]`
          : '';
  const type = browser.type === 'managed' ? ' [Managed]' : '';
  return `  ${isDefault ? '★' : ' '} ${browser.name} [${shortBrowserId(browser.browserId)}]${type}${transport}`;
}

function formatConnector(connector: CloudConnectorInfo): string {
  const id =
    connector.connectorId.length > 12
      ? `${connector.connectorId.slice(0, 8)}…`
      : connector.connectorId;
  const version = connector.version ? ` [v${connector.version}]` : '';
  return `    ${connector.name} [${id}]${version}`;
}

function printSection(writeLine: (line: string) => void, title: string, items: CheckItem[]): void {
  writeLine(title);
  for (const item of items) {
    const marker = item.status === 'ok' ? '✅' : item.status === 'warning' ? '⚠️ ' : '❌';
    writeLine(`  ${marker} ${item.label}`);
    for (const detail of item.details ?? []) writeLine(`     ${detail}`);
  }
  writeLine('');
}

export function parseCheckTimeout(value: string | undefined): number | null {
  const input = value ?? '5';
  if (!/^[1-9]\d*$/.test(input)) return null;
  const timeoutSec = Number(input);
  return Number.isSafeInteger(timeoutSec) ? timeoutSec : null;
}

export function runUnifiedCheck(
  options: UnifiedCheckOptions & { json: true },
  dependencies?: UnifiedCheckDependencies,
): Promise<UnifiedCheckResult>;
export function runUnifiedCheck(
  options: UnifiedCheckOptions,
  dependencies?: UnifiedCheckDependencies,
): Promise<boolean>;
export async function runUnifiedCheck(
  options: UnifiedCheckOptions,
  dependencies: UnifiedCheckDependencies = {},
): Promise<boolean | UnifiedCheckResult> {
  const timeoutSec = options.timeoutSec ?? 5;
  const writeLine = dependencies.writeLine ?? (line => console.error(line));
  const writeJson = dependencies.writeJson ?? (json => process.stdout.write(`${json}\n`));
  const createClient =
    dependencies.createClient ??
    ((clientOptions: UnifiedClientOptions) => new UnifiedClient(clientOptions));
  const client = createClient({
    ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
    connectTimeoutSec: timeoutSec,
    requestTimeoutSec: timeoutSec,
  });
  const latestVersions = options.checkUpdates
    ? Promise.allSettled(
        (Object.keys(UPDATE_SOURCES) as UpdateComponent[]).map(component =>
          (dependencies.fetchLatestVersion ?? fetchLatestVersion)(component),
        ),
      )
    : null;

  const environment: CheckItem[] = [
    { status: 'ok', label: `Unified client v${options.clientVersion}` },
  ];
  let connectors: CloudConnectorInfo[] = [];
  let browserList: BrowserListResult | null = null;

  try {
    if (options.local) {
      environment.push({
        status: 'ok',
        label: 'Browser scope: this machine',
      });
    } else if (options.serverUrl) {
      const source = options.serverUrlSource ? ` (${options.serverUrlSource})` : '';
      try {
        const connectorList = (await client.invoke(
          'connector_list',
          {},
          { timeoutSec },
        )) as CloudConnectorListResult;
        connectors = Array.isArray(connectorList?.connectors) ? connectorList.connectors : [];
        environment.push({
          status: 'ok',
          label: `Cloud server${source}`,
          details: [
            redactServerUrl(options.serverUrl),
            `${connectors.length} connector${connectors.length === 1 ? '' : 's'} connected`,
          ],
        });
      } catch (error) {
        environment.push({
          status: 'error',
          label: `Cloud server or connector discovery failed${source}`,
          details: [
            formatError(error),
            redactServerUrl(options.serverUrl),
            'On the Agent machine, run `mearl-cloud-server status` to verify the server and current connection command. Use `mearl check --local` to isolate this machine.',
          ],
        });
      }
    } else {
      environment.push({ status: 'ok', label: 'Local mode (no cloud-server configuration)' });
    }

    const inventoryOptions: UnifiedInvokeOptions = {
      timeoutSec,
      ...(options.local ? { local: true } : {}),
      ...(!options.local && options.connector ? { connector: options.connector } : {}),
    };
    try {
      if (
        options.serverUrl &&
        !options.local &&
        environment.some(item => item.status === 'error')
      ) {
        browserList = (await client.invoke(
          'browser_list',
          {},
          {
            timeoutSec,
            local: true,
          },
        )) as BrowserListResult;
      } else {
        browserList = (await client.invoke(
          'browser_list',
          {},
          inventoryOptions,
        )) as BrowserListResult;
      }
      environment.push({ status: 'ok', label: 'Browser inventory' });
      if (browserList.warnings?.length) {
        environment.push({
          status: 'warning',
          label: 'Some browser sources could not be inspected',
          details: browserList.warnings,
        });
      }
    } catch (error) {
      environment.push({
        status: 'error',
        label: 'Browser inventory failed',
        details: [formatError(error)],
      });
    }

    const connected = (browserList?.browsers ?? []).filter(
      browser => browser.status === 'connected',
    );
    if (
      (options.local || !options.serverUrl) &&
      !connected.some(browser => browser.transport === 'extension')
    ) {
      const diagnostics = (
        dependencies.inspectNativeHostInstallation ?? inspectNativeHostInstallation
      )();
      environment.push(...diagnostics.map(item => ({ status: 'warning' as const, ...item })));
    }
    let targets = connected;
    if (options.browser) {
      const matches = findBrowsers(connected, options.browser);
      if (matches.length === 0) {
        environment.push({
          status: 'error',
          label: `Browser "${options.browser}" is not connected`,
          details: ['Run `mearl browser_list` and use an exact global browserId.'],
        });
        targets = [];
      } else if (matches.length > 1) {
        environment.push({
          status: 'error',
          label: `Browser selector "${options.browser}" is ambiguous`,
          details: matches.map(browser => browser.browserId),
        });
        targets = [];
      } else {
        targets = matches;
      }
    }

    if (!options.browser && connected.length === 0 && browserList) {
      environment.push({
        status: 'error',
        label: 'No connected browser',
        details: [
          'Open Chrome with the Mearl extension, start a managed browser, or attach an existing browser with a Provider.',
          ...(!options.local && connectors.length > 0
            ? [
                'Connectors are connected but expose no ready browser. On the browser machine, run `mearl check --local`; use `mearl connector_list` for versions and heartbeat details.',
              ]
            : []),
        ],
      });
    }

    const browserChecks: Array<{
      browserAccess?: BrowserAccess;
      browser: BrowserInfo;
      capabilities?: BrowserCapabilities;
      extensionInstallation?: ExtensionInstallationInfo;
      errors?: string[];
      item: CheckItem;
      versions?: UnifiedCheckVersions;
      warnings?: string[];
    }> = [];
    await Promise.all(
      targets.map(async browser => {
        try {
          const versions = (await client.invoke(
            'get_versions',
            {},
            {
              timeoutSec,
              browser: browser.browserId,
            },
          )) as VersionInfo;
          if (browser.transport === 'cdp' && options.browser)
            await client.invoke('tab_list', {}, { timeoutSec, browser: browser.browserId });
          const publicVersions: UnifiedCheckVersions = {
            ...(versions.nativeHost ? { nativeHost: versions.nativeHost } : {}),
            ...(versions.extension !== undefined ? { extension: versions.extension } : {}),
            ...(versions.browser !== undefined ? { browser: versions.browser } : {}),
            ...(versions.provider ? { provider: versions.provider } : {}),
          };
          const details = [
            versions.nativeHost ? `native-host v${versions.nativeHost}` : null,
            versions.extension ? `extension v${versions.extension}` : null,
            versions.browser ? `Chrome ${versions.browser}` : null,
            versions.provider
              ? `${versions.provider.name} v${versions.provider.version} (protocol v${versions.provider.protocolVersion})`
              : null,
          ].filter((value): value is string => value !== null);
          const capabilities = options.browser ? versions.capabilities : undefined;
          if (capabilities) {
            details.push(
              `capabilities (${capabilities.actions.length}): ${capabilities.actions.join(', ') || 'none'}`,
              `screenshot: ${capabilities.screenshot}`,
            );
          }
          let extensionInstallation: ExtensionInstallationInfo | undefined;
          if (
            options.local &&
            browser.transport === 'extension' &&
            typeof versions.extensionId === 'string' &&
            typeof versions.extension === 'string' &&
            (typeof versions.setupManagedPath === 'string' || versions.setupManagedPath === null)
          ) {
            extensionInstallation = {
              extensionId: versions.extensionId,
              setupManagedPath: versions.setupManagedPath,
            };
          }
          let browserAccess: BrowserAccess | undefined;
          let accessUrlWarning: string | undefined;
          const browserAccessCapability = versions.browserAccess;
          const providerAccess = browser.operations?.includes('access') === true;
          if ((providerAccess || browserAccessCapability) && options.browser) {
            try {
              browserAccess = await getBrowserAccess(
                client,
                browser,
                providerAccess ? undefined : browserAccessCapability,
                timeoutSec,
              );
              details.push(
                `Browser access URL (${browserAccessLabel(browserAccess)}; sensitive): ${browserAccess.url}`,
              );
            } catch (error) {
              accessUrlWarning = formatError(error);
              details.push(`Browser access URL unavailable: ${accessUrlWarning}`);
            }
          }
          browserChecks.push({
            ...(browserAccess ? { browserAccess } : {}),
            browser,
            ...(capabilities ? { capabilities } : {}),
            ...(extensionInstallation ? { extensionInstallation } : {}),
            item: {
              status: accessUrlWarning ? 'warning' : 'ok',
              label: accessUrlWarning
                ? 'Browser command path ready; browser access URL unavailable'
                : 'Browser command path',
              details,
            },
            versions: publicVersions,
            ...(accessUrlWarning ? { warnings: [accessUrlWarning] } : {}),
          });
        } catch (error) {
          const message = formatError(error);
          browserChecks.push({
            browser,
            ...(message.includes('Unknown action')
              ? { warnings: ['Update @mearl/native-host for complete diagnostics.'] }
              : { errors: [message] }),
            item: message.includes('Unknown action')
              ? {
                  status: 'warning',
                  label: 'Browser is reachable but runtime version details are unavailable',
                  details: ['Update @mearl/native-host for complete diagnostics.'],
                }
              : {
                  status: 'error',
                  label: 'Browser command path failed',
                  details: [message],
                },
          });
        }
      }),
    );

    let updates: UnifiedCheckUpdate[] | undefined;
    if (latestVersions) {
      const latestResults = await latestVersions;
      const components = Object.keys(UPDATE_SOURCES) as UpdateComponent[];
      const installed = new Map<UpdateComponent, Set<string>>();
      const addInstalled = (component: UpdateComponent, version: string | null | undefined) => {
        if (!version) return;
        const versions = installed.get(component) ?? new Set<string>();
        versions.add(version);
        installed.set(component, versions);
      };
      addInstalled('client', options.clientVersion);
      for (const check of browserChecks) {
        addInstalled('native-host', check.versions?.nativeHost);
        addInstalled('extension', check.versions?.extension);
      }
      for (const connector of connectors) addInstalled('cloud-connector', connector.version);
      updates = components.flatMap((component, index) => {
        const result = latestResults[index]!;
        return [...(installed.get(component) ?? [])].map(version => ({
          component,
          installed: version,
          ...(result.status === 'fulfilled' ? { latest: result.value } : {}),
          status:
            result.status === 'rejected' ||
            !parseReleaseVersion(version) ||
            !parseReleaseVersion(result.value)
              ? ('unavailable' as const)
              : isNewerRelease(result.value, version)
                ? ('available' as const)
                : ('current' as const),
        }));
      });
      const available = updates.filter(update => update.status === 'available');
      const unavailable = updates.filter(update => update.status === 'unavailable');
      const packageUpdateAvailable = available.some(
        update => update.component === 'client' || update.component === 'native-host',
      );
      const extensionUpdateAvailable = available.some(update => update.component === 'extension');
      const connectorUpdateAvailable = available.some(
        update => update.component === 'cloud-connector',
      );
      environment.push({
        status: available.length || unavailable.length ? 'warning' : 'ok',
        label: available.length
          ? `${available.length} Mearl update${available.length === 1 ? '' : 's'} available`
          : unavailable.length
            ? 'Mearl update check incomplete'
            : 'Mearl packages are current',
        details: [
          ...available.map(update => `${update.component}: ${update.installed} → ${update.latest}`),
          ...(packageUpdateAvailable
            ? ['Update on the affected machine: npx @mearl/setup update']
            : []),
          ...(extensionUpdateAvailable
            ? ['Update a setup-managed extension: npx @mearl/setup extension']
            : []),
          ...(connectorUpdateAvailable
            ? ['Update cloud-connector with its package manager on the connector machine.']
            : []),
          ...unavailable.map(update => `${update.component}: latest version unavailable`),
        ],
      });
    }

    const hasError =
      environment.some(item => item.status === 'error') ||
      browserChecks.some(check => check.item.status === 'error');
    const listedBrowsers = browserList?.browsers ?? [];
    if (options.json) {
      const result: UnifiedCheckResult = {
        browsers: listedBrowsers.map(browser => {
          const check = browserChecks.find(item => item.browser.browserId === browser.browserId);
          const browserIdentity = { ...browser };
          delete browserIdentity.extensionVersion;
          delete browserIdentity.nativeHostVersion;
          return {
            ...browserIdentity,
            selected: targets.some(target => target.browserId === browser.browserId),
            ...(check?.browserAccess ? { browserAccess: check.browserAccess } : {}),
            ...(check?.capabilities ? { capabilities: check.capabilities } : {}),
            ...(check?.item
              ? {
                  check: {
                    label: check.item.label,
                    status: check.item.status,
                    ...(check.errors ? { errors: check.errors } : {}),
                    ...(check.warnings ? { warnings: check.warnings } : {}),
                  },
                }
              : {}),
            ...(check?.extensionInstallation
              ? { extensionInstallation: check.extensionInstallation }
              : {}),
            ...(check?.versions ? { versions: check.versions } : {}),
          };
        }),
        clientVersion: options.clientVersion,
        connectors,
        environment,
        ok: !hasError,
        ...(updates ? { updates } : {}),
      };
      writeJson(JSON.stringify(result, null, 2));
      return result;
    }

    writeLine('');
    printSection(writeLine, 'Environment', environment);

    if (connectors.length > 0) {
      writeLine('Cloud connectors');
      for (const connector of connectors) writeLine(formatConnector(connector));
      writeLine('');
    }

    if (listedBrowsers.length > 0) {
      writeLine('Browsers');
      for (const browser of listedBrowsers) {
        writeLine(formatBrowser(browser, browser.browserId === browserList?.defaultBrowserId));
        const check = browserChecks.find(item => item.browser.browserId === browser.browserId);
        if (check) {
          const marker =
            check.item.status === 'ok' ? '✅' : check.item.status === 'warning' ? '⚠️ ' : '❌';
          writeLine(`      ${marker} ${check.item.label}`);
          for (const detail of check.item.details ?? []) writeLine(`         ${detail}`);
        } else if (browser.status !== 'connected') {
          writeLine(`      ⚪ ${browser.status}`);
        }
      }
      writeLine('');
    }

    if (hasError) {
      writeLine('⚠️  Mearl checks failed. See the browser or source details above.');
      return false;
    }
    writeLine(
      options.browser
        ? '🎉 Selected browser is ready!'
        : `🎉 All ${targets.length} connected browser${targets.length === 1 ? '' : 's'} are ready!`,
    );
    return true;
  } finally {
    client.disconnect();
  }
}
