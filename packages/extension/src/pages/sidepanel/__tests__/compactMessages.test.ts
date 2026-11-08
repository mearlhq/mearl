import { describe, expect, it } from 'vitest';
import type { AgentChatEvent } from '@mearl/browser-core';
import { toCompactChatCards } from '../compactMessages';
import { rebuildConversationEvents } from '../conversationEvents';
import { chatMessages } from './chatTestHelpers';

function event(
  method: string,
  params: unknown,
  kind: AgentChatEvent['kind'] = 'notification',
  timestamp = 1,
): AgentChatEvent {
  return {
    id: `${method}_${Math.random()}`,
    sessionId: 'session_1',
    providerId: 'codex',
    kind,
    method,
    params,
    timestamp,
  };
}

it('keeps a visible boundary when a missing provider session is replaced', () => {
  const events = rebuildConversationEvents([
    event('chat/userMessage', { text: 'Old conversation' }, 'lifecycle', 1),
    event('session/reconnected', { providerSessionId: 'new-thread' }, 'lifecycle', 2),
  ]);
  expect(toCompactChatCards(events, 'A new session was started.')).toEqual([
    { role: 'user', message: 'Old conversation', timestamp: 1 },
    { role: 'system', message: 'A new session was started.', timestamp: 2 },
  ]);
});

