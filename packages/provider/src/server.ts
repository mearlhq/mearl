import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmodSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir } from '@mearl/daemon-core';
import { isProviderAction } from './actions.js';
import { createProviderRuntime, validateProviderBrowser } from './provider-runtime.js';
import {
  PROVIDER_START_TOKEN_ENV,
  claimProviderStart,
  providerBrowserKey,
  providerSocketPath,
  publishLiveProvider,
  publishProviderBrowsers,
  readLiveProvider,
  releaseProviderStart,
  removeStaleProviderSocket,
  touchProviderBrowser,
  unpublishLiveProvider,
  unpublishProviderBrowsers,
} from './registry.js';
import type {
  JsonObject,
  ProviderActionRequest,
  ProviderBrowser,
  ProviderContext,
  ProviderHostContextData,
  ProviderServer,
  ProviderServerOptions,
} from './types.js';
import { MEARL_PROVIDER_PROTOCOL_VERSION } from './types.js';
import { assertProviderProtocolVersion } from './protocol.js';
import { assertProviderControlSessionMode, ensureProviderControlHost, readProviderControlHost } from './control-host.js';

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const activeProviderIds = new Set<string>();

function assertControlHost(browser: ProviderBrowser): void {
  validateProviderBrowser(browser);
  if (browser.control.kind === 'provider' && browser.control.capabilities.controlSessionMode === 'external') {
    assertProviderControlSessionMode(readProviderControlHost(), 'external');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProviderHostContextData(value: unknown): value is ProviderHostContextData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const host = value as Partial<ProviderHostContextData>;
  return (
    (host.userAgent === undefined || typeof host.userAgent === 'string') &&
    (host.cookies === undefined ||
      (Array.isArray(host.cookies) &&
        host.cookies.every(
          cookie => cookie && typeof cookie === 'object' && !Array.isArray(cookie),
        )))
  );
}

function isProviderActionRequest(value: unknown): value is ProviderActionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Partial<ProviderActionRequest>;
  return (
    typeof request.id === 'string' &&
    request.id.length > 0 &&
    typeof request.action === 'string' &&
    request.action.length > 0 &&
    typeof request.protocolVersion === 'number' &&
    (request.deadline === undefined || (Number.isSafeInteger(request.deadline) && request.deadline! > 0)) &&
    (request.data === undefined ||
      (request.data !== null &&
        typeof request.data === 'object' &&
        !Array.isArray(request.data))) &&
    (request.browserId === undefined || typeof request.browserId === 'string') &&
    (request.version === undefined || typeof request.version === 'string') &&
    (request.controlSource === undefined || typeof request.controlSource === 'string') &&
    (request.host === undefined || isProviderHostContextData(request.host))
  );
}

function providerContext(request: ProviderActionRequest): ProviderContext {
  const hostData = request.host as ProviderHostContextData | undefined;
  return {
    controlSource: request.controlSource,
    ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
    ...(hostData
      ? {
          host: {
            async request<T>(method: string): Promise<T> {
              if (method === 'export_cookies') return (hostData.cookies ?? []) as T;
              if (method === 'get_browser_user_agent') {
                if (!hostData.userAgent) throw new Error('Host browser user agent is unavailable');
                return hostData.userAgent as T;
              }
              throw new Error(`Unsupported Provider host service: ${method}`);
            },
          },
        }
      : {}),
  };
}

