import { hasRequestConditions } from './mockConditions';

/** Names are supplied by the background inspector; page text never becomes a matcher. */
export function findSseOverride<T extends { apiName: string; url?: string; conditions?: Record<string, unknown> }>(
  overrides: T[], input: { url: string; apiName?: string | null },
): T | undefined {
  if (input.apiName) {
    const named = overrides.find(item => item.apiName === input.apiName && !hasRequestConditions(item.conditions))
      ?? overrides.find(item => item.apiName === input.apiName);
    if (named) return named;
  }
  if (typeof input.url !== 'string') return;
  const path = input.url.split('?')[0];
  return overrides.find(item => item.url && item.url.split('?')[0] === path);
}
