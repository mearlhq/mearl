import fs from 'node:fs';
import { keyedConfigFile } from '@mearl/daemon-core';
import {
  shouldObservePageAction,
  startCdpRecording,
  type ControlSource,
  type PageDownloadParams,
  type PageRecordingOptions,
} from '@mearl/browser-core';
import { ensureDiscoverableCdpBrowser, providerIdentity } from '../browser-inventory.js';
import { registerBrowser, unregisterBrowser } from '../browser-registry.js';
import { CdpSession } from '../cdp-backend/cdp-session.js';
import { cdpObservedPageAction } from '../cdp-backend/composite-handlers.js';
import { releaseControlledIndicator } from '../cdp-backend/controlled-indicator.js';
import { cdpExportCookies } from '../cdp-backend/cookie-transfer.js';
import { captureCdpDownload } from '../cdp-backend/download-handlers.js';
import { dispatchCdpAction, getRegisteredActionNames } from '../cdp-backend/handlers.js';
import { clearCdpPageMocks } from '../cdp-backend/mock-handlers.js';
import { clearPageRefsForNavigation } from '../cdp-backend/page-refs.js';
import { CdpPluginPageHost } from '../cdp-backend/plugin-pages.js';
import { releaseCdpControl } from '../cdp-backend/release-control.js';
import type { NativeHostRuntimeArgs } from '../runtimeArgs.js';
import { NATIVE_HOST_VERSION } from '../version.js';
import { toTimeoutMs } from './action-timeout.js';
import { CDP_PROVIDER } from './cdp-attach.js';
import type { HostBrowserProvider } from './host-browser-provider.js';

interface CdpProviderOptions {
  args: NativeHostRuntimeArgs;
  socketPath: string;
  endpointSource: 'command-line' | 'built-in default';
  useActivePortFile: boolean;
  log: (...args: any[]) => void;
  onPublish: () => void;
  onAttachDisconnect: () => void;
  pluginService: ConstructorParameters<typeof CdpPluginPageHost>[1];
}

export class CdpBrowserProvider implements HostBrowserProvider {
  private session: CdpSession | null = null;
  private pageHost?: CdpPluginPageHost;
  private autoReconnectEnabled = true;
  private registrationTimer?: ReturnType<typeof setInterval>;
  private published = false;
  private permissionNoticeLogged = false;
  private readonly stateKey: string;

  constructor(private readonly options: CdpProviderOptions) {
    const { browserId, cdpUserDataDir, cdpEndpointFile, cdpPort } = options.args;
    this.stateKey = `${browserId}:${cdpUserDataDir ?? cdpEndpointFile ?? cdpPort}`;
  }

  get browserId(): string {
    return this.options.args.browserId;
  }

  get endpointDescription(): string {
    const { args, endpointSource } = this.options;
    const endpoint = args.cdpEndpointFile ? 'endpoint-file' : `127.0.0.1:${args.cdpPort}`;
    return `${endpoint} (source=${endpointSource})`;
  }

  private get registrationEnabled(): boolean {
    return this.options.args.daemon && !this.options.args.skipBrowserRegistration;
  }

  get isConnected(): boolean {
    return this.published;
  }

  get isAttached(): boolean {
    return this.published && this.options.args.attachCdp;
  }

  private get reconnectable(): boolean {
    return Boolean(this.options.args.cdpEndpointFile) || this.browserId.startsWith('managed:');
  }

  async start(): Promise<void> {
    // Managed endpoints reconnect without a local Chrome authorization prompt.
    if (!this.registrationEnabled || this.options.args.attachCdp) return;
    if (!this.reconnectable) {
      await this.discover();
      return;
    }
    let checking = false;
    const refresh = async (): Promise<void> => {
      if (checking || !this.autoReconnectEnabled) return;
      checking = true;
      try {
        const available = await this.getSession().isAvailable();
        if (available) this.publish();
        else this.unpublish();
      } finally {
        checking = false;
      }
    };
    await refresh();
    this.registrationTimer = setInterval(() => {
      void refresh();
    }, 2_000).unref();
  }

