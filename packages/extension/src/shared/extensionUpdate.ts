export const BROWSER_EXTENSION_UPDATE_VERSION_KEY = 'mearl-browser-extension-update-version';
export const UPDATE_SETUP_EXTENSION_ACTION = 'updateSetupExtension';

export interface ExtensionUpdateResponse {
  error?: string;
  success: boolean;
  updated?: boolean;
  version?: string;
}
