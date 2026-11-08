import type { InjectedAppProfileConfig } from '@mearl/browser-core';

export interface AppProfileDocumentEnvironmentOptions {
  /** Some hosts prepare globals before the separately installed page runtime. */
  globals: 'always' | 'runtime';
  safeAreaVariables?: boolean;
  restoreHintName?: string;
}

/** Self-contained MAIN-world bootstrap; hosts own script registration and removal. */
export function installAppProfileDocumentEnvironment(
  config: InjectedAppProfileConfig,
  options: AppProfileDocumentEnvironmentOptions,
): void {
  const browser = globalThis;
  const target = browser as unknown as Record<string, unknown>;
  if (options.restoreHintName) {
    try {
      Object.defineProperty(target, options.restoreHintName, {
        configurable: true, enumerable: false, writable: false, value: true,
      });
    } catch { target[options.restoreHintName] = true; }
  }
  const includeGlobals = options.globals === 'always' || Boolean(config.pageRuntime);
  for (const [key, value] of Object.entries(includeGlobals ? config.globals : {})) {
    try { target[key] = value; } catch { /* Frozen page globals keep their original values. */ }
  }
  const insets = config.safeAreaInsets ?? { top: config.statusBarHeight, right: 0, bottom: 0, left: 0 };
  if (includeGlobals) {
    target.__STATUS_BAR_HEIGHT__ = config.statusBarHeight;
    target.__SAFE_AREA_INSET_BOTTOM__ = insets.bottom;
  }
  for (const [key, value] of [
    ['userAgent', config.userAgent],
    ['platform', config.navigatorPlatform],
    ...(includeGlobals ? [['vendor', 'Apple Computer, Inc.']] : []),
    ['appVersion', config.userAgent.replace(/^Mozilla\//, '')],
    ['maxTouchPoints', config.maxTouchPoints],
    ...(includeGlobals && config.policies?.navigatorLanguage === true ? [['language', config.language]] : []),
  ] as Array<[string, string | number]>) {
    try { Object.defineProperty(browser.navigator, key, { configurable: true, get: () => value }); }
    catch { /* Non-configurable native properties keep their original values. */ }
  }
  if (includeGlobals && config.policies?.navigatorLanguage === true) {
    try { Object.defineProperty(browser.navigator, 'languages', { configurable: true, get: () => [config.language] }); }
    catch { /* Non-configurable native properties keep their original values. */ }
  }
  if (options.safeAreaVariables) {
    const apply = (): boolean => {
      const root = browser.document.documentElement;
      if (!root) return false;
      root.style.setProperty('--safe-area-inset-top', `${insets.top}px`);
      root.style.setProperty('--safe-area-inset-right', `${insets.right}px`);
      root.style.setProperty('--safe-area-inset-bottom', `${insets.bottom}px`);
      root.style.setProperty('--safe-area-inset-left', `${insets.left}px`);
      return true;
    };
    if (!apply()) {
      const observer = new browser.MutationObserver(() => { if (apply()) observer.disconnect(); });
      observer.observe(browser.document, { childList: true });
    }
  }
}

/** Self-contained document-start scheduling, including App containers that need a body. */
export function installAppProfileWhenDocumentReady(install: () => void, waitForBody = false): void {
  const browser = globalThis;
  const ready = () => Boolean(browser.document.documentElement && (!waitForBody || browser.document.body));
  if (ready()) { install(); return; }
  const observer = new browser.MutationObserver(() => {
    if (!ready()) return;
    observer.disconnect();
    install();
  });
  observer.observe(browser.document, { childList: true, subtree: waitForBody });
}