export function createProviderServer(options: ProviderServerOptions): ProviderServer {
  const runtime = createProviderRuntime(options.definition);
  const descriptor = options.definition.descriptor;
  const requiresExternalControl = options.definition.browserType.controlSessionModes?.includes('external') === true;
  const socketPath = options.socketPath ?? providerSocketPath(descriptor.providerId);
  let server: net.Server | null = null;
  let browserIds = new Set<string>();
  let browsers: ProviderBrowser[] = [];
  let state: 'idle' | 'starting' | 'running' | 'stopping' = 'idle';
  let stopPromise: Promise<void> | null = null;
  const connections = new Set<net.Socket>();

  async function prepareControlHost(): Promise<void> {
    if (requiresExternalControl) {
      assertProviderControlSessionMode(await ensureProviderControlHost(), 'external');
    }
  }

  async function providerBrowserId(requested?: string): Promise<string> {
    const available = await runtime.listBrowsers();
    const selected = requested
      ? available.find(browser => browser.browserId === requested)
      : available.length === 1 ? available[0] : undefined;
    if (selected) {
      assertControlHost(selected);
      return selected.browserId;
    }
    if (requested) throw new Error(`Provider browser not found: ${requested}`);
    if (available.length === 0) throw new Error('Provider has no browser instances');
    throw new Error('browserId is required when the provider has multiple browsers');
  }

  async function dispatch(request: ProviderActionRequest): Promise<unknown> {
    const assertDeadline = () => {
      if (request.deadline !== undefined && Date.now() >= request.deadline)
        throw new Error('Provider request deadline exceeded');
    };
    assertDeadline();
    if ((request as any).controlSessionId)
      throw new Error(
        'CONTROL_SESSION_UNSUPPORTED: this Provider does not implement control sessions',
      );
    await prepareControlHost();
    assertDeadline();
    const context = providerContext(request);
    if (request.action === '__provider_enhancement_target') {
      const browserId = await providerBrowserId(request.browserId);
      if (!runtime.getEnhancementTarget) throw new Error('BROWSER_ENHANCEMENT_TARGET_UNSUPPORTED');
      return runtime.getEnhancementTarget({ browserId, tabId: request.data?.tabId as number }, context);
    }
    if (request.action === 'browser_providers') {
      if (request.browserId) throw new Error('Provider management does not accept browserId');
      switch (request.data?.operation) {
        case 'configure':
          return runtime.configure(request.data.options as JsonObject, context);
        case 'launch_form':
          return runtime.getLaunchForm(
            {
              variant: request.data.variant as string | undefined,
              values: request.data.values as JsonObject,
            },
            context,
          );
        default:
          throw new Error('Invalid browser provider operation');
      }
    }
    if (request.action === 'browser_launch') {
      if (request.browserId) throw new Error('browser_launch does not accept browserId');
      const browser = await runtime.launch(request.data ?? {}, context);
      assertControlHost(browser);
      return browser;
    }
    if (request.action === 'browser_instances') {
      if (!['start', 'detach', 'sync_cookies'].includes(String(request.data?.operation))) {
        throw new Error('Invalid browser instance operation');
      }
      const browserId = await providerBrowserId(request.browserId);
      switch (request.data!.operation) {
        case 'start':
          return runtime.start({ browserId }, context);
        case 'detach':
          return runtime.detach({ browserId }, context);
        case 'sync_cookies':
          return runtime.syncCookies(
            { browserId, scope: request.data!.scope as JsonObject },
            context,
          );
      }
    }
    if (
      request.action !== 'get_versions' &&
      request.action !== 'browser_close' &&
      request.action !== 'get_browser_access_url' &&
      !isProviderAction(request.action)
    ) {
      throw new Error(`Unsupported provider action: ${String(request.action)}`);
    }
    const browserId = await providerBrowserId(request.browserId);
    if (request.action === 'browser_close') {
      return runtime.close(
        { browserId, deleteData: request.data?.deleteProfile === true },
        context,
      );
    }
    if (request.action === 'get_browser_access_url') {
      return {
        browserAccess: await runtime.getAccess({ browserId }, context),
      };
    }
    if (request.action === 'get_versions') {
      const found = (await runtime.listBrowsers()).find(browser => browser.browserId === browserId);
      if (!found) throw new Error(`Provider browser not found: ${browserId}`);
      return {
        provider: {
          id: descriptor.providerId,
          name: descriptor.name,
          builtin: descriptor.builtin === true,
          version: descriptor.version,
          protocolVersion: descriptor.protocolVersion ?? MEARL_PROVIDER_PROTOCOL_VERSION,
        },
        capabilities: found.control.kind === 'provider' ? found.control.capabilities : undefined,
      };
    }
    touchProviderBrowser(providerBrowserKey(descriptor.providerId, browserId));
    return runtime.invokeAction({
      browserId,
      action: request.action,
      data: request.data ?? {},
      controlSource: request.controlSource,
      ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
    });
  }

  function handleConnection(socket: net.Socket): void {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        socket.end(
          `${JSON.stringify({ id: '', success: false, error: 'Invalid JSON request' })}\n`,
        );
        return;
      }
      const id =
        parsed && typeof parsed === 'object' && typeof (parsed as { id?: unknown }).id === 'string'
          ? (parsed as { id: string }).id
          : '';
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        try {
          assertProviderProtocolVersion((parsed as { protocolVersion?: unknown }).protocolVersion);
        } catch (error) {
          socket.end(`${JSON.stringify({ id, success: false, error: errorMessage(error) })}\n`);
          return;
        }
      }
      if (!isProviderActionRequest(parsed)) {
        socket.end(
          `${JSON.stringify({ id, success: false, error: 'Invalid request envelope' })}\n`,
        );
        return;
      }
      const request = parsed;
      void dispatch(request)
        .then(data => socket.end(`${JSON.stringify({ id: request.id, success: true, data })}\n`))
        .catch(error =>
          socket.end(
            `${JSON.stringify({ id: request.id, success: false, error: errorMessage(error) })}\n`,
          ),
        );
    });
  }

  return {
    socketPath,
    runtime,
    async start(): Promise<void> {
      if (state !== 'idle') throw new Error(`Provider server is already ${state}`);
      const providerId = descriptor.providerId;
      if (activeProviderIds.has(providerId)) {
        throw new Error(`Provider ${providerId} is already running in this process`);
      }
      state = 'starting';
      activeProviderIds.add(providerId);
      const startToken = process.env[PROVIDER_START_TOKEN_ENV] || randomUUID();
      const existing = readLiveProvider(descriptor.providerId);
      if (existing) {
        state = 'idle';
        activeProviderIds.delete(providerId);
        throw new Error(
          `Provider ${descriptor.providerId} is already running (pid ${existing.pid})`,
        );
      }
      if (!claimProviderStart(providerId, startToken)) {
        state = 'idle';
        activeProviderIds.delete(providerId);
        throw new Error(`Provider ${providerId} start is already in progress`);
      }

      try {
        await prepareControlHost();
        const competing = readLiveProvider(providerId);
        if (competing) {
          throw new Error(`Provider ${providerId} is already running (pid ${competing.pid})`);
        }
        removeStaleProviderSocket(providerId, socketPath);
        if (process.platform !== 'win32') ensureDir(dirname(socketPath));
        server = net.createServer(handleConnection);
        await new Promise<void>((resolve, reject) => {
          server!.once('error', reject);
          server!.listen(socketPath, () => {
            server!.off('error', reject);
            resolve();
          });
        });
        if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
        publishLiveProvider(descriptor, socketPath);
        releaseProviderStart(providerId, startToken);
        state = 'running';
      } catch (error) {
        const active = server;
        server = null;
        for (const connection of connections) connection.destroy();
        connections.clear();
        if (active?.listening) {
          await new Promise<void>(resolve => active.close(() => resolve()));
        }
        unpublishLiveProvider(providerId);
        if (process.platform !== 'win32') rmSync(socketPath, { force: true });
        releaseProviderStart(providerId, startToken);
        activeProviderIds.delete(providerId);
        state = 'idle';
        throw error;
      }
    },
    updateBrowsers(nextBrowsers: ProviderBrowser[]): void {
      if (state !== 'running') throw new Error('Provider server is not running');
      nextBrowsers.forEach(assertControlHost);
      runtime.updateBrowsers(nextBrowsers);
      browsers = [...nextBrowsers];
      browserIds = publishProviderBrowsers(descriptor, socketPath, browsers, browserIds);
    },
    touchBrowser(browserId: string): void {
      if (state !== 'running') throw new Error('Provider server is not running');
      if (!browsers.some(browser => browser.browserId === browserId)) {
        throw new Error(`Provider browser not found: ${browserId}`);
      }
      touchProviderBrowser(providerBrowserKey(descriptor.providerId, browserId));
    },
    async stop(): Promise<void> {
      if (state === 'idle') return;
      if (state === 'starting') throw new Error('Provider server is still starting');
      if (state === 'stopping' && stopPromise) return stopPromise;
      state = 'stopping';
      stopPromise = (async () => {
        const active = server;
        server = null;
        for (const connection of connections) connection.destroy();
        connections.clear();
        if (active) await new Promise<void>(resolve => active.close(() => resolve()));
        unpublishProviderBrowsers(browserIds);
        browserIds.clear();
        browsers = [];
        if (process.platform !== 'win32') rmSync(socketPath, { force: true });
        unpublishLiveProvider(descriptor.providerId);
      })().finally(() => {
        activeProviderIds.delete(descriptor.providerId);
        stopPromise = null;
        state = 'idle';
      });
      return stopPromise;
    },
  };
}
