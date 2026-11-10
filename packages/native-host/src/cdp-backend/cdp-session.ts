/**
 * CDP session manager — maintains browser-level and page-level CDP connections.
 *
 * - Browser client: connected to the browser's top-level WebSocket endpoint.
 *   Used for Target.* commands (list/open/close tabs).
 * - Page sessions: per-target connections used for page interaction, screenshots,
 *   and buffered network/log/event collection.
 */

import http from 'node:http';
import { NodePageRuntimeStore, type PageRuntimeOwner } from '../page-runtime-store.js';
import { dirname } from 'node:path';
import { ensureDir, readRecord, writeRecord, processIdentity } from '@mearl/daemon-core';
import type { ResolvedEmulationConfig } from '@mearl/browser-core';
import { CdpClient, CdpChildSession } from './client.js';
import { createBuffers, setupBufferListeners, type CdpBuffers } from './buffers.js';
import { discoverTargets, readDevToolsActivePort, type CdpTarget } from './discover.js';
import { initializePageSession } from './page-session-initializers.js';
import { getCdpPageDialogs, monitorCdpPageDialogs } from './page-dialogs.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PageSession {
  /** External owners check their native task lease before host-side effects. */
  assertHostControl?: () => Promise<void>;
  hostSignal?: AbortSignal;
  pendingHostRequests?: number;
  onHostRequestActivity?: (active: boolean) => void;
  tabId: number;
  client: CdpClient | CdpChildSession;
  buffers: CdpBuffers;
  targetId: string;
  runtimeOwner?: PageRuntimeOwner;
  url: string;
  emulation?: {
    mobile: boolean;
    touch: boolean;
    config?: ResolvedEmulationConfig;
    deviceShell?: boolean;
    splitScreen?: boolean;
  };
}

export interface CdpSessionOptions {
  port?: number;
  userDataDir?: string;
  endpointUrl?: string;
  endpointResolver?: () => Promise<string>;
  targetRegistryFile?: string;
}

export interface CdpAvailabilityProbe {
  available: boolean;
  error?: string;
}

interface BrowserEndpoint {
  url: string;
  approvalRequired?: boolean;
  discoveryFileError?: Error;
}

class CdpHttpDiscoveryError extends Error {
  constructor(readonly statusCode: number) {
    super(`CDP HTTP discovery returned status ${statusCode}`);
  }
}

export function isImplicitlySelectablePageUrl(url: string): boolean {
  return (
    !url.startsWith('chrome-extension://') &&
    !url.startsWith('about:') &&
    !url.startsWith('chrome://')
  );
}

// ─── CdpSession ───────────────────────────────────────────────────────────────

export class CdpSession {
  readonly port: number;
  readonly userDataDir?: string;
  private readonly endpointUrl?: string;
  private readonly endpointResolver?: () => Promise<string>;
  private readonly targetRegistryFile?: string;
  private browserClient: CdpClient | null = null;
  private runtimeBrowserOwner?: Omit<PageRuntimeOwner, 'target'>;
  private browserClientPromise: Promise<CdpClient> | null = null;
  private browserConnectedListeners = new Set<() => void>();
  private pageSessions = new Map<string, PageSession>(); // targetId → PageSession
  private pageSessionPromises = new Map<string, Promise<PageSession>>();
  private pageSessionInitializers = new Set<(session: PageSession) => Promise<void>>();
  private pageInitialization = new WeakMap<
    PageSession,
    { monitor?: Promise<void>; buffers?: Promise<void>; ready: boolean; pending?: Promise<void> }
  >();
  /** Virtual tabId counter → CDP targetId */
  private tabIdMap = new Map<number, string>();
  private nextTabId = 1000;

  constructor(options: number | CdpSessionOptions = 9222) {
    if (typeof options === 'number') {
      this.port = options;
      return;
    }
    this.port = options.port ?? 9222;
    this.userDataDir = options.userDataDir;
    this.endpointUrl = options.endpointUrl;
    this.endpointResolver = options.endpointResolver;
    this.targetRegistryFile = options.targetRegistryFile;
  }

  // ── Browser-level ──────────────────────────────────────────────────────────

  async getBrowserClient(): Promise<CdpClient> {
    if (this.browserClient && !this.browserClient.closed) {
      return this.browserClient;
    }

    if (!this.browserClientPromise) {
      this.browserClientPromise = this.connectBrowserClient();
    }

    const pending = this.browserClientPromise;
    try {
      return await pending;
    } finally {
      if (this.browserClientPromise === pending) {
        this.browserClientPromise = null;
      }
    }
  }

