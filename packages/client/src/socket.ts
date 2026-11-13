/**
 * 底层 Socket 通信模块
 *
 * 通过 Unix Domain Socket (macOS/Linux) 或 Named Pipe (Windows) 与 native host 进程通信。
 * 每次调用新建连接，收到响应后关闭，简单可靠。
 *
 * 当 Socket 不存在，或 legacy Socket 是无人监听的残留文件时，
 * 自动尝试拉起 native host，稍后重试连接。
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLIENT_VERSION } from './runtimePaths.js';
import { StringDecoder } from 'node:string_decoder';
import {
  assertProviderControlSessionMode,
  ensureProviderControlHost,
  listInstalledProviders,
} from '@mearl/provider/host';
import {
  MEARL_PROVIDER_PROTOCOL_VERSION,
  assertProviderProtocolVersion,
  validateProviderLaunchForm,
} from '@mearl/provider';
import { readLiveProvider, ensureInstalledProvidersRunning } from '@mearl/provider/runtime';
import { resolveFileRefs } from './fileRefs.js';
import {
  listLiveBrowsers,
  findBrowser,
  describeBrowser,
  type LiveBrowser,
} from './browserRegistry.js';
import { resolveActionTimeoutSec } from './actionTimeouts.js';
import {
  isBrowserCapabilityAction,
  parseBrowserListParams,
  type BrowserControlSessionMode,
} from '@mearl/browser-core';

export { CLIENT_VERSION };
const MAX_SOCKET_BUFFER_SIZE = 64 * 1024 * 1024;

/**
 * Legacy well-known socket. New native-hosts publish per-browser sockets in the
 * registry and we address those; this path is a fallback for pre-registry hosts
 * (or the pre-ping startup window) and is what auto-spawn targets.
 */
export const SOCKET_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\mearl-agent'
    : path.join(os.tmpdir(), 'mearl-agent.sock');

export type ControlSource = 'local' | 'remote';
type CompatibleControlSource = ControlSource | 'cloud';
type ControlSourceWireValue = 'local' | 'cloud';

function toControlSourceWireValue(source: CompatibleControlSource): ControlSourceWireValue {
  return source === 'remote' || source === 'cloud' ? 'cloud' : 'local';
}

const SESSION_OPTION = Symbol('control-session');

export interface InvokeOptions {
  controlSessionId?: string;
  /** Pin a known local endpoint for a sequence of transport requests. */
  socketPath?: string;
  /** 超时时间（秒），默认 15 */
  timeoutSec?: number;
  /** Absolute cutoff for sending this request, including any routing retries. */
  deadline?: number;
  /** Target a specific browser by id / name (see the browser registry). */
  browser?: string;
  /** Identifies whether browser control originated on this machine or through a remote connector. */
  controlSource?: CompatibleControlSource;
}

/**
 * Process-wide default browser selector. Lets a long-lived host (e.g. the MCP
 * server) pin a target once via `select_browser` without threading it through
 * every call. Explicit `options.browser` still wins per-call.
 */
let defaultBrowser: string | undefined;

/** Pin the default target browser for subsequent invokes (undefined clears it). */
export function setDefaultBrowser(selector: string | undefined): void {
  defaultBrowser = selector && selector.trim() ? selector.trim() : undefined;
}

export function getDefaultBrowser(): string | undefined {
  return defaultBrowser;
}

function findConnectedBrowser(
  items: Record<string, any>[],
  selector: string,
): Record<string, any> | null {
  const normalized = selector.trim().toLowerCase();
  const connected = items.filter(item => item.status === 'connected');
  const byId = connected.find(item => String(item.browserId).toLowerCase() === normalized);
  if (byId) return byId;
  const exactNameMatches = connected.filter(item => String(item.name).toLowerCase() === normalized);
  if (exactNameMatches.length > 1) {
    throw new Error(
      `Browser name "${selector.trim()}" is ambiguous. Use a full browserId: ${exactNameMatches
        .map(item => String(item.browserId))
        .join(', ')}`,
    );
  }
  return (
    exactNameMatches[0] ??
    connected.find(
      item =>
        String(item.browserId).toLowerCase().includes(normalized) ||
        String(item.name).toLowerCase().includes(normalized),
    ) ??
    null
  );
}

