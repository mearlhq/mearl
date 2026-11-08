import type { InjectedAppProfileConfig } from './app-profile-runtime/types.js';
export type * from './app-profile-runtime/types.js';
export { installRootWebViewDocumentTransport } from './rootWebViewDocument.js';

/** Self-contained UA installer for the basic built-in profiles. */
export function installAppProfileRuntime(config: InjectedAppProfileConfig): void {
  if (config.pageRuntime) throw new Error('The host must prepare the bound page runtime');
  if (typeof config.profile === 'string') Object.defineProperty(globalThis, '__mearlAppProfile__', { configurable: true, value: config.profile });
  const values = { userAgent: config.userAgent, appVersion: config.userAgent.replace(/^Mozilla\//, ''), platform: config.navigatorPlatform, maxTouchPoints: config.maxTouchPoints };
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) Object.defineProperty(navigator, name, { configurable: true, get: () => value });
  }
}

/** The host resolves capability code before generating scripts for profiles with a runtime binding. */
export function buildAppProfileRuntimeCallSource(configExpression: string): string {
  return `(${installAppProfileRuntime.toString()})(${configExpression});`;
}
