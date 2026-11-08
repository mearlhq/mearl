import type { AgentChatEvent } from '@mearl/browser-core';

// Chrome accepts at most 1 MiB per native-host message. Keep Agent events well
// below that boundary so the surrounding response envelope also has headroom.
export const MAX_AGENT_EVENT_BYTES = 512 * 1024;
const EVENT_VALUE_BUDGET_BYTES = 400 * 1024;
const MAX_COLLECTION_ENTRIES = 160;
const MAX_DEPTH = 12;
const TRUNCATED_MARKER = '\n… [middle truncated for Native Messaging] …\n';

interface SanitizeBudget {
  remaining: number;
  truncated: boolean;
  seen: WeakSet<object>;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(TRUNCATED_MARKER, 'utf8');
  if (maxBytes <= markerBytes) return '';
  const source = Buffer.from(value, 'utf8');
  const contentBytes = maxBytes - markerBytes;
  let headBytes = Math.ceil(contentBytes / 2);
  let tailBytes = Math.floor(contentBytes / 2);
  do {
    const truncated = `${source.subarray(0, headBytes).toString('utf8')}${TRUNCATED_MARKER}${source
      .subarray(source.length - tailBytes)
      .toString('utf8')}`;
    if (Buffer.byteLength(truncated, 'utf8') <= maxBytes) return truncated;
    if (headBytes >= tailBytes) headBytes -= 1;
    else tailBytes -= 1;
  } while (headBytes > 0 && tailBytes > 0);
  return '';
}

function sanitizeValue(value: unknown, budget: SanitizeBudget, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;

  if (typeof value === 'string') {
    const available = Math.max(0, budget.remaining);
    const next = truncateUtf8(value, available);
    const bytes = Buffer.byteLength(next, 'utf8');
    budget.remaining = Math.max(0, budget.remaining - bytes);
    if (next !== value) budget.truncated = true;
    return next;
  }

  if (typeof value === 'undefined') return null;
  if (typeof value !== 'object') return String(value);
  if (depth >= MAX_DEPTH || budget.remaining <= 0) {
    budget.truncated = true;
    return { __transportTruncated: true };
  }
  if (budget.seen.has(value)) {
    budget.truncated = true;
    return '[Circular]';
  }
  budget.seen.add(value);

  if (Array.isArray(value)) {
    const next = value
      .slice(0, MAX_COLLECTION_ENTRIES)
      .map(entry => sanitizeValue(entry, budget, depth + 1));
    if (value.length > MAX_COLLECTION_ENTRIES) {
      budget.truncated = true;
      next.push({ __transportTruncated: true, originalLength: value.length });
    }
    return next;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const next: Record<string, unknown> = {};
  for (const [index, [key, entry]] of entries.entries()) {
    if (index >= MAX_COLLECTION_ENTRIES || budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    budget.remaining = Math.max(0, budget.remaining - Buffer.byteLength(key, 'utf8'));
    next[key] = sanitizeValue(entry, budget, depth + 1);
  }
  if (budget.truncated) next.__transportTruncated = true;
  return next;
}

export function sanitizeAgentChatEvent(event: AgentChatEvent): AgentChatEvent {
  const budget: SanitizeBudget = {
    remaining: EVENT_VALUE_BUDGET_BYTES,
    truncated: false,
    seen: new WeakSet(),
  };
  const next = { ...event, params: sanitizeValue(event.params, budget, 0) };
  const bytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
  if (bytes <= MAX_AGENT_EVENT_BYTES) return next;

  return {
    ...event,
    params: {
      __transportTruncated: true,
      originalBytes: bytes,
      message: 'Agent event exceeded the Native Messaging transport limit.',
    },
  };
}