  async discover(): Promise<{ discovered: boolean; warning?: string }> {
    if (!this.registrationEnabled) return { discovered: false };
    let probeError: string | undefined;
    const discovered = await ensureDiscoverableCdpBrowser({
      isPublished: () => this.published,
      isAvailable: async () => {
        const probe = await this.getSession().probeAvailability();
        probeError = probe.error
          ?.replace(/[\r\n]+/g, ' ')
          .trim()
          .slice(0, 500);
        this.options.log(
          `CDP discovery probe ${this.endpointDescription} -> ${probe.available ? 'ok' : `fail (${probeError || 'unknown error'})`}`,
        );
        return probe.available;
      },
      publish: () => this.publish(),
      monitor: () => this.monitorConnection(),
    });
    return discovered
      ? { discovered }
      : {
          discovered,
          warning: `CDP discovery probe ${this.endpointDescription} failed: ${probeError || 'unknown error'}`,
        };
  }

  async invoke(action: string, data: any, controlSource: ControlSource, deadline?: number) {
    if (!this.permissionNoticeLogged) {
      this.permissionNoticeLogged = true;
      this.options.log(
        'CDP mode: domain permission checks are not enforced — all actions run without domain authorization',
      );
    }
    // Apply the same timeout input validation as Native Messaging.
    toTimeoutMs(action, data);
    return this.execute(action, data, controlSource, deadline);
  }

  async browserInfo(): Promise<{ product?: string; userAgent?: string }> {
    const browser = await this.getSession().getBrowserClient();
    return browser.sendCommand('Browser.getVersion', {}, 5000);
  }

  exportCookies(domains: string[]) {
    return cdpExportCookies(this.getSession(), domains);
  }

  async cleanup(tabIds: number[], preserveEnvironment: boolean): Promise<void> {
    for (const tabId of tabIds) {
      if (!this.session?.listRegisteredTabIds().includes(tabId)) continue;
      const page = await this.session.getPageSession(tabId);
      clearPageRefsForNavigation(page);
      await releaseControlledIndicator(page);
      if (!preserveEnvironment) {
        clearCdpPageMocks(page);
        await dispatchCdpAction(
          this.getSession(),
          'set_app_profile',
          { tabId, enabled: false, networkControl: null },
          'local',
        );
        await dispatchCdpAction(
          this.getSession(),
          'set_device_emulation',
          { tabId, enabled: false },
          'local',
        );
        await dispatchCdpAction(
          this.getSession(),
          'set_timezone',
          { tabId, timezone: '' },
          'local',
        );
      }
    }
  }

  download(data: PageDownloadParams, source: ControlSource) {
    return captureCdpDownload(this.getSession(), data, this.browserId.startsWith('managed:'), () =>
      this.execute('page_click', { ...data.trigger, tabId: data.tabId }, source),
    );
  }

