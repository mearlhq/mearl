import { BROWSER_COMMAND_ACTIONS } from '@mearl/browser-core/browserActionProtocol';

/** Method names and signature exceptions shared by script dispatch and command help. */
export const SDK_METHOD_ACTIONS = new Map(
  Object.keys(BROWSER_COMMAND_ACTIONS).map(action => [
    action.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    action,
  ]),
);
SDK_METHOD_ACTIONS.set('selectBrowser', 'browser_select_browser');
SDK_METHOD_ACTIONS.set('captureCheckpoint', 'tab_checkpoint');
export const SDK_OPTIONS_ONLY_METHODS = new Set(['browserList', 'tabList', 'getRules']);