export function decorateBrowserListResult(result: Record<string, any>): Record<string, any> {
  const browsers: Record<string, any>[] = Array.isArray(result?.browsers) ? result.browsers : [];
  const selector = getDefaultBrowser() ?? process.env.MEARL_BROWSER;
  const selected = selector
    ? findConnectedBrowser(browsers, selector)
    : (browsers.find(browser => browser.status === 'connected') ?? null);

  return {
    ...result,
    defaultBrowserId: selected?.browserId ?? null,
  };
}

function browserListFromProviderRecords(browsers: LiveBrowser[]): Record<string, any> {
  const providerBrowsers = browsers
    .filter(browser => browser.transport === 'provider')
    .map(browser => ({
      browserId: browser.browserId,
      name: browser.browserName,
      type: 'managed',
      status: browser.status ?? 'running_disconnected',
      transport: 'provider',
      provider: browser.provider,
      ownership: browser.ownership,
      persistence: browser.persistence,
      operations: browser.operations,
      pairing: browser.pairing,
      references: browser.references,
      details: browser.details,
    }));
  return {
    count: providerBrowsers.length,
    connectedCount: providerBrowsers.filter(browser => browser.status === 'connected').length,
    browsers: providerBrowsers,
  };
}

function withInventoryWarning(result: Record<string, any>, error: unknown): Record<string, any> {
  const cause = (error as Error & { cause?: unknown }).cause ?? error;
  const code = (cause as NodeJS.ErrnoException)?.code;
  const detail = code ?? (error instanceof Error ? error.message.split('\n')[0] : String(error));
  return {
    ...result,
    warnings: [
      ...(Array.isArray(result.warnings) ? result.warnings : []),
      `Local browser inventory could not load: ${detail}`,
    ],
  };
}

function areInstalledProvidersRunning(): boolean {
  return listInstalledProviders().every(provider => readLiveProvider(provider.providerId));
}

function isConnectedBrowser(browser: LiveBrowser): boolean {
  return browser.status === undefined || browser.status === 'connected';
}

function supportsAction(browser: LiveBrowser, action: string, data: Record<string, any>): boolean {
  if (browser.transport === 'provider') {
    if (
      action === 'browser_control' ||
      (action === 'get_capabilities' && isConnectedBrowser(browser)) ||
      (action === 'browser_release' && (data as any)[SESSION_OPTION])
    )
      return true;
    if (action.startsWith('__artifact_'))
      return (
        browser.capabilities?.actions.includes('page_upload') === true ||
        ((action === '__artifact_read' || action === '__artifact_remove') &&
          browser.capabilities?.actions.includes('page_download') === true)
      );
    if (action === 'run_actions' && (data as any)[SESSION_OPTION]) return true;
  }
  if (action === 'get_versions') return true;
  if (action === 'get_browser_access_url') {
    return browser.transport !== 'provider' || browser.operations?.includes('access') === true;
  }
  if (action === 'browser_close') {
    if (browser.transport !== 'provider') return true;
    const required = data.deleteProfile === true ? 'deleteData' : 'close';
    return browser.operations?.includes(required as any) === true;
  }
  if (action === 'browser_release') {
    return browser.transport !== 'provider' || browser.operations?.includes('detach') === true;
  }
  if (!isConnectedBrowser(browser)) return false;
  return (
    browser.transport !== 'provider' ||
    browser.capabilities?.actions.some(capability => capability === action) === true
  );
}

