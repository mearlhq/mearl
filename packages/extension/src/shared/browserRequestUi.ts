export const BROWSER_REQUEST_UI_ACTION = 'browserRequestUi';
export const BROWSER_REQUEST_UI_CHANGED = 'browserRequestUiChanged';
export const BROWSER_REQUEST_LOGIN_PORT = 'browser-request-login:';
export const BROWSER_REQUEST_LOGIN_RULE_START = 1_000_000;
export const BROWSER_REQUEST_LOGIN_RULE_END = 1_000_127;
export function isBrowserRequestLoginRule(id: number) {
  return id >= BROWSER_REQUEST_LOGIN_RULE_START && id <= BROWSER_REQUEST_LOGIN_RULE_END;
}
