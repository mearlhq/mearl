import { sendCdpPageCommand, getCdpPageDialogs } from './page-dialogs.js';
import { createHash, randomUUID } from 'node:crypto';
import { processIdentity } from '@mearl/daemon-core';
import { NodePageRuntimeStore, nativeCapabilityDirectory } from '../page-runtime-store.js';
import {
  buildPageRuntimeRegistrationSource,
  buildPageRuntimeCallSource,
} from '@mearl/preset/bundles';
import { nativeCapabilities } from '../native-capability-services.js';
import { findCapabilityAppProfile, resolveInstalledAppProfile } from '../app-profile-catalog.js';
/** CDP App environment and JSBridge injection. */

import {
  installAppProfileMessageRelay,
  installAppProfileDocumentEnvironment,
  installAppProfileWhenDocumentReady,
  updateAppProfileSetting,
  validateAppBridgeConfig,
  findAppProfileDefinitionUpdate,
  resolveAppProfile,
  resolveAppProfileUpdate,
  type ResolvedAppProfile,
} from '@mearl/app-profiles';
import {
  DEVICE_PRESETS,
  validateAppProfileDefinition,
  appProfileRevision,
  type AppProfileBinding,
  type AppProfileDefinition,
  buildDisableEmulationCommands,
  buildEnableEmulationCommands,
  getDeviceSideBarWidth,
  resolveEmulationConfig,
  preparePausedDebuggerTarget,
  type CdpCommand,
  type BrowserDevicePresetName,
  type InjectedAppProfileConfig,
  type ResolvedEmulationConfig,
  type SetAppProfileParams,
} from '@mearl/browser-core';
import { buildAppProfileRuntimeCallSource } from '@mearl/browser-core/appProfileRuntime';
import type { CdpChildSession, CdpClient } from './client.js';
import type { PageSession } from './cdp-session.js';
import { readCdpCurrentUrl, waitForPageLoad } from './cdp-utils.js';
import { cdpPageScreenshot } from './browser-handlers.js';
import { cdpSendProtocolRequest, cdpSendProtocolStreamRequest } from './http-handlers.js';
import {
  recordCdpProtocolStreamChunk,
  recordCdpProtocolStreamEnd,
  recordCdpProtocolStreamResponse,
  recordCdpProtocolStreamStart,
  type CdpProtocolStreamCapture,
} from './buffers.js';
import { clearPageRefsForNavigation } from './page-refs.js';
import { registerActions } from './action-registry.js';
import { registerPageSessionInitializer } from './page-session-initializers.js';
import {
  applyCdpDeviceShell,
  canLoadCdpDeviceShell,
  setCdpDeviceShellNavigationProxy,
  clearCdpDeviceShell,
  isCdpDeviceShellActive,
  setCdpDeviceShellChildEnvironmentManagedByApp,
  waitForCdpDeviceShellLoad,
} from './device-shell.js';
import { setCdpNetworkControl } from './network-control.js';
import {
  registerCdpFetchPauseHandler,
  unregisterCdpFetchPauseHandler,
} from './fetch-interceptor.js';
import {
  startAppAuthorization,
  waitAppAuthorization,
  closeAppAuthorization,
} from '../app-authorization.js';

const APP_PROFILE_BINDING = '__mearlCdpAppProfileRelay';
const APP_PROFILE_RESTORE_HINT = '__mearlCdpAppProfileRestoreHint__';
const APP_PROFILE_RESTORE_STATE = '__mearlCdpAppProfileState__';
const APP_PROFILE_RESTORE_WORLD = '__mearl_cdp_app_profile_state__';
const APP_PROFILE_RESTORE_VERSION = 1;
const MAX_APP_PROFILE_RESTORE_STATE_LENGTH = 160_000;

type CommandClient = CdpClient | CdpChildSession;

interface CdpAppProfileState {
  baseConfig: InjectedAppProfileConfig;
  config: InjectedAppProfileConfig;
  documentScriptIdentifiers: string[];
  profileScriptIdentifier: string;
  restoreScriptIdentifier: string;
  restoreState: Omit<CdpAppProfileRestoreState, 'activeDocument'>;
  emulation?: ResolvedEmulationConfig;
  disposeListeners: Array<() => void>;
  childClients: CommandClient[];
  mainFrameId?: string;
  mainFrameUrl?: string;
  definitionRefreshPending?: boolean;
}

interface CdpAppProfileRestoreOptions {
  lockDefinition?: boolean;
  os: 'ios' | 'android';
  appVersion: string;
  language?: SetAppProfileParams['language'];
  deviceModel: string;
  devicePreset?: BrowserDevicePresetName;
  orientation?: 'portrait' | 'landscape';
  bridgeConfig?: ResolveCdpAppProfileOptions['bridgeConfig'];
}

interface CdpAppProfileRestoreEmulation {
  preset?: BrowserDevicePresetName;
  width: number;
  height: number;
  deviceScaleFactor: number;
  scale: number;
  mobile: boolean;
  userAgent: string;
  orientation: 'portrait' | 'landscape';
  touch: boolean;
  deviceShell: boolean;
  splitScreen?: boolean;
}

interface CdpAppProfileRestoreState {
  version: typeof APP_PROFILE_RESTORE_VERSION;
  profile: string;
  binding: Omit<AppProfileBinding, 'options'>;
  options: CdpAppProfileRestoreOptions;
  emulation?: CdpAppProfileRestoreEmulation;
  activeDocument: boolean;
}

export interface ResolvedCdpAppProfile {
  profile: ResolvedAppProfile;
  restoreState: Omit<CdpAppProfileRestoreState, 'activeDocument'>;
}

interface ResolveCdpAppProfileOptions extends Omit<
  SetAppProfileParams,
  'enabled' | 'profile' | 'tabId' | 'reload'
> {
  devicePreset?: BrowserDevicePresetName;
  orientation?: 'portrait' | 'landscape';
}

const appProfileStates = new WeakMap<PageSession, CdpAppProfileState>();

function serializeForSource(value: unknown): string {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, character =>
    character === '\u2028' ? '\\u2028' : '\\u2029',
  );
}

function buildDocumentSource(config: InjectedAppProfileConfig, session: PageSession): string {
  const runtime = config.pageRuntime;
  const source = runtime
    ? new NodePageRuntimeStore(nativeCapabilityDirectory()).resolve(
        runtime,
        nativeCapabilities.get('app.pageRuntime'),
        session.runtimeOwner,
      )
    : undefined;
  const registration =
    runtime && source
      ? buildPageRuntimeRegistrationSource(runtime, source, '__mearlInstallPageRuntime__')
      : '';
  const call = runtime
    ? buildPageRuntimeCallSource('config')
    : buildAppProfileRuntimeCallSource('config');
  return `;(() => {const config=${serializeForSource(config)};(${installAppProfileMessageRelay.toString()})(${JSON.stringify(APP_PROFILE_BINDING)});(${installAppProfileDocumentEnvironment.toString()})(config,${JSON.stringify({ globals: 'runtime', restoreHintName: APP_PROFILE_RESTORE_HINT })});${registration};(${installAppProfileWhenDocumentReady.toString()})(() => {${call};},config.rootContainer?.enabled===true&&window===window.top);})();`;
}

function usesAppProfileSplitScreen(emulation: PageSession['emulation']): boolean {
  return (
    emulation?.deviceShell === true &&
    emulation.splitScreen === true &&
    emulation.config?.orientation === 'landscape'
  );
}