function routableBrowsers(
  browsers: LiveBrowser[],
  action: string,
  data: Record<string, any>,
): LiveBrowser[] {
  return browsers.filter(
    browser =>
      isConnectedBrowser(browser) &&
      (!['browser_list', 'browser_launch'].includes(action) || browser.transport !== 'provider') &&
      supportsAction(browser, action, data),
  );
}

/** Resolve an existing local route without executing the action. */
export function resolveLocalActionTarget(
  action: string,
  data: Record<string, any>,
  options: InvokeOptions = {},
): { browser?: string; socketPath?: string } | undefined {
  const selector = options.browser ?? defaultBrowser ?? process.env.MEARL_BROWSER ?? undefined;
  const socketPath = options.socketPath ?? process.env.MEARL_SOCKET_PATH?.trim();
  if (socketPath && (options.socketPath || !selector)) return { socketPath };
  const browsers = listLiveBrowsers();
  const target = selector
    ? findBrowser(browsers, selector)
    : routableBrowsers(browsers, action, data)[0];
  return target ? { browser: target.browserId } : undefined;
}

function selectBrowserResult(data: Record<string, any>): Record<string, any> {
  const selector = typeof data.browser === 'string' ? data.browser.trim() : '';
  if (!selector) {
    setDefaultBrowser(undefined);
    return {
      selected: null,
      note: 'Cleared: default target is now the most-recently focused browser.',
    };
  }

  const browsers = listLiveBrowsers();
  const controllableBrowsers = browsers.filter(isConnectedBrowser);
  const match = findBrowser(controllableBrowsers, selector);
  if (!match) throw new Error(formatNoMatchError(selector, browsers));
  setDefaultBrowser(match.browserId);
  return { selected: { browserId: match.browserId, name: match.browserName } };
}

/** Deduplicates concurrent recovery attempts in long-lived clients such as the MCP server. */
let persistentSpawnPromise: Promise<boolean> | null = null;
let inventoryListPromise: Promise<Record<string, any>> | null = null;
let inventoryListCache: {
  key: string;
  until: number;
  result?: Record<string, any>;
  error?: unknown;
} | null = null;
const INVENTORY_STARTUP_TIMEOUT_MS = 3_000;
const INVENTORY_RETRY_INTERVAL_MS = 50;
const INVENTORY_CACHE_MS = 2_000;

