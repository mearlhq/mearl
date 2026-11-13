import { invokePageEvalWithArgs } from './pageEvalArguments.js';
import { stageFile, exportArtifact } from './artifacts.js';
import type { BrowserArtifact } from '@mearl/browser-core';
import WebSocket, { WebSocket as WebSocketType } from 'ws';
import {
  DEFAULT_CONNECT_TIMEOUT,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_REQUEST_TIMEOUT,
  MAX_BUFFER_SIZE,
  isHeartbeatMessage,
  resolveCloudConnectorSelector,
  type AgentHelloMessage,
  type CloudConnectorInfo,
  type CloudConnectorListResult,
  type CloudMessage,
  type CloudResponse,
  type HeartbeatMessage,
} from '@mearl/cloud-types';
import { resolveActionTimeoutSec } from './actionTimeouts.js';
import {
  validateRequiredActionTabId,
  parseBrowserListParams,
  type BrowserSource,
} from '@mearl/browser-core';
import type { PluginInvocation, PluginInvokeOptions } from './plugins/sdk/plugin.js';
import { invoke as invokeLocalBrowser, resolveLocalActionTarget } from './socket.js';
import { loadCloudServerConfig, loadLocalConnectorId } from './unifiedConfig.js';

const RESPONSE_GRACE_MS = 1_000;
const GLOBAL_BROWSER_PREFIX = 'mearl:';

export interface UnifiedInvokeOptions {
  /** Use new on the first tab_open/page_snapshot, then reuse the returned id. */
  session?: string;
  /** Source-local session id used by transport adapters. */
  controlSessionId?: string;
  timeoutSec?: number;
  /** Global browser id, source-local browser id, or unique browser name. */
  browser?: string;
  /** Restrict the action to one remote connector. */
  connector?: string;
  /** Restrict the action to browsers on this machine. */
  local?: boolean;
}

export interface UnifiedClientOptions {
  serverUrl?: string;
  /** Absolute deadline shared by all requests from a script. */
  requestDeadline?: number;
  connectTimeoutSec?: number;
  requestTimeoutSec?: number;
  heartbeatInterval?: number;
  defaultBrowser?: string;
  defaultConnector?: string;
}

interface PinnedPageEvalOptions extends UnifiedInvokeOptions {
  socketPath?: string;
}

interface BrowserTarget {
  browser: string;
  connector?: string;
}

interface BrowserRecord {
  browserId: string;
  name: string;
  originalBrowserId?: string;
  originalName?: string;
  status: string;
  source?: BrowserSource;
  [key: string]: any;
}

interface BrowserListResult {
  count: number;
  connectedCount: number;
  defaultBrowserId: string | null;
  browsers: BrowserRecord[];
  warnings?: string[];
}

interface RemoteBrowserListing {
  connector: CloudConnectorInfo;
  listing: any;
}

function encodeBrowserTarget(target: BrowserTarget): string {
  const browser = encodeURIComponent(target.browser).replace(/%3A/g, ':');
  return target.connector
    ? `${GLOBAL_BROWSER_PREFIX}remote:${encodeURIComponent(target.connector)}:${browser}`
    : `${GLOBAL_BROWSER_PREFIX}local:${browser}`;
}

function omitTransientBrowserSecrets(browser: Record<string, any>): Record<string, any> {
  const safeBrowser = { ...browser };
  for (const key of Object.keys(safeBrowser)) {
    if (/accessUrl$/i.test(key)) delete safeBrowser[key];
  }
  return safeBrowser;
}

