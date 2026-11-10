/** Native Messaging management handshake; independent of Agent page access. */
export interface ExtensionAgentPolicy {
  revision: number;
  providerIds: string[];
  available?: boolean;
}

/** Internal file references grant payload trust, not permission to operate pages. */
export function requiresExtensionAgentAccess(
  action: string,
  data: any,
  trustedInternal = false,
): boolean {
  if (!trustedInternal) return true;
  if (!action.startsWith('__') && action !== 'get_browser_info') return true;
  if (action === '__capture_download' || action === '__export_cookies') return true;
  if (action === '__send_request_files') return data?.operation !== 'abort';
  if (action === '__browser_enhancement') return data?.operation !== 'release';
  return false;
}

export function isExtensionAgentPolicy(value: unknown): value is ExtensionAgentPolicy {
  const policy = value as ExtensionAgentPolicy | null;
  return (
    !!policy &&
    Number.isSafeInteger(policy.revision) &&
    policy.revision >= 0 &&
    (policy.available === undefined || typeof policy.available === 'boolean') &&
    Array.isArray(policy.providerIds) &&
    policy.providerIds.length <= 100 &&
    policy.providerIds.every(
      id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f]/.test(id),
    )
  );
}