function instanceSocketPath(pid: number): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mearl-agent-${pid}`
    : path.join(os.tmpdir(), `mearl-agent-${pid}.sock`);
}

function inventoryCacheKey(): string {
  const browsers = listLiveBrowsers()
    .map(browser => [
      browser.browserId,
      browser.pid,
      browser.socketPath,
      browser.status,
      browser.updatedAt,
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const providers = listInstalledProviders()
    .map(provider => provider.providerId)
    .sort();
  return JSON.stringify({ browsers, providers });
}

async function spawnNativeHost(args: string[]): Promise<number | undefined> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('mearl-native-host', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

/**
 * Attempt to spawn `mearl-native-host` in the background (detached).
 * Returns true if a spawn was attempted (regardless of success).
 */
async function trySpawnNativeHost(): Promise<boolean> {
  if (persistentSpawnPromise) return persistentSpawnPromise;

  const spawnPromise = (async () => {
    try {
      await spawnNativeHost(['--daemon', '--inventory']);
      return true;
    } catch {
      return false;
    }
  })();

  persistentSpawnPromise = spawnPromise;
  try {
    return await spawnPromise;
  } finally {
    if (persistentSpawnPromise === spawnPromise) persistentSpawnPromise = null;
  }
}

async function loadLocalBrowserList(
  timeoutSec: number,
  controlSource: CompatibleControlSource,
): Promise<Record<string, any>> {
  if (inventoryListPromise) return inventoryListPromise;
  const cacheKey = inventoryCacheKey();
  if (
    inventoryListCache &&
    inventoryListCache.key === cacheKey &&
    Date.now() < inventoryListCache.until
  ) {
    if (inventoryListCache.error) throw inventoryListCache.error;
    return inventoryListCache.result!;
  }
  inventoryListCache = null;
  const request = (async () => {
    const pid = await spawnNativeHost(['--daemon', '--inventory', '--skip-browser-registration']);
    if (pid === undefined) throw new Error('Native host did not report its process id');
    const socketPath = instanceSocketPath(pid);
    const deadline = Date.now() + Math.min(timeoutSec * 1_000, INVENTORY_STARTUP_TIMEOUT_MS);
    while (true) {
      try {
        return await invokeOnce('browser_list', {}, timeoutSec, socketPath, controlSource);
      } catch (error) {
        if (!isConnError(error) || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, INVENTORY_RETRY_INTERVAL_MS));
      }
    }
  })();
  inventoryListPromise = request;
  try {
    const result = await request;
    inventoryListCache = { key: cacheKey, result, until: Date.now() + INVENTORY_CACHE_MS };
    return result;
  } catch (error) {
    inventoryListCache = { key: cacheKey, error, until: Date.now() + INVENTORY_CACHE_MS };
    throw error;
  } finally {
    if (inventoryListPromise === request) inventoryListPromise = null;
  }
}

interface UnixSocketIdentity {
  dev: number;
  ino: number;
}

function readOwnedLegacySocketIdentity(): UnixSocketIdentity | null {
  if (process.platform === 'win32') return null;
  try {
    const stat = fs.lstatSync(SOCKET_PATH);
    if (!stat.isSocket()) return null;
    if (process.getuid && stat.uid !== process.getuid()) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

/** Remove only the same-user socket inode whose failed connection proved it stale. */
function removeStaleLegacySocket(identity: UnixSocketIdentity | null): void {
  if (!identity) return;
  try {
    const current = fs.lstatSync(SOCKET_PATH);
    if (!current.isSocket() || current.dev !== identity.dev || current.ino !== identity.ino) return;
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // Spawning and the final retry provide the authoritative recovery result.
  }
}

/**
 * 向 native host 发送一个 action 请求并等待响应。
 *
 * 目标解析优先级：显式 options.browser → setDefaultBrowser → 环境变量
 * MEARL_BROWSER → 自动（注册表中最近聚焦的浏览器）。注册表为空时回退到
 * legacy well-known socket，并在 socket 不存在或已残留时自动拉起 native host。
 */
export function invoke(
  action: string,
  data: Record<string, any> = {},
  options: InvokeOptions = {},
): Promise<any> {
  if (action === '__resolve_action_target') {
    if (!isBrowserCapabilityAction(data.action))
      return Promise.reject(new Error('Invalid browser capability action'));
    const target = resolveLocalActionTarget(data.action, data.data ?? {}, options);
    const browser =
      target?.browser ??
      (target?.socketPath
        ? listLiveBrowsers().find(
            item =>
              item.socketPath === target.socketPath &&
              supportsAction(item, data.action, data.data ?? {}),
          )?.browserId
        : undefined);
    return Promise.resolve(browser ? { browser } : null);
  }
  if (action === 'browser_select_browser') {
    try {
      return Promise.resolve(selectBrowserResult(data));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  const {
    timeoutSec = resolveActionTimeoutSec(action, data),
    browser,
    controlSource = 'local',
  } = options;
  if (action === '__control_session_resolve') {
    return resolveControlSession(data.sessionId, timeoutSec, controlSource);
  }
  // 统一解析 payload 顶层字段中的 `@<path>` 文件引用（所有 action 通用）
  const resolvedData = resolveFileRefs(data);
  Object.defineProperty(resolvedData, SESSION_OPTION, { value: options.controlSessionId });
  if (action === 'browser_list') {
    const discovery = parseBrowserListParams(resolvedData);
    if (discovery) {
      return (async () => {
        if (options.socketPath || controlSource !== 'local' || options.controlSessionId)
          throw new Error(
            'Provider discovery requires the local source without a socket or session override',
          );
        const provider = listInstalledProviders().find(
          provider => provider.providerId === discovery.provider,
        );
        if (!provider?.browserType.dynamicLaunchForm)
          throw new Error(`Provider does not support dynamic launch forms: ${discovery.provider}`);
        const warnings = await ensureInstalledProvidersRunning([discovery.provider]);
        if (warnings.length) throw new Error(warnings.join('; '));
        const live = readLiveProvider(discovery.provider);
        if (!live) throw new Error(`Provider did not start: ${discovery.provider}`);
        assertProviderProtocolVersion(live.providerProtocolVersion, discovery.provider);
        const form = await invokeOnce(
          'browser_providers',
          { operation: 'launch_form', ...discovery.launchForm },
          timeoutSec,
          live.socketPath,
          'local',
        );
        validateProviderLaunchForm(form);
        return decorateBrowserListResult({
          ...browserListFromProviderRecords(
            listLiveBrowsers().filter(browser => browser.provider?.id === discovery.provider),
          ),
          discovery: { provider: discovery.provider, launchForm: form },
        });
      })();
    }
    return dispatchInvoke(
      action,
      resolvedData,
      timeoutSec,
      undefined,
      controlSource,
      options.socketPath,
      options.deadline,
    ).then(decorateBrowserListResult);
  }
  const selector = browser ?? defaultBrowser ?? process.env.MEARL_BROWSER ?? undefined;
  return dispatchInvoke(
    action,
    resolvedData,
    timeoutSec,
    selector,
    controlSource,
    options.socketPath,
    options.deadline,
  );
}

/** Infrastructure calls stay on this machine even when an Agent has selected an external browser. */
export function invokeLocalHost(
  action: string,
  data: Record<string, any> = {},
  options: Pick<InvokeOptions, 'timeoutSec' | 'socketPath'> = {},
): Promise<any> {
  const timeoutSec = options.timeoutSec ?? resolveActionTimeoutSec(action, data);
  const socketPath = options.socketPath ?? process.env.MEARL_SOCKET_PATH?.trim();
  const accepted = resolveFileRefs(data);
  return socketPath
    ? invokeOnce(action, accepted, timeoutSec, socketPath, 'local')
    : invokeViaLegacy(action, accepted, timeoutSec, 'local', false, true);
}

/** Session ownership lives in the control hosts and survives individual CLI connections. */
async function resolveControlSession(
  sessionId: string,
  timeoutSec: number,
  controlSource: CompatibleControlSource,
): Promise<any> {
  const browsers = listLiveBrowsers();
  const configuredSocketPath = process.env.MEARL_SOCKET_PATH?.trim();
  const sockets = configuredSocketPath
    ? [configuredSocketPath]
    : [
        ...new Set(
          browsers
            .filter(browser => browser.transport !== 'provider')
            .map(browser => browser.socketPath),
        ),
      ];
  const provider = configuredSocketPath
    ? undefined
    : browsers.find(browser => browser.transport === 'provider');
  if (!sockets.length && !provider) sockets.push(SOCKET_PATH);
  const requests = sockets.map(socketPath =>
    invokeOnce('__control_session_resolve', { sessionId }, timeoutSec, socketPath, controlSource),
  );
  if (provider) {
    requests.push(
      invokeOnce(
        '__control_session_resolve',
        { sessionId },
        timeoutSec,
        provider.socketPath,
        controlSource,
        provider.browserId,
      ),
    );
  }
  const results = await Promise.allSettled(requests);
  const sessions = results.flatMap(result =>
    result.status === 'fulfilled' && result.value?.session?.sessionId === sessionId
      ? [result.value.session]
      : [],
  );
  if (sessions.length > 1) throw new Error('CONTROL_SESSION_AMBIGUOUS: multiple hosts own this id');
  if (sessions.length) return { session: sessions[0] };
  const failure = results.find(
    result => result.status === 'rejected' && !isConnError(result.reason),
  );
  if (failure?.status === 'rejected') throw failure.reason;
  return { session: null };
}

function isConnError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

function isSocketSandboxError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EPERM';
}

function isUnavailableConnection(error: unknown): boolean {
  const cause = (error as Error & { cause?: unknown }).cause ?? error;
  const code = (cause as NodeJS.ErrnoException)?.code;
  return isConnError(cause) || isSocketSandboxError(cause) || code === 'EACCES';
}

async function dispatchInvoke(
  action: string,
  data: Record<string, any>,
  timeoutSec: number,
  selector: string | undefined,
  controlSource: CompatibleControlSource,
  socketPath?: string,
  deadline?: number,
): Promise<any> {
  const send = (path: string, target?: LiveBrowser) =>
    invokeOnce(
      action,
      data,
      timeoutSec,
      path,
      controlSource,
      target?.transport === 'provider' ? target.browserId : undefined,
      target?.capabilities?.controlSessionMode,
      deadline,
    );
  const configuredSocketPath = socketPath ?? process.env.MEARL_SOCKET_PATH?.trim();
  if (configuredSocketPath && (socketPath || !selector)) {
    try {
      return await send(configuredSocketPath);
    } catch (error) {
      if (isConnError(error) || isSocketSandboxError(error)) {
        throw new Error(formatConnectError(error as NodeJS.ErrnoException, configuredSocketPath), {
          cause: error,
        });
      }
      throw error;
    }
  }

  const browsers = listLiveBrowsers();
  // Explicit target: must match a live browser; do not silently fall back.
  if (selector) {
    const match = findBrowser(browsers, selector);
    if (!match) {
      throw new Error(formatNoMatchError(selector, browsers));
    }
    if (action === 'browser_launch' && match.transport === 'provider')
      return invokeViaLegacy(action, data, timeoutSec, controlSource, false, true, deadline);
    if (
      match.status === 'pairing' &&
      action !== 'get_versions' &&
      action !== 'browser_close' &&
      action !== 'browser_release' &&
      action !== 'browser_control'
    ) {
      throw new Error(`Browser ${describeBrowser(match)} is waiting for device pairing`);
    }
    if (!supportsAction(match, action, data)) {
      throw new Error(`Browser ${describeBrowser(match)} does not support ${action}`);
    }
    try {
      return await send(match.socketPath, match);
    } catch (error) {
      if (isConnError(error) || isSocketSandboxError(error)) {
        throw new Error(formatConnectError(error as NodeJS.ErrnoException, match.socketPath), {
          cause: error,
        });
      }
      throw error;
    }
  }

  // No explicit target: prefer the most-recently-focused live browser; on a
  // stale socket, fall through to the legacy path + auto-spawn.
  const candidates = routableBrowsers(browsers, action, data);
  if (candidates.length > 0) {
    const target = candidates[0]!;
    try {
      return await send(target.socketPath, target);
    } catch (error) {
      if (isSocketSandboxError(error)) {
        throw new Error(formatConnectError(error as NodeJS.ErrnoException, target.socketPath), {
          cause: error,
        });
      }
      if (!isConnError(error)) throw error;
    }
  }

  if (action === 'browser_list') {
    try {
      return await loadLocalBrowserList(timeoutSec, controlSource);
    } catch (error) {
      if (
        isUnavailableConnection(error) &&
        browsers.some(browser => browser.transport === 'provider') &&
        areInstalledProvidersRunning()
      ) {
        return withInventoryWarning(browserListFromProviderRecords(browsers), error);
      }
      throw error;
    }
  }

  return invokeViaLegacy(
    action,
    data,
    timeoutSec,
    controlSource,
    false,
    action === 'browser_launch',
    deadline,
  );
}

/** Legacy well-known socket, repairing a missing or stale endpoint and retrying once. */
async function invokeViaLegacy(
  action: string,
  data: Record<string, any>,
  timeoutSec: number,
  controlSource: CompatibleControlSource,
  isRetry: boolean,
  localOnly = false,
  deadline?: number,
): Promise<any> {
  const legacySocketIdentity = readOwnedLegacySocketIdentity();
  try {
    return await invokeOnce(
      action,
      data,
      timeoutSec,
      SOCKET_PATH,
      controlSource,
      undefined,
      undefined,
      deadline,
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const shouldAttemptSpawn = err.code === 'ENOENT' || err.code === 'ECONNREFUSED';
    if (shouldAttemptSpawn && !isRetry) {
      if (err.code === 'ECONNREFUSED') removeStaleLegacySocket(legacySocketIdentity);
      const spawned = await trySpawnNativeHost();
      if (spawned) {
        await new Promise(r => setTimeout(r, 1200));
        const browsers = listLiveBrowsers();
        const target = browsers.find(
          browser =>
            isConnectedBrowser(browser) &&
            (!localOnly || browser.transport !== 'provider') &&
            supportsAction(browser, action, data),
        );
        if (target) {
          return invokeOnce(
            action,
            data,
            timeoutSec,
            target.socketPath,
            controlSource,
            target.transport === 'provider' ? target.browserId : undefined,
            target.capabilities?.controlSessionMode,
            deadline,
          );
        }
        return invokeViaLegacy(
          action,
          data,
          timeoutSec,
          controlSource,
          /* isRetry */ true,
          localOnly,
          deadline,
        );
      }
    }
    if (err instanceof Error && !isConnError(err) && !isSocketSandboxError(err)) throw err;
    throw new Error(formatConnectError(err, SOCKET_PATH), { cause: error });
  }
}

async function invokeOnce(
  action: string,
  data: Record<string, any>,
  timeoutSec: number,
  socketPath: string,
  controlSource: CompatibleControlSource,
  providerTarget?: string,
  controlSessionMode?: BrowserControlSessionMode,
  requestDeadline?: number,
): Promise<any> {
  if (requestDeadline !== undefined && Date.now() >= requestDeadline)
    throw new Error('Browser request deadline exceeded before dispatch');
  if (providerTarget) {
    const host = await ensureProviderControlHost(Math.min(timeoutSec * 1000, 10_000));
    assertProviderControlSessionMode(host, controlSessionMode);
    socketPath = host.socketPath;
  }
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Math.min(Date.now() + Math.ceil(timeoutSec * 1000), requestDeadline ?? Infinity);

  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32' && fs.existsSync(socketPath) && process.getuid) {
      const ownerUid = fs.statSync(socketPath).uid;
      if (ownerUid !== process.getuid()) {
        const error = new Error(`拒绝连接不属于当前用户的 Socket: ${socketPath}`);
        Object.assign(error, { code: 'EACCES' });
        reject(error);
        return;
      }
    }

    const socket = net.createConnection(socketPath);
    let settled = false;
    let buffer = '';
    const decoder = new StringDecoder('utf8');

    const settle = (error: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.end();
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(result);
    };

    const timer = setTimeout(
      () => {
        settle(new Error(`请求超时，已等待 ${timeoutSec} 秒`));
      },
      Math.max(0, Math.min(timeoutSec * 1000, deadline - Date.now())),
    );

    socket.on('connect', () => {
      if (Date.now() >= deadline) {
        settle(new Error('Browser request deadline exceeded before dispatch'));
        return;
      }
      const message: Record<string, any> = {
        id,
        action,
        data,
        version: CLIENT_VERSION,
        protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
        controlSource: toControlSourceWireValue(controlSource),
        deadline,
      };
      if ((data as any)[SESSION_OPTION]) message.controlSessionId = (data as any)[SESSION_OPTION];
      if (providerTarget) {
        message.providerTarget = providerTarget;
      }
      socket.write(JSON.stringify(message) + '\n');
    });

    socket.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, 'utf-8') > MAX_SOCKET_BUFFER_SIZE) {
        settle(new Error(`Socket 响应超过 ${MAX_SOCKET_BUFFER_SIZE} 字节限制`));
        return;
      }

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (!line.trim()) continue;

        try {
          const response = JSON.parse(line);
          if (response.id !== id) continue;

          if (response.versionWarning) {
            console.warn(response.versionWarning);
          }

          if (response.success) {
            settle(null, response.data);
          } else if (
            action === 'browser_launch' &&
            typeof data.provider === 'string' &&
            data.provider.trim() === 'cdp' &&
            response.error === 'Provider is not registered: cdp'
          ) {
            settle(
              new Error(
                'The connected Native Host does not include the CDP Provider. Update Mearl or reload the extension to restart its Native Host, then retry.',
              ),
            );
          } else {
            settle(new Error(response.error || 'Socket 服务端返回未知错误'));
          }
          return;
        } catch {
          settle(new Error(`无效的 JSON 响应: ${line}`));
          return;
        }
      }
    });

    // Preserve the raw error (with .code) so the caller can branch on
    // ENOENT / ECONNREFUSED to prune stale sockets or auto-spawn.
    socket.on('error', (error: NodeJS.ErrnoException) => settle(error));

    socket.on('end', () => {
      if (!settled) settle(new Error('在收到响应前 Socket 已关闭'));
    });
  });
}

const EXTENSION_INSTALL_URL =
  'https://chromewebstore.google.com/detail/mearl/aoehhjnofngknnjefamjbplchbolghkm';

function formatConnectError(error: NodeJS.ErrnoException, socketPath: string): string {
  const installHint = `如果尚未安装浏览器插件，请先前往: ${EXTENSION_INSTALL_URL}`;

  if (error.code === 'ENOENT') {
    return [
      `未找到 Socket: ${socketPath}`,
      'native host 自动拉起失败。先运行 mearl check --local；缺少命令时运行 npx @mearl/setup --local --yes。',
      '',
      '【方式一：浏览器插件模式】',
      `1. 确认已安装 Mearl 浏览器插件（${EXTENSION_INSTALL_URL}）`,
      '2. 确认已执行 Native Messaging 初始化（安装 @mearl/native-host 时会自动完成）',
      '3. 确认 Chrome 浏览器正在运行，如仍无法连接可在 chrome://extensions 重新加载插件',
      '',
      '【方式二：CDP Provider】',
      '  在 Chrome 或 Electron 启用远程调试后运行 mearl guide browsers 查看接入命令。',
    ].join('\n');
  }

  if (error.code === 'ECONNREFUSED') {
    return [
      `Socket 连接被拒绝: ${socketPath}`,
      '已尝试处理 stale socket，但 native host 自动恢复仍失败。请运行 mearl check --local 定位故障。',
      '请确认 Chrome 浏览器正在运行，可尝试在 chrome://extensions 重新加载插件。',
      '',
      installHint,
    ].join('\n');
  }

  if (error.code === 'EPERM') {
    return [
      `Socket 连接被执行环境拦截: ${socketPath}`,
      '当前进程没有访问该 Mearl Unix Socket 的权限（EPERM）。',
      '如果命令运行在 Agent 沙箱中，请为这个 Socket 配置精确的 Unix Socket 白名单后重试。',
      '无需重新安装浏览器插件，也不要使用 sudo 或改写 Socket 权限。',
    ].join('\n');
  }

  return [`Socket 连接失败: ${error.message}`, '', installHint].join('\n');
}

/** Error message when an explicit --browser selector matches no live browser. */
function formatNoMatchError(
  selector: string,
  browsers: ReturnType<typeof listLiveBrowsers>,
): string {
  const available = browsers.length
    ? browsers.map(b => `  - ${describeBrowser(b)}`).join('\n')
    : '  （当前没有已连接的浏览器）';
  return [
    `未找到匹配 "${selector}" 的浏览器。`,
    '当前已连接的浏览器：',
    available,
    '',
    '用 `mearl browser_list` 查看完整列表；可用 browserId 或名称匹配。',
  ].join('\n');
}