export function decodeBrowserTarget(selector: string | undefined): BrowserTarget | undefined {
  if (!selector?.startsWith(GLOBAL_BROWSER_PREFIX)) return undefined;
  try {
    const target = selector.slice(GLOBAL_BROWSER_PREFIX.length);
    if (target.startsWith('local:')) {
      const browser = decodeURIComponent(target.slice('local:'.length));
      return browser ? { browser } : undefined;
    }
    if (target.startsWith('remote:')) {
      const remoteTarget = target.slice('remote:'.length);
      const separator = remoteTarget.indexOf(':');
      if (separator < 0) return undefined;
      const connector = decodeURIComponent(remoteTarget.slice(0, separator));
      const browser = decodeURIComponent(remoteTarget.slice(separator + 1));
      return connector && browser ? { connector, browser } : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function normalizeBrowserSelector(selector: string): string {
  const decodedTarget = decodeBrowserTarget(selector);
  return (decodedTarget ? encodeBrowserTarget(decodedTarget) : selector.trim()).toLowerCase();
}

interface ControlSessionTarget {
  browser: string;
  id: string;
  transport: 'extension' | 'cdp' | 'provider';
}

function decorateBrowser(browser: Record<string, any>, source: BrowserSource): BrowserRecord {
  const safeBrowser = omitTransientBrowserSecrets(browser);
  const originalBrowserId = String(browser.browserId);
  const originalName = String(browser.name);
  return {
    ...safeBrowser,
    browserId: encodeBrowserTarget({
      browser: originalBrowserId,
      ...(source.connectorId ? { connector: source.connectorId } : {}),
    }),
    name:
      source.kind === 'local'
        ? `[this machine] ${originalName}`
        : `[${source.connectorName}] ${originalName}`,
    originalBrowserId,
    originalName,
    status: typeof browser.status === 'string' ? browser.status : 'disconnected',
    source,
  };
}

function browserMatches(browser: BrowserRecord, selector: string): boolean {
  const normalized = normalizeBrowserSelector(selector);
  return (
    browser.browserId.toLowerCase() === normalized ||
    browser.originalBrowserId?.toLowerCase() === normalized ||
    browser.name.toLowerCase() === normalized ||
    browser.originalName?.toLowerCase() === normalized
  );
}

function findBrowsers(
  browsers: BrowserRecord[],
  selector: string,
  connectedOnly = true,
): BrowserRecord[] {
  const candidates = connectedOnly
    ? browsers.filter(browser => browser.status === 'connected')
    : browsers;
  const exact = candidates.filter(browser => browserMatches(browser, selector));
  if (exact.length > 0) return exact;
  const normalized = normalizeBrowserSelector(selector);
  return candidates.filter(
    browser =>
      browser.browserId.toLowerCase().includes(normalized) ||
      browser.originalBrowserId?.toLowerCase().includes(normalized) ||
      browser.name.toLowerCase().includes(normalized) ||
      browser.originalName?.toLowerCase().includes(normalized),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class UnifiedClient {
  private readonly requestDeadline?: number;
  private readonly controlSessions = new Map<string, ControlSessionTarget>();
  private readonly options: {
    serverUrl?: string;
    connectTimeoutSec: number;
    requestTimeoutSec: number;
    heartbeatInterval: number;
  };
  private defaultBrowser: string | undefined;
  private defaultConnector: string | undefined;
  private ws: WebSocketType | null = null;
  private connectPromise: Promise<void> | null = null;
  private messageBuffer = '';
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closing = false;

  constructor(options: UnifiedClientOptions = {}) {
    this.requestDeadline = options.requestDeadline;
    this.options = {
      ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
      connectTimeoutSec: options.connectTimeoutSec ?? DEFAULT_CONNECT_TIMEOUT,
      requestTimeoutSec: options.requestTimeoutSec ?? DEFAULT_REQUEST_TIMEOUT,
      heartbeatInterval: options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
    };
    this.defaultBrowser =
      options.defaultBrowser ?? (process.env.MEARL_BROWSER?.trim() || undefined);
    this.defaultConnector = options.defaultConnector;
  }

  disconnect(): void {
    this.closing = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.rejectAllPending(new Error('Connection closed by user'));
    this.ws?.close();
    this.ws = null;
  }

  async invokePlugin(
    name: string,
    invocation: PluginInvocation,
    options: PluginInvokeOptions = {},
  ): Promise<unknown> {
    const { invokeRegisteredPlugin } = await import('./plugins/sdk/plugin.js');
    return invokeRegisteredPlugin(
      name,
      invocation,
      {
        invoke: (action, payload, invokeOptions) => this.invoke(action, payload, invokeOptions),
        runModel: async (plugin, request, execution) => {
          const { PluginModelClient } = await import('./plugins/clients/pluginModels.js');
          const models = new PluginModelClient({ source: options.source ?? 'sdk' });
          try {
            return await models.run(plugin, request, {
              signal: execution.signal,
              onProgress: progress => {
                if (progress !== undefined) execution.onProgress?.(progress);
              },
            });
          } finally {
            models.disconnect();
          }
        },
      },
      options,
    );
  }

  async invoke(
    action: string,
    data: Record<string, any> = {},
    options: UnifiedInvokeOptions = {},
  ): Promise<any> {
    const discovery = action === 'browser_list' ? parseBrowserListParams(data) : undefined;
    if (
      discovery &&
      (!options.local || options.connector || options.session || options.controlSessionId)
    )
      throw new Error(
        'Provider discovery requires explicit --local without connector or session overrides',
      );
    if (action === 'plugin_state') {
      const { PluginStateClient } = await import('./plugins/clients/pluginState.js');
      const state = new PluginStateClient();
      try {
        return await state.call(
          String(data.plugin ?? ''),
          data.collection,
          data.operation,
          data,
          options,
        );
      } finally {
        state.disconnect();
      }
    }
    if (action === 'plugin_model') {
      const { PluginModelClient } = await import('./plugins/clients/pluginModels.js');
      const models = new PluginModelClient();
      try {
        if (data.operation === 'capabilities') return await models.capabilities();
        if (data.operation === 'list') return await models.list(data.provider);
        if (data.operation === 'start')
          return await models.start(
            String(data.plugin ?? ''),
            data.request,
            data.taskOptions ?? {},
          );
        if (data.operation === 'run')
          return await models.run(String(data.plugin ?? ''), data.request, data.taskOptions ?? {});
        throw new Error('Invalid model operation');
      } finally {
        models.disconnect();
      }
    }
    if (action === 'plugin_page') {
      const { PluginHostConnection } = await import('./plugins/clients/pluginHostConnection.js');
      const { PluginPageClient } = await import('./plugins/clients/pluginPages.js');
      const connection = new PluginHostConnection();
      const pages = new PluginPageClient({}, connection);
      try {
        const pinned = ['attach', 'activation'].includes(data.operation)
          ? await this.pinBrowserTarget(options)
          : options;
        return await pages.call(String(data.plugin ?? ''), data.operation, data, pinned);
      } finally {
        pages.disconnect();
        connection.disconnect();
      }
    }
    if (options.session && options.session !== 'new') {
      const session = await this.resolveControlSession(options.session, options);
      const selected = decodeBrowserTarget(options.browser);
      const pinned = decodeBrowserTarget(session.browser);
      if (
        options.browser &&
        (!selected ||
          selected.browser !== pinned?.browser ||
          selected.connector !== pinned?.connector)
      ) {
        throw new Error('The selected browser does not match the control session');
      }
      options = {
        ...options,
        browser: session.browser,
        controlSessionId: session.id,
      };
    } else if (options.session === 'new') {
      if (!['tab_open', 'page_snapshot', 'page_screenshot'].includes(action))
        throw new Error('--session new requires tab_open, page_snapshot or page_screenshot');
      options = { ...options, controlSessionId: 'new' };
    }
    if (action === 'page_eval' && data.args !== undefined) {
      let pinnedOptions: PinnedPageEvalOptions = {
        ...options,
        ...(options.browser || !this.defaultBrowser ? {} : { browser: this.defaultBrowser }),
        ...(options.connector ||
        !this.defaultConnector ||
        decodeBrowserTarget(options.browser ?? this.defaultBrowser)
          ? {}
          : { connector: this.defaultConnector }),
      };
      let targetPinned = false;
      return invokePageEvalWithArgs(async (request, transfer) => {
        if (transfer && !targetPinned) {
          pinnedOptions = await this.pinPageEvalTarget(pinnedOptions, request);
          targetPinned = true;
        }
        return this.invokeRouted(action, request, pinnedOptions);
      }, data as any);
    }
    if (
      action === 'page_upload' &&
      data.files !== undefined &&
      (!Array.isArray(data.files) ||
        !data.files.length ||
        data.files.some(
          (file: any) =>
            !file || (typeof file.filePath === 'string') === (typeof file.artifactId === 'string'),
        ))
    )
      throw new Error('files requires exactly one filePath or artifactId per entry');
    if (
      action === 'page_upload' &&
      Array.isArray(data.files) &&
      data.files.some((file: any) => file.filePath)
    ) {
      if (data.filePaths) throw new Error('Use files or filePaths, not both');
      const staged: Array<{ artifactId: string }> = [];
      const temporary: string[] = [];
      try {
        for (const file of data.files) {
          if (file.filePath) {
            const uploaded = await stageFile(this, file.filePath, options);
            options = uploaded.options;
            temporary.push(uploaded.artifactId);
            staged.push({ artifactId: uploaded.artifactId });
          } else staged.push(file);
        }
        return await this.invokeRouted(action, { ...data, files: staged }, options);
      } finally {
        for (const id of temporary)
          await this.invoke('__artifact_remove', { artifactId: id }, options).catch(() => {});
      }
    }
    return this.invokeRouted(action, data, options);
  }

  saveArtifact(
    artifact: BrowserArtifact & { browserId?: string },
    outputPath: string,
    options: UnifiedInvokeOptions = {},
  ) {
    return exportArtifact(this, artifact, outputPath, options);
  }

  async pinBrowserTarget(options: UnifiedInvokeOptions = {}): Promise<UnifiedInvokeOptions> {
    const selector = options.browser ?? this.defaultBrowser;
    if (decodeBrowserTarget(selector)) return { ...options, browser: selector };
    const listing = (await this.invoke(
      'browser_list',
      {},
      {
        ...options,
        ...(options.connector || !this.defaultConnector
          ? {}
          : { connector: this.defaultConnector }),
      },
    )) as BrowserListResult;
    const connected = listing.browsers.filter(browser => browser.status === 'connected');
    const matches = selector
      ? findBrowsers(connected, selector)
      : connected.filter(browser => browser.browserId === listing.defaultBrowserId);
    const target = matches.length ? matches : selector ? [] : connected;
    if (target.length !== 1)
      throw new Error('Plugin pages require an explicit, connected and unambiguous browser target');
    const pinned = { ...options, browser: target[0].browserId };
    delete pinned.connector;
    return pinned;
  }

  private async pinPageEvalTarget(
    options: UnifiedInvokeOptions,
    data: Record<string, unknown>,
  ): Promise<PinnedPageEvalOptions> {
    const target = decodeBrowserTarget(options.browser);
    if (target && !options.connector) return options;
    const local = options.local || (!this.options.serverUrl && !options.connector);
    if (local) {
      const resolved = resolveLocalActionTarget('page_eval', data, {
        browser: options.browser,
      });
      if (resolved?.socketPath) return { ...options, socketPath: resolved.socketPath };
      if (resolved?.browser)
        return { ...options, browser: encodeBrowserTarget({ browser: resolved.browser }) };
    }
    if (options.connector && !options.browser) {
      const timeoutSec = options.timeoutSec ?? this.options.requestTimeoutSec;
      const connector = await this.resolveConnector(options.connector, timeoutSec);
      const resolved = await this.requestRemote(
        '__resolve_action_target',
        { action: 'page_eval', data },
        timeoutSec,
        undefined,
        connector.connectorId,
      );
      if (!resolved?.browser)
        throw new Error(
          'Cannot pin the connector browser for large page_eval arguments. Pass --browser <global-id>.',
        );
      const pinned = {
        ...options,
        browser: encodeBrowserTarget({
          browser: resolved.browser,
          connector: connector.connectorId,
        }),
      };
      delete pinned.connector;
      return pinned;
    }
    const listing = (await this.invokeRouted('browser_list', {}, options)) as BrowserListResult;
    const connected = listing.browsers.filter(
      browser => browser.status === 'connected' && (!local || browser.transport !== 'provider'),
    );
    const implicitHost = options.local || options.connector || !this.options.serverUrl;
    const automatic =
      connected.find(browser => browser.browserId === listing.defaultBrowserId) ??
      (implicitHost || connected.length === 1 ? connected[0] : undefined);
    const candidates = options.browser
      ? findBrowsers(listing.browsers, options.browser)
      : automatic
        ? [automatic]
        : [];
    if (candidates.length !== 1)
      throw new Error(
        'Large page_eval arguments require a unique connected browser. Pass --browser <global-id>.',
      );
    const browser = candidates[0]!;
    const pinned = { ...options, browser: browser.browserId };
    delete pinned.connector;
    return pinned;
  }

  private async invokeRouted(
    action: string,
    data: Record<string, any> = {},
    options: PinnedPageEvalOptions = {},
  ): Promise<any> {
    validateRequiredActionTabId(action, data);
    const timeoutSec =
      options.timeoutSec ?? resolveActionTimeoutSec(action, data, this.options.requestTimeoutSec);

    if (options.socketPath)
      return this.invokeLocal(
        action,
        data,
        timeoutSec,
        undefined,
        options.controlSessionId,
        options.socketPath,
      );

    if (action === 'connector_list') return this.listConnectors(timeoutSec);
    if (action === 'browser_list') {
      if (parseBrowserListParams(data)) {
        const result = await invokeLocalBrowser('browser_list', data, {
          timeoutSec,
          controlSource: 'local',
        });
        if (!result?.discovery)
          throw new Error('Provider launch-form discovery is not supported by this host');
        return this.applyConfiguredDefault(this.decorateListing(result, { kind: 'local' }));
      }
      if (options.local) {
        return this.listLocalBrowsers(timeoutSec);
      }
      const connector = options.connector ?? this.defaultConnector;
      return connector
        ? this.listConnectorBrowsers(connector, timeoutSec)
        : this.listAllBrowsers(timeoutSec);
    }
    if (action === 'browser_select_browser') {
      return this.selectDefaultBrowser(data, options, timeoutSec);
    }

    if (options.local) {
      return this.invokeExplicitLocal(action, data, options, timeoutSec);
    }

    const optionTarget = decodeBrowserTarget(options.browser);
    const defaultTarget = options.browser ? undefined : decodeBrowserTarget(this.defaultBrowser);
    const closeTarget =
      action === 'browser_close' && typeof data.browser === 'string'
        ? decodeBrowserTarget(data.browser)
        : undefined;
    const target = optionTarget ?? closeTarget ?? defaultTarget;
    const connector = target?.connector ?? options.connector ?? this.defaultConnector;
    const browser =
      optionTarget?.browser ??
      defaultTarget?.browser ??
      (options.browser && !optionTarget ? options.browser : undefined) ??
      (this.defaultBrowser && !defaultTarget ? this.defaultBrowser : undefined);
    const requestData = closeTarget ? { ...data, browser: closeTarget.browser } : data;

    if (target && !target.connector) {
      if (options.connector) {
        throw new Error('A local browser cannot be used together with --connector.');
      }
      return this.invokeLocal(
        action,
        requestData,
        timeoutSec,
        target.browser,
        options.controlSessionId,
      );
    }
    if (connector) {
      const selected =
        target?.connector && !options.connector && !this.defaultConnector
          ? { connectorId: target.connector, name: target.connector }
          : await this.resolveConnector(connector, timeoutSec);
      if (target?.connector && selected.connectorId !== target.connector) {
        throw new Error('The selected browser belongs to a different cloud connector.');
      }
      return this.invokeRemote(
        action,
        requestData,
        timeoutSec,
        browser,
        selected,
        options.controlSessionId,
      );
    }
    if (!this.options.serverUrl) {
      return this.invokeLocal(
        action,
        requestData,
        timeoutSec,
        options.browser ?? this.defaultBrowser,
        options.controlSessionId,
      );
    }

    const selector =
      options.browser ??
      this.defaultBrowser ??
      (action === 'browser_close' && typeof data.browser === 'string' ? data.browser : undefined);
    const resolved = await this.resolveUnifiedBrowser(
      selector,
      timeoutSec,
      action === 'browser_close',
    );
    if (resolved) {
      if (action === 'browser_close') {
        const nextOptions = { ...options };
        delete nextOptions.browser;
        return this.invoke(action, { ...data, browser: resolved }, nextOptions);
      }
      return this.invoke(action, data, { ...options, browser: resolved });
    }

    if (action === 'browser_launch') {
      return this.invokeLaunchWithoutControlBrowser(data, timeoutSec);
    }
    throw new Error(
      'No connected browser is available. Run `mearl browser_list` to inspect all sources.',
    );
  }

  private async invokeExplicitLocal(
    action: string,
    data: Record<string, any>,
    options: UnifiedInvokeOptions,
    timeoutSec: number,
  ): Promise<any> {
    const optionTarget = decodeBrowserTarget(options.browser);
    const defaultTarget = options.browser ? undefined : decodeBrowserTarget(this.defaultBrowser);
    const closeTarget =
      action === 'browser_close' && typeof data.browser === 'string'
        ? decodeBrowserTarget(data.browser)
        : undefined;
    if (optionTarget?.connector || defaultTarget?.connector || closeTarget?.connector) {
      throw new Error('A remote browser cannot be used together with --local.');
    }
    const browser =
      optionTarget?.browser ?? defaultTarget?.browser ?? options.browser ?? this.defaultBrowser;
    const requestData = closeTarget ? { ...data, browser: closeTarget.browser } : data;
    return this.invokeLocal(action, requestData, timeoutSec, browser, options.controlSessionId);
  }

  private async invokeLaunchWithoutControlBrowser(
    data: Record<string, any>,
    timeoutSec: number,
  ): Promise<any> {
    const local = await this.tryLocalBrowserList(timeoutSec);
    const discoveredConnectors = await this.listConnectors(timeoutSec).then(
      result => result.connectors,
    );
    const localAvailable = local !== null;
    const localConnectorId = localAvailable ? loadLocalConnectorId() : null;
    const connectors = localConnectorId
      ? discoveredConnectors.filter(connector => connector.connectorId !== localConnectorId)
      : discoveredConnectors;
    if (localAvailable && connectors.length === 0) {
      return this.invokeLocal('browser_launch', data, timeoutSec, undefined);
    }
    if (!localAvailable && connectors.length === 1) {
      return this.invokeRemote('browser_launch', data, timeoutSec, undefined, connectors[0]!);
    }
    if (!localAvailable && connectors.length === 0) {
      throw new Error(
        'No browser host is available. Install @mearl/native-host locally or connect a cloud connector.',
      );
    }
    const availableHosts = [
      ...(localAvailable ? ['this machine [--local]'] : []),
      ...connectors.map(connector => `${connector.name} [${connector.connectorId}]`),
    ].join(', ');
    throw new Error(
      'The browser host for browser_launch is ambiguous. ' +
        `Pass --local, --connector <id|name>, or --browser <global-id>. Available: ${availableHosts}`,
    );
  }

  private async selectDefaultBrowser(
    data: Record<string, any>,
    options: UnifiedInvokeOptions,
    timeoutSec: number,
  ): Promise<any> {
    const selector = typeof data.browser === 'string' ? data.browser.trim() : '';
    if (!selector) {
      this.defaultBrowser = undefined;
      this.defaultConnector = undefined;
      return { selected: null, note: 'Cleared the process-wide default browser.' };
    }
    const listing = (await this.invoke(
      'browser_list',
      {},
      {
        timeoutSec,
        ...(options.local ? { local: true } : {}),
        ...(options.connector ? { connector: options.connector } : {}),
      },
    )) as BrowserListResult;
    const matches = findBrowsers(listing.browsers, selector);
    if (matches.length > 1) {
      throw new Error(
        `Browser selector "${selector}" is ambiguous. Use an exact global browserId.`,
      );
    }
    const match = matches[0];
    if (!match) throw new Error(`No connected browser matches "${selector}".`);
    this.defaultBrowser = match.browserId;
    this.defaultConnector = undefined;
    return { selected: { browserId: match.browserId, name: match.name } };
  }

  private async resolveUnifiedBrowser(
    selector: string | undefined,
    timeoutSec: number,
    includeDisconnected: boolean,
  ): Promise<string | undefined> {
    const listing = await this.listAllBrowsers(timeoutSec);
    if (selector) {
      const matches = findBrowsers(listing.browsers, selector, !includeDisconnected);
      if (matches.length > 1) {
        throw new Error(
          `Browser selector "${selector}" is ambiguous. Use an exact global browserId from browser_list.`,
        );
      }
      if (matches.length === 0) {
        throw new Error(`No browser matches "${selector}". Run \`mearl browser_list\`.`);
      }
      return matches[0]!.browserId;
    }
    if (listing.defaultBrowserId) return listing.defaultBrowserId;
    const connected = listing.browsers.filter(browser => browser.status === 'connected');
    if (connected.length === 1) return connected[0]!.browserId;
    if (connected.length > 1) {
      throw new Error(
        'Multiple browsers are connected and there is no unique default. Pass --browser <global-id>.',
      );
    }
    return undefined;
  }

  async listConnectors(
    timeoutSec = this.options.requestTimeoutSec,
  ): Promise<CloudConnectorListResult> {
    if (!this.options.serverUrl) return { count: 0, connectors: [] };
    return this.requestRemote(
      'connector_list',
      {},
      timeoutSec,
      undefined,
      undefined,
    ) as Promise<CloudConnectorListResult>;
  }

  private async resolveConnector(
    selector: string,
    timeoutSec: number,
  ): Promise<CloudConnectorInfo> {
    const connectors = (await this.listConnectors(timeoutSec)).connectors;
    const selection = resolveCloudConnectorSelector(connectors, selector);
    const available = connectors
      .map(connector => `${connector.name} [${connector.connectorId}]`)
      .join(', ');
    if (selection.status === 'ambiguous') {
      throw new Error(
        `Cloud connector selector "${selector}" is ambiguous. Use an exact connectorId. Available: ${available}`,
      );
    }
    if (selection.status !== 'matched') {
      throw new Error(`No cloud connector matches "${selector}". Available: ${available}`);
    }
    return selection.connector;
  }

  private async listLocalBrowsers(timeoutSec: number): Promise<BrowserListResult> {
    const result = await invokeLocalBrowser(
      'browser_list',
      {},
      { timeoutSec, controlSource: 'local' },
    );
    return this.applyConfiguredDefault(this.decorateListing(result, { kind: 'local' }));
  }

  private async tryLocalBrowserList(timeoutSec: number): Promise<any | null> {
    try {
      return await invokeLocalBrowser('browser_list', {}, { timeoutSec, controlSource: 'local' });
    } catch {
      return null;
    }
  }

  private decorateListing(result: any, source: BrowserSource): BrowserListResult {
    const rawBrowsers: Record<string, any>[] = Array.isArray(result?.browsers)
      ? result.browsers
      : [];
    const browsers = rawBrowsers.map(browser => decorateBrowser(browser, source));
    const resultWarnings = Array.isArray(result?.warnings)
      ? result.warnings.filter((warning: unknown): warning is string => typeof warning === 'string')
      : [];
    return {
      count: browsers.length,
      connectedCount: browsers.filter(browser => browser.status === 'connected').length,
      defaultBrowserId:
        typeof result?.defaultBrowserId === 'string'
          ? encodeBrowserTarget({
              browser: result.defaultBrowserId,
              ...(source.connectorId ? { connector: source.connectorId } : {}),
            })
          : null,
      browsers,
      ...(result?.discovery ? { discovery: result.discovery } : {}),
      ...(resultWarnings.length > 0 ? { warnings: resultWarnings } : {}),
    };
  }

  private applyConfiguredDefault(listing: BrowserListResult): BrowserListResult {
    if (!this.defaultBrowser) return listing;
    const matches = findBrowsers(listing.browsers, this.defaultBrowser);
    return {
      ...listing,
      defaultBrowserId: matches.length === 1 ? matches[0]!.browserId : null,
    };
  }

  private async listConnectorBrowsers(
    selector: string,
    timeoutSec: number,
  ): Promise<BrowserListResult> {
    const connector = await this.resolveConnector(selector, timeoutSec);
    const result = await this.requestRemote(
      'browser_list',
      {},
      timeoutSec,
      undefined,
      connector.connectorId,
    );
    return this.applyConfiguredDefault(
      this.decorateListing(result, {
        kind: 'remote',
        connectorId: connector.connectorId,
        connectorName: connector.name,
      }),
    );
  }

  private async listAllBrowsers(timeoutSec: number): Promise<BrowserListResult> {
    const warnings: string[] = [];
    const localPromise = this.tryLocalBrowserList(timeoutSec);
    let connectors: CloudConnectorInfo[] = [];
    if (this.options.serverUrl) {
      try {
        connectors = (await this.listConnectors(timeoutSec)).connectors;
      } catch (error) {
        warnings.push(`cloud-server: ${errorMessage(error)}`);
      }
    }
    const localResult = await localPromise;
    if (!localResult) warnings.push('this machine: local browser runtime is unavailable');

    const localConnectorId = localResult ? loadLocalConnectorId() : null;
    const remoteConnectors = localConnectorId
      ? connectors.filter(connector => connector.connectorId !== localConnectorId)
      : connectors;
    const settled = await Promise.allSettled(
      remoteConnectors.map(async connector => ({
        connector,
        listing: await this.requestRemote(
          'browser_list',
          {},
          timeoutSec,
          undefined,
          connector.connectorId,
        ),
      })),
    );
    const remoteListings: RemoteBrowserListing[] = [];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]!;
      const connector = remoteConnectors[index]!;
      if (result.status === 'fulfilled') remoteListings.push(result.value);
      else warnings.push(`${connector.name}: ${errorMessage(result.reason)}`);
    }

    const listings: BrowserListResult[] = [];
    if (localResult) listings.push(this.decorateListing(localResult, { kind: 'local' }));
    for (const { connector, listing } of remoteListings) {
      listings.push(
        this.decorateListing(listing, {
          kind: 'remote',
          connectorId: connector.connectorId,
          connectorName: connector.name,
        }),
      );
    }
    for (const listing of listings) warnings.push(...(listing.warnings ?? []));
    const browsers = listings.flatMap(listing => listing.browsers);
    const defaults = listings
      .map(listing => listing.defaultBrowserId)
      .filter((browserId): browserId is string => typeof browserId === 'string');
    let defaultBrowserId: string | null = null;
    if (
      this.defaultBrowser &&
      browsers.some(browser => browser.browserId === this.defaultBrowser)
    ) {
      defaultBrowserId = this.defaultBrowser;
    } else if (defaults.length === 1) {
      defaultBrowserId = defaults[0]!;
    }
    return this.applyConfiguredDefault({
      count: browsers.length,
      connectedCount: browsers.filter(browser => browser.status === 'connected').length,
      defaultBrowserId,
      browsers,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  }

  private async invokeLocal(
    action: string,
    data: Record<string, any>,
    timeoutSec: number,
    browser: string | undefined,
    controlSessionId?: string,
    socketPath?: string,
  ): Promise<any> {
    const result = await invokeLocalBrowser(action, data, {
      timeoutSec,
      ...(this.requestDeadline === undefined ? {} : { deadline: this.requestDeadline }),
      ...(browser ? { browser } : {}),
      ...(socketPath ? { socketPath } : {}),
      controlSource: 'local',
      ...(controlSessionId ? { controlSessionId } : {}),
    });
    return this.decorateActionResult(action, result, { kind: 'local' });
  }

  private async invokeRemote(
    action: string,
    data: Record<string, any>,
    timeoutSec: number,
    browser: string | undefined,
    connector: Pick<CloudConnectorInfo, 'connectorId' | 'name'>,
    controlSessionId?: string,
  ): Promise<any> {
    const result = await this.requestRemote(
      action,
      data,
      timeoutSec,
      browser,
      connector.connectorId,
      controlSessionId,
    );
    return this.decorateActionResult(action, result, {
      kind: 'remote',
      connectorId: connector.connectorId,
      connectorName: connector.name,
    });
  }

  private decorateActionResult(action: string, result: any, source: BrowserSource): any {
    if (result?.session?.sessionId) {
      const browserId = encodeBrowserTarget({
        browser: result.session.browserId,
        ...(source.connectorId ? { connector: source.connectorId } : {}),
      });
      if (action !== '__control_session_resolve') {
        this.controlSessions.set(result.session.sessionId, {
          browser: browserId,
          id: result.session.sessionId,
          transport: result.session.transport,
        });
      }
      result = {
        ...result,
        session: {
          ...result.session,
          browserId,
        },
      };
    }
    if (
      typeof result?.browserId === 'string' &&
      (action.startsWith('__artifact_') || action === 'page_record')
    ) {
      result = {
        ...result,
        browserId: encodeBrowserTarget({
          browser: result.browserId,
          ...(source.connectorId ? { connector: source.connectorId } : {}),
        }),
      };
    }
    const artifactKey = action === 'page_record' ? 'recording' : 'download';
    const artifact = result?.[artifactKey];
    if (artifact?.browserId)
      result = {
        ...result,
        [artifactKey]: {
          ...artifact,
          browserId: encodeBrowserTarget({
            browser: artifact.browserId,
            ...(source.connectorId ? { connector: source.connectorId } : {}),
          }),
        },
      };
    if (action !== 'browser_launch' || typeof result?.browserId !== 'string') return result;
    return decorateBrowser(result, source);
  }

  private async resolveControlSession(
    id: string,
    options: UnifiedInvokeOptions,
  ): Promise<ControlSessionTarget> {
    if (!/^s_[A-Za-z0-9_-]{8}$/.test(id))
      throw new Error('Invalid session id; reuse session.sessionId from the first response');
    const cached = this.controlSessions.get(id);
    if (cached) return cached;
    const timeoutSec = options.timeoutSec ?? 15;
    const localLookup = this.invokeLocal(
      '__control_session_resolve',
      { sessionId: id },
      timeoutSec,
      undefined,
    );
    const discover = async () => {
      const { connectors } = await this.listConnectors(timeoutSec);
      return Promise.allSettled(
        connectors.map(connector =>
          this.invokeRemote(
            '__control_session_resolve',
            { sessionId: id },
            timeoutSec,
            undefined,
            connector,
          ),
        ),
      );
    };
    const [local, remote] = await Promise.allSettled([
      localLookup,
      this.options.serverUrl && !options.local ? discover() : Promise.resolve([]),
    ]);
    const localSession = local.status === 'fulfilled' ? local.value?.session : undefined;
    const localTarget = decodeBrowserTarget(localSession?.browserId);
    const localConnectorId = localSession?.sessionId === id ? loadLocalConnectorId() : null;
    const results = [local, ...(remote.status === 'fulfilled' ? remote.value : [remote])].filter(
      result => {
        if (result === local || result.status === 'rejected') return true;
        const session = result.value?.session;
        const target = decodeBrowserTarget(session?.browserId);
        // The same host can be reached over both its local socket and its cloud connector.
        return !(
          localConnectorId &&
          target?.connector === localConnectorId &&
          target.browser === localTarget?.browser &&
          session?.sessionId === id &&
          session.transport === localSession.transport
        );
      },
    );
    const sessions = results.flatMap(result =>
      result.status === 'fulfilled' && result.value?.session?.sessionId === id
        ? [result.value.session]
        : [],
    );
    const ambiguous = results.some(
      result =>
        result.status === 'rejected' &&
        errorMessage(result.reason).startsWith('CONTROL_SESSION_AMBIGUOUS'),
    );
    if (sessions.length > 1 || ambiguous) {
      this.controlSessions.delete(id);
      throw new Error('CONTROL_SESSION_AMBIGUOUS: multiple hosts own this id');
    }
    const session = sessions[0];
    if (!session) {
      const errors = results.flatMap(result =>
        result.status === 'rejected' ? [errorMessage(result.reason)] : [],
      );
      throw new Error(
        `CONTROL_SESSION_NOT_FOUND: ${id}${errors.length ? ` (${errors.join('; ')})` : ''}`,
      );
    }
    const target = { browser: session.browserId, id, transport: session.transport };
    this.controlSessions.set(id, target);
    return target;
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.closing = false;
    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.options.serverUrl) {
        reject(
          new Error(
            'Cloud server URL is required. Run mearl-cloud-server status on the Agent machine. ' +
              'Resolution order: --server > MEARL_SERVER_URL > ~/.mearl/cloud-server.json.',
          ),
        );
        return;
      }
      const ws = new WebSocket(this.options.serverUrl);
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => {
        ws.close();
        if (!settled)
          reject(new Error(`Connection timeout after ${this.options.connectTimeoutSec}s`));
      }, this.options.connectTimeoutSec * 1_000);
      ws.on('open', () => {
        settled = true;
        clearTimeout(timer);
        ws.send(JSON.stringify({ type: 'agent_hello' } satisfies AgentHelloMessage) + '\n');
        this.startHeartbeat();
        resolve();
      });
      ws.on('message', data => this.handleMessage(data as Buffer));
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        this.rejectAllPending(new Error(`Connection closed (${code}: ${reason.toString()})`));
        if (!this.closing) this.ws = null;
      });
      ws.on('error', error => {
        clearTimeout(timer);
        if (!settled) reject(error);
      });
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ type: 'ping', timestamp: Date.now() } satisfies HeartbeatMessage) + '\n',
        );
      }
    }, this.options.heartbeatInterval * 1_000);
  }

  private handleMessage(data: Buffer): void {
    this.messageBuffer += data.toString('utf8');
    if (this.messageBuffer.length > MAX_BUFFER_SIZE) {
      this.disconnect();
      return;
    }
    let newlineIndex: number;
    while ((newlineIndex = this.messageBuffer.indexOf('\n')) !== -1) {
      const line = this.messageBuffer.slice(0, newlineIndex);
      this.messageBuffer = this.messageBuffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (!isHeartbeatMessage(message)) this.handleResponse(message as CloudResponse);
      } catch {
        // Ignore malformed or unrelated frames; pending requests retain their timeout.
      }
    }
  }

  private handleResponse(response: CloudResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;
    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timer);
    if (response.versionWarning) console.warn(response.versionWarning);
    if (response.success) pending.resolve(response.data);
    else pending.reject(new Error(response.error || 'Unknown error from cloud-server'));
  }

  private async requestRemote(
    action: string,
    data: Record<string, any>,
    timeoutSec: number,
    browser: string | undefined,
    connector: string | undefined,
    controlSessionId?: string,
  ): Promise<any> {
    await this.ensureConnected();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Connection is not open');
    if (this.requestDeadline !== undefined) {
      const remainingSec = (this.requestDeadline - Date.now()) / 1000;
      if (remainingSec <= 0) throw new Error('Browser request deadline exceeded before dispatch');
      timeoutSec = Math.min(timeoutSec, remainingSec);
    }
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const message: CloudMessage = { id, action, data, timeoutSec };
    if (browser) message.browser = browser;
    if (connector) message.connector = connector;
    if (controlSessionId) message.controlSessionId = controlSessionId;
    const serialized = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_BUFFER_SIZE) {
      throw new Error(
        `Cloud request exceeds ${MAX_BUFFER_SIZE} byte message limit (${bytes} bytes)`,
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout after ${timeoutSec}s`));
        },
        timeoutSec * 1_000 + RESPONSE_GRACE_MS,
      );
      this.pendingRequests.set(id, { resolve, reject, timer });
      ws.send(serialized);
    });
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

let defaultBrowser: string | undefined;
let defaultConnector: string | undefined;

export async function invoke(
  action: string,
  data: Record<string, any> = {},
  options: UnifiedInvokeOptions = {},
): Promise<any> {
  const serverUrl = process.env.MEARL_SERVER_URL ?? loadCloudServerConfig()?.server;
  const client = new UnifiedClient({
    ...(serverUrl ? { serverUrl } : {}),
    defaultBrowser,
    defaultConnector,
  });
  try {
    const result = await client.invoke(action, data, options);
    if (action === 'browser_select_browser') {
      defaultBrowser = result?.selected?.browserId;
      defaultConnector = undefined;
    }
    return result;
  } finally {
    client.disconnect();
  }
}

export async function invokePlugin(
  name: string,
  invocation: PluginInvocation,
  options: PluginInvokeOptions = {},
): Promise<unknown> {
  const serverUrl = process.env.MEARL_SERVER_URL ?? loadCloudServerConfig()?.server;
  const client = new UnifiedClient({
    ...(serverUrl ? { serverUrl } : {}),
    defaultBrowser,
    defaultConnector,
  });
  try {
    return await client.invokePlugin(name, invocation, options);
  } finally {
    client.disconnect();
  }
}

export function listCloudConnectors(): Promise<CloudConnectorListResult> {
  return invoke('connector_list', {}) as Promise<CloudConnectorListResult>;
}