  async openRecording(
    tabId: number,
    _recordingId: string,
    options: Required<PageRecordingOptions>,
  ): ReturnType<HostBrowserProvider['openRecording']> {
    const session = this.getSession();
    const page = await session.getPageSession(tabId);
    const { client } = page;
    const send = (method: string, params?: Record<string, unknown>) =>
      client.sendCommand(method, params, 10_000);
    try {
      const stream = await startCdpRecording(send, options);
      return { ...stream, isAlive: () => session.listOpenPageSessions().includes(page) };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'CDP command timeout: Page.startScreenRecording'
      ) {
        const stopped = await send('Page.stopScreenRecording').catch(() => undefined);
        if (stopped?.stream) await send('IO.close', { handle: stopped.stream }).catch(() => {});
      }
      throw error;
    }
  }

  async release() {
    const session = this.session;
    this.autoReconnectEnabled = false;
    try {
      if (session) return await releaseCdpControl(session);
    } catch (error) {
      session?.close();
      throw error;
    } finally {
      this.pageHost?.dispose();
      this.pageHost = undefined;
      this.session = null;
      this.autoReconnectEnabled = false;
    }
  }

  dispose(): void {
    clearInterval(this.registrationTimer);
    this.registrationTimer = undefined;
    this.pageHost?.dispose();
    this.pageHost = undefined;
    this.session?.close();
    this.session = null;
    this.unpublish();
  }

  private getSession(): CdpSession {
    this.autoReconnectEnabled = true;
    if (!this.session) {
      const { cdpEndpointFile, cdpPort, cdpUserDataDir } = this.options.args;
      const targetRegistryFile = keyedConfigFile('cdp-targets', this.stateKey);
      this.session = cdpEndpointFile
        ? new CdpSession({
            targetRegistryFile,
            endpointResolver: async () => {
              const endpoint = fs.readFileSync(cdpEndpointFile, 'utf8').trim();
              const url = new URL(endpoint);
              if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
                throw new Error(`Unsupported CDP WebSocket protocol: ${url.protocol}`);
              }
              return url.toString();
            },
          })
        : new CdpSession({
            port: cdpPort,
            userDataDir: cdpUserDataDir,
            useActivePortFile: this.options.useActivePortFile,
            requireActivePortFile: this.options.args.attachCdp && this.options.useActivePortFile,
            targetRegistryFile,
          });
      this.session.onBrowserConnected(() => {
        this.getPageHost();
      });
    }
    return this.session;
  }

  private getPageHost(): CdpPluginPageHost {
    return (this.pageHost ??= new CdpPluginPageHost(this.getSession(), this.options.pluginService, {
      browserId: this.stateKey,
    }));
  }

  private async execute(
    action: string,
    data: any,
    controlSource: ControlSource,
    deadline?: number,
  ) {
    if (action !== 'page_runtime' && !getRegisteredActionNames().includes(action)) {
      throw new Error(`Action "${action}" is not supported in CDP mode`);
    }
    const probe = await this.getSession().probeAvailability();
    if (!probe.available) {
      const { cdpEndpointFile, cdpPort } = this.options.args;
      if (cdpEndpointFile)
        throw new Error(`The remote CDP endpoint is not available: ${probe.error}`);
      throw new Error(
        `Chrome DevTools remote debugging is not available on port ${cdpPort}. ` +
          'Enable it via chrome://inspect/#remote-debugging (Chrome 145+) ' +
          `or install the Mearl extension. ${probe.error}`,
      );
    }

    if (this.registrationEnabled) {
      this.publish();
      if (this.options.args.attachCdp || !this.reconnectable) this.monitorConnection();
    }

    if (action === 'page_runtime') return this.getPageHost().handle(data);
    if (shouldObservePageAction(action, data)) {
      return cdpObservedPageAction(this.getSession(), action, data, controlSource, deadline);
    }
    return dispatchCdpAction(this.getSession(), action, data, controlSource, deadline);
  }

  private publish(): boolean {
    this.options.onPublish();
    if (this.published) return true;
    const { browserName, attachCdp } = this.options.args;
    this.published = registerBrowser({
      browserId: this.browserId,
      socketPath: this.options.socketPath,
      browserName,
      nativeHostVersion: NATIVE_HOST_VERSION,
      transport: 'cdp',
      ...(attachCdp
        ? {
            provider: providerIdentity(CDP_PROVIDER),
            ownership: 'attached',
            persistence: 'ephemeral',
            operations: ['detach'],
            details: {
              headless: this.options.args.browserHeadless,
              ...(this.options.args.cdpEndpointFile
                ? {}
                : { cdpPort: this.getSession().getEffectivePort() }),
            },
          }
        : {}),
      // An attached browser has no focus signal.
      lastFocusedAt: attachCdp ? -1 : this.browserId.startsWith('managed:') ? 0 : undefined,
      preserveFocus: !attachCdp,
    });
    return this.published;
  }

  private unpublish(): void {
    if (!this.published) return;
    unregisterBrowser();
    this.published = false;
  }

  private monitorConnection(): void {
    if (this.registrationTimer) return;
    this.registrationTimer = setInterval(() => {
      if (!this.autoReconnectEnabled || this.session?.hasActiveConnections()) return;
      this.unpublish();
      clearInterval(this.registrationTimer);
      this.registrationTimer = undefined;
      if (this.options.args.attachCdp) this.options.onAttachDisconnect();
    }, 2_000).unref();
  }
}
