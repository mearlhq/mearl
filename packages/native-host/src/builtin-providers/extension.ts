import { invokePageEvalWithArgs } from '@mearl/client/plugin';
import {
  EXTENSION_RPC_VERSION,
  ExtensionRpcError,
  extensionRpcErrorCode,
  isExtensionUiServiceAction,
  isHostToExtensionAction,
  requiresExtensionAgentAccess,
  type BrowserReleaseParams,
  type BrowserReleaseResult,
  type ControlSource,
  type PageDownloadParams,
  type PageRecordingOptions,
} from '@mearl/browser-core';
import {
  browserNameForBundle,
  createExtensionBrowserNameResolver,
  detectNativeBrowserBundleId,
} from '../browser-identity.js';
import { registerBrowser, touchFocus, unregisterBrowser } from '../browser-registry.js';
import { watchExtensionAgentPolicy } from '../extension-agent-policy.js';
import {
  hasRunActionsSendRequestFiles,
  hasSendRequestFiles,
  sendRequestWithTransferredFiles,
  sendRunActionsWithTransferredFiles,
} from '../extension-file-transfer.js';
import { createExtensionRequestMessage } from '../internal-extension-actions.js';
import { PRESET_INSTALLATION_PROTOCOL } from '../preset-installation.js';
import { createToolboxExtensionInvoker, extensionResponseError } from '../toolbox-permissions.js';
import { NATIVE_HOST_VERSION } from '../version.js';
import { toTimeoutMs } from './action-timeout.js';
import type { HostBrowserProvider } from './host-browser-provider.js';

interface ExtensionProviderOptions {
  socketPath: string;
  daemon: boolean;
  log: (...args: any[]) => void;
  onDisconnect: (code: number) => void;
  onRequest: (message: any, respond: (response: Record<string, any>) => void) => Promise<void>;
  onPing: (message: any) => void;
  getPresetInstallationRevision: () => Promise<string | null>;
}

interface ExtensionBrowserInfo {
  userAgent?: string | null;
  extensionId?: string;
  extensionVersion?: string;
  setupManagedPath?: string | null;
}

export class ExtensionBrowserProvider implements HostBrowserProvider {
  private extensionVersion: string | null = null;
  private rpcVersion: number | null = null;
  private uploadTransfer = false;
  private record?: Parameters<typeof registerBrowser>[0];
  private agentAllowed = false;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly agentPolicy: ReturnType<typeof watchExtensionAgentPolicy>;
  private readonly resolveBrowserName: ReturnType<typeof createExtensionBrowserNameResolver>;

  constructor(private readonly options: ExtensionProviderOptions) {
    const bundleId = options.daemon ? undefined : detectNativeBrowserBundleId();
    this.resolveBrowserName = createExtensionBrowserNameResolver(() =>
      browserNameForBundle(bundleId),
    );
    this.agentPolicy = watchExtensionAgentPolicy(bundleId, policy => {
      this.agentAllowed = false;
      unregisterBrowser();
      this.send({ type: 'agent_policy', policy });
    });
  }

  get version(): string | null {
    return this.extensionVersion;
  }

  get connected(): boolean {
    return this.version !== null;
  }

  get protocolReady(): boolean {
    return this.connected && this.rpcVersion === EXTENSION_RPC_VERSION;
  }

  get supportsUploadTransfer(): boolean {
    return this.protocolReady && this.uploadTransfer;
  }

  get browserId(): string {
    return this.record?.browserId ?? 'default';
  }

