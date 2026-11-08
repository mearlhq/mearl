/**
 * App 容器模拟的扩展能力中转（ISOLATED world）
 *
 * MAIN world 的容器运行时（installAppProfileRuntime）把需要扩展权限的桥调用
 * 经 window.postMessage 发出；本模块在 content-script 层转发给 background，
 * 处理 PROTOCOL 签名代发与页面脚本不可见 Cookie 的用户信息查询，并回发页面完成桥回调。
 *
 * 该通道能用用户 Cookie 发任意签名请求，因此只在本 frame 确实处于容器模拟态时挂载：
 * 判据与 early-inject 相同——导航响应里带 mearl-app-profile 的 Server-Timing 头。
 * background 侧按 sender tab 再校验一次，两道都过才受理。
 */

/** 与 background utils/appProfileRules.ts 的 APP_PROFILE_SERVER_TIMING_KEY 对应 */
const APP_PROFILE_SERVER_TIMING_KEY = 'mearl-app-profile';

interface AppBridgeMessage {
  source: string;
  type: string;
  requestId: number;
  payload?: Record<string, unknown> & {
    appId?: string;
    scopeNicks?: string[];
    showErrorTip?: boolean;
  };
}

/** 本 frame 是否被下发了容器模拟配置（不解析内容，只判定存在） */
function hasAppProfileConfig(): boolean {
  try {
    const [navigation] = performance.getEntriesByType(
      'navigation',
    ) as PerformanceNavigationTiming[];
    return Boolean(
      navigation?.serverTiming?.some(timing => timing.name === APP_PROFILE_SERVER_TIMING_KEY),
    );
  } catch {
    return false;
  }
}

