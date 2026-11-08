import type { BrowserListParams } from './browserActionProtocol.js';

/** An empty request retains ordinary discovery; partial or unknown options cannot be ignored. */
export function parseBrowserListParams(value: unknown): BrowserListParams | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser_list request');
  const keys = Object.keys(value);
  if (!keys.length) return undefined;
  const params = value as BrowserListParams;
  const form = params.launchForm;
  if (keys.some(key => key !== 'provider' && key !== 'launchForm') ||
    typeof params.provider !== 'string' || !params.provider.trim() ||
    !form || typeof form !== 'object' || Array.isArray(form) ||
    Object.keys(form).some(key => key !== 'variant' && key !== 'values') ||
    (form.variant !== undefined && typeof form.variant !== 'string') ||
    !form.values || typeof form.values !== 'object' || Array.isArray(form.values))
    throw new Error('browser_list discovery requires provider and launchForm with values');
  return params;
}
