export const POPUP_PERMISSION_REQUEST = 'popup_permission_request';
export const POPUP_PERMISSION_CANCEL = 'popup_permission_cancel';
export const POPUP_PERMISSION_ALLOW = 'popup_permission_allow';
export const PERMISSION_REQUEST_TIMEOUT_MS = 90_000;

export interface DomainPermissionDecision {
  granted: boolean;
  origin?: string;
  error?: string;
}
