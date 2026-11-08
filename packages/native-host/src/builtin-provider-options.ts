import type { CookieCopyScope } from '@mearl/browser-core';

/** Launch values understood by the built-in local Provider. */
export interface BuiltinBrowserLaunchOptions {
  name?: string;
  headless?: boolean;
  userAgentMode?: 'default' | 'desktop';
  persistent?: boolean;
  executablePath?: string;
  url?: string;
  copyCookieDomains?: string[] | string | CookieCopyScope;
}
