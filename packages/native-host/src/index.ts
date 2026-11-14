#!/usr/bin/env node
import { nativeCapabilityDirectory } from './page-runtime-store.js';
import { createNativePresetAutoUpdater } from './preset-auto-update.js';
import { nativeCapabilities } from './native-capability-services.js';
import { PresetBrowserTransfer } from '@mearl/setup/preset';
import { PresetComponentInstaller } from './preset-components.js';
import { NativePresetInstallation } from './preset-installation.js';
import { PluginPageResults } from './plugin-page-results.js';
import {
  callPluginPageService,
  callPluginStateService,
  callPluginModelService,
} from './plugin-host-services.js';
import { listInstalledAppProfiles } from './app-profile-catalog.js';
import { ControlSessionManager } from './control-session-manager.js';
import { BrowserEnhancementGateway } from './browser-enhancement-gateway.js';
import { requestBrowserSocket } from './browser-socket-request.js';
import { providerRequestTimeoutMs } from './provider-request-timeout.js';
import { readProviderControlHost } from '@mearl/provider/host';

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyedDir, pruneOrphanLogs } from '@mearl/daemon-core';
import { ensureInstalledProvidersRunning } from '@mearl/provider/runtime';
import { Utf8LineBuffer } from './socketLines.js';
import {
  isAgentServiceAction,
  isExtensionBrowserAction,
  parseBrowserManageParams,
  parseSessionManageParams,
  resolveSessionManageId,
  type BrowserManageParams,
  isToolboxServiceAction,
  ExtensionRpcError,
  type HostToExtensionActionMap,
  type PageUploadChunkRequest,
  normalizeControlSource,
  validateRequiredActionTabId,
  type AgentServiceAction,
  type AgentServiceHandlerMap,
  type AgentServiceRequest,
  type AgentServiceResponse,
  type AgentChatRunOptions,
  type BrowserTransport,
  type BrowserReleaseFailure,
  type BrowserReleaseResult,
  type ControlSource,
} from '@mearl/browser-core';
import {
  initCloudConnector,
  startCloudConnector,
  stopCloudConnector,
  listCloudConnectors,
} from './cloud-connector.js';
import { listBrowserInventory } from './browser-inventory.js';
import { classifyAnalyticsError, setAnalyticsClientId, trackAction } from './analytics.js';
import { AgentChatManager, type AgentProviderLoader } from './agent/manager.js';
import { ManagedAgentPrograms } from './agent/managed-programs.js';
import { readChatVisualization } from './agent/chat-visualization.js';
import { AgentSkillManager } from './agent/skill-manager.js';
import { pickWorkspaceDirectory } from './agent/workspace-directory.js';
import {
  initBrowserRegistry,
  listRegisteredBrowsers,
  pruneDeadBrowsers,
} from './browser-registry.js';
import { isPrivateExtensionAction } from './internal-extension-actions.js';
import { NATIVE_HOST_VERSION } from './version.js';
import { NativeHostUpdateCoordinator, runNativeHostUpdate } from './host-updater.js';
import { updateSetupManagedExtension } from './extension-updater.js';
import { parseNativeHostRuntimeArgs, type NativeHostRuntimeArgs } from './runtimeArgs.js';
import {
  resolveSandboxBrowserAccess,
  resolveSandboxBrowserAccessCapability,
  type SandboxBrowserAccessCapability,
} from './sandbox-browser-access.js';
import { CdpBrowserProvider } from './builtin-providers/cdp.js';
import { CDP_PROVIDER, createCdpAttachProvider } from './builtin-providers/cdp-attach.js';
import { ExtensionBrowserProvider } from './builtin-providers/extension.js';
import { createLocalBrowserProvider } from './builtin-providers/local.js';
import type { HostBrowserProvider } from './builtin-providers/host-browser-provider.js';
import { assertBrowserRequestDeadline } from './control-session.js';
import { CLOSED_OWN_MANAGED_HOST } from './managed-browser.js';
import { BrowserProviderCoordinator } from './browser-provider-coordinator.js';
import { listProviderControlSessions, updateProviderControlSession } from './browser-provider.js';
import {
  startAppAuthorization,
  waitAppAuthorization,
  closeAppAuthorization,
  closeAppAuthorizations,
} from './app-authorization.js';
import {
  invokeToolboxPluginTool,
  handleToolboxTask,
  listToolboxPluginTools,
  openToolboxPluginTool,
  readToolboxPluginPageChunk,
  uninstallToolboxPlugin,
  setToolboxSkillEnabled,
} from './toolbox-service.js';

process.env.MEARL_NATIVE_HOST_ENTRY ??= fileURLToPath(import.meta.url);

// CLI argument handling — runs before the native host server starts.
const cliArgs = process.argv.slice(2);
const cliArg = cliArgs[0];

if (cliArg === '--provider-control') {
  const { runProviderControlHost } = await import('./provider-control-host.js');
  await runProviderControlHost(cliArgs[1] ?? '');
  process.exit(0);
}

// Route manifest lifecycle commands to the install entry point.
if (
  cliArg === '--init' ||
  cliArg === '--uninstall' ||
  cliArg === 'init' ||
  cliArg === 'uninstall'
) {
  const { runCli } = await import('./install.js');
  process.exit(await runCli(cliArgs));
}

function printCliHelp(): void {
  console.error(`mearl-native-host v${NATIVE_HOST_VERSION}

Usage:
  mearl-native-host [runtime-options]
  mearl-native-host <init|uninstall> [options]

Lifecycle commands:
  init [--mode <skills|mcp|both>] [--extension-id <id>]
                             Initialize Native Messaging Host
                             (default: both — installs the Skills and MCP hosts)
  uninstall [--mode <skills|mcp|both>]
                             Remove Native Messaging Host registration

Runtime options:
  --daemon                   Start as standalone CDP daemon (no extension needed)
  --cdp-port <port>          CDP port for daemon mode (default 9222)
  --cdp-user-data-dir <dir>  Read DevToolsActivePort from this Chrome profile
  --cdp-endpoint-file <path> Read a private remote CDP WebSocket URL from a file
  --skip-browser-registration
                             Keep this CDP runtime private to its Provider
  --browser-id <id>          Registry id for this CDP browser
  --browser-name <name>      Human-readable registry name
  --browser-headless         Mark this CDP browser as having no graphical display
  --version, -v              Show version
  --help, -h                 Show this help message

Compatibility aliases:
  --init, --uninstall        Established flag forms for lifecycle commands

Connection modes (auto-detected at runtime):
  Extension mode             Requires Mearl browser extension installed
  CDP mode (Chrome 145+)     No extension needed. Enable "Allow remote debugging"
                             at chrome://inspect/#remote-debugging (click Allow
                             in the Chrome dialog that appears).
  Auto-started daemon        Serves browser inventory and Provider lifecycle requests.

Examples:
  mearl-native-host init
  mearl-native-host init --mode skills
  mearl-native-host uninstall --mode skills
  mearl-native-host init --extension-id abcdefghijklmnopqrstuvwxyzabcdef
  mearl-native-host --daemon
  mearl-native-host --version`);
}

if (!cliArg && process.stdin.isTTY) {
  printCliHelp();
  process.exit(0);
}

let runtimeArgs: NativeHostRuntimeArgs = {
  browserId: 'cdp',
  browserHeadless: false,
  browserName: 'CDP',
  cdpPort: 9222,
  daemon: false,
  attachCdp: false,
  help: false,
  inventory: false,
  skipBrowserRegistration: false,
  version: false,
};
if (cliArgs.length > 0) {
  try {
    runtimeArgs = await parseNativeHostRuntimeArgs(cliArgs);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    printCliHelp();
    process.exit(2);
  }
}
if (runtimeArgs.version) {
  console.log(NATIVE_HOST_VERSION);
  process.exit(0);
}
if (runtimeArgs.help) {
  printCliHelp();
  process.exit(0);
}

