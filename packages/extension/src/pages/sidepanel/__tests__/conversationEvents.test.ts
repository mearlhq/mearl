import { describe, expect, it } from 'vitest';
import type { AgentChatEvent } from '@mearl/browser-core';
import { chatMessages } from './chatTestHelpers';
import { appendConversationEvent, rebuildConversationEvents } from '../conversationEvents';

function event(
  id: string,
  method: string,
  params: unknown,
  kind: AgentChatEvent['kind'] = 'notification',
): AgentChatEvent {
  return {
    id,
    sessionId: 'session_1',
    providerId: 'codex',
    kind,
    method,
    params,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
  };
}

describe('conversation events', () => {
  it('keeps old messages when raw protocol noise exceeds the raw event window', () => {
    const rawEvents: AgentChatEvent[] = [
      event('1', 'chat/userMessage', { text: '第一条问题' }, 'lifecycle'),
      event('2', 'item/completed', {
        item: { id: 'answer_1', type: 'agentMessage', text: '第一条回答' },
      }),
      ...Array.from({ length: 250 }, (_, index) =>
        event(`noise_${index + 3}`, 'thread/tokenUsage/updated', { total: index }),
      ),
      event('300', 'chat/userMessage', { text: '第二条问题' }, 'lifecycle'),
      event('301', 'item/completed', {
        item: { id: 'answer_2', type: 'agentMessage', text: '第二条回答' },
      }),
    ];

    const conversationEvents = rebuildConversationEvents(rawEvents);

    expect(chatMessages(conversationEvents)).toEqual([
      { role: 'user', message: '第一条问题' },
      { role: 'assistant', message: '第一条回答' },
      { role: 'user', message: '第二条问题' },
      { role: 'assistant', message: '第二条回答' },
    ]);
  });

  it('keeps image-only user messages without persisting image data', () => {
    const events = rebuildConversationEvents([
      event(
        '1',
        'chat/userMessage',
        { text: '', imageCount: 1, images: [{ data: 'large-base64-data' }] },
        'lifecycle',
      ),
    ]);

    expect(events[0]?.params).toEqual({ text: '', imageCount: 1 });
    expect(chatMessages(events)).toEqual([{ role: 'user', message: '🖼 ×1' }]);
  });

  it('coalesces streaming deltas and replaces them with the completed item', () => {
    const events = [
      event('1', 'turn/started', { turn: { id: 'turn_1' } }),
      event('2', 'item/agentMessage/delta', {
        turnId: 'turn_1',
        itemId: 'answer_1',
        delta: '第一',
      }),
      event('3', 'item/agentMessage/delta', {
        turnId: 'turn_1',
        itemId: 'answer_1',
        delta: '段',
      }),
      event('4', 'item/completed', {
        turnId: 'turn_1',
        item: { id: 'answer_1', type: 'agentMessage', text: '第一段。' },
      }),
      event('5', 'turn/completed', { turn: { id: 'turn_1' } }),
    ].reduce(appendConversationEvent, [] as AgentChatEvent[]);

    expect(events).toHaveLength(1);
    expect(events[0]?.method).toBe('item/completed');
    expect(chatMessages(events)).toEqual([{ role: 'assistant', message: '第一段。' }]);
  });

  it('replaces the local preparing event when the real turn starts', () => {
    const events = [
      event('1', 'chat/userMessage', { text: '你好' }, 'lifecycle'),
      event('2', 'chat/preparing', {}, 'lifecycle'),
      event('3', 'turn/started', { turn: { id: 'turn_1' } }),
    ].reduce(appendConversationEvent, [] as AgentChatEvent[]);

    expect(events.map(value => value.method)).toEqual(['chat/userMessage', 'turn/started']);
    expect(chatMessages(events)).toEqual([
      { role: 'user', message: '你好' },
      { role: 'thinking', message: '💭 …' },
    ]);
  });

  it('drops large tool output while retaining its compact status', () => {
    const events = rebuildConversationEvents([
      event('1', 'item/completed', {
        item: {
          id: 'command_1',
          type: 'commandExecution',
          command: 'pnpm test',
          status: 'completed',
          aggregatedOutput: 'x'.repeat(100_000),
        },
      }),
    ]);

    expect(JSON.stringify(events)).not.toContain('xxxxxxxxxx');
    expect(chatMessages(events)).toEqual([{ role: 'tool', message: '✓ $ pnpm test' }]);
  });
});
