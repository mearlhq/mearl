import { resolveJsonRefs } from '../../utils/jsonRefResolver';

export interface NormalizedMockEntry {
  apiName: string;
  responseData: unknown;
}

export type NormalizeResult =
  | { ok: true; entry: NormalizedMockEntry }
  | { ok: false; reason: 'notObject' | 'missingApi' };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

/** Import a named response without adding a protocol envelope or converting server fields. */
export function normalizeImportItem(item: unknown, fallbackApi: string): NormalizeResult {
  if (!isPlainObject(item)) return { ok: false, reason: 'notObject' };
  const apiName = typeof item.api === 'string' && item.api.trim() ? item.api.trim() : fallbackApi.trim();
  if (!apiName) return { ok: false, reason: 'missingApi' };
  return { ok: true, entry: { apiName, responseData: resolveJsonRefs(item) } };
}

export async function normalizeInstalledImportItem(item: unknown, fallbackApi: string): Promise<NormalizeResult> {
  const response = await chrome.runtime.sendMessage({ action: 'requestInspection', data: { operation: 'import', input: { item: resolveJsonRefs(item), fallbackApi } } });
  if (response?.success === false) throw new Error(response.error || 'Import normalizer unavailable');
  if (response?.data == null) return normalizeImportItem(item, fallbackApi);
  const value = response.data;
  if (value.ok === false && ['notObject', 'missingApi'].includes(value.reason) || value.ok === true && typeof value.entry?.apiName === 'string' && Object.hasOwn(value.entry, 'responseData')) return value;
  throw new Error('Invalid import normalizer result');
}
