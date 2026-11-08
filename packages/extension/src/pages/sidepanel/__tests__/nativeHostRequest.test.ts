import type { AgentChatEvent } from '@mearl/browser-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestAgentChatEvents, requestAgentChatRefresh } from '../nativeHostRequest';

function event(id: string): AgentChatEvent {
  return {
    id,
    sessionId: 'session_1',
    providerId: 'codex',
    kind: 'notification',
    method: 'tool/progress',
    params: { id },
    timestamp: 1,
  };
}

describe('requestAgentChatEvents', () => {
  beforeEach(() => {
    vi.mocked(chrome.runtime.sendMessage).mockReset();
  });

  it('collects every replay page in event order', async () => {
    vi.mocked(chrome.runtime.sendMessage)
      .mockResolvedValueOnce({
        success: true,
        data: {
          events: [event('event_2')],
          nextCursor: 1,
          retention: {
            truncated: false,
            maxEvents: 1000,
            maxBytes: 2048 * 1024,
            maxPageBytes: 512 * 1024,
            retainedBytes: 800 * 1024,
          },
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          events: [event('event_1')],
          retention: {
            truncated: false,
            maxEvents: 1000,
            maxBytes: 2048 * 1024,
            maxPageBytes: 512 * 1024,
            retainedBytes: 800 * 1024,
          },
        },
      });

    const result = await requestAgentChatEvents('session_1');

    expect(result.events.map(item => item.id)).toEqual(['event_1', 'event_2']);
    expect(result.nextCursor).toBeUndefined();
    expect(chrome.runtime.sendMessage).toHaveBeenNthCalledWith(1, {
      action: 'agent_chat_events',
      data: { sessionId: 'session_1' },
    });
    expect(chrome.runtime.sendMessage).toHaveBeenNthCalledWith(2, {
      action: 'agent_chat_events',
      data: { sessionId: 'session_1', cursor: 1 },
    });
  });

  it('keeps refreshed session metadata while collecting earlier pages', async () => {
    vi.mocked(chrome.runtime.sendMessage)
      .mockResolvedValueOnce({
        success: true,
        data: {
          session: {
            id: 'session_1',
            providerId: 'codex',
            providerSessionId: 'thread_1',
            status: 'idle',
          },
          events: [event('event_2')],
          nextCursor: 1,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          events: [event('event_1')],
        },
      });

    const result = await requestAgentChatRefresh('session_1');

    expect(result.session.providerSessionId).toBe('thread_1');
    expect(result.events.map(item => item.id)).toEqual(['event_1', 'event_2']);
    expect(chrome.runtime.sendMessage).toHaveBeenNthCalledWith(1, {
      action: 'agent_chat_refresh',
      data: { sessionId: 'session_1' },
    });
  });
});
