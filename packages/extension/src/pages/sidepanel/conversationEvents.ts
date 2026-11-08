import {
  AGENT_CHAT_STREAM_FIELDS,
  agentChatEventItemId,
  isAgentChatStreamMethod,
  type AgentChatEvent,
} from '@mearl/browser-core';

const MAX_CONVERSATION_EVENTS = 1_000;
const MAX_CONVERSATION_CHARS = 3_000_000;
const MAX_MESSAGE_CHARS = 250_000;
const MAX_DETAIL_CHARS = 10_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function limitedString(value: unknown, maxChars = MAX_DETAIL_CHARS): string | null {
  if (typeof value !== 'string') return null;
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function eventWithParams(event: AgentChatEvent, params: unknown): AgentChatEvent {
  return { ...event, params };
}

function eventItemId(event: AgentChatEvent): string | null {
  return agentChatEventItemId(event) || null;
}

function eventTurnId(event: AgentChatEvent): string | null {
  const params = record(event.params);
  if (typeof params?.turnId === 'string') return params.turnId;
  const turn = record(params?.turn);
  return typeof turn?.id === 'string' ? turn.id : null;
}

function minimalItem(value: unknown): Record<string, unknown> | null {
  const item = record(value);
  if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') return null;

  const base = { id: item.id, type: item.type };
  switch (item.type) {
    case 'agentMessage':
      return { ...base, text: limitedString(item.text, MAX_MESSAGE_CHARS) || '' };
    case 'reasoning':
      return {
        ...base,
        summary: Array.isArray(item.summary)
          ? [
              limitedString(item.summary.filter(part => typeof part === 'string').join('\n')),
            ].filter((part): part is string => part !== null)
          : [],
      };
    case 'plan':
      return { ...base, text: limitedString(item.text, MAX_MESSAGE_CHARS) || '' };
    case 'commandExecution':
      return {
        ...base,
        command: limitedString(item.command) || '',
        status: item.status,
      };
    case 'fileChange':
      return {
        ...base,
        status: item.status,
        changes: Array.isArray(item.changes)
          ? item.changes.slice(0, 3).flatMap(change => {
              const values = record(change);
              const path = limitedString(values?.path);
              return path ? [{ path, kind: values?.kind }] : [];
            })
          : [],
        changeCount: Array.isArray(item.changes) ? item.changes.length : 0,
      };
    case 'mcpToolCall':
      return {
        ...base,
        server: limitedString(item.server) || '',
        tool: limitedString(item.tool) || '',
        status: item.status,
      };
    case 'dynamicToolCall':
      return {
        ...base,
        namespace: limitedString(item.namespace),
        tool: limitedString(item.tool) || '',
        status: item.status,
      };
    case 'webSearch':
      return {
        ...base,
        query: limitedString(item.query) || '',
        status: item.status,
      };
    case 'imageView':
      return {
        ...base,
        path: limitedString(item.path) || '',
        status: item.status,
      };
    default:
      return null;
  }
}

function minimalErrorParams(value: unknown): { message: string } | null {
  const params = record(value);
  const error = record(params?.error);
  const message = params?.message ?? error?.message ?? params?.error;
  if (typeof message === 'string') return { message: limitedString(message) || '' };
  if (message === undefined || message === null) return null;
  try {
    return { message: limitedString(JSON.stringify(message)) || '' };
  } catch {
    return { message: limitedString(String(message)) || '' };
  }
}

function minimalConversationEvent(event: AgentChatEvent): AgentChatEvent | null {
  const params = record(event.params);

  if (event.method === 'session/reconnected' && typeof params?.providerSessionId === 'string') {
    return eventWithParams(event, { providerSessionId: params.providerSessionId });
  }

  if (event.method === 'chat/userMessage') {
    const text = limitedString(params?.text, MAX_MESSAGE_CHARS);
    const imageCount =
      typeof params?.imageCount === 'number' && params.imageCount > 0
        ? Math.floor(params.imageCount)
        : 0;
    return text === null && imageCount === 0
      ? null
      : eventWithParams(event, {
          ...(text !== null ? { text } : {}),
          ...(imageCount > 0 ? { imageCount } : {}),
          ...(params?.hasAdditionalContext === true ? { hasAdditionalContext: true } : {}),
        });
  }

  if (event.method === 'chat/preparing') {
    const message = limitedString(params?.message);
    return eventWithParams(event, message ? { message } : {});
  }

  if (event.method === 'turn/started') {
    const id = eventTurnId(event);
    return id ? eventWithParams(event, { turn: { id } }) : null;
  }

  if (event.method === 'item/started' || event.method === 'item/completed') {
    const item = minimalItem(params?.item);
    if (!item) return null;
    return eventWithParams(event, {
      ...(typeof params?.turnId === 'string' ? { turnId: params.turnId } : {}),
      item,
    });
  }

  if (isAgentChatStreamMethod(event.method) && AGENT_CHAT_STREAM_FIELDS[event.method] === 'delta') {
    const id = eventItemId(event);
    const delta = limitedString(params?.delta, MAX_MESSAGE_CHARS);
    if (!id || delta === null) return null;
    return eventWithParams(event, {
      ...(typeof params?.turnId === 'string' ? { turnId: params.turnId } : {}),
      itemId: id,
      delta,
    });
  }

  if (
    isAgentChatStreamMethod(event.method) &&
    AGENT_CHAT_STREAM_FIELDS[event.method] === 'message'
  ) {
    const id = eventItemId(event);
    const message = limitedString(params?.message);
    if (!id || message === null) return null;
    return eventWithParams(event, {
      ...(typeof params?.turnId === 'string' ? { turnId: params.turnId } : {}),
      itemId: id,
      message,
    });
  }

  if (event.kind === 'error' || event.method === 'chat/error') {
    const errorParams = minimalErrorParams(event.params);
    return errorParams ? eventWithParams(event, errorParams) : null;
  }

  return null;
}

function trimConversationEvents(events: AgentChatEvent[]): AgentChatEvent[] {
  const selected: AgentChatEvent[] = [];
  let totalChars = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const chars = JSON.stringify(event).length;
    if (selected.length >= MAX_CONVERSATION_EVENTS || totalChars + chars > MAX_CONVERSATION_CHARS) {
      break;
    }
    selected.push(event);
    totalChars += chars;
  }
  return selected.reverse();
}