function resolveAppProfileRuntimeConfig(
  baseConfig: InjectedAppProfileConfig,
  emulation: PageSession['emulation'],
): InjectedAppProfileConfig {
  if (!usesAppProfileSplitScreen(emulation) || !emulation?.config) {
    const rootContainer = { ...baseConfig.rootContainer };
    delete rootContainer.splitScreen;
    return {
      ...baseConfig,
      rootContainer: { ...rootContainer, enabled: false },
      simulateSystemBars: false,
      externalDeviceChrome: false,
    };
  }

  const device = emulation.config;
  const sideBarWidth = getDeviceSideBarWidth(device.presetName, device.orientation);
  return {
    ...baseConfig,
    statusBarHeight: sideBarWidth ? 0 : 24,
    safeAreaInsets: device.safeAreaInsets,
    deviceAppearance: {
      preset: device.presetName ?? baseConfig.deviceAppearance?.preset ?? 'iphone-17-pro',
      orientation: device.orientation,
      cutout: device.appearance.cutout,
    },
    rootContainer: {
      ...baseConfig.rootContainer,
      enabled: true,
      splitScreen: true,
    },
    simulateSystemBars: true,
    externalDeviceChrome: sideBarWidth > 0,
  };
}

function buildRestoreHintSource(): string {
  return `;(() => {try{Object.defineProperty(globalThis,${JSON.stringify(APP_PROFILE_RESTORE_HINT)},{configurable:true,enumerable:false,writable:false,value:true});}catch{globalThis[${JSON.stringify(APP_PROFILE_RESTORE_HINT)}]=true;}})();`;
}

function buildRestoreStateSource(
  restoreState: Omit<CdpAppProfileRestoreState, 'activeDocument'>,
  activeDocument: boolean,
): string {
  return `;(() => {const state=${serializeForSource({ ...restoreState, activeDocument })};try{Object.defineProperty(globalThis,${JSON.stringify(APP_PROFILE_RESTORE_STATE)},{configurable:true,enumerable:false,writable:false,value:state});}catch{globalThis[${JSON.stringify(APP_PROFILE_RESTORE_STATE)}]=state;}})();`;
}

function snapshotCdpAppProfileEmulation(
  emulation: PageSession['emulation'],
): CdpAppProfileRestoreEmulation | undefined {
  const config = emulation?.config;
  if (!config) return undefined;
  const landscape = config.orientation === 'landscape';
  return {
    ...(config.presetName ? { preset: config.presetName } : {}),
    width: landscape ? config.height : config.width,
    height: landscape ? config.width : config.height,
    deviceScaleFactor: config.deviceScaleFactor,
    scale: config.scale ?? 1,
    mobile: config.mobile,
    userAgent: config.userAgent,
    orientation: config.orientation,
    touch: config.touch,
    deviceShell: emulation.deviceShell === true,
    splitScreen: emulation.splitScreen === true,
  };
}

function resolveCdpAppProfileRestoreEmulation(
  emulation: CdpAppProfileRestoreEmulation,
): ResolvedEmulationConfig {
  return resolveEmulationConfig({ enabled: true, ...emulation });
}

async function getRestoreExecutionContext(session: PageSession): Promise<number> {
  const frameTree = await session.client.sendCommand('Page.getFrameTree');
  const frameId = frameTree.frameTree?.frame?.id;
  if (typeof frameId !== 'string' || !frameId) {
    throw new Error('Chrome did not return the main frame id');
  }
  const world = await sendCdpPageCommand(session, session.client, 'Page.createIsolatedWorld', {
    frameId,
    worldName: APP_PROFILE_RESTORE_WORLD,
    grantUniveralAccess: false,
  });
  if (typeof world.executionContextId !== 'number') {
    throw new Error('Chrome did not return the App profile restore execution context');
  }
  return world.executionContextId;
}

function appProfileEmulationCommands(
  config: ResolvedEmulationConfig,
  userAgent: string,
): CdpCommand[] {
  return buildEnableEmulationCommands(config).map(command =>
    command.method === 'Emulation.setUserAgentOverride'
      ? {
          ...command,
          params: { userAgent, platform: config.platform },
        }
      : command,
  );
}

function childAppProfileEnvironment(
  config: InjectedAppProfileConfig,
  emulation: ResolvedEmulationConfig | undefined,
): { profile: InjectedAppProfileConfig; emulation: ResolvedEmulationConfig | undefined } {
  if (!emulation || !getDeviceSideBarWidth(emulation.presetName, emulation.orientation)) {
    return { profile: config, emulation };
  }
  const insets = { ...(config.safeAreaInsets ?? emulation.safeAreaInsets), right: 0 };
  return {
    profile: { ...config, safeAreaInsets: insets },
    emulation: { ...emulation, safeAreaInsets: { ...emulation.safeAreaInsets, right: 0 } },
  };
}

async function sendCommands(
  session: PageSession,
  client: CommandClient,
  commands: ReturnType<typeof buildEnableEmulationCommands>,
  signal?: AbortSignal,
): Promise<void> {
  for (const { method, params, optional } of commands) {
    signal?.throwIfAborted();
    await sendCdpPageCommand(session, client, method, params).catch(error => {
      if (!optional || getCdpPageDialogs(session).pending) throw error;
    });
  }
}

async function postRuntimeMessage(
  client: CommandClient,
  executionContextId: number | undefined,
  message: Record<string, unknown>,
): Promise<void> {
  await client.sendCommand('Runtime.evaluate', {
    expression: `window.postMessage(${serializeForSource(message)}, '*')`,
    ...(typeof executionContextId === 'number' ? { contextId: executionContextId } : {}),
  });
}