  onBrowserConnected(listener: () => void): () => void {
    this.browserConnectedListeners.add(listener);
    return () => this.browserConnectedListeners.delete(listener);
  }

  async browserSessionIdentity(): Promise<string> {
    return (await this.getBrowserClient()).identity;
  }

  // ── Page-level ─────────────────────────────────────────────────────────────

  /**
   * Get (or create) a page session.
   *
   * @param virtualTabId  Numeric tabId returned by `tab_open` (optional).
   *                      If omitted, connects to the first available page target.
   */
  async getPageSession(virtualTabId?: number): Promise<PageSession> {
    if (this.targetRegistryFile) await this.getBrowserClient();
    let targetId: string | undefined;

    if (virtualTabId !== undefined) {
      targetId = this.tabIdMap.get(virtualTabId);
      if (!targetId) {
        throw new Error(`Tab ${virtualTabId} not found. Open a tab first with tab_open.`);
      }
    }

    if (targetId) {
      const existing = this.pageSessions.get(targetId);
      if (existing && !existing.client.closed) return this.preparePageSession(existing);
      const pending = this.pageSessionPromises.get(targetId);
      if (pending) return pending;
    }

    // Discover a page target
    const target = targetId
      ? await this.findTargetById(targetId)
      : await this.findDefaultPageTarget();

    if (!target) {
      throw new Error(
        virtualTabId
          ? `CDP target for tab ${virtualTabId} is no longer available`
          : 'No implicitly selectable page target found. about:, chrome:, and extension pages are excluded; pass a tabId returned by tab_open or open a web page.',
      );
    }

    const existing = this.pageSessions.get(target.id);
    if (existing && !existing.client.closed) return this.preparePageSession(existing);
    const pending = this.pageSessionPromises.get(target.id);
    if (pending) return pending;

    return this.getOrCreatePageSession(target);
  }

  /** Register a newly opened target as a virtual tabId and return the numeric ID. */
  async registerTarget(targetId: string): Promise<number> {
    const virtualId = await this.ensureTargetRegistered(targetId);

    const target = await this.findTargetById(targetId);
    if (target) {
      await this.getOrCreatePageSession(target);
    }

    return virtualId;
  }

  /** Return the existing virtual tabId for a target, registering it when first discovered. */
  async ensureTargetRegistered(targetId: string): Promise<number> {
    if (this.targetRegistryFile) await this.getBrowserClient();
    for (const [virtualId, registeredTargetId] of this.tabIdMap) {
      if (registeredTargetId === targetId) return virtualId;
    }
    const virtualId = this.nextTabId++;
    this.tabIdMap.set(virtualId, targetId);
    try {
      this.saveTargetRegistry();
    } catch (error) {
      this.tabIdMap.delete(virtualId);
      this.nextTabId = virtualId;
      throw error;
    }
    return virtualId;
  }

