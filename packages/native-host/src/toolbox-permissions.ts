import {
  browserActionResponseError,
  DOMAIN_PERMISSION_ACTION_TIMEOUT_MS,
  DomainPermissionError,
} from '@mearl/browser-core';

type ExtensionInvoker = (
  action: string,
  data: any,
  timeoutMs: number,
  trustedInternal?: boolean,
) => Promise<any>;

const pendingPermissions = new Map<string, Promise<boolean>>();

export function extensionResponseError(message: { error?: string; errorDetails?: unknown }): Error {
  return browserActionResponseError(message, 'Unknown error from extension');
}

/** Toolbox commands share one decision per domain; simultaneous commands share the open dialog. */
export function createToolboxExtensionInvoker(send: ExtensionInvoker): ExtensionInvoker {
  const decisions = new Map<string, Promise<boolean>>();
  const permission = (domain: string) => {
    let decision = decisions.get(domain);
    if (!decision) {
      decision = pendingPermissions.get(domain);
      if (!decision) {
        decision = send('request_permission', { domain }, DOMAIN_PERMISSION_ACTION_TIMEOUT_MS)
          .then(result => result?.granted === true)
          .finally(() => pendingPermissions.delete(domain));
        pendingPermissions.set(domain, decision);
      }
      decisions.set(domain, decision);
    }
    return decision;
  };

  return async (action, data, timeoutMs, trustedInternal) => {
    try {
      return await send(action, data, timeoutMs, trustedInternal);
    } catch (error) {
      // Only attachment resolution is an interactive page preflight. Existing-instance
      // traffic also serves heartbeats and background events and cannot open dialogs.
      // A compound action may have completed earlier steps and must not be replayed.
      if (
        !(error instanceof DomainPermissionError) ||
        error.action !== action ||
        action === 'run_actions' ||
        (action === 'page_runtime' && data?.operation !== 'resolve')
      )
        throw error;
      let granted: boolean;
      try {
        granted = await permission(error.domain);
      } catch (permissionError) {
        throw new DomainPermissionError(
          action,
          error.domain,
          permissionError instanceof Error ? permissionError.message : String(permissionError),
        );
      }
      if (!granted)
        throw new DomainPermissionError(
          action,
          error.domain,
          `Access to "${error.domain}" was not granted. Retry the operation to request permission again.`,
        );
      return send(action, data, timeoutMs, trustedInternal);
    }
  };
}