function listenForBridgeRequests(
  session: PageSession,
  client: CommandClient,
  state: CdpAppProfileState,
): () => void {
  const authSessions = new Map<string, string>();
  const cancelledAuth = new Set<string>();
  const pendingAuth = new Set<string>();
  return client.on('Runtime.bindingCalled', params => {
    if (params?.name !== APP_PROFILE_BINDING || appProfileStates.get(session) !== state) return;
    let request: {
      type?: string;
      requestId?: number;
      payload?: Record<string, unknown>;
    };
    try {
      request = JSON.parse(params.payload);
    } catch {
      return;
    }
    if (typeof request.requestId !== 'number') return;
    const requestId = request.requestId;
    const contextId =
      typeof params.executionContextId === 'number' ? params.executionContextId : undefined;
    const authKey = `${contextId ?? 'main'}:${requestId}`;
    // Pin the lease to this request; a later resume must not revive old work.
    const hostSignal = session.hostSignal;
    const reply = async (message: Record<string, unknown>) => {
      hostSignal?.throwIfAborted();
      await session.assertHostControl?.();
      hostSignal?.throwIfAborted();
      return postRuntimeMessage(client, contextId, {
        requestId,
        source: 'mearl-content',
        ...message,
      });
    };

    if (request.type === 'authCodeCancel') {
      if (!pendingAuth.has(authKey)) return;
      cancelledAuth.add(authKey);
      const browserId = authSessions.get(authKey);
      if (browserId) {
        authSessions.delete(authKey);
        void closeAppAuthorization(browserId).catch(() => {});
      }
      return;
    }

    void (async () => {
      session.pendingHostRequests = (session.pendingHostRequests ?? 0) + 1;
      if (session.pendingHostRequests === 1) session.onHostRequestActivity?.(true);
      hostSignal?.throwIfAborted();
      await session.assertHostControl?.();
      hostSignal?.throwIfAborted();
      if (request.type === 'settings') {
        try {
          const top =
            client === session.client && typeof contextId === 'number'
              ? await client.sendCommand('Runtime.evaluate', {
                  expression: 'globalThis === globalThis.top',
                  contextId,
                  returnByValue: true,
                })
              : null;
          if (
            top?.result?.value !== true ||
            appProfileStates.get(session) !== state ||
            !state.baseConfig.binding ||
            request.payload?.profile !== state.baseConfig.profile
          )
            throw new Error('App settings require the active top document');
          let bridgeConfig;
          let options;
          let responses;
          let reload = false;
          if (typeof request.payload?.settingId === 'string') {
            const updated = updateAppProfileSetting(
              state.baseConfig,
              request.payload.settingId,
              request.payload.value,
            );
            options = updated.options;
            responses = updated.responses;
            reload = updated.reload;
          } else {
            const value = request.payload?.responses;
            if (
              !value ||
              typeof value !== 'object' ||
              Array.isArray(value) ||
              Object.keys(value).some(
                method =>
                  !Object.hasOwn(
                    state.baseConfig.binding!.definition.actions.responses ?? {},
                    method,
                  ),
              )
            )
              throw new Error('Undeclared App response');
            bridgeConfig = {
              methods: Object.fromEntries(
                Object.entries(value).map(([method, response]) => [
                  method,
                  {
                    response,
                    ...(state.baseConfig.actions.silent?.includes(method) && { silent: true }),
                  },
                ]),
              ),
            };
            validateAppBridgeConfig(bridgeConfig);
            responses = value;
          }
          await cdpSetAppProfile(session, {
            ...options,
            ...(bridgeConfig && { bridgeConfig }),
            tabId: session.tabId,
            enabled: true,
            profile: state.baseConfig.profile,
            reload,
          });
          await reply({
            type: 'APP_BRIDGE_SETTINGS_RESPONSE',
            result: { success: true, responses, reload },
          });
        } catch (error) {
          await reply({
            type: 'APP_BRIDGE_SETTINGS_RESPONSE',
            result: { success: false, error: String(error) },
          });
        }
        return;
      }
      if (request.type === 'authCode') {
        if (
          !state.config.binding?.definition.authorization ||
          state.config.actions.behaviors?.[state.config.binding.definition.authorization.method] !==
            'authCode'
        )
          return;
        if (pendingAuth.has(authKey)) return;
        pendingAuth.add(authKey);
        let browserId = '';
        const abort = () => {
          cancelledAuth.add(authKey);
          if (browserId) void closeAppAuthorization(browserId).catch(() => {});
        };
        hostSignal?.addEventListener('abort', abort, { once: true });
        try {
          let progressQueue: Promise<void> = Promise.resolve();
          const pairing = await startAppAuthorization(
            state.config.binding!.definition.authorization!.hook,
            request.payload,
            phase => {
              progressQueue = progressQueue
                .then(async () => {
                  if (!cancelledAuth.has(authKey)) {
                    await reply({ type: 'APP_BRIDGE_AUTH_CODE_PROGRESS', phase });
                  }
                })
                .catch(() => {});
            },
          );
          await progressQueue;
          browserId = pairing.browserId;
          hostSignal?.throwIfAborted();
          if (cancelledAuth.has(authKey)) return;
          authSessions.set(authKey, browserId);
          await reply({ type: 'APP_BRIDGE_AUTH_CODE_PAIRING', result: { qrSvg: pairing.qrSvg } });
          progressQueue = Promise.resolve();
          const response = await waitAppAuthorization(browserId, request.payload, phase => {
            progressQueue = progressQueue
              .then(async () => {
                if (!cancelledAuth.has(authKey)) {
                  await reply({ type: 'APP_BRIDGE_AUTH_CODE_PROGRESS', phase });
                }
              })
              .catch(() => {});
          });
          await progressQueue;
          if (!cancelledAuth.has(authKey)) {
            await reply({
              type: 'APP_BRIDGE_AUTH_CODE_RESPONSE',
              result: { success: true, response },
            });
          }
        } catch (error) {
          if (!cancelledAuth.has(authKey)) {
            await reply({
              type: 'APP_BRIDGE_AUTH_CODE_RESPONSE',
              result: {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              },
            });
          }
        } finally {
          hostSignal?.removeEventListener('abort', abort);
          authSessions.delete(authKey);
          cancelledAuth.delete(authKey);
          pendingAuth.delete(authKey);
          if (browserId) await closeAppAuthorization(browserId).catch(() => {});
        }
        return;
      }
      if (request.type === 'screenshot') {
        if (client !== session.client) return;
        try {
          const result = await cdpPageScreenshot(session, { tabId: session.tabId, format: 'png' });
          await reply({
            type: 'APP_BRIDGE_SCREENSHOT_RESPONSE',
            result: { success: true, ...result },
          });
        } catch (error) {
          await reply({
            type: 'APP_BRIDGE_SCREENSHOT_RESPONSE',
            result: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      if (request.type === 'userInfo') {
        try {
          const currentUrl = await readCdpCurrentUrl(session, 'user_info');
          const result = await session.client.sendCommand('Network.getCookies', {
            urls: [currentUrl],
          });
          const response = nativeCapabilities.require('app.userInfo')(
            currentUrl,
            (result.cookies ?? []).map((cookie: { name: string; value: string }) => ({
              name: cookie.name,
              value: cookie.value,
            })),
          );
          await reply({
            type: 'APP_BRIDGE_USER_INFO_RESPONSE',
            result: { success: true, response },
          });
        } catch (error) {
          await reply({
            type: 'APP_BRIDGE_USER_INFO_RESPONSE',
            result: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }

      const payload = request.payload ?? {};
      const protocolPayload: Record<string, unknown> = payload;
      let streamCapture: CdpProtocolStreamCapture | undefined;
      try {
        if (request.type === 'protocolStream') {
          await cdpSendProtocolStreamRequest(
            session,
            protocolPayload as unknown as Record<string, unknown>,
            {
              onRequestPrepared: metadata => {
                streamCapture = recordCdpProtocolStreamStart(session.buffers, {
                  namespace: metadata.metadata?.namespace,
                  environment: metadata.metadata?.environment,
                  api: String(protocolPayload.api ?? ''),
                  url: metadata.url,
                  method: metadata.method,
                  requestHeaders: metadata.requestHeaders,
                  requestData: protocolPayload.data ?? null,
                });
              },
              onResponse: metadata => {
                if (streamCapture) {
                  recordCdpProtocolStreamResponse(session.buffers, streamCapture, metadata);
                }
              },
              onReceive: async data => {
                if (streamCapture) {
                  recordCdpProtocolStreamChunk(session.buffers, streamCapture, data);
                }
                await reply({
                  type: 'APP_BRIDGE_PROTOCOL_STREAM_EVENT',
                  eventType: 'onReceive',
                  data,
                });
              },
            },
          );
          if (streamCapture) recordCdpProtocolStreamEnd(session.buffers, streamCapture);
          await reply({
            type: 'APP_BRIDGE_PROTOCOL_STREAM_EVENT',
            eventType: 'onFinish',
            data: {},
          });
          return;
        }

        const result = await cdpSendProtocolRequest(
          session,
          protocolPayload as unknown as Record<string, unknown>,
        );
        await reply({ type: 'APP_BRIDGE_PROTOCOL_RESPONSE', result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (request.type === 'protocolStream') {
          if (streamCapture) {
            recordCdpProtocolStreamEnd(session.buffers, streamCapture, { error: message });
          }
          await reply({
            type: 'APP_BRIDGE_PROTOCOL_STREAM_EVENT',
            eventType: 'onError',
            data: { error: message },
          });
        } else {
          await reply({
            type: 'APP_BRIDGE_PROTOCOL_RESPONSE',
            result: { success: false, error: message },
          });
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        session.pendingHostRequests = Math.max(0, (session.pendingHostRequests ?? 1) - 1);
        if (!session.pendingHostRequests) session.onHostRequestActivity?.(false);
      });
  });
}

async function installChildTarget(
  session: PageSession,
  state: CdpAppProfileState,
  params: Record<string, any>,
): Promise<void> {
  const sessionId = params.sessionId;
  if (typeof sessionId !== 'string') return;
  const child = session.client.createChildSession(sessionId);
  const source = await preparePausedDebuggerTarget(
    async signal => {
      if (params.targetInfo?.type !== 'iframe' || appProfileStates.get(session) !== state) return;
      await child.sendCommand('Runtime.enable');
      signal.throwIfAborted();
      const frameNameResult = await child.sendCommand('Runtime.evaluate', {
        expression: 'window.name',
        returnByValue: true,
      });
      const frameName = frameNameResult.result?.value;
      signal.throwIfAborted();
      if (frameName !== '__mearl_root__' && frameName !== '__mearl_layer__') return;
      const childEnvironment = childAppProfileEnvironment(state.config, state.emulation);
      const source = buildDocumentSource(childEnvironment.profile, session);

      if (childEnvironment.emulation) {
        await sendCommands(
          session,
          child,
          appProfileEmulationCommands(childEnvironment.emulation, state.config.userAgent),
          signal,
        );
      } else {
        await child.sendCommand('Emulation.setUserAgentOverride', {
          userAgent: state.config.userAgent,
          platform: state.config.navigatorPlatform,
        });
      }
      signal.throwIfAborted();
      await child.sendCommand('Runtime.addBinding', { name: APP_PROFILE_BINDING });
      signal.throwIfAborted();
      state.disposeListeners.push(listenForBridgeRequests(session, child, state));
      state.childClients.push(child);
      await child.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => {});
      signal.throwIfAborted();
      return source;
    },
    () => child.sendCommand('Runtime.runIfWaitingForDebugger'),
  );
  if (source) await child.sendCommand('Runtime.evaluate', { expression: source });
}

async function disposeState(session: PageSession, state: CdpAppProfileState): Promise<void> {
  if (appProfileStates.get(session) === state) appProfileStates.delete(session);
  setCdpDeviceShellNavigationProxy(session);
  await unregisterCdpFetchPauseHandler(session, 'app-profile-navigation');
  setCdpDeviceShellChildEnvironmentManagedByApp(session, false);
  for (const dispose of state.disposeListeners.splice(0)) dispose();
  if (!isCdpDeviceShellActive(session)) {
    await session.client
      .sendCommand('Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => {});
  }
  await Promise.allSettled(
    state.documentScriptIdentifiers.map(identifier =>
      session.client.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier }),
    ),
  );
  await Promise.allSettled(
    [session.client, ...state.childClients].map(client =>
      client.sendCommand('Runtime.removeBinding', { name: APP_PROFILE_BINDING }),
    ),
  );
  try {
    const contextId = await getRestoreExecutionContext(session);
    await sendCdpPageCommand(session, session.client, 'Runtime.evaluate', {
      contextId,
      expression: `delete globalThis[${JSON.stringify(APP_PROFILE_RESTORE_STATE)}]`,
    });
  } catch {
    // The target may already be closing; the daemon-owned handlers are still disposed locally.
  }
  await sendCdpPageCommand(session, session.client, 'Runtime.evaluate', {
    expression: `delete globalThis[${JSON.stringify(APP_PROFILE_RESTORE_HINT)}]`,
  }).catch(() => {});
  const deviceEmulation = session.emulation?.config;
  if (deviceEmulation) {
    const commands = buildEnableEmulationCommands(deviceEmulation);
    await sendCommands(session, session.client, commands);
    await Promise.allSettled(
      state.childClients.map(client => sendCommands(session, client, commands)),
    );
  } else {
    await Promise.allSettled(
      [session.client, ...state.childClients].map(client =>
        client.sendCommand('Emulation.setUserAgentOverride', { userAgent: '' }),
      ),
    );
  }
}

async function rollbackAppProfileInstall(
  session: PageSession,
  documentScriptIdentifiers: string[],
  deviceEmulation: ResolvedEmulationConfig | undefined,
): Promise<void> {
  await Promise.allSettled([
    ...documentScriptIdentifiers.map(identifier =>
      session.client.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier }),
    ),
    session.client.sendCommand('Runtime.removeBinding', { name: APP_PROFILE_BINDING }),
    sendCdpPageCommand(session, session.client, 'Runtime.evaluate', {
      expression: `delete globalThis[${JSON.stringify(APP_PROFILE_RESTORE_HINT)}]`,
    }),
  ]);
  if (deviceEmulation) {
    await sendCommands(
      session,
      session.client,
      buildEnableEmulationCommands(deviceEmulation),
    ).catch(() => {});
  } else {
    await sendCdpPageCommand(session, session.client, 'Emulation.setUserAgentOverride', {
      userAgent: '',
    }).catch(() => {});
  }
}

export function resolveCdpAppProfile(
  profile: string,
  options: ResolveCdpAppProfileOptions = {},
  definition?: AppProfileDefinition,
  current?: InjectedAppProfileConfig,
): ResolvedCdpAppProfile {
  definition ??= findCapabilityAppProfile(profile)?.definition;
  const candidate = definition ?? current?.binding?.definition;
  if (
    candidate &&
    !candidate.pageRuntime &&
    (candidate.bridges.length > 0 || Object.keys(candidate.globals).length > 0)
  ) {
    const runtime = nativeCapabilities.get('app.defaultPageRuntime')?.();
    if (!runtime) throw new Error('This App profile requires an installed page runtime capability');
    definition = validateAppProfileDefinition({ ...candidate, pageRuntime: runtime });
  }
  const resolved = resolveAppProfileUpdate(profile, { current, definition, options });
  const restoreOptions: CdpAppProfileRestoreOptions = {
    os: resolved.injected.platform === 'Android' ? 'android' : 'ios',
    appVersion:
      resolved.injected.binding?.options.appVersion ??
      resolved.injected.globals.__APP_VERSION__ ??
      '',
    language: resolved.injected.language,
    ...(resolved.injected.binding?.options.lockDefinition !== undefined && {
      lockDefinition: resolved.injected.binding.options.lockDefinition,
    }),
    deviceModel:
      resolved.injected.binding?.options.deviceModel ??
      resolved.injected.globals.__DEVICE_MODEL__ ??
      '',
    ...(resolved.injected.deviceAppearance?.preset
      ? { devicePreset: resolved.injected.deviceAppearance.preset }
      : {}),
    ...(resolved.injected.deviceAppearance?.orientation
      ? { orientation: resolved.injected.deviceAppearance.orientation }
      : {}),
    ...(resolved.injected.binding?.options.bridgeConfig
      ? { bridgeConfig: resolved.injected.binding.options.bridgeConfig }
      : {}),
  };
  return {
    profile: resolved,
    restoreState: {
      version: APP_PROFILE_RESTORE_VERSION,
      profile: resolved.profile,
      binding: {
        version: 1,
        revision: resolved.injected.binding!.revision,
        definition: resolved.injected.binding!.definition,
        explicitOptions: resolved.injected.binding!.explicitOptions,
      },
      options: restoreOptions,
    },
  };
}

function isFiniteNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function isCdpAppProfileRestoreEmulation(value: unknown): value is CdpAppProfileRestoreEmulation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const emulation = value as Record<string, unknown>;
  const supportedKeys = new Set([
    'preset',
    'width',
    'height',
    'deviceScaleFactor',
    'scale',
    'mobile',
    'userAgent',
    'orientation',
    'touch',
    'deviceShell',
    'splitScreen',
  ]);
  return (
    !Object.keys(emulation).some(key => !supportedKeys.has(key)) &&
    (emulation.preset === undefined ||
      (typeof emulation.preset === 'string' && Object.hasOwn(DEVICE_PRESETS, emulation.preset))) &&
    isFiniteNumberInRange(emulation.width, 1, 100_000) &&
    isFiniteNumberInRange(emulation.height, 1, 100_000) &&
    isFiniteNumberInRange(emulation.deviceScaleFactor, 0, 100) &&
    isFiniteNumberInRange(emulation.scale, Number.MIN_VALUE, 100) &&
    typeof emulation.mobile === 'boolean' &&
    typeof emulation.userAgent === 'string' &&
    emulation.userAgent.length <= 4_096 &&
    (emulation.orientation === 'portrait' || emulation.orientation === 'landscape') &&
    typeof emulation.touch === 'boolean' &&
    typeof emulation.deviceShell === 'boolean' &&
    (emulation.splitScreen === undefined || typeof emulation.splitScreen === 'boolean')
  );
}

function parseCdpAppProfileRestoreState(value: unknown): CdpAppProfileRestoreState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    if (JSON.stringify(value).length > MAX_APP_PROFILE_RESTORE_STATE_LENGTH) return null;
  } catch {
    return null;
  }
  const state = value as Record<string, unknown>;
  const supportedStateKeys = new Set([
    'version',
    'profile',
    'options',
    'emulation',
    'activeDocument',
    'binding',
  ]);
  if (
    Object.keys(state).some(key => !supportedStateKeys.has(key)) ||
    state.version !== APP_PROFILE_RESTORE_VERSION ||
    typeof state.profile !== 'string' ||
    !state.binding ||
    typeof state.activeDocument !== 'boolean' ||
    (state.emulation !== undefined && !isCdpAppProfileRestoreEmulation(state.emulation)) ||
    !state.options ||
    typeof state.options !== 'object' ||
    Array.isArray(state.options)
  ) {
    return null;
  }
  const options = state.options as Record<string, unknown>;
  const supportedKeys = new Set([
    'os',
    'appVersion',
    'language',
    'deviceModel',
    'devicePreset',
    'orientation',
    'bridgeConfig',
    'lockDefinition',
  ]);
  if (Object.keys(options).some(key => !supportedKeys.has(key))) return null;
  if (options.lockDefinition !== undefined && typeof options.lockDefinition !== 'boolean')
    return null;
  if (
    options.language !== undefined &&
    (typeof options.language !== 'string' || options.language.length > 100)
  )
    return null;
  try {
    const binding = state.binding as AppProfileBinding;
    const definition = validateAppProfileDefinition(binding.definition);
    if (binding.explicitOptions !== undefined)
      resolveAppProfile(definition.name, binding.explicitOptions, definition);
    if (
      binding.version !== 1 ||
      definition.name !== state.profile ||
      appProfileRevision(definition) !== binding.revision
    )
      return null;
  } catch {
    return null;
  }
  if (
    (options.os !== 'ios' && options.os !== 'android') ||
    typeof options.appVersion !== 'string' ||
    options.appVersion.length > 100 ||
    typeof options.deviceModel !== 'string' ||
    options.deviceModel.length > 200 ||
    (options.devicePreset !== undefined &&
      (typeof options.devicePreset !== 'string' ||
        !Object.hasOwn(DEVICE_PRESETS, options.devicePreset))) ||
    (options.orientation !== undefined &&
      options.orientation !== 'portrait' &&
      options.orientation !== 'landscape')
  ) {
    return null;
  }
  return value as CdpAppProfileRestoreState;
}

function restoreStateForSession(
  restoreState: Omit<CdpAppProfileRestoreState, 'activeDocument'>,
  emulation: PageSession['emulation'],
): Omit<CdpAppProfileRestoreState, 'activeDocument'> {
  const result = { ...restoreState };
  const emulationSnapshot = snapshotCdpAppProfileEmulation(emulation);
  if (emulationSnapshot) result.emulation = emulationSnapshot;
  else delete result.emulation;
  return result;
}

async function writeCurrentRestoreState(
  session: PageSession,
  restoreState: Omit<CdpAppProfileRestoreState, 'activeDocument'>,
): Promise<void> {
  const activeProfile = await sendCdpPageCommand(session, session.client, 'Runtime.evaluate', {
    expression: `globalThis.__mearlAppProfile__===${JSON.stringify(restoreState.profile)}`,
    returnByValue: true,
  });
  const contextId = await getRestoreExecutionContext(session);
  await sendCdpPageCommand(session, session.client, 'Runtime.evaluate', {
    contextId,
    expression: buildRestoreStateSource(restoreState, activeProfile.result?.value === true),
  });
}

async function replaceRestoreState(
  session: PageSession,
  state: CdpAppProfileState,
  restoreState: Omit<CdpAppProfileRestoreState, 'activeDocument'>,
  writeCurrent = true,
): Promise<void> {
  const result = await sendCdpPageCommand(
    session,
    session.client,
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: buildRestoreStateSource(restoreState, true),
      worldName: APP_PROFILE_RESTORE_WORLD,
    },
  );
  if (typeof result.identifier !== 'string' || !result.identifier) {
    throw new Error('Chrome did not return an app profile restore script identifier');
  }
  const identifier = result.identifier;
  try {
    if (writeCurrent) await writeCurrentRestoreState(session, restoreState);
  } catch (error) {
    await session.client
      .sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier })
      .catch(() => {});
    throw error;
  }

  const previousIdentifier = state.restoreScriptIdentifier;
  state.restoreState = restoreState;
  state.restoreScriptIdentifier = identifier;
  state.documentScriptIdentifiers.push(identifier);
  const removed = await session.client
    .sendCommand('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: previousIdentifier,
    })
    .then(
      () => true,
      () => false,
    );
  if (removed) {
    state.documentScriptIdentifiers = state.documentScriptIdentifiers.filter(
      scriptIdentifier => scriptIdentifier !== previousIdentifier,
    );
  }
}