  private restoreTargetRegistry(identity: string): void {
    if (!this.targetRegistryFile) return;
    const saved = readRecord(this.targetRegistryFile);
    this.tabIdMap.clear();
    // Stale requests must not address a new tab when the browser endpoint changes.
    if (
      typeof saved?.nextTabId === 'number' &&
      Number.isSafeInteger(saved.nextTabId) &&
      saved.nextTabId >= 1000
    )
      this.nextTabId = Math.max(this.nextTabId, saved.nextTabId);
    if (saved?.identity !== identity || !Array.isArray(saved.targets)) return;
    const seenTargets = new Set<string>();
    const restored = new Map<number, string>();
    for (const entry of saved.targets) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        !Number.isSafeInteger(entry[0]) ||
        entry[0] < 1000 ||
        typeof entry[1] !== 'string' ||
        !entry[1] ||
        restored.has(entry[0]) ||
        seenTargets.has(entry[1])
      )
        return;
      restored.set(entry[0], entry[1]);
      seenTargets.add(entry[1]);
    }
    const nextTabId = saved.nextTabId;
    if (
      typeof nextTabId !== 'number' ||
      !Number.isSafeInteger(nextTabId) ||
      nextTabId < 1000 ||
      [...restored.keys()].some(id => id >= nextTabId)
    )
      return;
    this.tabIdMap = restored;
    this.nextTabId = Math.max(this.nextTabId, nextTabId);
  }

  private saveTargetRegistry(): void {
    if (!this.targetRegistryFile || !this.browserClient) return;
    ensureDir(dirname(this.targetRegistryFile));
    writeRecord(this.targetRegistryFile, {
      pid: process.pid,
      identity: this.browserClient.identity,
      nextTabId: this.nextTabId,
      targets: [...this.tabIdMap],
    });
  }

  addPageSessionInitializer(initializer: (session: PageSession) => Promise<void>): () => void {
    this.pageSessionInitializers.add(initializer);
    return () => this.pageSessionInitializers.delete(initializer);
  }

  async attachOpenPageTargets(): Promise<void> {
    const browser = await this.getBrowserClient();
    const result = await browser.sendCommand('Target.getTargets', {});
    for (const target of result.targetInfos ?? []) {
      if (target.type !== 'page' || /^(?:chrome:|chrome-extension:)/.test(target.url ?? ''))
        continue;
      const tabId = await this.ensureTargetRegistered(target.targetId);
      await this.getPageSession(tabId);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async connectBrowserClient(): Promise<CdpClient> {
    const endpoint = await this.resolveBrowserEndpoint();
    let client: CdpClient;
    try {
      client = endpoint.approvalRequired
        ? await CdpClient.connect(endpoint.url, 30000)
        : await CdpClient.connect(endpoint.url);
    } catch (error) {
      if (!endpoint.approvalRequired) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Chrome CDP approval connection failed on port ${this.port}: ${detail}. ` +
          'Allow the remote debugging connection in Chrome when prompted.' +
          (endpoint.discoveryFileError ? ` ${endpoint.discoveryFileError.message}` : ''),
        { cause: error },
      );
    }
    this.restoreTargetRegistry(client.identity);
    this.runtimeBrowserOwner = { browser: client.identity };
    if (!this.isRemote()) {
      try {
        const info = await client.sendCommand('SystemInfo.getProcessInfo', {}, 2000);
        const pid = info.processInfo?.find(
          (entry: { type: string }) => entry.type === 'browser',
        )?.id;
        if (Number.isSafeInteger(pid) && pid > 0)
          this.runtimeBrowserOwner = {
            browser: client.identity,
            pid,
            processIdentity: processIdentity(pid),
          };
      } catch {
        /* Remote or restricted CDP may expose no local browser process. */
      }
    }
    try {
      const inventory = await client.sendCommand('Target.getTargets');
      new NodePageRuntimeStore().reconcile(
        client.identity,
        new Set(inventory.targetInfos.map((target: { targetId: string }) => target.targetId)),
      );
    } catch (error) {
      console.warn('[cdp] Could not reconcile page runtime references', error);
    }
    this.browserClient = client;
    for (const listener of this.browserConnectedListeners) listener();
    client.on('Target.targetDestroyed', (params: any) => {
      for (const [virtualId, targetId] of this.tabIdMap) {
        if (targetId === params.targetId) {
          this.tabIdMap.delete(virtualId);
          try {
            this.saveTargetRegistry();
          } catch (error) {
            console.warn('[cdp] Could not persist removed target', error);
          }
          break;
        }
      }
      this.pageSessions.delete(params.targetId);
      try {
        new NodePageRuntimeStore().release({ browser: client.identity, target: params.targetId });
      } catch (error) {
        console.warn('[cdp] Could not release page runtime reference', error);
      }
    });

    return client;
  }

  private async createPageSession(target: CdpTarget): Promise<PageSession> {
    // Prefer Target.attachToTarget (multiplexed over browser WS) — this works when
    // Chrome is started via chrome://inspect, where direct /devtools/page/... connections
    // return 403. Fall back to direct WS connection for --remote-debugging-port mode.
    let client: CdpClient | CdpChildSession;
    try {
      const browser = await this.getBrowserClient();
      const { sessionId } = await browser.sendCommand(
        'Target.attachToTarget',
        { targetId: target.id, flatten: true },
        5000,
      );
      client = browser.createChildSession(sessionId);
    } catch (error) {
      if (this.isRemote()) {
        throw new Error(
          `Failed to attach to remote CDP target ${target.id}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      // Direct connection fallback (e.g. --remote-debugging-port with no security)
      client = await CdpClient.connect(target.webSocketDebuggerUrl);
    }
    let tabId: number | undefined;
    for (const [virtualId, registeredTargetId] of this.tabIdMap) {
      if (registeredTargetId === target.id) {
        tabId = virtualId;
        break;
      }
    }
    if (tabId === undefined) {
      tabId = await this.ensureTargetRegistered(target.id);
    }
    const buffers = createBuffers(tabId);
    const session: PageSession = {
      tabId,
      client,
      buffers,
      targetId: target.id,
      runtimeOwner: {
        ...(this.runtimeBrowserOwner ?? {
          browser:
            client instanceof CdpClient
              ? client.identity
              : (await this.getBrowserClient()).identity,
        }),
        target: target.id,
      },
      url: target.url,
    };

    this.pageSessions.set(target.id, session);
    this.pageInitialization.set(session, { ready: false });
    const stopDialogMonitor = monitorCdpPageDialogs(session);

    client.on('Inspector.detached', () => {
      this.pageSessions.delete(target.id);
    });

    try {
      const state = this.pageInitialization.get(session)!;
      state.monitor = client.sendCommand('Page.enable', {}, 5000);
      await getCdpPageDialogs(session).command(() => state.monitor!);
      await this.preparePageSession(session);
    } catch (error) {
      if (getCdpPageDialogs(session).pending) return session;
      stopDialogMonitor();
      this.pageSessions.delete(target.id);
      if (client instanceof CdpChildSession) {
        await (
          await this.getBrowserClient()
        )
          .sendCommand('Target.detachFromTarget', { sessionId: client.sessionId }, 5000)
          .catch(() => {});
      }
      client.close();
      if (error instanceof Error && error.message === 'CDP command timeout: Page.enable') {
        throw new Error(
          'Page monitoring could not start. A native dialog opened before attachment may block Chrome; close it manually, then retry.',
          { cause: error },
        );
      }
      throw error;
    }

    return session;
  }

  private async preparePageSession(session: PageSession): Promise<PageSession> {
    const dialogs = getCdpPageDialogs(session);
    const state = this.pageInitialization.get(session);
    if (!state || state.ready || dialogs.pending) return session;
    try {
      if (state.monitor) await dialogs.command(() => state.monitor!);
    } catch (error) {
      if (dialogs.pending) return session;
      throw error;
    }
    if (dialogs.pending) return session;
    if (!state.pending) {
      const initialize = async () => {
        state.buffers ??= setupBufferListeners(session.client, session.buffers);
        await dialogs.command(() => state.buffers!);
        if (dialogs.pending) return;
        await initializePageSession(session);
        dialogs.assertCanDispatch();
        for (const initializer of this.pageSessionInitializers) {
          dialogs.assertCanDispatch();
          await initializer(session);
        }
        dialogs.assertCanDispatch();
        if (!dialogs.pending) state.ready = true;
      };
      state.pending = dialogs.execute(initialize, false).finally(() => {
        state.pending = undefined;
      });
    }
    try {
      await dialogs.command(() => state.pending!);
    } catch (error) {
      if (!dialogs.pending) {
        if (!dialogs.busy && (error as { code?: string })?.code === 'DIALOG_PENDING')
          return this.preparePageSession(session);
        throw error;
      }
    }
    return session;
  }

  private async getOrCreatePageSession(target: CdpTarget): Promise<PageSession> {
    const existing = this.pageSessions.get(target.id);
    if (existing && !existing.client.closed && !this.pageSessionPromises.has(target.id))
      return existing;
    let pending = this.pageSessionPromises.get(target.id);
    if (!pending) {
      pending = this.createPageSession(target);
      this.pageSessionPromises.set(target.id, pending);
    }
    try {
      return await pending;
    } finally {
      if (this.pageSessionPromises.get(target.id) === pending)
        this.pageSessionPromises.delete(target.id);
    }
  }

  private async findTargetById(targetId: string): Promise<CdpTarget | null> {
    if (this.isRemote()) return this.findTargetByIdViaCdp(targetId);
    try {
      const targets = await discoverTargets(this.effectivePort());
      return targets.find(t => t.id === targetId && t.webSocketDebuggerUrl) ?? null;
    } catch {
      // HTTP not available — fall back to Target.getTargets via browser WS
      return this.findTargetByIdViaCdp(targetId);
    }
  }

  private async findDefaultPageTarget(): Promise<CdpTarget | null> {
    if (this.isRemote()) return this.findDefaultPageTargetViaCdp();
    try {
      const targets = await discoverTargets(this.effectivePort());
      return (
        targets.find(
          t => t.type === 'page' && t.webSocketDebuggerUrl && isImplicitlySelectablePageUrl(t.url),
        ) ?? null
      );
    } catch {
      // HTTP not available — fall back to Target.getTargets via browser WS
      return this.findDefaultPageTargetViaCdp();
    }
  }

  // ── CDP-based target discovery (when HTTP /json is unavailable) ───────────

  /** Effective port: from DevToolsActivePort file if present, else this.port */
  private effectivePort(): number {
    return readDevToolsActivePort(this.userDataDir)?.port ?? this.port;
  }

  /**
   * Resolve the browser-level WebSocket URL.
   * Priority: DevToolsActivePort file → HTTP /json/version → approval-mode WebSocket.
   */
  private async resolveBrowserEndpoint(): Promise<BrowserEndpoint> {
    const configuredEndpoint = this.endpointResolver
      ? await this.endpointResolver()
      : this.endpointUrl;
    if (configuredEndpoint) {
      const url = new URL(configuredEndpoint);
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error(`Unsupported CDP endpoint protocol: ${url.protocol}`);
      }
      return { url: url.toString() };
    }
    let discoveryFileError: Error | undefined;
    const fileInfo = readDevToolsActivePort(this.userDataDir, error => {
      discoveryFileError = error;
    });
    if (fileInfo) {
      return { url: `ws://localhost:${fileInfo.port}${fileInfo.browserWsPath}` };
    }
    try {
      const versionInfo = await this.fetchVersionInfo();
      if (!versionInfo.webSocketDebuggerUrl)
        throw new Error('No browser-level WebSocket URL available from CDP');
      return { url: versionInfo.webSocketDebuggerUrl };
    } catch (error) {
      // Approval mode disables HTTP discovery and requires Chrome's user prompt
      // instead of a GUID in the browser endpoint path.
      if (error instanceof CdpHttpDiscoveryError && error.statusCode === 404) {
        return {
          url: `ws://127.0.0.1:${this.port}/devtools/browser`,
          approvalRequired: true,
          discoveryFileError,
        };
      }
      if (!discoveryFileError) throw error;
      throw new Error(
        `${discoveryFileError.message}; ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Build a page-level WebSocket URL from a target ID.
   * Used when HTTP /json is unavailable.
   */
  private pageWsUrl(targetId: string): string {
    const port = this.effectivePort();
    return `ws://localhost:${port}/devtools/page/${targetId}`;
  }

  private isRemote(): boolean {
    return Boolean(this.endpointUrl || this.endpointResolver);
  }

  private async findTargetByIdViaCdp(targetId: string): Promise<CdpTarget | null> {
    try {
      const browser = await this.getBrowserClient();
      const result: any = await browser.sendCommand('Target.getTargets', {});
      const raw = result.targetInfos as any[];
      const info = raw.find(t => t.targetId === targetId);
      if (!info) return null;
      return {
        id: info.targetId,
        title: info.title ?? '',
        type: info.type ?? 'page',
        url: info.url ?? '',
        webSocketDebuggerUrl: this.pageWsUrl(info.targetId),
      };
    } catch {
      return null;
    }
  }

  private async findDefaultPageTargetViaCdp(): Promise<CdpTarget | null> {
    try {
      const browser = await this.getBrowserClient();
      const result: any = await browser.sendCommand('Target.getTargets', {});
      const raw = result.targetInfos as any[];
      const info = raw.find((t: any) => t.type === 'page' && isImplicitlySelectablePageUrl(t.url));
      if (!info) return null;
      return {
        id: info.targetId,
        title: info.title ?? '',
        type: info.type ?? 'page',
        url: info.url ?? '',
        webSocketDebuggerUrl: this.pageWsUrl(info.targetId),
      };
    } catch {
      return null;
    }
  }

  private fetchVersionInfo(): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://localhost:${this.port}/json/version`, res => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new CdpHttpDiscoveryError(res.statusCode ?? 0));
          return;
        }
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse CDP version info: ${e}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error('CDP version info timeout'));
      });
    });
  }

  async probeAvailability(): Promise<CdpAvailabilityProbe> {
    try {
      const client = await this.getBrowserClient();
      await client.sendCommand('Target.getTargets', {}, 3000);
      return { available: true };
    } catch (error) {
      this.browserClient?.close();
      this.browserClient = null;
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        error: message.trim() || 'CDP connection failed',
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    return (await this.probeAvailability()).available;
  }

  hasActiveConnections(): boolean {
    return (
      (this.browserClient !== null && !this.browserClient.closed) ||
      Array.from(this.pageSessions.values()).some(session => !session.client.closed)
    );
  }

  listOpenPageSessions(): PageSession[] {
    return Array.from(this.pageSessions.values()).filter(session => !session.client.closed);
  }

  listRegisteredTabIds(targetIds?: ReadonlySet<string>): number[] {
    return Array.from(this.tabIdMap.entries())
      .filter(([, targetId]) => !targetIds || targetIds.has(targetId))
      .map(([tabId]) => tabId);
  }

  close(): void {
    this.browserClient?.close();
    this.browserClient = null;
    for (const session of this.pageSessions.values()) {
      session.client.close();
    }
    this.pageSessions.clear();
    this.pageSessionPromises.clear();
    this.tabIdMap.clear();
  }
}