const isDaemonMode = runtimeArgs.daemon;
const attachCdp = runtimeArgs.attachCdp;
const inventoryOnly = runtimeArgs.inventory;
const skipBrowserRegistration = runtimeArgs.skipBrowserRegistration;
const BROWSER_HEADLESS = runtimeArgs.browserHeadless;
const cdpEndpointSource = cliArgs.some(argument =>
  ['--cdp-port', '--cdp-user-data-dir', '--cdp-endpoint-file'].some(
    option => argument === option || argument.startsWith(`${option}=`),
  ),
)
  ? 'command-line'
  : 'built-in default';

function socketPathFor(suffix: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mearl-agent${suffix}`
    : path.join(os.tmpdir(), `mearl-agent${suffix}.sock`);
}

/**
 * Well-known socket kept for backward compatibility with clients that predate
 * the per-browser registry. Bound best-effort, first-come, no-takeover — see
 * tryBindLegacySocket. New clients discover us via the registry instead.
 */
const LEGACY_SOCKET_PATH = socketPathFor('');

/**
 * This process's own socket — unique per pid, so multiple native-hosts (one per
 * browser) coexist without contention. Advertised in the browser registry.
 */
const INSTANCE_SOCKET_PATH = socketPathFor(`-${process.pid}`);

const LOG_FILE = path.join(os.tmpdir(), 'mearl-native-host.log');
const INVENTORY_IDLE_EXIT_MS = 1000;
const ATTACH_REQUEST_IDLE_EXIT_MS = 10_000;
const MAX_SOCKET_BUFFER_SIZE = 64 * 1024 * 1024;

/** Ensure the version-mismatch warning is sent to clients at most once per native-host process. */
let versionWarningEmitted = false;

const EXTENSION_INSTALL_URL =
  'https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm';

/**
 * Build a version-mismatch warning string when native-host and extension versions differ.
 * Returns `null` when versions match or the extension version is not yet known.
 */
function majorMinor(version: string): string {
  const parts = version.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : version;
}

function extractChromeVersion(input: string): string | null {
  const match = /Chrome\/([\d.]+)/.exec(input);
  if (!match) return null;
  const parts = match[1]!.split('.');
  return parts.slice(0, 3).join('.');
}

const pluginPageResults = new PluginPageResults();

function createNativePluginContext(interactive: boolean, pluginScope?: string) {
  const invokeBrowser = extensionProvider.createPluginInvoker(interactive);
  return {
    source: 'toolbox' as const,
    runModel: (
      plugin: string,
      request: import('@mearl/client').PluginModelRequest,
      execution: { signal?: AbortSignal; onProgress?: (progress: any) => void },
    ) => {
      if (pluginScope && plugin !== pluginScope)
        throw new Error('Plugin model is outside the tool scope');
      return callPluginModelService(
        plugin,
        { operation: 'run', request },
        () => createNativePluginContext(false).invoke,
        execution,
      ) as Promise<import('@mearl/client').PluginModelResult>;
    },
    invoke: (
      pluginAction: string,
      payload: Record<string, any> = {},
      options: { timeoutSec?: number } = {},
    ) => {
      if (pluginAction === 'plugin_state' || pluginAction === 'plugin_model') {
        const plugin = pluginScope ?? String(payload.plugin ?? '');
        if (pluginScope && payload.plugin !== pluginScope)
          throw new Error('Plugin request is outside the tool scope');
        return pluginAction === 'plugin_state'
          ? callPluginStateService(plugin, payload, () => createNativePluginContext(false).invoke)
          : callPluginModelService(plugin, payload, () => createNativePluginContext(false).invoke);
      }
      if (pluginAction === 'plugin_page') {
        const plugin = pluginScope ?? String(payload.plugin ?? '');
        if (pluginScope && payload.plugin !== pluginScope)
          throw new Error('Plugin page is outside the tool scope');
        return callPluginPageService(
          plugin,
          payload,
          () => createNativePluginContext(interactive).invoke,
          false,
          interactive,
        );
      }
      if (pluginAction === 'agent_chat_run')
        return getAgentChatManager().runTask(payload as AgentChatRunOptions);
      return invokeBrowser(pluginAction, payload, options.timeoutSec);
    },
  };
}

async function getCurrentBrowserUserAgent(): Promise<string> {
  if (extensionProvider.connected) {
    try {
      const result = await extensionProvider.browserInfo();
      if (result.userAgent?.trim()) return result.userAgent;
    } catch {
      // Fall back to the CDP transport when the extension cannot report browser information.
    }
  }

  if (isDaemonMode && !inventoryOnly) {
    try {
      const result = await cdpProvider.browserInfo();
      if (result.userAgent?.trim()) return result.userAgent;
    } catch {
      // Surface one provider-neutral error below.
    }
  }
  throw new Error('Could not determine the control browser user agent for userAgentMode=desktop');
}

interface VersionInfo {
  nativeHost: string;
  extension: string | null;
  extensionId?: string;
  setupManagedPath?: string | null;
  browser: string | null;
  browserAccess?: BrowserAccessCapability;
}

type BrowserAccessCapability = SandboxBrowserAccessCapability;

type BrowserAccess = { kind: string; url: string };

function currentBrowserSupportsSandboxAccess(): boolean {
  return !BROWSER_HEADLESS;
}

function resolveBrowserAccessCapability(): BrowserAccessCapability | null {
  if (!currentBrowserSupportsSandboxAccess()) return null;
  return resolveSandboxBrowserAccessCapability();
}

async function resolveBrowserAccess(): Promise<BrowserAccess> {
  const capability = resolveBrowserAccessCapability();
  if (!capability) throw new Error('The selected browser does not expose a browser access URL');
  return resolveSandboxBrowserAccess();
}

async function collectVersions(includeInstallationInfo = false): Promise<VersionInfo> {
  const browserAccess = resolveBrowserAccessCapability();
  const info: VersionInfo = {
    nativeHost: NATIVE_HOST_VERSION,
    extension: extensionProvider.version,
    browser: null,
    ...(browserAccess ? { browserAccess } : {}),
  };

  if (extensionProvider.connected) {
    try {
      const browserInfo = await extensionProvider.browserInfo();
      if (browserInfo?.userAgent) info.browser = extractChromeVersion(browserInfo.userAgent);
      if (browserInfo?.extensionVersion) info.extension = browserInfo.extensionVersion;
      if (includeInstallationInfo) {
        if (browserInfo?.extensionId) info.extensionId = browserInfo.extensionId;
        if (
          typeof browserInfo?.setupManagedPath === 'string' ||
          browserInfo?.setupManagedPath === null
        ) {
          info.setupManagedPath = browserInfo.setupManagedPath;
        }
      }
    } catch {
      // extension might be older and not implement get_browser_info; fall through.
    }
  }

  if (!info.browser && isDaemonMode && !inventoryOnly) {
    try {
      const { product } = await cdpProvider.browserInfo();
      if (product) info.browser = extractChromeVersion(product);
    } catch {
      // The browser can be disconnected while the host is still available.
    }
  }

  return info;
}

function buildVersionWarning(clientVersion: string | undefined): string | null {
  const versions = [
    clientVersion ? { name: 'client', version: clientVersion } : null,
    { name: 'native-host', version: NATIVE_HOST_VERSION },
    extensionProvider.version ? { name: 'extension', version: extensionProvider.version } : null,
  ].filter(Boolean) as Array<{ name: string; version: string }>;

  const uniqueMajorMinor = new Set(versions.map(v => majorMinor(v.version)));
  if (uniqueMajorMinor.size <= 1) return null;

  const versionList = versions.map(v => `  - ${v.name}: ${v.version}`).join('\n');
  return [
    '⚠️ Mearl version mismatch detected:',
    versionList,
    '',
    'This may cause unexpected behavior. To update:',
    '  npx @mearl/setup update --local',
    `  Browser extension: ${EXTENSION_INSTALL_URL}`,
  ].join('\n');
}

/** Server bound to this process's unique instance socket (primary endpoint). */
let socketServer: ReturnType<typeof net.createServer> | null = null;
/** Server bound to the legacy well-known socket, when we managed to acquire it. */
let legacyServer: ReturnType<typeof net.createServer> | null = null;
let inventoryExitTimer: ReturnType<typeof setTimeout> | null = null;
function cancelInventoryExit(): void {
  if (!inventoryExitTimer) return;
  clearTimeout(inventoryExitTimer);
  inventoryExitTimer = null;
}

function scheduleInventoryExit(delayMs = INVENTORY_IDLE_EXIT_MS): void {
  cancelInventoryExit();
  inventoryExitTimer = setTimeout(() => cleanupAndExit(0), delayMs);
  inventoryExitTimer.unref();
}

let controlSessionManager: ControlSessionManager | undefined;
let browserEnhancementGateway: BrowserEnhancementGateway | undefined;
function getBrowserEnhancementGateway(): BrowserEnhancementGateway {
  return (browserEnhancementGateway ??= new BrowserEnhancementGateway({
    browsers: listRegisteredBrowsers,
    controlHost: readProviderControlHost,
    available: () => extensionProvider.protocolReady,
    tabs: async deadline => {
      const result = await extensionProvider.request(
        'tab_list',
        {},
        providerRequestTimeoutMs('tab_list', {}, deadline),
        true,
      );
      return result.tabs.map((tab: { tabId: number }) => tab.tabId);
    },
    verifySource: (provider, tabId, deadline) =>
      requestBrowserSocket(
        provider.socketPath,
        '__provider_enhancement_target',
        { tabId },
        NATIVE_HOST_VERSION,
        providerRequestTimeoutMs('page_frames', {}, deadline),
        provider.providerBrowserId,
        undefined,
        { deadline },
      ),
    run: (action, data, work) =>
      getControlSessionManager().registry.run(undefined, action, data, work, 'extension'),
    invoke: (request, deadline) =>
      extensionProvider.request(
        '__browser_enhancement',
        { ...request, deadline },
        providerRequestTimeoutMs(
          request.operation === 'invoke' ? request.action : 'page_frames',
          request,
          deadline,
        ),
        true,
      ),
  }));
}

function getControlSessionManager(): ControlSessionManager {
  return (controlSessionManager ??= new ControlSessionManager({
    browserId: () => (isDaemonMode ? cdpProvider : extensionProvider).browserId,
    transport: defaultBrowserTransport,
    supportsUploadTransfer: () => extensionProvider.supportsUploadTransfer,
    invoke: async (action, data, transport, deadline, trustedUpload) => {
      const { __mearlControlSource: origin, ...payload } = data;
      return (
        await dispatchHostRequest(
          { action, data: payload, controlSource: origin ?? 'local', transport, deadline },
          true,
          trustedUpload,
        )
      ).data;
    },
    deactivate: async (tabs, transport) => browserProvider(transport).deactivate?.(tabs),
    cleanup: (tabs, transport, preserveEnvironment, returningToAgent) =>
      browserProvider(transport).cleanup(tabs, preserveEnvironment, returningToAgent),
    download: (data, transport, origin) =>
      browserProvider(transport).download(data, normalizeControlSource(origin)),
    openRecording: (transport, tabId, recordingId, options) =>
      browserProvider(transport).openRecording(tabId, recordingId, options),
    notify: () => {
      if (extensionProvider.connected) extensionProvider.send({ type: 'control_sessions_changed' });
    },
  }));
}

function log(...args: any[]): void {
  const msg = `[${new Date().toISOString()}] [NativeHost] ${args.join(' ')}\n`;
  try {
    fs.appendFileSync(LOG_FILE, msg);
  } catch {
    // ignore logging errors
  }
}

const presetBrowserTransfer = new PresetBrowserTransfer();
let presetBrowserSync: Promise<unknown> = Promise.resolve();
function requestPresetBrowser(
  data: HostToExtensionActionMap['__preset_browser']['request'],
): Promise<HostToExtensionActionMap['__preset_browser']['response']> {
  if (!extensionProvider.connected)
    return Promise.resolve({
      installationRevision: null,
      browserRevision: null,
      ready: false,
      settingsReady: false,
      error: 'EXTENSION_NOT_CONNECTED',
    });
  if (data.operation === 'status')
    return extensionProvider.request('__preset_browser', data, 15000, true);
  const next = presetBrowserSync
    .catch(() => {})
    .then(() => extensionProvider.request('__preset_browser', data, 120000, true));
  presetBrowserSync = next;
  return next;
}

const nativeHostUpdateCoordinator = new NativeHostUpdateCoordinator({
  hostVersion: NATIVE_HOST_VERSION,
  log,
  runUpdate: targetVersion => runNativeHostUpdate(targetVersion),
  requestRestart: () => {
    shutdownWithDeadline();
  },
});

let agentChatManager: AgentChatManager | null = null;
const managedAgentPrograms = new ManagedAgentPrograms();
const agentSkillManager = new AgentSkillManager();
const presetComponentInstaller = new PresetComponentInstaller({ skills: agentSkillManager });
const invokePresetHost: NonNullable<
  import('@mearl/setup/preset').PresetInstallerOptions['invoke']
> = async (action, data = {}) => {
  if (action === 'node_capabilities_reload') return nativeCapabilities.synchronize();
  if (action === 'node_capabilities_status') return nativeCapabilities.status();
  if (action === 'preset_browser_status') return requestPresetBrowser({ operation: 'status' });
  if (action === 'preset_browser_sync')
    return requestPresetBrowser({
      operation: 'sync',
      installationRevision: data.installationRevision,
    });
  if (action === 'preset_components_install' || action === 'preset_components_status')
    return action === 'preset_components_install'
      ? presetComponentInstaller.install(data.installationRevision, {
          replaceSkills: data.replaceSkills,
        })
      : presetComponentInstaller.status(data.installationRevision);
  throw new Error('Unsupported preset installation service');
};
const presetInstallation = new NativePresetInstallation({
  request: (data, timeoutMs) =>
    extensionProvider.request('__preset_installation', data, timeoutMs, true),
  invoke: invokePresetHost,
});

function getAgentChatManager(): AgentChatManager {
  if (!agentChatManager) {
    managedAgentPrograms.addToExecutableSearch();
    agentChatManager = new AgentChatManager(
      [
        {
          id: 'codex',
          load: async () => {
            const { CodexAgentProvider } = await import('@mearl/agent-runtime/codex');
            return new CodexAgentProvider(log, NATIVE_HOST_VERSION, INSTANCE_SOCKET_PATH);
          },
        },
      ],
      event => {
        extensionProvider.send({ type: 'agent_chat_event', data: event });
      },
      {
        installedProviders: () => {
          const providers: Array<AgentProviderLoader & { revision: unknown }> = nativeCapabilities
            .entries('agent.provider.')
            .map(([name, create]) => ({
              id: name.slice('agent.provider.'.length),
              revision: create,
              load: async () => create({ log, version: NATIVE_HOST_VERSION }),
            }));
          if (!providers.some(provider => provider.id === 'qoder')) {
            const managed = managedAgentPrograms.qoderLoader({ log, version: NATIVE_HOST_VERSION });
            if (managed) providers.push(managed);
          }
          return providers;
        },
      },
    );
  }
  return agentChatManager;
}

const agentServiceHandlers = {
  agent_chat_pick_directory: async () => ({ path: await pickWorkspaceDirectory() }),
  agent_chat_status: async () =>
    managedAgentPrograms.describe(await getAgentChatManager().getStatus()),
  agent_chat_install_provider: data =>
    managedAgentPrograms.install(data?.providerId, () => getAgentChatManager().getStatus()),
  agent_chat_login_qoder: async () => ({
    url: await managedAgentPrograms.loginQoder(() =>
      getAgentChatManager().qoderCredentialsChanged(),
    ),
  }),
  agent_chat_prepare: async data => {
    await getAgentChatManager().prepare(data);
    return { ok: true as const };
  },
  agent_chat_list_sessions: data => getAgentChatManager().listSessions(data),
  agent_chat_start: data => getAgentChatManager().startSession(data),
  agent_chat_send: data => getAgentChatManager().sendMessage(data),
  agent_chat_run: data => getAgentChatManager().runTask(data),
  agent_chat_interrupt: async data => {
    await getAgentChatManager().interrupt(data);
    return { ok: true };
  },
  agent_chat_close: async data => {
    await getAgentChatManager().closeSession(data);
    return { ok: true };
  },
  agent_chat_events: data => getAgentChatManager().getEvents(data),
  agent_chat_read_visualization: data => readChatVisualization(data?.path),
  agent_chat_refresh: data => getAgentChatManager().refreshSession(data),
  agent_chat_open_app: async data => {
    await getAgentChatManager().openSession(data);
    return { ok: true };
  },
  agent_chat_open_workspace: async data => {
    await getAgentChatManager().openWorkspace(data);
    return { ok: true };
  },
  agent_chat_respond: data => {
    getAgentChatManager().respondToRequest(data);
    return { ok: true };
  },
  agent_skills_installed: async data => ({ skills: await getAgentChatManager().listSkills(data) }),
  agent_skills_read: data => getAgentChatManager().readSkill(data),
  agent_skills_install: data => agentSkillManager.install(data),
  agent_skills_check_updates: data => agentSkillManager.checkUpdates(data),
  agent_skills_update: data => agentSkillManager.update(data),
  agent_skills_uninstall: data => agentSkillManager.uninstall(data),
} satisfies AgentServiceHandlerMap;

function dispatchAgentServiceAction<A extends AgentServiceAction>(
  action: A,
  request: AgentServiceRequest<A>,
): Promise<AgentServiceResponse<A>> {
  const handler = agentServiceHandlers[action] as (
    value: AgentServiceRequest<A>,
  ) => AgentServiceResponse<A> | Promise<AgentServiceResponse<A>>;
  return Promise.resolve(handler(request));
}

let browserProviderCoordinator: BrowserProviderCoordinator | null = null;

function getBrowserProviderCoordinator(): BrowserProviderCoordinator {
  if (browserProviderCoordinator) return browserProviderCoordinator;
  const exportCookies = (domains: string[]) => browserProvider().exportCookies(domains);
  const local = createLocalBrowserProvider({
    nativeHostScript: fileURLToPath(import.meta.url),
    exportCookies,
    log,
  });
  const cdp = createCdpAttachProvider(fileURLToPath(import.meta.url), pid =>
    socketPathFor(`-${pid}`),
  );
  browserProviderCoordinator = new BrowserProviderCoordinator([local, cdp], {
    exportCookies,
    getBrowserUserAgent: getCurrentBrowserUserAgent,
  });
  return browserProviderCoordinator;
}

function openBrowser(
  { operation, ...params }: Extract<BrowserManageParams, { operation: 'launch' | 'attach' }>,
  deadline?: number,
) {
  return getBrowserProviderCoordinator().launch(params, deadline, operation);
}

async function closeBrowser(
  data: any,
  request: { deadline?: number; controlSource: ControlSource },
): Promise<any> {
  const selector = String(data?.browser ?? data?.browserId ?? data?.name ?? '').trim();
  if (!selector) throw new Error('browser is required');
  const deleteProfile = data?.deleteProfile === true;
  const coordinator = getBrowserProviderCoordinator();
  const { deadline, controlSource } = request;
  return coordinator.close(selector, deleteProfile, (close, localBrowserId) => {
    assertBrowserRequestDeadline(deadline);
    const registry = getControlSessionManager().registry;
    if (localBrowserId) {
      if (isDaemonMode && localBrowserId === cdpProvider.browserId)
        return registry.closeBrowser(close);
      const owner = listRegisteredBrowsers().find(
        browser =>
          browser.browserId === localBrowserId &&
          browser.transport === 'cdp' &&
          browser.pid !== process.pid,
      );
      if (!owner) return close();
      return requestBrowserSocket(
        owner.socketPath,
        'browser_manage',
        { operation: 'close', browser: localBrowserId, deleteProfile },
        NATIVE_HOST_VERSION,
        undefined,
        localBrowserId,
        undefined,
        { deadline, controlSource },
      );
    }
    return close();
  });
}

async function getManagedBrowserAccess(data: any): Promise<BrowserAccess> {
  const selector = String(data?.browser ?? data?.browserId ?? '').trim();
  if (!selector) throw new Error('browser is required');
  return (await getBrowserProviderCoordinator().access(selector)).browserAccess as BrowserAccess;
}

function appendWarnings<T extends { warnings?: string[] }>(result: T, warnings: string[]): T {
  const merged = [...new Set([...(result.warnings ?? []), ...warnings])];
  return { ...result, ...(merged.length > 0 ? { warnings: merged } : {}) };
}

async function handleExtensionControlMessage(
  message: any,
  sendToExtension: (message: Record<string, any>) => void,
): Promise<void> {
  const { id, action, data = {} } = message;
  if (action === 'page_upload_chunk') {
    if (!extensionProvider.protocolReady) throw new Error('Native Messaging protocol mismatch');
    const chunk = await getControlSessionManager().readUploadChunk(data as PageUploadChunkRequest);
    sendToExtension({ id, success: true, data: chunk });
    return;
  }
  if (action === 'preset_installation') {
    sendToExtension({ id, success: true, data: await presetInstallation.handle(data) });
    return;
  }
  if (action === 'preset_browser_transfer') {
    sendToExtension({ id, success: true, data: await presetBrowserTransfer.handle(data) });
    return;
  }
  if (action === 'preset_components_status' || action === 'preset_components_install') {
    sendToExtension({
      id,
      success: true,
      data: await (action === 'preset_components_install'
        ? presetComponentInstaller.install(data.installationRevision, {
            replaceSkills: data.replaceSkills,
          })
        : presetComponentInstaller.status(data.installationRevision)),
    });
    return;
  }
  if (
    action === 'node_capabilities_status' ||
    (action === 'node_capabilities_reload' && data?.structured === true)
  ) {
    sendToExtension({
      id,
      success: true,
      data:
        action === 'node_capabilities_status'
          ? nativeCapabilities.status()
          : await nativeCapabilities.synchronize(),
    });
    return;
  }
  if (action === 'node_capabilities_reload') {
    await nativeCapabilities.refresh();
    sendToExtension({ id, success: true, data: nativeCapabilities.status() });
    return;
  }
  if (action === 'browser_sessions') {
    if (data.operation === 'list') {
      sendToExtension({
        id,
        success: true,
        data: {
          sessions: [
            ...getControlSessionManager().registry.list(),
            ...(await listProviderControlSessions()),
          ],
        },
      });
      return;
    }
    if (
      !['handoff', 'resume', 'release'].includes(data.operation) ||
      typeof data.sessionId !== 'string' ||
      !data.sessionId
    ) {
      throw new Error('Invalid browser session operation');
    }
    let session;
    try {
      getControlSessionManager().registry.info(data.sessionId);
      session = await getControlSessionManager().userControl(data.sessionId, data.operation);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('CONTROL_SESSION_NOT_FOUND'))
        throw error;
      session = await updateProviderControlSession(data.sessionId, data.operation);
    }
    sendToExtension({ id, success: true, data: { session } });
    return;
  }

  if (action === 'app_authorization_start') {
    const pairing = await startAppAuthorization(data.hook, data.params, phase => {
      try {
        sendToExtension({ id, type: 'progress', data: { phase } });
      } catch {
        // The page may have closed while the installer is running.
      }
    });
    sendToExtension({ id, success: true, data: pairing });
    return;
  }
  if (action === 'app_authorization_wait') {
    const browserId = String(data.browserId ?? '');
    try {
      const response = await waitAppAuthorization(browserId, data.params, phase => {
        try {
          sendToExtension({ id, type: 'progress', data: { phase } });
        } catch {
          // The page may have closed while the device request is still finishing.
        }
      });
      sendToExtension({ id, success: true, data: response });
    } finally {
      await closeAppAuthorization(browserId).catch(() => {});
    }
    return;
  }
  if (action === 'app_authorization_close') {
    await closeAppAuthorization(String(data.browserId ?? ''));
    sendToExtension({ id, success: true, data: {} });
    return;
  }

  if (isAgentServiceAction(action)) {
    const result = await dispatchAgentServiceAction(action, data);
    sendToExtension({ id, success: true, data: result });
    return;
  }

  if (action === 'app_profile_catalog') {
    sendToExtension({
      id,
      success: true,
      data: await listInstalledAppProfiles({ refresh: data?.refresh !== false }),
    });
    return;
  }

  if (action === 'plugin_page_call' || action === 'plugin_page_event') {
    try {
      const result = await callPluginPageService(
        String(data.plugin ?? ''),
        data.input ?? {},
        () => createNativePluginContext(false).invoke,
        action === 'plugin_page_event',
      );
      sendToExtension({ id, success: true, data: result });
    } catch (error) {
      sendToExtension({
        id,
        success: true,
        data: {
          error: {
            code: (error as any)?.code,
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
    return;
  }

  if (isToolboxServiceAction(action)) {
    const context = createNativePluginContext(true, String(data?.id ?? '').replace(/^plugin:/, ''));
    let result: unknown;
    switch (action) {
      case 'toolbox_model': {
        const plugin = String(data.id ?? '').replace(/^plugin:/, '');
        if (!['capabilities', 'list', 'start'].includes(data.operation))
          throw new Error('Invalid toolbox model operation');
        result = await callPluginModelService(
          plugin,
          { ...(data.input ?? {}), operation: data.operation },
          () => createNativePluginContext(true).invoke,
        );
        break;
      }
      case 'toolbox_state': {
        const plugin = String(data.id ?? '').replace(/^plugin:/, '');
        if (['result_chunk', 'result_release'].includes(data.operation)) {
          result = pluginPageResults.read(plugin, data.operation, data.input ?? {});
          break;
        }
        if (!['get', 'get-many', 'list', 'transact'].includes(data.operation))
          throw new Error('Invalid toolbox state operation');
        result = pluginPageResults.wrap(
          plugin,
          await callPluginStateService(
            plugin,
            { ...(data.input ?? {}), operation: data.operation },
            () => createNativePluginContext(true).invoke,
          ),
        );
        break;
      }
      case 'toolbox_page': {
        const plugin = String(data.id ?? '').replace(/^plugin:/, '');
        if (['result_chunk', 'result_release'].includes(data.operation)) {
          result = pluginPageResults.read(plugin, data.operation, data.input ?? {});
          break;
        }
        if (
          !['attach', 'get', 'list', 'send', 'detach', 'events', 'activation'].includes(
            data.operation,
          )
        )
          throw new Error('Invalid toolbox page operation');
        result = pluginPageResults.wrap(
          plugin,
          await callPluginPageService(
            plugin,
            { ...(data.input ?? {}), operation: data.operation },
            () => createNativePluginContext(true).invoke,
            false,
            true,
          ),
        );
        break;
      }
      case 'toolbox_tools_list':
        result = await listToolboxPluginTools();
        break;
      case 'toolbox_plugin_uninstall':
        result = await uninstallToolboxPlugin(data?.id);
        break;
      case 'toolbox_skill_set_enabled':
        result = setToolboxSkillEnabled(data?.id, data?.enabled);
        break;
      case 'toolbox_tool_open':
        result = await openToolboxPluginTool(data?.id, context);
        break;
      case 'toolbox_tool_page_chunk':
        result = readToolboxPluginPageChunk(data?.id, data?.hash, data?.index);
        break;
      case 'toolbox_task':
        result = await handleToolboxTask(data, context);
        break;
      case 'toolbox_tool_invoke':
        result = await invokeToolboxPluginTool(data?.id, data?.command, data?.input, context);
        break;
      default: {
        const unhandledAction: never = action;
        throw new Error(`Unknown toolbox action: ${unhandledAction}`);
      }
    }
    sendToExtension({ id, success: true, data: result });
    return;
  }

  if (action === 'browser_list') {
    const providerWarnings = await ensureInstalledProvidersRunning();
    const inventory = await listBrowserInventory(getBrowserProviderCoordinator().providerRuntimes);
    sendToExtension({
      id,
      success: true,
      data: appendWarnings(inventory, providerWarnings),
    });
    return;
  }

  if (action === 'browser_providers') {
    const coordinator = getBrowserProviderCoordinator();
    let result: unknown;
    if (data.operation === 'list') result = coordinator.definitions();
    else if (data.operation === 'configure' || data.operation === 'launch_form') {
      if (typeof data.provider !== 'string' || !data.provider.trim())
        throw new Error('provider is required');
      result =
        data.operation === 'configure'
          ? await coordinator.configure(data.provider, data.options)
          : await coordinator.getLaunchForm(data.provider, {
              variant: data.variant,
              values: data.values ?? {},
            });
    } else throw new Error('Invalid browser provider operation');
    sendToExtension({ id, success: true, data: result });
    return;
  }

  if (action === 'browser_manage') {
    const { browser, ...params } = data;
    const command = parseBrowserManageParams(params);
    let result;
    if (command.operation === 'launch' || command.operation === 'attach') {
      result = await openBrowser(command);
    } else if (typeof browser !== 'string' || !browser.trim()) {
      throw new Error('browser is required');
    } else if (command.operation === 'close') {
      result = await closeBrowser(
        { browser, deleteProfile: command.deleteProfile },
        {
          controlSource: 'local',
        },
      );
    } else if (command.operation === 'detach') {
      result = await getBrowserProviderCoordinator().detach(browser);
    } else {
      throw new Error('Invalid browser management operation for the extension');
    }
    sendToExtension({ id, success: true, data: result });
    return;
  }

  if (action === 'browser_instances') {
    if (!['start', 'detach', 'sync_cookies'].includes(data.operation))
      throw new Error('Invalid browser instance operation');
    const selector = typeof data.browser === 'string' ? data.browser.trim() : '';
    if (!selector) throw new Error('browser is required');
    const coordinator = getBrowserProviderCoordinator();
    const result =
      data.operation === 'start'
        ? await coordinator.start(selector)
        : data.operation === 'detach'
          ? await coordinator.detach(selector)
          : await coordinator.syncCookies(selector, data.scope);
    sendToExtension({ id, success: true, data: result });
    return;
  }

  if (action === 'get_browser_access_url') {
    const browserAccess = await getManagedBrowserAccess(data);
    sendToExtension({ id, success: true, data: { browserAccess } });
    return;
  }

  if (action === 'start_cloud_connector') {
    const serverUrl = data?.serverUrl;
    if (!serverUrl || typeof serverUrl !== 'string') {
      sendToExtension({ id, success: false, error: 'serverUrl is required' });
      return;
    }
    const result = await startCloudConnector(serverUrl);
    sendToExtension({ id, success: result.success, data: result, error: result.error });
    return;
  }

  if (action === 'stop_cloud_connector') {
    const serverUrl = data?.serverUrl;
    if (!serverUrl || typeof serverUrl !== 'string') {
      sendToExtension({ id, success: false, error: 'serverUrl is required' });
      return;
    }
    const result = stopCloudConnector(serverUrl);
    sendToExtension({ id, success: result.success, data: result, error: result.error });
    return;
  }

  if (action === 'list_cloud_connectors') {
    sendToExtension({ id, success: true, data: listCloudConnectors() });
    return;
  }

  if (action === 'update_setup_extension') {
    const result = await updateSetupManagedExtension({
      currentVersion: data?.currentVersion,
      setupManagedPath: data?.setupManagedPath,
    });
    sendToExtension({ id, success: true, data: result });
    return;
  }

  throw new ExtensionRpcError('UNSUPPORTED_ACTION', `Unknown extension action: ${action}`);
}

const extensionProvider = new ExtensionBrowserProvider({
  socketPath: INSTANCE_SOCKET_PATH,
  daemon: isDaemonMode,
  log,
  onDisconnect: cleanupAndExit,
  onRequest: handleExtensionControlMessage,
  onPing: message => {
    setAnalyticsClientId(message.analyticsClientId);
    nativeHostUpdateCoordinator.evaluate(message.version, message.checkForUpdates);
  },
  getPresetInstallationRevision: () =>
    presetBrowserTransfer.selectedRevision(nativeCapabilities.status().installationRevision),
});

const cdpProvider = new CdpBrowserProvider({
  args: runtimeArgs,
  socketPath: INSTANCE_SOCKET_PATH,
  endpointSource: cdpEndpointSource,
  useActivePortFile:
    Boolean(runtimeArgs.cdpUserDataDir) || cdpEndpointSource === 'built-in default',
  log,
  onPublish: cancelInventoryExit,
  onAttachDisconnect: scheduleInventoryExit,
  pluginService: (action, data) =>
    callPluginPageService(
      String(data.plugin ?? ''),
      data.input as Record<string, unknown>,
      () => async (action, payload) => {
        return (
          await dispatchHostRequest(
            { action, data: payload ?? {}, transport: 'cdp', controlSource: 'local' },
            true,
          )
        ).data;
      },
      action === 'plugin_page_event',
      false,
      'cdp',
    ),
});

function defaultBrowserTransport(): 'extension' | 'cdp' {
  return extensionProvider.connected ? 'extension' : 'cdp';
}

function browserProvider(
  transport: BrowserTransport = defaultBrowserTransport(),
): HostBrowserProvider {
  if (transport === 'extension') return extensionProvider;
  if (isDaemonMode && !inventoryOnly) return cdpProvider;
  throw new Error(
    'No connected browser. Run mearl browser_list or attach an existing browser with the CDP Provider.',
  );
}

async function releaseBrowserControl(): Promise<BrowserReleaseResult> {
  const startedAt = Date.now();
  const affectedTabIds = new Set<number>();
  const transports: Array<'extension' | 'cdp'> = [];
  const failures: BrowserReleaseFailure[] = [];
  let released = true;
  let hadActiveControl = false;
  try {
    const releaseErrors: string[] = [];
    for (const transport of ['extension', 'cdp'] as const) {
      if (transport === 'cdp' && (!isDaemonMode || inventoryOnly)) continue;
      try {
        const result = await browserProvider(transport).release({});
        released = released && result?.released !== false;
        hadActiveControl = hadActiveControl || result?.hadActiveControl === true;
        if (result?.hadActiveControl) transports.push(transport);
        for (const tabId of result?.affectedTabIds ?? []) affectedTabIds.add(tabId);
        if (Array.isArray(result?.failures)) failures.push(...result.failures);
      } catch (error) {
        releaseErrors.push(
          `${transport}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (releaseErrors.length > 0) {
      throw new Error(`Failed to fully release browser control (${releaseErrors.join('; ')})`);
    }

    trackAction('browser_manage', {
      success: released,
      transport: transports.join('+') || 'none',
      duration_ms: Date.now() - startedAt,
      extension_version: extensionProvider.version ?? 'not_connected',
    });
    return {
      released,
      hadActiveControl,
      transports,
      affectedTabIds: [...affectedTabIds].sort((a, b) => a - b),
      ...(failures.length ? { failures } : {}),
    };
  } catch (error) {
    trackAction('browser_manage', {
      success: false,
      transport: transports.join('+') || defaultBrowserTransport(),
      duration_ms: Date.now() - startedAt,
      error_code: classifyAnalyticsError(error),
      extension_version: extensionProvider.version ?? 'not_connected',
    });
    throw error;
  }
}

