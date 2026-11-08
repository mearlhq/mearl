import { BundleError, readBundleJson, type PreparedBundle } from './bundle.js';
import { validateBrowserUiText, type BrowserUiText } from './requestUi.js';
import { parseNetworkRoutePlan, type NetworkRoutePlan } from './networkRoutes.js';

export interface BrowserSegmentedControl {
  schemaVersion: 1;
  id: string;
  kind: 'segmented';
  label: BrowserUiText;
  description: BrowserUiText;
  defaultValue: string;
  aliases?: string[];
  messages: { changed: BrowserUiText; failed: BrowserUiText };
  options: Array<{ value: string; label: BrowserUiText; networkRoutes: NetworkRoutePlan }>;
}
export interface SelectedBrowserControl {
  bundleId: string;
  revision: string;
  definition: BrowserSegmentedControl;
}
const id = /^[a-z][a-zA-Z0-9_.-]{0,79}$/;
function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) throw new BundleError('BUNDLE_INVALID', 'Invalid browser control');
}
export function validateBrowserControl(input: unknown): BrowserSegmentedControl {
  fields(input, ['schemaVersion', 'id', 'kind', 'label', 'description', 'defaultValue', 'aliases', 'messages', 'options']);
  if (input.schemaVersion !== 1 || input.kind !== 'segmented' || typeof input.id !== 'string' || !id.test(input.id) || typeof input.defaultValue !== 'string' || !id.test(input.defaultValue)) throw new BundleError('BUNDLE_INVALID', 'Invalid segmented control');
  validateBrowserUiText(input.label); validateBrowserUiText(input.description);
  fields(input.messages, ['changed', 'failed']);
  validateBrowserUiText(input.messages.changed); validateBrowserUiText(input.messages.failed);
  if (input.aliases !== undefined && (!Array.isArray(input.aliases) || input.aliases.length > 8 || new Set(input.aliases).size !== input.aliases.length || input.aliases.some(alias => typeof alias !== 'string' || !id.test(alias)))) throw new BundleError('BUNDLE_INVALID', 'Invalid browser control aliases');
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 8) throw new BundleError('BUNDLE_INVALID', 'Invalid browser control options');
  const values = new Set<string>();
  const options = input.options.map(option => {
    fields(option, ['value', 'label', 'networkRoutes']);
    if (typeof option.value !== 'string' || !id.test(option.value) || values.has(option.value)) throw new BundleError('BUNDLE_INVALID', 'Invalid browser control option');
    values.add(option.value); validateBrowserUiText(option.label);
    try { return { value: option.value, label: structuredClone(option.label) as unknown as BrowserUiText, networkRoutes: parseNetworkRoutePlan(option.networkRoutes) }; }
    catch { throw new BundleError('BUNDLE_INVALID', 'Invalid control network route plan'); }
  });
  if (!values.has(input.defaultValue) || options.find(option => option.value === input.defaultValue)!.networkRoutes.routes.length) throw new BundleError('BUNDLE_INVALID', 'The default option must clear network routes');
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 65536) throw new BundleError('BUNDLE_QUOTA', 'Browser control exceeds 64 KiB');
  return { schemaVersion: 1, id: input.id, kind: 'segmented', label: structuredClone(input.label) as unknown as BrowserUiText, description: structuredClone(input.description) as unknown as BrowserUiText, defaultValue: input.defaultValue, messages: structuredClone(input.messages) as unknown as BrowserSegmentedControl['messages'], options, ...(input.aliases ? { aliases: [...input.aliases as string[]] } : {}) };
}

/** The network-route surface has one owner, so competing packages cannot silently overwrite it. */
export function selectBrowserControl(bundles: PreparedBundle[]): SelectedBrowserControl | undefined {
  let selected: SelectedBrowserControl | undefined;
  for (const bundle of bundles) {
    const resource = bundle.manifest.contributions?.browserControls;
    if (!resource) continue;
    if (selected) throw new BundleError('BUNDLE_CONFLICT', 'Browser network control has multiple providers');
    selected = { bundleId: bundle.manifest.id, revision: bundle.revision, definition: validateBrowserControl(readBundleJson(bundle, resource)) };
  }
  return selected;
}
