import { describe, expect, it } from 'vitest';
import type { AgentChatEvent } from '@mearl/browser-core';
import {
  buildAgentChatConversationExport,
  buildAgentChatDebugExport,
  mergeAgentChatDebugEvents,
} from '../debugExport';

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
    timestamp: Date.UTC(2026, 6, 25, 8, 0, Number(id.replace(/\D/g, '')) || 0),
  };
}

describe('agent chat debug exports', () => {
  it('copies a clean user and assistant conversation', () => {
    const result = JSON.parse(
      buildAgentChatConversationExport([
        event('1', 'chat/userMessage', { text: '检查页面' }, 'lifecycle'),
        event('2', 'item/completed', {
          item: { id: 'message_1', type: 'agentMessage', text: '页面检查完成' },
        }),
      ]),
    );

    expect(result).toMatchObject({
      formatVersion: 1,
      type: 'agent-chat-conversation',
      messages: [
        { role: 'user', message: '检查页面' },
        { role: 'assistant', message: '页面检查完成' },
      ],
    });
  });

  it('preserves message content in the conversation-only export', () => {
    const result = JSON.parse(
      buildAgentChatConversationExport([
        event(
          '1',
          'chat/userMessage',
          { text: '联系 traveler@example.com 或 138 0013 8000' },
          'lifecycle',
        ),
      ]),
    );

    expect(result.messages[0].message).toBe('联系 traveler@example.com 或 138 0013 8000');
  });

  it('keeps structured optimization context without verbose debug sections', () => {
    const userEvent = event(
      '1',
      'chat/userMessage',
      {
        text: '检查当前页面并点击提交',
      },
      'lifecycle',
    );
    const assistantEvent = event('2', 'item/completed', {
      item: { id: 'message_1', type: 'agentMessage', text: '提交完成' },
    });
    const toolEvent = event('3', 'item/completed', {
      turnId: 'turn_1',
      item: {
        id: 'tool_1',
        type: 'mcpToolCall',
        server: 'mearl',
        tool: 'page_click',
        arguments: {
          ref: '@e1',
          authorization: 'secret-token',
        },
        result: {
          clicked: true,
          cookie: 'session-secret',
        },
      },
    });
    const privateReasoningEvent = event('4', 'item/reasoning/textDelta', {
      delta: 'private reasoning',
    });
    const reasoningSummaryEvent = event('5', 'item/completed', {
      turnId: 'turn_1',
      item: {
        id: 'reasoning_1',
        type: 'reasoning',
        summary: ['先读取页面快照，再点击提交。'],
      },
    });
    const planEvent = event('6', 'item/completed', {
      turnId: 'turn_1',
      item: {
        id: 'plan_1',
        type: 'plan',
        text: '1. 获取快照\n2. 点击提交',
      },
    });
    const tokenEvent = event('7', 'thread/tokenUsage/updated', {
      turnId: 'turn_1',
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    const errorEvent = event(
      '8',
      'chat/error',
      {
        turnId: 'turn_1',
        message: 'Tool failed',
        authorization: 'error-secret',
      },
      'error',
    );

    const result = JSON.parse(
      buildAgentChatDebugExport(
        [
          userEvent,
          assistantEvent,
          toolEvent,
          privateReasoningEvent,
          reasoningSummaryEvent,
          planEvent,
          tokenEvent,
          errorEvent,
        ],
        [userEvent, reasoningSummaryEvent, planEvent, assistantEvent],
        {
          providerId: 'codex',
          providerName: 'Codex',
          sessionId: 'session_1',
          provider: {
            id: 'codex',
            name: 'Codex',
            available: true,
            capabilities: {
              streaming: true,
              resume: true,
              listSessions: true,
              refreshHistory: true,
              imageInput: true,
              interrupt: true,
              requests: true,
            },
          },
          sessionStatus: 'idle',
          providerSessionId: 'thread_1',
          model: { id: 'gpt-5.6-codex' },
          activeModel: { id: 'gpt-5.6-codex-mini' },
          workspaceDirectory: '/workspace/mearl',
          ephemeral: false,
          tabId: 88,
          initialPageUrl: 'https://example.com/checkout?step=confirm',
          initialPageTitle: 'Checkout',
          developerInstructions: 'Always use mearl with {"tabId":88}.',
          developerInstructionsSource: 'session',
          extensionVersion: '2.0.0',
          nativeHostVersion: '2.0.0',
          browserTab: {
            id: 88,
            url: 'https://example.com/checkout?token=secret',
            title: 'Checkout',
          },
          clientSettings: {
            autoApprove: false,
            saveToCodexHistory: true,
          },
          liveEventCount: 8,
          liveEventLimit: 200,
          replayEventCount: 8,
          replayRetention: {
            truncated: false,
            maxEvents: 1000,
            maxBytes: 2048 * 1024,
            maxPageBytes: 512 * 1024,
            retainedBytes: 2_048,
          },
          generatedAt: '2026-07-25T08:30:00.000Z',
        },
      ),
    );

    expect(result.session).toEqual({
      localSessionId: 'session_1',
      providerId: 'codex',
      providerName: 'Codex',
      status: 'idle',
      providerSessionId: 'thread_1',
      model: { id: 'gpt-5.6-codex' },
      activeModel: { id: 'gpt-5.6-codex-mini' },
      workspaceDirectory: '/workspace/mearl',
      ephemeral: false,
      tabId: 88,
      initialPage: {
        url: 'https://example.com/checkout?step=confirm',
        title: 'Checkout',
      },
      developerInstructions: 'Always use mearl with {"tabId":88}.',
      developerInstructionsSource: 'session',
    });
    expect(result.provider).toMatchObject({
      id: 'codex',
      available: true,
      capabilities: { requests: true },
    });
    expect(result.environment).toMatchObject({
      extensionVersion: '2.0.0',
      nativeHostVersion: '2.0.0',
      browserTab: { id: 88, title: 'Checkout' },
      clientSettings: {
        autoApprove: false,
        saveToCodexHistory: true,
      },
    });
    expect(result.environment.browserTab.url).not.toContain('secret');
    expect(result.conversation).toEqual([
      expect.objectContaining({ role: 'user', message: '检查当前页面并点击提交' }),
      expect.objectContaining({ role: 'assistant', message: '提交完成' }),
    ]);
    expect(result.publicInsights).toEqual([
      expect.objectContaining({
        type: 'reasoning-summary',
        text: '先读取页面快照，再点击提交。',
      }),
      expect.objectContaining({ type: 'plan', text: '1. 获取快照\n2. 点击提交' }),
    ]);
    expect(result.tokenUsage).toEqual([
      expect.objectContaining({
        scope: 'turn_1',
        usage: expect.objectContaining({
          usage: { inputTokens: 100, outputTokens: 20 },
        }),
      }),
    ]);
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({
        itemId: 'tool_1',
        type: 'mcpToolCall',
        turnId: 'turn_1',
        server: 'mearl',
        tool: 'page_click',
        input: {
          arguments: {
            ref: '@e1',
            authorization: '[REDACTED]',
          },
        },
        output: {
          result: {
            clicked: true,
            cookie: '[REDACTED]',
          },
        },
      }),
    ]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        method: 'chat/error',
        turnId: 'turn_1',
        details: {
          turnId: 'turn_1',
          message: 'Tool failed',
          authorization: '[REDACTED]',
        },
      }),
    ]);
    expect(result.eventSummary).toMatchObject({
      total: 8,
      methodCounts: {
        'chat/userMessage': 1,
        'item/completed': 4,
        'item/reasoning/textDelta': 1,
        'thread/tokenUsage/updated': 1,
        'chat/error': 1,
      },
    });
    expect(result.retention.replayBuffer).toEqual({
      truncated: false,
      maxEvents: 1000,
      maxBytes: 2048 * 1024,
      maxPageBytes: 512 * 1024,
      retainedBytes: 2_048,
    });
    expect(result.retention.liveBuffer).toEqual({
      retainedEvents: 8,
      maxEvents: 200,
      possiblyTruncated: false,
    });
    expect(result).not.toHaveProperty('diagnosticEvents');
    expect(result).not.toHaveProperty('skills');
    expect(result).not.toHaveProperty('limitations');
    expect(result).not.toHaveProperty('prompts');
    expect(JSON.stringify(result)).not.toContain('private reasoning');
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.stringify(result)).not.toContain('session-secret');
    expect(JSON.stringify(result)).not.toContain('error-secret');
  });

  it('includes the latest runtime permission settings as diagnostic evidence', () => {
    const result = JSON.parse(
      buildAgentChatDebugExport(
        [
          event('1', 'thread/settings/updated', {
            threadSettings: {
              approvalPolicy: 'never',
              sandboxPolicy: { type: 'readOnly', networkAccess: true },
              activePermissionProfile: {
                id: 'mearl_browser_read_only',
                extends: ':read-only',
              },
              model: 'gpt-5.6-codex',
            },
          }),
        ],
        [],
        {
          providerId: 'codex',
          providerName: 'Codex',
        },
      ),
    );

    expect(result.session.runtimePermissions).toEqual({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
      activePermissionProfile: {
        id: 'mearl_browser_read_only',
        extends: ':read-only',
      },
    });
    expect(result.session.runtimePermissions).not.toHaveProperty('model');
  });

  it('redacts sensitive URL fragments and credentials', () => {
    const result = JSON.parse(
      buildAgentChatDebugExport([], [], {
        providerId: 'codex',
        providerName: 'Codex',
        initialPageUrl: 'https://user:password@example.com/callback#access_token=fragment-secret',
        browserTab: {
          id: 88,
          url: 'https://example.com/callback#access_token=browser-secret',
        },
      }),
    );

    expect(JSON.stringify(result)).not.toContain('password');
    expect(JSON.stringify(result)).not.toContain('fragment-secret');
    expect(JSON.stringify(result)).not.toContain('browser-secret');
    expect(result.session.initialPage.url).toContain('REDACTED');
    expect(result.environment.browserTab.url).toContain('REDACTED');
  });

  it('redacts common PII patterns and omits long URL query values', () => {
    const identifier = '110105 19491231 002X';
    const phone = '138 0013 8000';
    const email = 'traveler@example.com';
    const longQueryValue = 'x'.repeat(180);
    const rawOutput = JSON.stringify({
      url: `https://example.com/confirm?date=2026-09-02&context=${longQueryValue}`,
      snapshot: `身份证 ${identifier}\n联系电话 ${phone}\n邮箱 ${email}`,
    });
    const result = JSON.parse(
      buildAgentChatDebugExport(
        [
          event('1', 'item/completed', {
            item: {
              id: 'tool_1',
              type: 'dynamicToolCall',
              rawOutput,
            },
          }),
        ],
        [event('2', 'chat/userMessage', { text: `联系 ${email}` }, 'lifecycle')],
        {
          providerId: 'qoder',
          providerName: 'Qoder',
        },
      ),
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(identifier);
    expect(serialized).not.toContain(phone);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain(longQueryValue);
    expect(result.conversation[0].message).toContain('[REDACTED]');
    const output = JSON.parse(result.toolExecutions[0].output.rawOutput);
    expect(output.snapshot.match(/\[REDACTED\]/g)).toHaveLength(3);
    expect(output.url).toContain('date=2026-09-02');
    expect(new URL(output.url).searchParams.get('context')).toBe(
      '[omitted long query value: 180 chars]',
    );
    expect(result.redaction).toMatchObject({
      sensitiveFields: true,
      contentPatterns: true,
      longQueryValues: true,
    });
  });

  it('redacts page metadata embedded in developer instructions', () => {
    const email = 'traveler@example.com';
    const phone = '138 0013 8000';
    const result = JSON.parse(
      buildAgentChatDebugExport([], [], {
        providerId: 'codex',
        providerName: 'Codex',
        developerInstructions: `Initial page title: ${email}; contact: ${phone}`,
      }),
    );

    expect(result.session.developerInstructions).not.toContain(email);
    expect(result.session.developerInstructions).not.toContain(phone);
    expect(result.session.developerInstructions.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it('sanitizes URLs embedded in human-readable tool output', () => {
    const longQueryValue = 'x'.repeat(180);
    const rawOutput = [
      '✓ Screenshot captured',
      `URL: https://example.com/order?date=2026-08-01&context=${longQueryValue}`,
    ].join('\n');
    const result = JSON.parse(
      buildAgentChatDebugExport(
        [
          event('1', 'item/completed', {
            item: {
              id: 'tool_1',
              type: 'dynamicToolCall',
              rawOutput,
            },
          }),
        ],
        [],
        {
          providerId: 'qoder',
          providerName: 'Qoder',
        },
      ),
    );

    const output = result.toolExecutions[0].output.rawOutput;
    expect(output).not.toContain(longQueryValue);
    expect(output).toContain('date=2026-08-01');
    expect(output).toContain('%5Bomitted+long+query+value%3A+180+chars%5D');
  });

  it('separates tool completion from the explicit operation outcome', () => {
    const result = JSON.parse(
      buildAgentChatDebugExport(
        [
          event('1', 'item/completed', {
            turnId: 'turn_1',
            item: {
              id: 'tool_1',
              type: 'dynamicToolCall',
              status: 'completed',
              rawOutput: JSON.stringify({
                action: {
                  name: 'page_click',
                  success: false,
                  error: 'Matched multiple elements',
                },
                observation: { changed: false },
              }),
            },
          }),
        ],
        [],
        {
          providerId: 'qoder',
          providerName: 'Qoder',
        },
      ),
    );

    expect(result.toolExecutions[0]).toMatchObject({
      status: 'completed',
      operation: {
        success: false,
        error: 'Matched multiple elements',
      },
    });
    expect(result.errors).toEqual([]);
  });

  it('recognizes a non-zero command exit code as the operation outcome', () => {
    const result = JSON.parse(
      buildAgentChatDebugExport(
        [
          event('1', 'item/completed', {
            turnId: 'turn_1',
            item: {
              id: 'tool_1',
              type: 'dynamicToolCall',
              status: 'completed',
              rawOutput:
                'Output: page_snapshot: query must be an object\nExit Code: 1\nProcess Group PGID: 42',
            },
          }),
        ],
        [],
        {
          providerId: 'qoder',
          providerName: 'Qoder',
        },
      ),
    );

    expect(result.toolExecutions[0]).toMatchObject({
      status: 'completed',
      operation: {
        success: false,
        exitCode: 1,
        error: 'page_snapshot: query must be an object',
      },
    });
  });

  it('keeps one canonical tool output and sanitizes JSON raw output', () => {
    const rawOutput = JSON.stringify({
      url: 'https://example.com/result?access_token=secret-token',
      image: 'A'.repeat(3_000),
      value: 42,
    });
    const result = JSON.parse(
      buildAgentChatDebugExport(
        [
          event('1', 'item/completed', {
            turnId: 'turn_1',
            item: {
              id: 'tool_1',
              type: 'dynamicToolCall',
              namespace: 'qoder',
              tool: 'capture page',
              rawInput: null,
              rawOutput,
              content: [{ type: 'text', text: `\`\`\`console\n${rawOutput}\n\`\`\`` }],
              locations: [{ path: '/tmp/capture.png' }],
            },
          }),
        ],
        [],
        {
          providerId: 'qoder',
          providerName: 'Qoder',
        },
      ),
    );

    expect(result.toolExecutions[0]).not.toHaveProperty('input');
    expect(result.toolExecutions[0].output).toEqual({
      rawOutput: expect.any(String),
      locations: [{ path: '/tmp/capture.png' }],
    });
    expect(result.toolExecutions[0].output).not.toHaveProperty('content');
    expect(JSON.parse(result.toolExecutions[0].output.rawOutput)).toEqual({
      url: expect.stringContaining('REDACTED'),
      image: '[omitted base64: 3000 chars]',
      value: 42,
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('merges replay and live events into turn and tool timelines', () => {
    const toolStartedEvent = event('1', 'item/started', {
      turnId: 'turn_1',
      item: {
        id: 'tool_1',
        type: 'commandExecution',
        status: 'inProgress',
      },
    });
    const turnStartedEvent = event('2', 'turn/started', {
      turn: { id: 'turn_1', status: 'inProgress' },
    });
    const replayEvent = event('3', 'item/completed', {
      turnId: 'turn_1',
      item: {
        id: 'tool_1',
        type: 'commandExecution',
        status: 'completed',
      },
    });
    const liveEvent = {
      ...replayEvent,
      params: {
        ...(replayEvent.params as Record<string, unknown>),
        live: true,
      },
    };
    const merged = mergeAgentChatDebugEvents(
      [
        event('0', 'item/agentMessage/delta', {
          turnId: 'turn_1',
          itemId: 'message_1',
          delta: '完成',
        }),
        event('0b', 'item/completed', {
          turnId: 'turn_1',
          item: { id: 'message_1', type: 'agentMessage', text: '完成' },
        }),
        toolStartedEvent,
        turnStartedEvent,
        replayEvent,
        event('4', 'turn/completed', { turn: { id: 'turn_1', status: 'completed' } }),
      ],
      [liveEvent],
    );
    const result = JSON.parse(
      buildAgentChatDebugExport(merged, [], {
        providerId: 'codex',
        providerName: 'Codex',
      }),
    );

    expect(merged).toHaveLength(5);
    expect(merged.some(event => event.method === 'item/agentMessage/delta')).toBe(false);
    expect(merged.find(event => event.id === '3')?.params).toMatchObject({ live: true });
    expect(result.turns).toEqual([
      expect.objectContaining({
        turnId: 'turn_1',
        startedAt: expect.any(String),
        completedAt: expect.any(String),
        durationMs: 2_000,
        status: 'completed',
      }),
    ]);
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({
        itemId: 'tool_1',
        type: 'commandExecution',
        turnId: 'turn_1',
        startedAt: expect.any(String),
        completedAt: expect.any(String),
        durationMs: 2_000,
        status: 'completed',
      }),
    ]);
  });
});