interface HostActionResult {
  data: any;
  closeConnection?: boolean;
  closeHost?: boolean;
}

/** Structured dispatch is shared by Socket requests and scoped browser operations. */
async function dispatchHostRequest(
  request: any,
  managed = false,
  trustedUpload?: true,
): Promise<HostActionResult> {
  const { action, data = {} } = request;
  assertBrowserRequestDeadline(request.deadline);
  const controlSource = normalizeControlSource(request.controlSource);
  if (action === '__provider_enhancement') {
    if (request.controlSessionId !== undefined)
      throw new Error('Enhancements do not accept Mearl control sessions');
    return {
      data: await getBrowserEnhancementGateway().invoke(
        request.providerTarget,
        request.providerControlToken,
        data,
        request.deadline,
        request.providerSourceIdentity,
        request.providerPageId,
      ),
    };
  }
  if (action === 'preset_components_status' || action === 'preset_components_install')
    return {
      data: await (action === 'preset_components_install'
        ? presetComponentInstaller.install(data.installationRevision, {
            replaceSkills: data.replaceSkills,
          })
        : presetComponentInstaller.status(data.installationRevision)),
    };
  if (action === 'preset_browser_sync') {
    if (
      typeof data.installationRevision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.installationRevision)
    )
      throw new Error('Expected a preset installation revision');
    return {
      data: await requestPresetBrowser({
        operation: 'sync',
        installationRevision: data.installationRevision,
        showPermissions:
          !managed && controlSource === 'local' && request.controlSessionId === undefined,
      }),
    };
  }
  if (action === 'preset_browser_status') {
    const status = await requestPresetBrowser({ operation: 'status' });
    return { data: { ...status, uninstallSupported: true } };
  }
  if (action === 'preset_browser_uninstall') {
    if (managed || controlSource !== 'local' || request.controlSessionId !== undefined)
      throw new Error('Preset removal requires local setup');
    return {
      data: await requestPresetBrowser({
        operation: 'uninstall',
        browserRevision: data.browserRevision,
        installationToken: data.installationToken,
      }),
    };
  }
  if (action === 'profile_install') {
    if (controlSource !== 'local' || request.controlSessionId !== undefined)
      throw new Error('App profile installation requires local setup');
    if (!extensionProvider.connected)
      throw new Error('Connect a Mearl extension before installing App profiles');
    if (typeof data.source !== 'string') throw new Error('Expected an App profile source');
    return {
      data: await extensionProvider.request(
        '__profile_install',
        { source: data.source },
        145000,
        true,
      ),
    };
  }
  if (action === 'node_capabilities_status') return { data: nativeCapabilities.status() };
  if (action === 'node_capabilities_reload' && data.structured === true)
    return { data: await nativeCapabilities.synchronize() };
  if (action === 'node_capabilities_reload') {
    await nativeCapabilities.refresh();
    return { data: nativeCapabilities.status() };
  }
  if (action === '__control_session_resolve') {
    return { data: { session: getControlSessionManager().registry.find(data.sessionId) ?? null } };
  }
  if (action === 'provider_control_sessions_changed') {
    extensionProvider.send({ type: 'control_sessions_changed' });
    return { data: { refreshed: true } };
  }
  if (action === 'session_list') {
    if (request.controlSessionId !== undefined)
      throw new Error('session_list does not accept a session override');
    return { data: { sessions: getControlSessionManager().registry.list() } };
  }
  if (action === 'session_manage') {
    const command = parseSessionManageParams(data);
    if (
      command.operation === 'new' &&
      (request.transport === 'cdp'
        ? !cdpProvider.isConnected
        : !extensionProvider.connected && !cdpProvider.isConnected)
    )
      throw new Error('No connected browser for session_manage new');
    return {
      data: await getControlSessionManager().manageSession(
        command,
        resolveSessionManageId(command, request.controlSessionId),
        request.transport,
        request.deadline,
      ),
    };
  }
  // A private CDP host also serves the external Provider's control capability.
  if (action === 'browser_release' && isDaemonMode && skipBrowserRegistration && !inventoryOnly) {
    return { data: await getControlSessionManager().releaseBrowser(releaseBrowserControl) };
  }
  if (action === 'browser_manage') {
    if (request.controlSessionId !== undefined)
      throw new Error('browser_manage does not accept a control session');
    const { browser, ...params } = data;
    const command = parseBrowserManageParams(params);
    if (command.operation === 'launch' || command.operation === 'attach')
      return { data: await openBrowser(command, request.deadline) };
    if (command.operation === 'close')
      return {
        data: await closeBrowser(
          { browser, deleteProfile: command.deleteProfile },
          {
            deadline: request.deadline,
            controlSource,
          },
        ),
      };
    if (command.operation === 'detach' && !cdpProvider.isAttached)
      throw new Error('This browser does not support detach');
    return getControlSessionManager().releaseBrowser(async () => {
      assertBrowserRequestDeadline(request.deadline);
      const result = await releaseBrowserControl();
      if (command.operation === 'release') return { data: result };
      if (!result.released) throw new Error('Could not fully release control before detaching');
      cdpProvider.dispose();
      return { data: { detached: true }, closeHost: true };
    });
  }
  if (
    !managed &&
    (isExtensionBrowserAction(action) ||
      action === 'page_download' ||
      action === 'page_record' ||
      (typeof action === 'string' && action.startsWith('__artifact_')))
  ) {
    return {
      data: await getControlSessionManager().invoke(
        action,
        data,
        request.controlSessionId,
        request.transport,
        controlSource,
        request.deadline,
      ),
    };
  }
  if (action === 'start_cloud_connector') {
    if (!data.serverUrl || typeof data.serverUrl !== 'string')
      throw new Error('serverUrl is required');
    const result = await startCloudConnector(data.serverUrl);
    if (!result.success) throw new Error(result.error ?? 'Cloud connector failed to start');
    return { data: result };
  }
  if (action === 'stop_cloud_connector') {
    if (!data.serverUrl || typeof data.serverUrl !== 'string')
      throw new Error('serverUrl is required');
    const result = stopCloudConnector(data.serverUrl);
    if (!result.success) throw new Error(result.error ?? 'Cloud connector failed to stop');
    return { data: result };
  }
  if (action === 'list_cloud_connectors') return { data: listCloudConnectors() };
  if (action === 'get_versions') return { data: await collectVersions(controlSource === 'local') };
  if (action === '__cdp_attach' && attachCdp) {
    cancelInventoryExit();
    const { discovered, warning } = await cdpProvider.discover();
    if (!discovered) {
      if (!listRegisteredBrowsers().some(browser => browser.browserId === cdpProvider.browserId))
        throw new Error(warning ?? 'Could not attach to the CDP browser');
      scheduleInventoryExit();
    }
    return { data: { connected: true } };
  }
  if (action === 'get_browser_access_url')
    return {
      data: {
        browserAccess: data.browser
          ? await getManagedBrowserAccess(data)
          : await resolveBrowserAccess(),
      },
    };
  if (isPrivateExtensionAction(action))
    throw new Error('Internal action is not available to clients');
  if (action === 'agent_chat_run') return { data: await getAgentChatManager().runTask(data) };
  if (action === 'browser_list') {
    const providerWarnings = await ensureInstalledProvidersRunning();
    const hasLocalBrowser = listRegisteredBrowsers().some(
      browser =>
        (browser.status === undefined || browser.status === 'connected') &&
        (browser.transport === 'extension' ||
          (browser.transport === 'cdp' && !browser.browserId.startsWith('managed:'))),
    );
    if (!attachCdp && (!skipBrowserRegistration || inventoryOnly) && !hasLocalBrowser) {
      try {
        await openBrowser(
          { operation: 'attach', provider: CDP_PROVIDER.providerId },
          request.deadline,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        providerWarnings.push(`Local CDP discovery: ${message}`);
      }
    }
    const inventory = await listBrowserInventory(getBrowserProviderCoordinator().providerRuntimes);
    const inventoryData = appendWarnings(inventory, providerWarnings);
    const closeConnection = inventoryOnly && skipBrowserRegistration;
    if (closeConnection) scheduleInventoryExit();
    return { data: inventoryData, closeConnection };
  }
  if (!isExtensionBrowserAction(action) && (typeof action !== 'string' || !action.startsWith('__')))
    throw new Error(`Unsupported action: ${String(action)}`);
  if (request.transport === 'extension' && !extensionProvider.connected) {
    throw new Error('CONTROL_SESSION_TRANSPORT_UNAVAILABLE: extension is disconnected');
  }
  const transport = request.transport === 'cdp' ? 'cdp' : defaultBrowserTransport();
  const startedAt = Date.now();
  try {
    validateRequiredActionTabId(action, data);
    const result =
      trustedUpload && transport === 'extension'
        ? await extensionProvider.invokeStagedUpload(action, data, controlSource)
        : await browserProvider(transport).invoke(action, data, controlSource, request.deadline);
    trackAction(action, {
      success: true,
      transport,
      duration_ms: Date.now() - startedAt,
      extension_version: extensionProvider.version ?? 'not_connected',
    });
    return { data: result };
  } catch (error) {
    trackAction(action, {
      success: false,
      transport,
      duration_ms: Date.now() - startedAt,
      error_code: classifyAnalyticsError(error),
      extension_version: extensionProvider.version ?? 'not_connected',
    });
    throw error;
  }
}