function coalesceDelta(
  events: AgentChatEvent[],
  event: AgentChatEvent,
  id: string,
): AgentChatEvent[] | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const existing = events[index]!;
    if (existing.method !== event.method || eventItemId(existing) !== id) continue;
    const existingParams = record(existing.params);
    const nextParams = record(event.params);
    const previousDelta = existingParams?.delta;
    const nextDelta = nextParams?.delta;
    if (typeof previousDelta !== 'string' || typeof nextDelta !== 'string') return null;
    const next = [...events];
    next[index] = {
      ...event,
      id: existing.id,
      params: { ...nextParams, delta: previousDelta + nextDelta },
    };
    return next;
  }
  return null;
}

export function appendConversationEvent(
  events: AgentChatEvent[],
  event: AgentChatEvent,
): AgentChatEvent[] {
  if (event.method === 'turn/completed') {
    const completedTurnId = eventTurnId(event);
    if (!completedTurnId) return events;
    return events.filter(
      existing =>
        !(existing.method === 'turn/started' && eventTurnId(existing) === completedTurnId),
    );
  }

  const minimal = minimalConversationEvent(event);
  if (!minimal) return events;
  const id = eventItemId(minimal);

  if (minimal.method === 'turn/started') {
    return trimConversationEvents([
      ...events.filter(existing => existing.method !== 'chat/preparing'),
      minimal,
    ]);
  }

  if (minimal.kind === 'error' || minimal.method === 'chat/error') {
    return trimConversationEvents([
      ...events.filter(existing => existing.method !== 'chat/preparing'),
      minimal,
    ]);
  }

  if (minimal.method === 'item/completed' && id) {
    return trimConversationEvents([
      ...events.filter(existing => eventItemId(existing) !== id),
      minimal,
    ]);
  }

  if (
    id &&
    isAgentChatStreamMethod(minimal.method) &&
    AGENT_CHAT_STREAM_FIELDS[minimal.method] === 'delta'
  ) {
    const coalesced = coalesceDelta(events, minimal, id);
    if (coalesced) return trimConversationEvents(coalesced);
  }

  if (
    id &&
    isAgentChatStreamMethod(minimal.method) &&
    AGENT_CHAT_STREAM_FIELDS[minimal.method] === 'message'
  ) {
    return trimConversationEvents([
      ...events.filter(
        existing => !(existing.method === minimal.method && eventItemId(existing) === id),
      ),
      minimal,
    ]);
  }

  return trimConversationEvents([...events, minimal]);
}

export function rebuildConversationEvents(events: AgentChatEvent[]): AgentChatEvent[] {
  return events.reduce(appendConversationEvent, [] as AgentChatEvent[]);
}

export function conversationEventsForStorage(events: AgentChatEvent[]): AgentChatEvent[] {
  return trimConversationEvents(events);
}
