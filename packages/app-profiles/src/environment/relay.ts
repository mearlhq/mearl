/** Self-contained MAIN-world transport; host services remain outside the page. */
export function installAppProfileMessageRelay(
  bindingName: string,
  options: { markerName?: string; supportedTypes?: readonly string[] } = {},
): void {
  const browser = globalThis as unknown as {
    addEventListener(
      type: string,
      listener: (event: { source: unknown; data: Record<string, unknown> | null }) => void,
    ): void;
    postMessage(message: unknown, targetOrigin: string): void;
    console?: { warn(...args: unknown[]): void };
  };
  const target = globalThis as unknown as Record<string, unknown>;
  const markerName = options.markerName ?? '__mearlCdpAppProfileRelayInstalled__';
  if (target[markerName]) return;
  target[markerName] = true;

  browser.addEventListener('message', event => {
    if (event.source !== globalThis) return;
    const message = event.data as Record<string, unknown> | null;
    if (!message || message.source !== 'mearl-app-bridge') return;
    const requestId = message.requestId;
    if (typeof requestId !== 'number') return;

    if (message.type === 'settings' && (globalThis as unknown as { top: unknown }).top !== globalThis) return;
    if (message.type === 'prepareWebView') {
      browser.postMessage(
        {
          source: 'mearl-content',
          type: 'APP_BRIDGE_PREPARE_WEBVIEW_RESPONSE',
          requestId,
          result: { success: true },
        },
        '*',
      );
      return;
    }
    if (
      message.type !== 'protocol' &&
      message.type !== 'protocolStream' &&
      message.type !== 'userInfo' &&
      message.type !== 'authCode' &&
      message.type !== 'authCodeCancel' &&
      message.type !== 'settings' &&
      message.type !== 'screenshot'
    ) {
      return;
    }
    const replyFailure = (reason: string) => {
      browser.console?.warn('[Mearl] App bridge relay unavailable:', reason);
      if (message.type === 'protocolStream') {
        browser.postMessage(
          {
            source: 'mearl-content',
            type: 'APP_BRIDGE_PROTOCOL_STREAM_EVENT',
            requestId,
            eventType: 'onError',
            data: { error: reason },
          },
          '*',
        );
        return;
      }
      const responseTypes: Record<string, string> = {
        protocol: 'APP_BRIDGE_PROTOCOL_RESPONSE',
        userInfo: 'APP_BRIDGE_USER_INFO_RESPONSE',
        authCode: 'APP_BRIDGE_AUTH_CODE_RESPONSE',
        screenshot: 'APP_BRIDGE_SCREENSHOT_RESPONSE',
        settings: 'APP_BRIDGE_SETTINGS_RESPONSE',
      };
      browser.postMessage(
        {
          source: 'mearl-content',
          type: responseTypes[String(message.type)],
          requestId,
          result: { success: false, error: reason },
        },
        '*',
      );
    };
    if (options.supportedTypes && !options.supportedTypes.includes(String(message.type))) {
      replyFailure('this App bridge operation is not supported by the selected backend');
      return;
    }
    const binding = target[bindingName];
    if (typeof binding !== 'function') {
      replyFailure('native relay binding is unavailable');
      return;
    }
    try {
      (binding as (payload: string) => void)(
        JSON.stringify({
          type: message.type,
          requestId,
          payload: message.payload,
        }),
      );
    } catch (error) {
      replyFailure(error instanceof Error ? error.message : 'native relay call failed');
    }
  });
}