async function handleSocketRequest(socket: net.Socket, line: string): Promise<void> {
  let request: any;
  try {
    request = JSON.parse(line);
  } catch {
    socket.write(
      JSON.stringify({ id: '', success: false, error: `Invalid JSON request: ${line}` }) + '\n',
    );
    return;
  }
  const id = request.id ?? '';
  try {
    const result = await dispatchHostRequest(request);
    const response: Record<string, any> = { id, success: true, data: result.data };
    if (!versionWarningEmitted) {
      const warning = buildVersionWarning(request.version);
      if (warning) {
        versionWarningEmitted = true;
        response.versionWarning = warning;
      }
    }
    const encoded = JSON.stringify(response) + '\n';
    if (result.closeHost || result.data?.[CLOSED_OWN_MANAGED_HOST]) {
      // A closing host owns the response socket until the receipt has been flushed.
      let shuttingDown = false;
      const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        socket.off('close', shutdown);
        shutdownWithDeadline();
      };
      if (socket.destroyed) shutdown();
      else {
        socket.once('close', shutdown);
        socket.end(encoded, shutdown);
      }
    } else if (result.closeConnection) socket.end(encoded);
    else socket.write(encoded);
  } catch (error) {
    socket.write(
      JSON.stringify({
        id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }) + '\n',
    );
  }
}

