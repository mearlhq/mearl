// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenAppBridgeRelay } from '../appBridgeRelay';

describe('App Bridge 中转', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('将 Example Device 配对和真机授权结果按请求 ID 回传', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { serverTiming: [{ name: 'mearl-app-profile' }] },
    ] as unknown as PerformanceEntryList);
    let resolvePairing: (value: unknown) => void = () => {};
    const pairingResult = new Promise(resolve => {
      resolvePairing = resolve;
    });
    let resolveAuth: (value: unknown) => void = () => {};
    const authResult = new Promise(resolve => {
      resolveAuth = resolve;
    });
    let runtimeListener: ((message: Record<string, unknown>) => void) | undefined;
    const sendMessage = vi
      .fn()
      .mockReturnValueOnce(pairingResult)
      .mockReturnValueOnce(authResult)
      .mockResolvedValueOnce({ success: true });
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: vi.fn((listener: (message: Record<string, unknown>) => void) => {
            runtimeListener = listener;
          }),
        },
      },
    });
    const post = vi.spyOn(window, 'postMessage');
    expect(listenAppBridgeRelay()).toBe(true);
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          source: 'mearl-app-bridge',
          type: 'authCode',
          requestId: 41,
          payload: { appId: '2021006132602053', scopeNicks: ['auth_user'] },
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          source: 'mearl-app-bridge',
          type: 'authCode',
          requestId: 41,
          payload: { appId: '2021006132602053', scopeNicks: ['auth_user'] },
        },
      }),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    runtimeListener?.({ action: 'appBridgeAuthCodeProgress', requestId: 41, phase: 'installing' });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'APP_BRIDGE_AUTH_CODE_PROGRESS',
        requestId: 41,
        phase: 'installing',
      }),
      '*',
    );
    resolvePairing({ success: true, browserId: 'example-device-1', qrSvg: '<svg/>' });
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        action: 'appBridgeAuthCodeWait',
        browserId: 'example-device-1',
        requestId: 41,
        params: { appId: '2021006132602053', scopeNicks: ['auth_user'] },
      }),
    );
    runtimeListener?.({ action: 'appBridgeAuthCodeProgress', requestId: 41, phase: 'connected' });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'APP_BRIDGE_AUTH_CODE_PROGRESS',
        requestId: 41,
        phase: 'connected',
      }),
      '*',
    );
    resolveAuth({ success: true, response: { authcode: 'code-1' } });
    await vi.waitFor(() =>
      expect(
        post.mock.calls
          .map(([value]) => value)
          .filter((value): value is Record<string, unknown> =>
            Boolean(value && typeof value === 'object'),
          ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'APP_BRIDGE_AUTH_CODE_PAIRING', requestId: 41 }),
          expect.objectContaining({
            type: 'APP_BRIDGE_AUTH_CODE_RESPONSE',
            requestId: 41,
            result: { success: true, response: { authcode: 'code-1' } },
          }),
        ]),
      ),
    );
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'appBridgeAuthCodeWait',
      browserId: 'example-device-1',
      requestId: 41,
      params: { appId: '2021006132602053', scopeNicks: ['auth_user'] },
    });
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'appBridgeAuthCodeStart',
      requestId: 41,
      params: { appId: '2021006132602053', scopeNicks: ['auth_user'] },
    });
  });

  it('完整转发图片上传需要的请求方法、环境与超时', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { serverTiming: [{ name: 'mearl-app-profile' }] },
    ] as unknown as PerformanceEntryList);
    const sendMessage = vi.fn().mockResolvedValue({ success: true, response: {} });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });

    expect(listenAppBridgeRelay()).toBe(true);
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          source: 'mearl-app-bridge',
          type: 'protocol',
          requestId: 7,
          payload: {
            api: 'sample.api.serverless.api.gateway',
            v: '2.0',
            data: { fcName: 'uploadByTokenUrl' },
            method: 'POST',
            env: 'pre',
            timeout: 60_000,
            customProtocolOption: { revision: 2 },
          },
        },
      }),
    );

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        action: 'appBridgeProtocol',
        payload: {
          api: 'sample.api.serverless.api.gateway',
          v: '2.0',
          data: { fcName: 'uploadByTokenUrl' },
          method: 'POST',
          env: 'pre',
          timeout: 60_000,
          customProtocolOption: { revision: 2 },
        },
      });
    });
  });

  it('转发 mtop_stream 并把分片和完成事件送回页面', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { serverTiming: [{ name: 'mearl-app-profile' }] },
    ] as unknown as PerformanceEntryList);
    const sendMessage = vi.fn().mockResolvedValue({ success: true });
    let runtimeListener: ((message: Record<string, unknown>) => void) | undefined;
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: vi.fn((listener: (message: Record<string, unknown>) => void) => {
            runtimeListener = listener;
          }),
        },
      },
    });
    const postMessage = vi.spyOn(window, 'postMessage');

    expect(listenAppBridgeRelay()).toBe(true);
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          source: 'mearl-app-bridge',
          type: 'protocolStream',
          requestId: 9,
          payload: {
            api: 'sample.api.ai.plan.chat',
            v: '1.0',
            data: { query: '杭州怎么玩' },
            method: 'POST',
            env: 'pre',
            timeout: 30_000,
            ttid: '201300@travel_h5_10.0.0',
          },
        },
      }),
    );

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        action: 'appBridgeProtocolStream',
        requestId: 9,
        payload: expect.objectContaining({
          api: 'sample.api.ai.plan.chat',
          v: '1.0',
          method: 'POST',
          env: 'pre',
          ttid: '201300@travel_h5_10.0.0',
        }),
      });
    });

    runtimeListener?.({
      action: 'appBridgeProtocolStreamEvent',
      requestId: 9,
      eventType: 'onReceive',
      data: { data: { text: '杭州' } },
    });
    runtimeListener?.({
      action: 'appBridgeProtocolStreamEvent',
      requestId: 9,
      eventType: 'onFinish',
      data: { data: { text: '杭州' } },
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'APP_BRIDGE_PROTOCOL_STREAM_EVENT',
        requestId: 9,
        eventType: 'onReceive',
      }),
      '*',
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'APP_BRIDGE_PROTOCOL_STREAM_EVENT',
        requestId: 9,
        eventType: 'onFinish',
      }),
      '*',
    );
  });

  it('转发 user_info 并把扩展后台的登录态送回页面', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { serverTiming: [{ name: 'mearl-app-profile' }] },
    ] as unknown as PerformanceEntryList);
    const sendMessage = vi.fn().mockResolvedValue({
      success: true,
      response: { userId: '123456', userName: '阅读器用户' },
    });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    const postMessage = vi.spyOn(window, 'postMessage');

    expect(listenAppBridgeRelay()).toBe(true);
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { source: 'mearl-app-bridge', type: 'userInfo', requestId: 11 },
      }),
    );

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({ action: 'appBridgeUserInfo' });
      expect(postMessage).toHaveBeenCalledWith(
        {
          source: 'mearl-content',
          type: 'APP_BRIDGE_USER_INFO_RESPONSE',
          requestId: 11,
          result: {
            success: true,
            response: { userId: '123456', userName: '阅读器用户' },
          },
        },
        '*',
      );
    });
  });

  it('新 WebView 导航前等待后台刷新安全区环境', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { serverTiming: [{ name: 'mearl-app-profile' }] },
    ] as unknown as PerformanceEntryList);
    const sendMessage = vi.fn().mockResolvedValue({ success: true });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    const postMessage = vi.spyOn(window, 'postMessage');

    expect(listenAppBridgeRelay()).toBe(true);
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { source: 'mearl-app-bridge', type: 'prepareWebView', requestId: 13 },
      }),
    );

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({ action: 'appBridgePrepareWebView' });
      expect(postMessage).toHaveBeenCalledWith(
        {
          source: 'mearl-content',
          type: 'APP_BRIDGE_PREPARE_WEBVIEW_RESPONSE',
          requestId: 13,
          result: { success: true },
        },
        '*',
      );
    });
  });

  it('把 iOS 胶囊的截图请求和结果在页面与后台间中转', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { serverTiming: [{ name: 'mearl-app-profile' }] },
    ] as unknown as PerformanceEntryList);
    const sendMessage = vi.fn().mockResolvedValue({
      success: true,
      meta: { format: 'png', width: 1179, height: 2556 },
      data: 'AQID',
    });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    });
    const postMessage = vi.spyOn(window, 'postMessage');

    expect(listenAppBridgeRelay()).toBe(true);
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { source: 'mearl-app-bridge', type: 'screenshot', requestId: 15 },
      }),
    );

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({ action: 'appBridgeScreenshot' });
      expect(postMessage).toHaveBeenCalledWith(
        {
          source: 'mearl-content',
          type: 'APP_BRIDGE_SCREENSHOT_RESPONSE',
          requestId: 15,
          result: {
            success: true,
            meta: { format: 'png', width: 1179, height: 2556 },
            data: 'AQID',
          },
        },
        '*',
      );
    });
  });
});