  start(): void {
    process.stdin.on('readable', () => {
      let chunk: Buffer | null;
      while ((chunk = process.stdin.read()) !== null) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processMessages();
      }
    });
    process.stdin.on('end', () => {
      this.options.log('Extension disconnected (stdin end)');
      this.options.onDisconnect(0);
    });
    process.stdin.on('error', (error: Error) => {
      this.options.log('stdin error:', String(error));
      this.options.onDisconnect(1);
    });
  }

  dispose(): void {
    this.agentPolicy.close();
    if (this.record) unregisterBrowser();
  }

  send(message: Record<string, any>): void {
    const json = JSON.stringify(message);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(Buffer.byteLength(json, 'utf-8'), 0);
    process.stdout.write(header);
    process.stdout.write(json);
  }

  async request(
    action: string,
    data: any,
    timeoutMs: number,
    trustedInternal = false,
    controlSource: ControlSource = 'local',
  ): Promise<any> {
    if (!this.agentAllowed && requiresExtensionAgentAccess(action, data, trustedInternal))
      throw new Error('Extension Agent access is disabled or awaiting coordination');
    if (trustedInternal || isHostToExtensionAction(action)) this.assertRpcVersion(this.rpcVersion);
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(createExtensionRequestMessage(id, action, data, trustedInternal, controlSource));
    });
  }

  invoke(action: string, data: any, controlSource: ControlSource): Promise<any> {
    return this.invokeAction(action, data, (action, payload, timeout, trusted) =>
      this.request(action, payload, timeout, trusted, controlSource),
    );
  }

  invokeStagedUpload(action: string, data: any, controlSource: ControlSource): Promise<any> {
    const upload = action === 'run_actions' ? data.actions[0].data.stagedUpload : data.stagedUpload;
    const timeout = upload.deadline - Date.now();
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Page upload deadline exceeded');
    return this.request(action, data, timeout, true, controlSource);
  }

  createPluginInvoker(interactive: boolean) {
    const send: Parameters<typeof createToolboxExtensionInvoker>[0] = (
      action,
      data,
      timeout,
      trusted,
    ) => this.request(action, data, timeout, trusted);
    const invoke = interactive ? createToolboxExtensionInvoker(send) : send;
    return (action: string, data: Record<string, any>, timeoutSec?: number) => {
      if (action === 'page_eval' && data.args !== undefined)
        return invokePageEvalWithArgs(
          request => invoke('page_eval', request, toTimeoutMs('page_eval', request), false),
          data as any,
        );
      return this.invokeAction(action, data, invoke, () => {
        const timeoutMs = timeoutSec === undefined ? toTimeoutMs(action, data) : timeoutSec * 1000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3600000)
          throw new Error('Invalid plugin request timeout');
        return timeoutMs;
      });
    };
  }

  private invokeAction(
    action: string,
    data: any,
    send: Parameters<typeof createToolboxExtensionInvoker>[0],
    timeout = () => toTimeoutMs(action, data),
  ): Promise<any> {
    const transfer = (action: string, payload: any, timeoutMs: number) =>
      send(action, payload, timeoutMs, true);
    if (action === 'send_request' && hasSendRequestFiles(data)) {
      return sendRequestWithTransferredFiles(data, transfer);
    }
    if (action === 'run_actions' && hasRunActionsSendRequestFiles(data)) {
      return sendRunActionsWithTransferredFiles(data, transfer, transformed =>
        toTimeoutMs('run_actions', transformed),
      );
    }
    return send(action, data, timeout(), false);
  }

  browserInfo(): Promise<ExtensionBrowserInfo> {
    return this.request('get_browser_info', {}, 3000, true);
  }

  async exportCookies(domains: string[]) {
    const result = await this.request('__export_cookies', { domains }, 20000, true);
    return result.cookies ?? [];
  }

  async release(data: BrowserReleaseParams): Promise<BrowserReleaseResult | undefined> {
    if (this.connected)
      return this.request('__control_release', data, toTimeoutMs('__control_release', data), true);
  }

  async deactivate(tabIds: number[]): Promise<void> {
    await this.request('__control_deactivate', { tabIds }, 30000, true);
  }

  async cleanup(tabIds: number[], preserveEnvironment: boolean, returningToAgent?: boolean) {
    const result = await this.request(
      '__control_cleanup',
      { tabIds, preserveEnvironment, ...(returningToAgent ? { returningToAgent } : {}) },
      30000,
      true,
    );
    if (result.released === false)
      throw new Error('Session cleanup failed: ' + JSON.stringify(result.failures));
  }

  download(data: PageDownloadParams, source: ControlSource) {
    return this.request(
      '__capture_download',
      data,
      Number(data.timeout ?? 30000) + 10000,
      true,
      source,
    );
  }

  async openRecording(
    tabId: number,
    recordingId: string,
    options: Required<PageRecordingOptions>,
  ): ReturnType<HostBrowserProvider['openRecording']> {
    const startTimeoutMs = 10_000;
    await this.request(
      '__page_record',
      {
        operation: 'start',
        recordingId,
        tabId,
        options,
        deadline: Date.now() + startTimeoutMs,
      },
      startTimeoutMs,
      true,
    );
    return {
      isAlive: async () => {
        if (!this.connected) return false;
        try {
          const { active } = await this.request(
            '__page_record_status',
            { recordingId },
            3000,
            true,
          );
          return active === true;
        } catch (error) {
          if (error instanceof Error && error.message.includes('Unknown action'))
            throw new Error('Update the Mearl extension to query recording status', {
              cause: error,
            });
          throw error;
        }
      },
      stop: () => this.request('__page_record', { operation: 'stop', recordingId }, 15_000, true),
      read: size =>
        this.request('__page_record', { operation: 'read', recordingId, size }, 10_000, true),
      close: () => this.request('__page_record', { operation: 'close', recordingId }, 10_000, true),
    };
  }

  private assertRpcVersion(version: unknown): void {
    if (version !== EXTENSION_RPC_VERSION)
      throw new ExtensionRpcError(
        'PROTOCOL_MISMATCH',
        'Update the Mearl extension and local service, then reconnect.',
      );
  }

  private publishAccess(enabled: boolean): void {
    this.agentAllowed = enabled;
    if (enabled && this.record) registerBrowser(this.record);
    else unregisterBrowser();
  }

  private handlePing(message: any): void {
    this.rpcVersion = typeof message.rpcVersion === 'number' ? message.rpcVersion : null;
    this.uploadTransfer = message.pageUploadTransfer === true;
    if (message.version) {
      this.extensionVersion = message.version;
      this.options.log(
        `Extension version: ${this.version}, Native Host version: ${NATIVE_HOST_VERSION}`,
      );
    }
    // Older extensions omit the browser ID. Keep their shared identity discoverable.
    this.record = {
      browserId: typeof message.browserId === 'string' ? message.browserId : 'default',
      socketPath: this.options.socketPath,
      browserName: this.resolveBrowserName(
        typeof message.browserName === 'string' ? message.browserName : 'Browser',
      ),
      nativeHostVersion: NATIVE_HOST_VERSION,
      transport: 'extension',
      extensionVersion: this.version ?? undefined,
    };
    const policy = this.agentPolicy.current();
    this.publishAccess(
      message.agentAccessProtocol !== 1 &&
        policy.available !== false &&
        policy.providerIds.length === 0,
    );
    void this.options
      .getPresetInstallationRevision()
      .catch(error => {
        this.options.log('Preset browser selection unavailable:', String(error));
        return null;
      })
      .then(presetInstallationRevision =>
        this.send({
          type: 'pong',
          timestamp: Date.now(),
          version: NATIVE_HOST_VERSION,
          rpcVersion: EXTENSION_RPC_VERSION,
          presetInstallationRevision,
          presetInstallationProtocol: PRESET_INSTALLATION_PROTOCOL,
          agentPolicy: this.agentPolicy.current(),
        }),
      );
    this.options.onPing(message);
  }

  private handleMessage(message: any): void {
    if (message?.type === 'agent_access') {
      const policy = this.agentPolicy.current();
      if (
        policy.available !== false &&
        message.revision === policy.revision &&
        typeof message.enabled === 'boolean'
      )
        this.publishAccess(message.enabled);
      return;
    }
    if (message?.type === 'ping') {
      this.handlePing(message);
      return;
    }
    if (message?.type === 'browser_focus') {
      if (this.agentAllowed) touchFocus();
      return;
    }
    if (!message || typeof message !== 'object' || !message.id) return;

    const pending = this.pending.get(message.id);
    if (!pending) {
      if (message.action) {
        this.handleRequest(message).catch(error => {
          this.send({
            id: message.id,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            code: extensionRpcErrorCode(error),
          });
        });
      }
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.success) pending.resolve(message.data);
    else pending.reject(extensionResponseError(message));
  }

  private async handleRequest(message: any): Promise<void> {
    if (isExtensionUiServiceAction(message.action) || message.action === 'preset_installation')
      this.assertRpcVersion(message.rpcVersion);
    return this.options.onRequest(message, response => this.send(response));
  }

  private processMessages(): void {
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) return;

      const jsonBytes = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        this.handleMessage(JSON.parse(jsonBytes.toString('utf-8')));
      } catch (error) {
        this.options.log('Failed to parse extension message:', String(error));
      }
    }
  }
}