async function handleSocketLine(socket: net.Socket, line: string): Promise<void> {
  await handleSocketRequest(socket, line);
}

/** Shared connection handler used by both the instance and legacy sockets. */
function onSocketConnection(socket: net.Socket): void {
  const lineBuffer = new Utf8LineBuffer(MAX_SOCKET_BUFFER_SIZE);

  socket.on('data', (chunk: Buffer) => {
    const result = lineBuffer.push(chunk);
    if (result.overflow) {
      log(`socket request exceeded ${MAX_SOCKET_BUFFER_SIZE} bytes; closing connection`);
      socket.destroy();
      return;
    }

    for (const line of result.lines) {
      if (!line.trim()) {
        continue;
      }

      handleSocketLine(socket, line);
    }
  });

  socket.on('error', (error: Error) => {
    log('socket error:', String(error));
  });
}

/** Best-effort liveness probe: true iff a connect to `socketPath` succeeds. */
function isPathAlive(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    if (process.platform !== 'win32' && !fs.existsSync(socketPath)) {
      resolve(false);
      return;
    }
    const client = net.createConnection(socketPath);
    const done = (alive: boolean): void => {
      client.removeAllListeners();
      client.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), 500);
    client.on('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    client.on('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/** Create and bind a socket server; resolves once it is listening, rejects on bind error. */
function listenOn(socketPath: string): Promise<ReturnType<typeof net.createServer>> {
  return new Promise((resolve, reject) => {
    // Unix domain sockets leave a stale file on disk; Named Pipes (Windows) do not.
    if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // ignore — listen surfaces a real conflict below
      }
    }
    const server = net.createServer(onSocketConnection);
    server.once('error', reject);
    server.listen(socketPath, () => {
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch (error) {
          server.close();
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // ignore cleanup errors; the original chmod failure is more useful
          }
          reject(error);
          return;
        }
      }
      server.removeListener('error', reject);
      server.on('error', (error: Error) => log('socket server error:', String(error)));
      log(`listening on ${socketPath}`);
      resolve(server);
    });
  });
}

