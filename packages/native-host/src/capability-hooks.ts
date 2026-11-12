import type { RequestCookie, AppProfileDefinition } from '@mearl/browser-core';
import type { AgentProvider } from '@mearl/agent-runtime';
import type { BrowserSegmentedControl, PageRuntimeBinding } from '@mearl/preset/bundles';
import type { RequestProtocolCapability, TrackingCapability } from './capability-contracts.js';
import type { AgentSkillBackend } from './agent/skill-manager.js';
import type {
  SandboxBrowserAccessCapability,
  ResolvedSandboxBrowserAccess,
} from './sandbox-browser-access.js';
import type { CookieCopyPlan } from './browser-cookie-copy.js';
import type { BuiltinBrowserLaunchOptions } from './builtin-provider-options.js';

export interface AppCapabilityCatalog {
  namespace: string;
  profiles: AppProfileDefinition[];
  bindings: Record<string, string>;
  order?: string[];
}
export type AgentCapabilityFactory = (options: {
  log(message: string): void;
  version: string;
}) => AgentProvider | Promise<AgentProvider>;

/** Host-owned contracts are defined once; providers implement these contracts. */
export interface NativeCapabilityHooks {
  'request.protocol': () => RequestProtocolCapability;
  'tracking.request': () => TrackingCapability;
  'request.inspect': (input: { url: string; body?: string }) => unknown;
  'app.profileCatalog': () => AppCapabilityCatalog;
  'app.pageRuntime': (binding: PageRuntimeBinding) => string | undefined;
  'app.defaultPageRuntime': () => PageRuntimeBinding;
  'app.userInfo': (url: string, cookies: RequestCookie[]) => { userId?: string; userName?: string };
  'browser.control': () => BrowserSegmentedControl;
  'browser.access.capability': () => SandboxBrowserAccessCapability | null;
  'browser.access.resolve': () => Promise<ResolvedSandboxBrowserAccess>;
  'cookie.copyPlan': (input: BuiltinBrowserLaunchOptions['copyCookieDomains']) => CookieCopyPlan;
  'plugins.catalog': () => unknown;
  'skills.manager': () => AgentSkillBackend | undefined;
  'analytics.endpoint': () => string;
  [hook: `agent.provider.${string}`]: AgentCapabilityFactory;
}