async function replaceAppProfileDocumentSource(
  session: PageSession,
  state: CdpAppProfileState,
  config: InjectedAppProfileConfig,
): Promise<void> {
  const result = await sendCdpPageCommand(
    session,
    session.client,
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: buildDocumentSource(config, session),
    },
  );
  if (typeof result.identifier !== 'string' || !result.identifier) {
    throw new Error('Chrome did not return an App profile bootstrap script identifier');
  }

  const previousIdentifier = state.profileScriptIdentifier;
  state.config = config;
  state.profileScriptIdentifier = result.identifier;
  state.documentScriptIdentifiers.push(result.identifier);
  const removed = await session.client
    .sendCommand('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: previousIdentifier,
    })
    .then(
      () => true,
      () => false,
    );
  if (removed) {
    state.documentScriptIdentifiers = state.documentScriptIdentifiers.filter(
      identifier => identifier !== previousIdentifier,
    );
  }
}

/** Reconnect daemon-owned CDP listeners for an App profile already installed in this target. */
export async function restoreCdpAppProfile(session: PageSession): Promise<boolean> {
  if (appProfileStates.has(session)) return true;
  const pageProbe = await sendCdpPageCommand(session, session.client, 'Runtime.evaluate', {
    expression: `({profile:typeof globalThis.__mearlAppProfile__==='string'?globalThis.__mearlAppProfile__:null,restoreHint:globalThis[${JSON.stringify(APP_PROFILE_RESTORE_HINT)}]===true})`,
    returnByValue: true,
    silent: true,
  });
  const pageState = pageProbe.result?.value as
    { profile?: unknown; restoreHint?: unknown } | undefined;
  if (typeof pageState?.profile !== 'string' && pageState?.restoreHint !== true) return false;

  const contextId = await getRestoreExecutionContext(session);
  const stateProbe = await sendCdpPageCommand(session, session.client, 'Runtime.evaluate', {
    contextId,
    expression: `globalThis[${JSON.stringify(APP_PROFILE_RESTORE_STATE)}]??null`,
    returnByValue: true,
  });
  const restoreState = parseCdpAppProfileRestoreState(stateProbe.result?.value);
  if (!restoreState) return false;
  if (
    restoreState.activeDocument &&
    typeof pageState?.profile === 'string' &&
    pageState.profile !== restoreState.profile
  ) {
    return false;
  }

  let resolved: ResolvedCdpAppProfile;
  try {
    resolved = resolveCdpAppProfile(
      restoreState.profile,
      restoreState.options,
      restoreState.binding.definition,
    );
    if (restoreState.binding.explicitOptions) {
      resolved.profile.injected.binding!.explicitOptions = restoreState.binding.explicitOptions;
      resolved.restoreState.binding!.explicitOptions = restoreState.binding.explicitOptions;
    }
  } catch {
    return false;
  }
  let restoredEmulation: ResolvedEmulationConfig | undefined;
  try {
    restoredEmulation = restoreState.emulation
      ? resolveCdpAppProfileRestoreEmulation(restoreState.emulation)
      : undefined;
  } catch {
    return false;
  }

  const previousEmulation = session.emulation;
  if (restoredEmulation && restoreState.emulation) {
    session.emulation = {
      mobile: restoredEmulation.mobile,
      touch: restoredEmulation.touch,
      config: restoredEmulation,
      deviceShell: restoreState.emulation.deviceShell,
      splitScreen: restoreState.emulation.splitScreen === true,
    };
  }
  try {
    await applyResolvedCdpAppProfile(session, resolved);
    if (restoredEmulation && restoreState.emulation?.deviceShell) {
      await applyCdpDeviceShell(session, restoredEmulation, {
        rootContainerManagedByApp: usesAppProfileSplitScreen(session.emulation),
      });
      setCdpDeviceShellChildEnvironmentManagedByApp(session, true);
    }
    if (restoreState.activeDocument) {
      await sendCdpPageCommand(session, session.client, 'Runtime.evaluate', {
        expression: buildDocumentSource(resolved.profile.injected, session),
      });
    }
  } catch (error) {
    await clearCdpDeviceShell(session).catch(() => {});
    const state = appProfileStates.get(session);
    if (state) await disposeState(session, state);
    session.emulation = previousEmulation;
    if (restoredEmulation) {
      if (previousEmulation?.config) {
        await sendCommands(
          session,
          session.client,
          buildEnableEmulationCommands(previousEmulation.config),
        ).catch(() => {});
      } else {
        await sendCommands(session, session.client, buildDisableEmulationCommands()).catch(
          () => {},
        );
      }
    }
    throw new Error(
      `Failed to restore App profile for target ${session.targetId}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return true;
}

export async function applyResolvedCdpAppProfile(
  session: PageSession,
  resolved: ResolvedCdpAppProfile,
): Promise<void> {
  const previousRuntime = appProfileStates.get(session)?.config.pageRuntime;
  const transitionOwner =
    previousRuntime && session.runtimeOwner
      ? {
          browser: createHash('sha256').update(randomUUID()).digest('hex'),
          target: session.targetId,
          pid: process.pid,
          processIdentity: processIdentity(process.pid),
        }
      : undefined;
  const store = new NodePageRuntimeStore();
  if (previousRuntime && transitionOwner)
    store.resolve(previousRuntime, undefined, transitionOwner);
  try {
    await applyResolvedCdpAppProfileImpl(session, resolved);
  } finally {
    if (transitionOwner) store.release(transitionOwner);
  }
}

async function applyResolvedCdpAppProfileImpl(
  session: PageSession,
  resolved: ResolvedCdpAppProfile,
): Promise<void> {
  const previous = appProfileStates.get(session);
  const baseConfig = resolved.profile.injected;
  const config = resolveAppProfileRuntimeConfig(baseConfig, session.emulation);
  const source = buildDocumentSource(config, session);
  if (previous) await disposeState(session, previous);
  const deviceEmulation = session.emulation?.config;
  const restoreState = restoreStateForSession(resolved.restoreState, session.emulation);
  const documentScriptIdentifiers: string[] = [];
  let state: CdpAppProfileState | undefined;
  try {
    if (deviceEmulation) {
      await sendCommands(
        session,
        session.client,
        appProfileEmulationCommands(deviceEmulation, resolved.profile.ua),
      );
    } else {
      await sendCdpPageCommand(session, session.client, 'Emulation.setUserAgentOverride', {
        userAgent: resolved.profile.ua,
        platform: resolved.profile.injected.navigatorPlatform,
      });
    }
    await session.client.sendCommand('Runtime.enable');
    await session.client.sendCommand('Runtime.addBinding', { name: APP_PROFILE_BINDING });
    const script = await sendCdpPageCommand(
      session,
      session.client,
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source,
      },
    );
    if (typeof script.identifier !== 'string' || !script.identifier) {
      throw new Error('Chrome did not return an app profile bootstrap script identifier');
    }
    documentScriptIdentifiers.push(script.identifier);

    const restoreScript = await sendCdpPageCommand(
      session,
      session.client,
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: buildRestoreStateSource(restoreState, true),
        worldName: APP_PROFILE_RESTORE_WORLD,
      },
    );
    if (typeof restoreScript.identifier !== 'string' || !restoreScript.identifier) {
      throw new Error('Chrome did not return an app profile restore script identifier');
    }
    documentScriptIdentifiers.push(restoreScript.identifier);

    await writeCurrentRestoreState(session, restoreState);
    await sendCdpPageCommand(session, session.client, 'Runtime.evaluate', {
      expression: buildRestoreHintSource(),
    });

    const installedState: CdpAppProfileState = {
      baseConfig,
      config,
      documentScriptIdentifiers,
      profileScriptIdentifier: script.identifier,
      restoreScriptIdentifier: restoreScript.identifier,
      restoreState,
      emulation: deviceEmulation,
      disposeListeners: [],
      childClients: [],
    };
    state = installedState;
    appProfileStates.set(session, installedState);
    setCdpDeviceShellNavigationProxy(session, config.layerUrlProxy);
    setCdpDeviceShellChildEnvironmentManagedByApp(session, true);
    installedState.disposeListeners.push(
      listenForBridgeRequests(session, session.client, installedState),
    );
    installedState.disposeListeners.push(
      session.client.on('Target.attachedToTarget', params => {
        void installChildTarget(session, installedState, params).catch(() => {});
      }),
    );
    installedState.disposeListeners.push(
      session.client.on('Page.frameNavigated', params => {
        if (params.frame && !params.frame.parentId) {
          installedState.mainFrameId = params.frame.id;
          installedState.mainFrameUrl = params.frame.url;
          installedState.definitionRefreshPending = false;
          if (session.runtimeOwner) {
            try {
              new NodePageRuntimeStore().retain(
                session.runtimeOwner,
                installedState.config.pageRuntime,
              );
            } catch (error) {
              console.warn('[cdp] Could not reclaim page runtime code', error);
            }
          }
        }
      }),
    );
    const mainFrame = (await session.client.sendCommand('Page.getFrameTree')).frameTree?.frame;
    installedState.mainFrameId = mainFrame?.id;
    installedState.mainFrameUrl = mainFrame?.url;
    installedState.disposeListeners.push(
      session.client.on('Target.detachedFromTarget', params => {
        const sessionId = params?.sessionId;
        if (typeof sessionId !== 'string' || appProfileStates.get(session) !== installedState)
          return;
        installedState.childClients = installedState.childClients.filter(
          client => (client as { sessionId?: string }).sessionId !== sessionId,
        );
      }),
    );
    await registerCdpFetchPauseHandler(
      session,
      'app-profile-navigation',
      200,
      async context => {
        const { params, isResponseStage } = context;
        if (
          isResponseStage ||
          params.resourceType !== 'Document' ||
          !params.frameId ||
          appProfileStates.get(session) !== installedState ||
          installedState.definitionRefreshPending ||
          installedState.baseConfig.binding?.options.lockDefinition
        )
          return false;
        if (installedState.mainFrameId !== params.frameId) return false;
        if (params.request?.method !== 'GET') return false;
        let intercepted = false;
        try {
          await refreshCdpAppProfileForNavigation(session, async () => {
            // A 204 leaves the old document intact and releases renderer commands before preparation.
            await session.client.sendCommand('Fetch.fulfillRequest', {
              requestId: params.requestId,
              responseCode: 204,
              responseHeaders: [{ name: 'Cache-Control', value: 'no-store' }],
            });
            intercepted = true;
            installedState.definitionRefreshPending = true;
          });
        } catch {
          // Failed updates restore their previous scripts; the pending navigation still proceeds.
        } finally {
          if (intercepted) {
            if (params.request.url === installedState.mainFrameUrl)
              await sendCdpPageCommand(session, session.client, 'Page.reload', {});
            else
              await sendCdpPageCommand(session, session.client, 'Page.navigate', {
                url: params.request.url,
              });
          }
        }
        return intercepted;
      },
      [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    );
    await session.client.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: 'iframe' }, { exclude: true }],
    });
  } catch (error) {
    if (state) await disposeState(session, state);
    else await rollbackAppProfileInstall(session, documentScriptIdentifiers, deviceEmulation);
    if (previous) {
      try {
        await applyResolvedCdpAppProfile(session, {
          profile: {
            profile: previous.baseConfig.profile as SetAppProfileParams['profile'] & string,
            label: previous.baseConfig.label,
            ua: previous.baseConfig.userAgent,
            injected: previous.baseConfig,
            recommendedPreset: previous.baseConfig.deviceAppearance?.preset ?? 'iphone-17-pro',
          },
          restoreState: previous.restoreState,
        });
      } catch (rollback) {
        throw new AggregateError([error, rollback], 'App profile activation and recovery failed', {
          cause: rollback,
        });
      }
    }
    throw error;
  }
}

/** Update future-document scripts without replacing the active runtime or its bridge listeners. */
export async function refreshCdpAppProfileForNavigation(
  session: PageSession,
  beforeApply?: () => Promise<void>,
): Promise<string | undefined> {
  const state = appProfileStates.get(session);
  const previous = state?.baseConfig;
  if (!state || !previous?.binding || previous.binding.options.lockDefinition) return undefined;
  const definition = await findAppProfileDefinitionUpdate(
    previous,
    async () => (await resolveInstalledAppProfile(previous.profile)).injected.binding!.definition,
  );
  if (!definition || appProfileStates.get(session) !== state || state.baseConfig !== previous)
    return undefined;
  const next = resolveCdpAppProfile(previous.profile, {}, definition, previous);
  await beforeApply?.();
  if (appProfileStates.get(session) !== state || state.baseConfig !== previous) return undefined;
  const previousConfig = state.config;
  const previousRestore = state.restoreState;
  try {
    await replaceAppProfileDocumentSource(
      session,
      state,
      resolveAppProfileRuntimeConfig(next.profile.injected, session.emulation),
    );
    // Only future-document scripts change; current-document bridge callbacks retain their owners.
    await replaceRestoreState(
      session,
      state,
      restoreStateForSession(next.restoreState, session.emulation),
      false,
    );
    await sendCdpPageCommand(session, session.client, 'Emulation.setUserAgentOverride', {
      userAgent: next.profile.ua,
      platform: next.profile.injected.navigatorPlatform,
    });
    state.baseConfig = next.profile.injected;
    return next.profile.ua;
  } catch (error) {
    const results = await Promise.allSettled([
      replaceAppProfileDocumentSource(session, state, previousConfig),
      replaceRestoreState(session, state, previousRestore, false),
      sendCdpPageCommand(session, session.client, 'Emulation.setUserAgentOverride', {
        userAgent: previous.userAgent,
        platform: previous.navigatorPlatform,
      }),
    ]);
    const failures = results.flatMap(result =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError([error, ...failures], 'App profile refresh and recovery failed', {
        cause: error,
      });
    throw error;
  }
}

export async function updateCdpAppProfileDeviceEmulation(
  session: PageSession,
  emulation: ResolvedEmulationConfig | null,
  deviceShell = session.emulation?.deviceShell === true,
  splitScreen = session.emulation?.splitScreen === true,
): Promise<{ userAgent: string; platform: string } | undefined> {
  const state = appProfileStates.get(session);
  if (!state) return undefined;
  const nextSessionEmulation = emulation
    ? {
        mobile: emulation.mobile,
        touch: emulation.touch,
        config: emulation,
        deviceShell,
        splitScreen,
      }
    : undefined;
  const nextConfig = resolveAppProfileRuntimeConfig(state.baseConfig, nextSessionEmulation);
  if (JSON.stringify(nextConfig) !== JSON.stringify(state.config)) {
    await replaceAppProfileDocumentSource(session, state, nextConfig);
  }
  await replaceRestoreState(
    session,
    state,
    restoreStateForSession(state.restoreState, nextSessionEmulation),
  );
  state.emulation = emulation ?? undefined;
  await Promise.allSettled(
    state.childClients.map(client =>
      emulation
        ? sendCommands(
            session,
            client,
            appProfileEmulationCommands(
              childAppProfileEnvironment(state.config, emulation).emulation!,
              state.config.userAgent,
            ),
          )
        : client.sendCommand('Emulation.setUserAgentOverride', {
            userAgent: state.config.userAgent,
            platform: state.config.navigatorPlatform,
          }),
    ),
  );
  return {
    userAgent: state.config.userAgent,
    platform: state.config.navigatorPlatform,
  };
}

export function isCdpAppProfileActive(session: PageSession): boolean {
  return appProfileStates.has(session);
}

export async function waitForCdpAppProfileLoad(
  session: PageSession,
  timeoutMs = 30000,
): Promise<void> {
  if (isCdpDeviceShellActive(session)) {
    await waitForCdpDeviceShellLoad(session, Math.min(timeoutMs, 15000));
    return;
  }
  // Ready-state evaluation can wait for the paused document and block its bootstrap update.
  await waitForPageLoad(session, timeoutMs, { probeReadyState: !isCdpAppProfileActive(session) });
}

export async function clearCdpAppProfile(
  session: PageSession,
  reload = true,
): Promise<{ enabled: false; reloaded: boolean }> {
  const state = appProfileStates.get(session);
  if (!state) return { enabled: false, reloaded: false };
  await disposeState(session, state);
  if (session.runtimeOwner) new NodePageRuntimeStore().release(session.runtimeOwner);
  if (session.emulation?.deviceShell && session.emulation.config) {
    await applyCdpDeviceShell(session, session.emulation.config);
  }

  let reloaded = false;
  if (reload) {
    clearPageRefsForNavigation(session);
    await sendCdpPageCommand(session, session.client, 'Page.reload', {});
    await waitForCdpAppProfileLoad(session);
    reloaded = true;
  }
  return { enabled: false, reloaded };
}

export async function cdpSetAppProfile(
  session: PageSession,
  data: SetAppProfileParams,
): Promise<any> {
  if (typeof data?.enabled !== 'boolean') {
    throw new Error('set_app_profile: "enabled" is required (true to enable, false to clear)');
  }
  if (!data.enabled) {
    if (data.emulation === undefined) {
      if (data.networkControl === undefined) {
        return clearCdpAppProfile(session, data.reload !== false);
      }
      const appResult = await clearCdpAppProfile(session, false);
      await setCdpNetworkControl(session, data.networkControl);
      let reloaded = false;
      if (data.reload !== false) {
        clearPageRefsForNavigation(session);
        await sendCdpPageCommand(session, session.client, 'Page.reload', {});
        await waitForCdpAppProfileLoad(session);
        reloaded = true;
      }
      return { ...appResult, networkControl: data.networkControl, reloaded };
    }

    const hadDeviceShell = await clearCdpDeviceShell(session);
    const appResult = await clearCdpAppProfile(session, false);
    await sendCommands(session, session.client, buildDisableEmulationCommands());
    session.emulation = undefined;
    if (data.networkControl !== undefined) {
      await setCdpNetworkControl(session, data.networkControl);
    }
    let reloaded = false;
    if (data.reload !== false || hadDeviceShell) {
      clearPageRefsForNavigation(session);
      await sendCdpPageCommand(session, session.client, 'Page.reload', {});
      await waitForPageLoad(session, 30000);
      reloaded = true;
    }
    return {
      ...appResult,
      ...(data.networkControl !== undefined && { networkControl: data.networkControl }),
      device: { enabled: false, deviceShell: false, splitScreen: false, reloaded },
      reloaded,
    };
  }
  if (data.refreshDefinition !== undefined && typeof data.refreshDefinition !== 'boolean')
    throw new Error('refreshDefinition must be a boolean');
  if (!data.profile || typeof data.profile !== 'string') {
    throw new Error('set_app_profile: "profile" is required when enabled=true');
  }

  const current = appProfileStates.get(session)?.baseConfig;
  const definition =
    current?.profile === data.profile && !data.refreshDefinition
      ? current.binding?.definition
      : undefined;
  const installed =
    definition ?? (await resolveInstalledAppProfile(data.profile)).injected.binding!.definition;
  const resolved = resolveCdpAppProfile(
    data.profile,
    {
      ...data,
      devicePreset: session.emulation?.config?.presetName,
      orientation: session.emulation?.config?.orientation,
    },
    installed,
    current,
  );
  if (data.emulation !== undefined) {
    const emulation = resolveEmulationConfig({
      enabled: true,
      preset: resolved.profile.recommendedPreset,
      ...data.emulation,
    });
    const targetOs =
      emulation.platform === 'Android' || emulation.platform === 'OpenHarmony' ? 'android' : 'ios';
    const targetDeviceModel =
      data.deviceModel ??
      (emulation.presetName
        ? DEVICE_PRESETS[emulation.presetName].appProfileModel
        : resolved.profile.injected.globals.__DEVICE_MODEL__);
    const appResolved = resolveCdpAppProfile(
      data.profile,
      {
        ...data,
        os: targetOs,
        deviceModel: targetDeviceModel,
        devicePreset: emulation.presetName,
        orientation: emulation.orientation,
      },
      installed,
      current,
    );
    const deviceShell = data.emulation.deviceShell ?? true;
    const splitScreen =
      deviceShell && data.emulation.splitScreen === true && emulation.orientation === 'landscape';
    session.emulation = {
      mobile: emulation.mobile,
      touch: emulation.touch,
      config: emulation,
      deviceShell,
      splitScreen,
    };
    await applyResolvedCdpAppProfile(session, appResolved);
    const shellChanged = deviceShell
      ? await applyCdpDeviceShell(session, emulation, {
          rootContainerManagedByApp: splitScreen,
        })
      : await clearCdpDeviceShell(session);
    if (deviceShell) setCdpDeviceShellChildEnvironmentManagedByApp(session, true);
    if (data.networkControl !== undefined) {
      await setCdpNetworkControl(session, data.networkControl);
    }
    let reloaded = false;
    if (
      (data.reload !== false || shellChanged) &&
      (!deviceShell || (await canLoadCdpDeviceShell(session)))
    ) {
      clearPageRefsForNavigation(session);
      await sendCdpPageCommand(session, session.client, 'Page.reload', {});
      if (deviceShell) await waitForCdpDeviceShellLoad(session);
      else await waitForPageLoad(session, 30000);
      reloaded = true;
    }
    return {
      enabled: true,
      profile: appResolved.profile.profile,
      label: appResolved.profile.label,
      userAgent: appResolved.profile.ua,
      os: appResolved.profile.injected.platform === 'Android' ? 'android' : 'ios',
      ...(data.networkControl !== undefined && { networkControl: data.networkControl }),
      device: {
        enabled: true,
        preset: emulation.presetName,
        viewport: {
          width: emulation.width,
          height: emulation.height,
          deviceScaleFactor: emulation.deviceScaleFactor,
          scale: emulation.scale ?? 1,
        },
        userAgent: emulation.userAgent,
        mobile: emulation.mobile,
        touch: emulation.touch,
        orientation: emulation.orientation,
        deviceShell,
        splitScreen,
        reloaded,
      },
      reloaded,
    };
  }

  await applyResolvedCdpAppProfile(session, resolved);
  const shellChanged =
    session.emulation?.deviceShell && session.emulation.config
      ? await applyCdpDeviceShell(session, session.emulation.config, {
          rootContainerManagedByApp: usesAppProfileSplitScreen(session.emulation),
        })
      : false;
  if (data.networkControl !== undefined) {
    await setCdpNetworkControl(session, data.networkControl);
  }
  let reloaded = false;
  if (data.reload !== false || shellChanged) {
    clearPageRefsForNavigation(session);
    await sendCdpPageCommand(session, session.client, 'Page.reload', {});
    await waitForCdpAppProfileLoad(session);
    reloaded = true;
  }
  return {
    enabled: true,
    profile: resolved.profile.profile,
    label: resolved.profile.label,
    userAgent: resolved.profile.ua,
    os: resolved.profile.injected.platform === 'Android' ? 'android' : 'ios',
    ...(data.networkControl !== undefined && { networkControl: data.networkControl }),
    reloaded,
  };
}

registerPageSessionInitializer(async session => {
  try {
    await restoreCdpAppProfile(session);
  } catch (error) {
    console.warn(
      `[CDP] Failed to restore App profile for target ${session.targetId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
});
registerActions([{ name: 'set_app_profile', session: 'page', handler: cdpSetAppProfile }]);
