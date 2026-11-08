import { describe, expect, it } from 'vitest';
import type { AgentChatEvent } from '@mearl/browser-core';
import { MAX_AGENT_EVENT_BYTES, sanitizeAgentChatEvent } from '../event-transport.js';

describe('sanitizeAgentChatEvent', () => {
  it('keeps large tool output below the Native Messaging limit', () => {
    const event: AgentChatEvent = {
      id: 'event-1',
      sessionId: 'session-1',
      providerId: 'codex',
      kind: 'notification',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'item-1',
          type: 'commandExecution',
          aggregatedOutput: `${'输出'.repeat(600_000)}TAIL`,
        },
      },
      timestamp: 1,
    };

    const sanitized = sanitizeAgentChatEvent(event);

    expect(Buffer.byteLength(JSON.stringify(sanitized), 'utf8')).toBeLessThanOrEqual(
      MAX_AGENT_EVENT_BYTES,
    );
    expect((sanitized.params as any).item.id).toBe('item-1');
    expect((sanitized.params as any).__transportTruncated).toBe(true);
    expect((sanitized.params as any).item.aggregatedOutput).toContain(
      'middle truncated for Native Messaging',
    );
    expect((sanitized.params as any).item.aggregatedOutput).toMatch(/^输出/);
    expect((sanitized.params as any).item.aggregatedOutput).toMatch(/TAIL$/);
  });
});