describe('toCompactChatCards', () => {
  it('keeps only user and completed assistant messages', () => {
    const result = chatMessages([
      event('session/started', { session: {} }, 'lifecycle'),
      event('chat/userMessage', { text: '你好' }, 'lifecycle'),
      event('thread/tokenUsage/updated', { total: 100 }),
      event('item/completed', {
        item: { id: 'message_1', type: 'agentMessage', text: '你好，有什么想一起做的吗？' },
      }),
    ]);

    expect(result).toEqual([
      { role: 'user', message: '你好' },
      { role: 'assistant', message: '你好，有什么想一起做的吗？' },
    ]);
  });

  it('shows pasted image counts for user messages', () => {
    expect(
      chatMessages([event('chat/userMessage', { text: '', imageCount: 2 }, 'lifecycle')]),
    ).toEqual([{ role: 'user', message: '🖼 ×2' }]);
  });

  it('shows one immediate waiting message while the session is preparing', () => {
    const result = chatMessages([
      event('chat/userMessage', { text: '你好' }, 'lifecycle'),
      event('chat/preparing', {}, 'lifecycle'),
    ]);

    expect(result).toEqual([
      { role: 'user', message: '你好' },
      { role: 'thinking', message: '💭 …' },
    ]);
  });

  it('keeps a distinct preparation card while a new provider conversation is starting', () => {
    expect(
      chatMessages([
        event('chat/preparing', { message: 'Creating Codex conversation…' }, 'lifecycle'),
      ]),
    ).toEqual([{ role: 'preparing', message: 'Creating Codex conversation…' }]);
  });

  it('coalesces streaming deltas and replaces them with the final message', () => {
    const result = toCompactChatCards([
      event('item/agentMessage/delta', { itemId: 'message_1', delta: '第一' }, undefined, 1),
      event('item/agentMessage/delta', { itemId: 'message_1', delta: '段' }, undefined, 2),
      event(
        'item/completed',
        {
          item: { id: 'message_1', type: 'agentMessage', text: '第一段。' },
        },
        undefined,
        3,
      ),
    ]);

    expect(result).toEqual([{ role: 'assistant', message: '第一段。', timestamp: 3 }]);
  });

  it('shows concise reasoning summaries but ignores private reasoning text deltas', () => {
    const result = chatMessages([
      event('turn/started', { turn: { id: 'turn_1' } }),
      event('item/started', {
        turnId: 'turn_1',
        item: { id: 'reasoning_1', type: 'reasoning', summary: [], content: [] },
      }),
      event('item/reasoning/summaryTextDelta', {
        turnId: 'turn_1',
        itemId: 'reasoning_1',
        delta: '先检查',
      }),
      event('item/reasoning/textDelta', {
        turnId: 'turn_1',
        itemId: 'reasoning_1',
        delta: '不应展示的完整推理',
      }),
      event('item/reasoning/summaryTextDelta', {
        turnId: 'turn_1',
        itemId: 'reasoning_1',
        delta: '现有实现。',
      }),
      event('item/completed', {
        turnId: 'turn_1',
        item: {
          id: 'reasoning_1',
          type: 'reasoning',
          summary: ['先检查现有实现。'],
          content: ['不应展示的完整推理'],
        },
      }),
    ]);

    expect(result).toEqual([{ role: 'thinking', message: '💭 先检查现有实现。' }]);
  });

  it('uses the thinking role for plan progress', () => {
    const result = chatMessages([
      event('turn/started', { turn: { id: 'turn_1' } }),
      event('item/plan/delta', {
        turnId: 'turn_1',
        itemId: 'plan_1',
        delta: '先检查调用链，再补测试。',
      }),
    ]);

    expect(result).toEqual([{ role: 'thinking', message: '📋 先检查调用链，再补测试。' }]);
  });

  it('reuses the waiting indicator for live tool progress', () => {
    const running = chatMessages([
      event('chat/userMessage', { text: '运行测试' }, 'lifecycle'),
      event('turn/started', { turn: { id: 'turn_1' } }),
      event('item/started', {
        turnId: 'turn_1',
        item: {
          id: 'command_1',
          type: 'commandExecution',
          command: 'pnpm test',
          status: 'inProgress',
        },
      }),
    ]);

    expect(running).toEqual([
      { role: 'user', message: '运行测试' },
      { role: 'tool', message: '… $ pnpm test' },
    ]);

    const completed = chatMessages([
      event('turn/started', { turn: { id: 'turn_1' } }),
      event('item/started', {
        turnId: 'turn_1',
        item: {
          id: 'command_1',
          type: 'commandExecution',
          command: 'pnpm test',
          status: 'inProgress',
        },
      }),
      event('item/completed', {
        turnId: 'turn_1',
        item: {
          id: 'command_1',
          type: 'commandExecution',
          command: 'pnpm test',
          status: 'completed',
        },
      }),
    ]);

    expect(completed).toEqual([{ role: 'tool', message: '✓ $ pnpm test' }]);
  });

  it('updates one transient progress message throughout a turn', () => {
    const runningEvents = [
      event('chat/userMessage', { text: '检查页面' }, 'lifecycle'),
      event('turn/started', { turn: { id: 'turn_1' } }),
      event('item/started', {
        turnId: 'turn_1',
        item: { id: 'reasoning_1', type: 'reasoning', summary: [] },
      }),
      event('item/reasoning/summaryTextDelta', {
        turnId: 'turn_1',
        itemId: 'reasoning_1',
        delta: 'Preparing snapshot command',
      }),
      event('item/started', {
        turnId: 'turn_1',
        item: {
          id: 'command_1',
          type: 'commandExecution',
          command: 'mearl page_snapshot',
          status: 'inProgress',
        },
      }),
      event('item/completed', {
        turnId: 'turn_1',
        item: {
          id: 'command_1',
          type: 'commandExecution',
          command: 'mearl page_snapshot',
          status: 'completed',
        },
      }),
      event('item/started', {
        turnId: 'turn_1',
        item: { id: 'reasoning_2', type: 'reasoning', summary: [] },
      }),
      event('item/reasoning/summaryTextDelta', {
        turnId: 'turn_1',
        itemId: 'reasoning_2',
        delta: 'Summarizing article in Chinese',
      }),
    ];

    expect(chatMessages(runningEvents)).toEqual([
      { role: 'user', message: '检查页面' },
      { role: 'thinking', message: '💭 Summarizing article in Chinese' },
    ]);

    expect(
      chatMessages([
        ...runningEvents,
        event('item/completed', {
          turnId: 'turn_1',
          item: { id: 'message_1', type: 'agentMessage', text: '文章摘要' },
        }),
      ]),
    ).toEqual([
      { role: 'user', message: '检查页面' },
      { role: 'assistant', message: '文章摘要' },
    ]);
  });

  it('removes an unused waiting indicator when a turn completes', () => {
    const result = chatMessages([
      event('turn/started', { turn: { id: 'turn_1' } }),
      event('turn/completed', { turn: { id: 'turn_1' } }),
    ]);

    expect(result).toEqual([]);
  });

  it('turns provider failures into system messages', () => {
    const result = chatMessages([event('chat/error', { error: { message: '连接失败' } }, 'error')]);

    expect(result).toEqual([{ role: 'system', message: '连接失败' }]);
  });
});
