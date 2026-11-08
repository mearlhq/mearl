import type { JsonObject } from '@mearl/preset';

/** Host-facing identity fields; provider-specific claims stay opaque to the UI. */
export type CaptureIdentity = JsonObject & {
  subject: string;
  displayName?: string;
  complete: boolean;
};

export function parseCaptureIdentity(value: unknown): CaptureIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid capture identity');
  const input = value as Record<string, unknown>;
  if (typeof input.subject !== 'string' || typeof input.complete !== 'boolean' || input.displayName !== undefined && typeof input.displayName !== 'string') throw new Error('Invalid capture identity');
  return { ...input } as CaptureIdentity;
}