/**
 * Also own the legacy well-known socket for pre-registry clients — but never
 * kick a live peer off it (that caused the historical takeover flapping). Bind
 * only when it is free or stale; otherwise leave the current owner alone and
 * rely on the registry to make us reachable.
 */
async function tryBindLegacySocket(): Promise<void> {
  if (await isPathAlive(LEGACY_SOCKET_PATH)) {
    log('legacy socket already owned by a live host, skipping');
    return;
  }
  try {
    legacyServer = await listenOn(LEGACY_SOCKET_PATH);
  } catch (error) {
    // Lost a race to bind it — fine, another host got there first.
    log('legacy socket bind failed (raced):', String(error));
    legacyServer = null;
  }
}

/** Stop serving the legacy socket (on a takeover request or shutdown). */
function releaseLegacySocket(): void {
  if (!legacyServer) return;
  const server = legacyServer;
  legacyServer = null;
  try {
    server.close();
  } catch {
    // ignore
  }
  if (process.platform !== 'win32') {
    try {
      if (fs.existsSync(LEGACY_SOCKET_PATH)) fs.unlinkSync(LEGACY_SOCKET_PATH);
    } catch {
      // ignore
    }
  }
}

async function startSocketServer(): Promise<void> {
  // Primary endpoint: this process's pid-unique socket. Never contended, so
  // multiple browsers' native-hosts coexist and are each addressable.
  socketServer = await listenOn(INSTANCE_SOCKET_PATH);
  // Best-effort backward-compat endpoint for clients that predate the registry.
  if (!skipBrowserRegistration && !attachCdp) await tryBindLegacySocket();
}

