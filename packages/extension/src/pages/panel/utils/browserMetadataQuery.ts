import type { BrowserUiSettings } from '../../../shared/browserUiSettings';
import { callBrowserUiOperation, getBrowserUiSettings } from './browserUiSettings';

export type BrowserMetadataResult = { status: 'success'; name: string; type?: string } | { status: 'unknown' };
const caches = new WeakMap<BrowserUiSettings, Map<string, BrowserMetadataResult>>();
function cacheFor(settings: BrowserUiSettings) {
  let cache = caches.get(settings);
  if (!cache) { cache = new Map(); caches.set(settings, cache); }
  return cache;
}
function key(name: string, value: string) { return JSON.stringify([name, value]); }
export function getCachedBrowserMetadata(settings: BrowserUiSettings, name: string, value: string) {
  return cacheFor(settings).get(key(name, value)) ?? null;
}
/** Cache only completed business results, scoped to the rendered capability selection. */
export async function queryBrowserMetadata(settings: BrowserUiSettings, name: string, input: { value: string; userId?: string }): Promise<BrowserMetadataResult> {
  if (getBrowserUiSettings() !== settings) throw new Error('Browser UI selection changed');
  const value = await callBrowserUiOperation<unknown>(name, input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid metadata result');
  const result = value as Record<string, unknown>;
  let accepted: BrowserMetadataResult;
  if (result.status === 'unknown') accepted = { status: 'unknown' };
  else if (result.status === 'success' && typeof result.name === 'string' && result.name.trim() && (result.type === undefined || typeof result.type === 'string')) accepted = { status: 'success', name: result.name, ...(typeof result.type === 'string' ? { type: result.type } : {}) };
  else throw new Error('Invalid metadata result');
  if (getBrowserUiSettings() === settings) cacheFor(settings).set(key(name, input.value), accepted);
  return accepted;
}