/** @returns 是否挂载了中转监听（未处于容器模拟态时不挂载） */
export function listenAppBridgeRelay(): boolean {
  if (!hasAppProfileConfig()) return false;

  const pendingStreams = new Set<number>();
  const authSessions = new Map<number, string>();
  const cancelledAuth = new Set<number>();
  const pendingAuthRequests = new Set<number>();
  const relayStreamEvent = (requestId: number, eventType: string, data: unknown) => {
    window.postMessage(
      {
        source: 'mearl-content',
        type: 'APP_BRIDGE_PROTOCOL_STREAM_EVENT',
        requestId,
        eventType,
        data,
      },
      '*',
    );
    if (eventType === 'onFinish' || eventType === 'onError') pendingStreams.delete(requestId);
  };

  chrome.runtime.onMessage.addListener(message => {
    if (message?.action === 'appBridgeAuthCodeProgress') {
      if (!pendingAuthRequests.has(message.requestId) || cancelledAuth.has(message.requestId))
        return;
      if (
        message.phase !== 'installing' &&
        message.phase !== 'connected' &&
        message.phase !== 'authorizing'
      )
        return;
      window.postMessage(
        {
          source: 'mearl-content',
          type: 'APP_BRIDGE_AUTH_CODE_PROGRESS',
          requestId: message.requestId,
          phase: message.phase,
        },
        '*',
      );
      return;
    }
    if (message?.action !== 'appBridgeProtocolStreamEvent') return;
    if (!pendingStreams.has(message.requestId)) return;
    relayStreamEvent(message.requestId, message.eventType, message.data);
  });

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const msg = event.data as AppBridgeMessage | null;
    if (!msg || msg.source !== 'mearl-app-bridge') return;
    if (
      msg.type !== 'protocol' &&
      msg.type !== 'protocolStream' &&
      msg.type !== 'userInfo' &&
      msg.type !== 'prepareWebView' &&
      msg.type !== 'authCode' &&
      msg.type !== 'authCodeCancel' &&
      msg.type !== 'settings' &&
      msg.type !== 'screenshot'
    ) {
      return;
    }
    if (typeof msg.requestId !== 'number') return;

    const requestId = msg.requestId;
    const reply = (type: string, result: unknown) => {
      window.postMessage({ source: 'mearl-content', type, requestId, result }, '*');
    };
    if (msg.type === 'settings') {
      const payload = msg.payload as Record<string, unknown> | undefined;
      const action = typeof payload?.settingId === 'string' ? 'appBridgeSetSetting' : 'appBridgeUpdateResponses';
      void chrome.runtime.sendMessage({ action, profile: payload?.profile, settingId: payload?.settingId, value: payload?.value, responses: payload?.responses })
        .then(result => reply('APP_BRIDGE_SETTINGS_RESPONSE', result))
        .catch(error => reply('APP_BRIDGE_SETTINGS_RESPONSE', { success: false, error: String(error) }));
      return;
    }
    if (msg.type === 'authCodeCancel') {
      if (!pendingAuthRequests.has(requestId)) return;
      cancelledAuth.add(requestId);
      const browserId = authSessions.get(requestId);
      if (browserId) {
        authSessions.delete(requestId);
        void chrome.runtime
          .sendMessage({ action: 'appBridgeAuthCodeClose', browserId })
          .catch(() => {});
      }
      return;
    }
    if (msg.type === 'authCode') {
      if (pendingAuthRequests.has(requestId)) return;
      pendingAuthRequests.add(requestId);
      const run = async () => {
        let browserId = '';
        try {
          const pairing = (await chrome.runtime.sendMessage({
            action: 'appBridgeAuthCodeStart',
            requestId,
            params: msg.payload,
          })) as {
            success?: boolean;
            browserId?: string;
            qrSvg?: string;
            error?: string;
          };
          if (!pairing?.success || !pairing.browserId || !pairing.qrSvg) {
            throw new Error(pairing?.error || 'Authorization pairing failed');
          }
          browserId = pairing.browserId;
          if (cancelledAuth.has(requestId)) return;
          authSessions.set(requestId, browserId);
          reply('APP_BRIDGE_AUTH_CODE_PAIRING', { qrSvg: pairing.qrSvg });
          const result = (await chrome.runtime.sendMessage({
            action: 'appBridgeAuthCodeWait',
            browserId,
            requestId,
            params: msg.payload,
          })) as { success?: boolean; response?: unknown; error?: string };
          if (!cancelledAuth.has(requestId)) reply('APP_BRIDGE_AUTH_CODE_RESPONSE', result);
        } catch (error) {
          if (!cancelledAuth.has(requestId))
            reply('APP_BRIDGE_AUTH_CODE_RESPONSE', {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
        } finally {
          authSessions.delete(requestId);
          cancelledAuth.delete(requestId);
          pendingAuthRequests.delete(requestId);
          if (browserId)
            void chrome.runtime
              .sendMessage({ action: 'appBridgeAuthCodeClose', browserId })
              .catch(() => {});
        }
      };
      void run();
      return;
    }
    if (msg.type === 'prepareWebView') {
      chrome.runtime
        .sendMessage({ action: 'appBridgePrepareWebView' })
        .then(result => reply('APP_BRIDGE_PREPARE_WEBVIEW_RESPONSE', result))
        .catch((error: unknown) => {
          reply('APP_BRIDGE_PREPARE_WEBVIEW_RESPONSE', {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    if (msg.type === 'userInfo') {
      chrome.runtime
        .sendMessage({ action: 'appBridgeUserInfo' })
        .then(result => reply('APP_BRIDGE_USER_INFO_RESPONSE', result))
        .catch((error: unknown) => {
          reply('APP_BRIDGE_USER_INFO_RESPONSE', {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    if (msg.type === 'screenshot') {
      chrome.runtime
        .sendMessage({ action: 'appBridgeScreenshot' })
        .then(result => reply('APP_BRIDGE_SCREENSHOT_RESPONSE', result))
        .catch((error: unknown) => {
          reply('APP_BRIDGE_SCREENSHOT_RESPONSE', {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    const payload = msg.payload || {};
    const forwardedPayload = payload;
    if (msg.type === 'protocolStream') {
      pendingStreams.add(requestId);
      chrome.runtime
        .sendMessage({
          action: 'appBridgeProtocolStream',
          requestId,
          payload: forwardedPayload,
        })
        .then((result: { success?: boolean; error?: unknown } | undefined) => {
          if (!result?.success && pendingStreams.has(requestId)) {
            relayStreamEvent(requestId, 'onError', {
              error: result?.error ?? 'protocol stream delegate failed',
            });
          }
        })
        .catch((error: unknown) => {
          if (!pendingStreams.has(requestId)) return;
          relayStreamEvent(requestId, 'onError', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }
    chrome.runtime
      .sendMessage({
        action: 'appBridgeProtocol',
        payload: forwardedPayload,
      })
      .then(result => reply('APP_BRIDGE_PROTOCOL_RESPONSE', result))
      .catch((error: unknown) => {
        reply('APP_BRIDGE_PROTOCOL_RESPONSE', {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });
  return true;
}