// Cloud connector management is in ./cloud-connector.ts
// (startCloudConnector, stopCloudConnector, listCloudConnectors)

function cleanupInstanceSocketFile(): void {
  // Named Pipes (Windows) are managed by the OS; only Unix domain sockets need cleanup.
  if (process.platform === 'win32') return;
  try {
    if (fs.existsSync(INSTANCE_SOCKET_PATH)) {
      fs.unlinkSync(INSTANCE_SOCKET_PATH);
    }
  } catch (error) {
    log('cleanup socket file failed:', String(error));
  }
}

function cleanupAndExit(code: number): void {
  controlSessionManager?.artifacts.disposeSync();
  cancelInventoryExit();
  // Cloud-connector child processes are intentionally NOT killed here. They run
  // detached so they survive extension reloads / native-host restarts; the next
  // native-host re-discovers and adopts them via the connector registry.
  cdpProvider.dispose();
  agentChatManager?.dispose();
  agentChatManager = null;
  extensionProvider.dispose();
  // releaseLegacySocket only unlinks the legacy file if we actually own it, so
  // this never disturbs another host that holds it.
  releaseLegacySocket();

  const finish = (): void => {
    cleanupInstanceSocketFile();
    const deadline = setTimeout(() => process.exit(code), 2_000);
    void closeAppAuthorizations().finally(() => {
      clearTimeout(deadline);
      process.exit(code);
    });
  };

  if (socketServer) {
    socketServer.close(finish);
    socketServer = null;
    return;
  }

  finish();
}

