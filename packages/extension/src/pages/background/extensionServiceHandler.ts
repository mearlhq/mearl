import {
  getExtensionServiceTimeout,
  extensionRpcErrorCode,
  isExtensionUiServiceAction,
  type ExtensionUiServiceAction,
} from '@mearl/browser-core';
import { isExtensionUiSender } from './extensionMessageTrust';
import { t } from '../panel/utils/i18n';

export async function handleExtensionServiceRequest(
  message: { action: unknown; data?: Record<string, unknown> },
  sender: Pick<chrome.runtime.MessageSender, 'id' | 'url'>,
  dependencies: {
    extensionId: string;
    ready: Promise<unknown>;
    request: (
      action: ExtensionUiServiceAction,
      data: Record<string, unknown>,
      timeoutMs: number,
    ) => Promise<unknown>;
  },
) {
  if (!isExtensionUiSender(sender, dependencies.extensionId)) {
    return {
      success: false,
      code: 'EXTENSION_UI_REQUIRED',
      error: t('extensionUiServiceRequired'),
    };
  }
  if (!isExtensionUiServiceAction(message.action)) {
    return {
      success: false,
      code: 'UNSUPPORTED_ACTION',
      error: 'Unsupported extension service action',
    };
  }
  try {
    await dependencies.ready;
    const data = await dependencies.request(
      message.action,
      message.data ?? {},
      getExtensionServiceTimeout(message.action, message.data),
    );
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      code: extensionRpcErrorCode(error),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
