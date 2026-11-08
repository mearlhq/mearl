import type { BrowserUiText } from '@mearl/preset/bundles';
import { browserUiMessages } from './browserRulePresets';

/** Presentation data only; activation still resolves the current installed implementation. */
export interface AppProfileMenuEntry {
  id: string;
  label: string;
  available?: boolean;
  definition?: { labels?: BrowserUiText };
}

export function parseAppProfileMenu(input: unknown): AppProfileMenuEntry[] {
  if (!Array.isArray(input)) throw new Error('Invalid App profile menu');
  const ids = new Set<string>();
  return input.map(entry => {
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || typeof entry.label !== 'string' || entry.available !== undefined && typeof entry.available !== 'boolean') throw new Error('Invalid App profile menu entry');
    ids.add(entry.id);
    const labels = entry.definition?.labels === undefined ? undefined : browserUiMessages({ label: entry.definition.labels }).label;
    return { id: entry.id, label: entry.label, ...(entry.available !== undefined ? { available: entry.available } : {}), ...(labels ? { definition: { labels: { ...labels } } } : {}) };
  });
}
