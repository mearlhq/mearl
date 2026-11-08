export const BROWSER_CONTROL_GET_ACTION = 'browserControlGet';
export const BROWSER_CONTROL_SET_ACTION = 'browserControlSet';
export const BROWSER_CONTROL_CLEAR_ACTION = 'browserControlClear';
export const NETWORK_CONTROL_STORAGE_PREFIX = 'networkControlV1:';
export const NETWORK_ROUTES_SERVER_TIMING_KEY = 'mearl-network-routes';
export const networkControlStorageKey = (tabId: number) => NETWORK_CONTROL_STORAGE_PREFIX + tabId;
export interface BrowserControlResponse { success: boolean; value?: string; error?: string }
