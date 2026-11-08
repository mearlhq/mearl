import type { InjectedAppProfileConfig } from '@mearl/browser-core/appProfileRuntime';

declare global {
  interface Window {
    __mearlInstallAppProfileRuntime__: (config: InjectedAppProfileConfig) => void;
  }
}

export const APP_PROFILE_RUNTIME_ASSET = 'src/pages/content-script/app-profile-runtime.js';
export const APP_PROFILE_RUNTIME_INSTALLER = '__mearlInstallAppProfileRuntime__';
export const EARLY_CONTENT_SCRIPT_FILES = [
  APP_PROFILE_RUNTIME_ASSET,
  'src/pages/content-script/early-inject.js',
];
