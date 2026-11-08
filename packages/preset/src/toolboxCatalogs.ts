import { isJsonObject, PresetError } from './manifest.js';

export interface ToolboxCatalogConfig { url?: string; label?: string; enabled?: boolean }
export type ToolboxCatalogConfigs = Record<string, ToolboxCatalogConfig>;

/** Stable keys let child presets patch or disable a parent directory through defaults merging. */
export function parseToolboxCatalogs(input: unknown): ToolboxCatalogConfigs {
  if (input === undefined) return {};
  function invalid(): never { throw new PresetError('PRESET_INVALID', 'Invalid extension.toolCatalogs configuration'); }
  if (!isJsonObject(input) || Object.keys(input).length > 16) invalid();
  return Object.fromEntries(Object.entries(input).map(([id, entry]) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || id === 'official' || !isJsonObject(entry) || Object.keys(entry).some(key => !['url', 'label', 'enabled'].includes(key))) invalid();
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') invalid();
    if (entry.label !== undefined && (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 120)) invalid();
    let url: string | undefined;
    if (entry.url !== undefined) {
      if (typeof entry.url !== 'string' || entry.url.length > 2048) invalid();
      try {
        const parsed = new URL(entry.url);
        if (parsed.username || parsed.password || parsed.hash || !(parsed.protocol === 'https:' || parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) invalid();
        url = parsed.href;
      } catch { invalid(); }
    } else if (entry.enabled !== false) invalid();
    return [id, { ...(url ? { url } : {}), ...(entry.label !== undefined ? { label: entry.label as string } : {}), ...(entry.enabled !== undefined ? { enabled: entry.enabled as boolean } : {}) }];
  }));
}