function shutdownWithDeadline(): void {
  // Persistent sockets must not keep a shutting-down host alive indefinitely.
  const forcedExit = setTimeout(() => process.exit(0), 2_000);
  forcedExit.unref();
  cleanupAndExit(0);
}

async function main(): Promise<void> {
  await nativeCapabilities
    .refresh()
    .catch(error => log('Node capabilities unavailable:', String(error)));
  initBrowserRegistry({ log });
  // Reap registry records left behind by native-hosts that crashed without
  // cleanup, so stale entries don't accumulate now that nothing prunes on read.
  pruneDeadBrowsers();
  pruneOrphanLogs(keyedDir('managed-browsers'));

  // Initialise cloud-connector module with runtime dependencies
  initCloudConnector({
    log,
    isDaemonMode,
    sendToExtension: message => extensionProvider.send(message),
    version: NATIVE_HOST_VERSION,
  });

  // In daemon mode there is no extension stdin pipe, so skip Native Messaging input setup.
  // Otherwise the stdin 'end' handler may fire immediately and kill the detached process.
  if (isDaemonMode) {
    const mode = inventoryOnly ? 'browser inventory' : 'CDP';
    log(
      `running in ${mode} daemon mode, pid=${process.pid}, version=${NATIVE_HOST_VERSION}, cdp=${cdpProvider.endpointDescription}`,
    );
  } else {
    extensionProvider.start();
  }
  if (attachCdp) scheduleInventoryExit(ATTACH_REQUEST_IDLE_EXIT_MS);
  await startSocketServer();
  if (!attachCdp && !skipBrowserRegistration && !inventoryOnly) {
    const updatePreset = createNativePresetAutoUpdater({
      directory: nativeCapabilityDirectory(),
      invoke: invokePresetHost,
      extensionConnected: () => extensionProvider.connected,
      browserSelection: () =>
        requestPresetBrowser({ operation: 'status' }) as Promise<{
          presetId?: string;
          presetSource?: string;
        }>,
      log,
    });
    setTimeout(() => {
      void updatePreset();
    }, 30_000).unref();
    setInterval(() => {
      void updatePreset();
    }, 60 * 60_000).unref();
  }

  if (!inventoryOnly) await cdpProvider.start();

  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));
  process.on('uncaughtException', (error: Error) => {
    log('uncaughtException:', String(error));
    cleanupAndExit(1);
  });
  process.on('unhandledRejection', (error: unknown) => {
    log('unhandledRejection:', String(error));
    cleanupAndExit(1);
  });
}

main().catch((error: unknown) => {
  log('main() failed:', String(error));
  process.exit(1);
});
