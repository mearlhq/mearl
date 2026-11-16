export const PERMISSION_REQUEST_PAGE = 'src/pages/permission-request/index.html';
export const PRESET_PERMISSION_REVISION_PARAM = 'presetRevision';
export const SIMULATION_PERMISSION_PARAM = 'simulationRequest';
export const SIMULATION_PERMISSION_ACTION = 'simulationSitePermission';
export const POPUP_PERMISSION_REQUEST = 'popup_permission_request';
export const POPUP_PERMISSION_CANCEL = 'popup_permission_cancel';
export const POPUP_PERMISSION_ALLOW = 'popup_permission_allow';
export const PERMISSION_REQUEST_TIMEOUT_MS = 90_000;

export interface DomainPermissionDecision {
  granted: boolean;
  origin?: string;
  error?: string;
}

export function getSimulationSitePattern(url: URL): string | undefined {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  return `${url.protocol}//${url.hostname}/*`;
}

export function getSimulationSiteUrl(rawUrl: string): URL | undefined {
  try {
    const url = new URL(rawUrl);
    if (getSimulationSitePattern(url)) return url;
  } catch {
    return undefined;
  }
}
