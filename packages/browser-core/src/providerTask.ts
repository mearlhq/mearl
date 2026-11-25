import type { BrowserDetails, BrowserProviderObjectSchema } from './browserActionProtocol.js';

export const PROVIDER_TASK_SESSION_VERSION = 1;

/** The host injects this reserved launch parameter when creating a Provider task. */
export function declaresProviderTaskSessions(schema: BrowserProviderObjectSchema): boolean {
  const field = schema.properties.taskSession;
  return field?.type === 'object' && field.formHidden === true;
}

/** Operations whose page inputs and outputs can be kept on the same execution route. */
export const PROVIDER_TASK_EXTENSION_ACTIONS = [
  'page_navigate',
  'page_snapshot',
  'page_eval',
  'page_click',
  'page_type',
  'page_press',
  'page_scroll',
  'page_hover',
  'page_wait',
  'page_frames',
  'page_screenshot',
  'set_timezone',
  'set_device_emulation',
  'set_app_profile',
  'tab_checkpoint',
  'get_requests',
  'get_logs',
] as const;

export type ProviderTaskExtensionAction = (typeof PROVIDER_TASK_EXTENSION_ACTIONS)[number];
export function isProviderTaskExtensionAction(
  action: string,
): action is ProviderTaskExtensionAction {
  return (PROVIDER_TASK_EXTENSION_ACTIONS as readonly string[]).includes(action);
}
/** Task handles are addressed by session ID. Each ordinary browser route remains selectable. */
export function isDiscoverableBrowser(browser: { details?: BrowserDetails }): boolean {
  return browser.details?.taskSessionScope !== 'session';
}
