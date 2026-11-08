import { getExtensionVersion } from './extensionVersion';
import {
  ExtensionRpcError,
  extensionRpcErrorCode,
  type ExtensionUiServiceAction,
  type ExtensionUiServiceRequest,
  type ExtensionUiServiceResponse,
} from '@mearl/browser-core';
import { t } from '../pages/panel/utils/i18n';
import type { NativeHostUpdateInfo } from '../pages/panel/components/NativeHostUpdateGuide';

export async function requestExtensionService<
  A extends ExtensionUiServiceAction,
  R extends ExtensionUiServiceRequest<A> = ExtensionUiServiceRequest<A>,
>(
  action: A,
  ...args: undefined extends ExtensionUiServiceRequest<A> ? [data?: R] : [data: R]
): Promise<ExtensionUiServiceResponse<A, R>> {
  const data = args[0] ?? {};
  const response = await chrome.runtime.sendMessage({ action, data });
  if (!response?.success) {
    const code = extensionRpcErrorCode(response);
    const message =
      code === 'PROTOCOL_MISMATCH'
        ? t('nativeHostProtocolMismatch')
        : response?.error || 'Native host service failed';
    throw code ? new ExtensionRpcError(code, message) : new Error(message);
  }
  return response.data;
}

export async function nativeHostServiceUpdateInfo(
  cause: unknown,
): Promise<NativeHostUpdateInfo | null> {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getAgentStatus' });
    const status = response?.success ? response.status : null;
    const code = extensionRpcErrorCode(cause);
    const reason =
      status?.connected === false
        ? 'not-connected'
        : code === 'PROTOCOL_MISMATCH' ||
            code === 'UNSUPPORTED_ACTION' ||
            status?.nativeRpcCompatible === false
          ? 'unsupported-capability'
          : null;
    if (!reason) return null;
    return {
      extensionVersion: status?.extensionVersion || getExtensionVersion(),
      nativeHostVersion: status?.nativeHostVersion || null,
      reason,
    };
  } catch {
    return null;
  }
}
