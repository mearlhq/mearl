import type { AgentChatEvent } from '@mearl/browser-core';

export interface CompactChatMessage {
  role: 'user' | 'assistant' | 'preparing' | 'thinking' | 'tool' | 'system';
  message: string;
}

export interface CompactChatCard extends CompactChatMessage {
  timestamp: number;
}

const WAITING_MESSAGE = '💭 …';
const UNBOUND_PROGRESS_KEY = '__unbound__';
const MAX_SUMMARY_CHARS = 800;
const MAX_DETAIL_CHARS = 240;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compactText(value: string, maxChars: number, singleLine = false): string {
  const text = singleLine ? value.replace(/\s+/g, ' ').trim() : value.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function errorMessage(params: unknown): string | null {
  const values = record(params);
  const error = record(values?.error);
  const value = values?.message ?? error?.message ?? values?.error;
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function statusSymbol(status: unknown, completed: boolean): string {
  if (status === 'failed' || status === 'declined') return '✗';
  return completed || status === 'completed' ? '✓' : '…';
}

function changedPaths(item: Record<string, unknown>): string {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const paths = changes
    .map(change => record(change)?.path)
    .filter((path): path is string => typeof path === 'string');
  const changeCount =
    typeof item.changeCount === 'number' && item.changeCount >= paths.length
      ? item.changeCount
      : paths.length;
  const visible = paths.slice(0, 3).join(', ');
  return changeCount > 3 ? `${visible}, +${changeCount - 3}` : visible || '…';
}

function itemPresentation(
  item: Record<string, unknown>,
  completed: boolean,
): Pick<CompactChatMessage, 'role' | 'message'> | null {
  const symbol = statusSymbol(item.status, completed);

  switch (item.type) {
    case 'reasoning': {
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((part): part is string => typeof part === 'string').join('\n')
        : '';
      return {
        role: 'thinking',
        message: summary ? `💭 ${compactText(summary, MAX_SUMMARY_CHARS)}` : WAITING_MESSAGE,
      };
    }
    case 'plan':
      return {
        role: 'thinking',
        message:
          typeof item.text === 'string' && item.text.trim()
            ? `📋 ${compactText(item.text, MAX_SUMMARY_CHARS)}`
            : '📋 …',
      };
    case 'commandExecution':
      return {
        role: 'tool',
        message: `${symbol} $ ${compactText(String(item.command || ''), MAX_DETAIL_CHARS, true)}`,
      };
    case 'fileChange':
      return { role: 'tool', message: `${symbol} ✎ ${changedPaths(item)}` };
    case 'mcpToolCall':
      return {
        role: 'tool',
        message: `${symbol} ⚙ ${String(item.server || '')}/${String(item.tool || '')}`,
      };
    case 'dynamicToolCall':
      return {
        role: 'tool',
        message: `${symbol} ⚙ ${item.namespace ? `${String(item.namespace)}/` : ''}${String(item.tool || '')}`,
      };
    case 'webSearch':
      return {
        role: 'tool',
        message: `${symbol} ⌕ ${compactText(String(item.query || ''), MAX_DETAIL_CHARS, true)}`,
      };
    case 'imageView':
      return {
        role: 'tool',
        message: `${symbol} ◉ ${compactText(String(item.path || ''), MAX_DETAIL_CHARS, true)}`,
      };
    default:
      return null;
  }
}

function itemId(params: Record<string, unknown> | null): string | null {
  return typeof params?.itemId === 'string' ? params.itemId : null;
}

function turnId(params: Record<string, unknown> | null): string | null {
  if (typeof params?.turnId === 'string') return params.turnId;
  const turn = record(params?.turn);
  return typeof turn?.id === 'string' ? turn.id : null;
}

export function toCompactChatCards(
  events: AgentChatEvent[],
  sessionReconnectedMessage?: string,
): CompactChatCard[] {
  const messages: CompactChatCard[] = [];
  const itemMessages = new Map<string, CompactChatCard>();
  const itemDescriptions = new Map<string, string>();
  const reasoningSummaries = new Map<string, string>();
  const planTexts = new Map<string, string>();
  const itemTurnIds = new Map<string, string>();
  const turnProgressMessages = new Map<string, CompactChatCard>();
  let activeTurnId: string | null = null;

  const removeMessage = (message: CompactChatCard) => {
    const index = messages.indexOf(message);
    if (index >= 0) messages.splice(index, 1);
  };

  const resolveTurnId = (
    params: Record<string, unknown> | null,
    id?: string | null,
  ): string | null => turnId(params) || (id ? itemTurnIds.get(id) || null : null) || activeTurnId;

  const removeTurnProgress = (id: string | null) => {
    const key = id || UNBOUND_PROGRESS_KEY;
    const progress = turnProgressMessages.get(key);
    if (progress) removeMessage(progress);
    turnProgressMessages.delete(key);
  };

  const upsertTurnProgress = (
    id: string | null,
    value: Pick<CompactChatMessage, 'role' | 'message'>,
    timestamp: number,
  ): CompactChatCard => {
    const key = id || UNBOUND_PROGRESS_KEY;
    let message = turnProgressMessages.get(key);
    if (!message) {
      message = { ...value, timestamp };
      messages.push(message);
    } else {
      message.role = value.role;
      message.message = value.message;
      message.timestamp = timestamp;
    }
    turnProgressMessages.set(key, message);
    return message;
  };

  const upsertAgentMessage = (
    id: string,
    value: Pick<CompactChatMessage, 'role' | 'message'>,
    currentTurnId: string | null,
    timestamp: number,
  ): CompactChatCard => {
    removeTurnProgress(currentTurnId);
    removeTurnProgress(null);
    let message = itemMessages.get(id);
    if (!message) {
      message = { ...value, timestamp };
      messages.push(message);
    } else {
      message.role = value.role;
      message.message = value.message;
      message.timestamp = timestamp;
    }
    itemMessages.set(id, message);
    return message;
  };

  for (const event of events) {
    const params = record(event.params);

    if (event.method === 'session/reconnected' && sessionReconnectedMessage) {
      messages.push({ role: 'system', message: sessionReconnectedMessage, timestamp: event.timestamp });
      continue;
    }

    if (event.method === 'chat/userMessage') {
      const text = typeof params?.text === 'string' ? params.text : '';
      const imageCount =
        typeof params?.imageCount === 'number' && params.imageCount > 0
          ? Math.floor(params.imageCount)
          : 0;
      const message = [text, imageCount > 0 ? `🖼 ×${imageCount}` : ''].filter(Boolean).join('\n');
      if (message) {
        messages.push({ role: 'user', message, timestamp: event.timestamp });
      }
      continue;
    }

    if (event.method === 'chat/preparing') {
      const startupMessage =
        typeof params?.message === 'string' && params.message.trim()
          ? compactText(params.message, MAX_DETAIL_CHARS)
          : null;
      upsertTurnProgress(
        null,
        {
          role: startupMessage ? 'preparing' : 'thinking',
          message: startupMessage || WAITING_MESSAGE,
        },
        event.timestamp,
      );
      continue;
    }

    if (event.method === 'turn/started') {
      const id = turnId(params);
      if (id) {
        removeTurnProgress(null);
        activeTurnId = id;
        upsertTurnProgress(id, { role: 'thinking', message: WAITING_MESSAGE }, event.timestamp);
      }
      continue;
    }

    if (event.method === 'item/started') {
      const item = record(params?.item);
      const id = typeof item?.id === 'string' ? item.id : null;
      const presentation = item ? itemPresentation(item, false) : null;
      if (id && presentation) {
        const currentTurnId = resolveTurnId(params, id);
        if (currentTurnId) itemTurnIds.set(id, currentTurnId);
        const entry = upsertTurnProgress(currentTurnId, presentation, event.timestamp);
        itemDescriptions.set(id, entry.message.replace(/^… /, ''));
      }
      continue;
    }

    if (event.method === 'item/reasoning/summaryTextDelta') {
      const id = itemId(params);
      const delta = params?.delta;
      if (!id || typeof delta !== 'string' || !delta) continue;
      const summary = `${reasoningSummaries.get(id) || ''}${delta}`;
      reasoningSummaries.set(id, summary);
      const currentTurnId = resolveTurnId(params, id);
      if (currentTurnId) itemTurnIds.set(id, currentTurnId);
      upsertTurnProgress(
        currentTurnId,
        {
          role: 'thinking',
          message: `💭 ${compactText(summary, MAX_SUMMARY_CHARS)}`,
        },
        event.timestamp,
      );
      continue;
    }

    if (event.method === 'item/plan/delta') {
      const id = itemId(params);
      const delta = params?.delta;
      if (!id || typeof delta !== 'string' || !delta) continue;
      const text = `${planTexts.get(id) || ''}${delta}`;
      planTexts.set(id, text);
      const currentTurnId = resolveTurnId(params, id);
      if (currentTurnId) itemTurnIds.set(id, currentTurnId);
      upsertTurnProgress(
        currentTurnId,
        {
          role: 'thinking',
          message: `📋 ${compactText(text, MAX_SUMMARY_CHARS)}`,
        },
        event.timestamp,
      );
      continue;
    }

    if (event.method === 'item/mcpToolCall/progress') {
      const id = itemId(params);
      const progress = params?.message;
      const description = id ? itemDescriptions.get(id) : null;
      if (!id || !description || typeof progress !== 'string') continue;
      upsertTurnProgress(
        resolveTurnId(params, id),
        {
          role: 'tool',
          message: `… ${description} — ${compactText(progress, MAX_DETAIL_CHARS, true)}`,
        },
        event.timestamp,
      );
      continue;
    }

    if (event.method === 'item/agentMessage/delta') {
      const id = itemId(params);
      const delta = params?.delta;
      if (!id || typeof delta !== 'string' || !delta) continue;
      const currentTurnId = resolveTurnId(params, id);
      if (currentTurnId) itemTurnIds.set(id, currentTurnId);
      const existing = itemMessages.get(id);
      if (existing) {
        existing.message += delta;
        existing.timestamp = event.timestamp;
      } else {
        upsertAgentMessage(
          id,
          { role: 'assistant', message: delta },
          currentTurnId,
          event.timestamp,
        );
      }
      continue;
    }

    if (event.method === 'item/completed') {
      const item = record(params?.item);
      const id = typeof item?.id === 'string' ? item.id : null;
      if (!item || !id) continue;
      const currentTurnId = resolveTurnId(params, id);
      if (currentTurnId) itemTurnIds.set(id, currentTurnId);

      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        upsertAgentMessage(
          id,
          { role: 'assistant', message: item.text },
          currentTurnId,
          event.timestamp,
        );
        continue;
      }

      const presentation = itemPresentation(item, true);
      if (presentation) {
        const entry = upsertTurnProgress(currentTurnId, presentation, event.timestamp);
        itemDescriptions.set(id, entry.message.replace(/^[✓✗…] /, ''));
      }
      continue;
    }

    if (event.method === 'turn/completed') {
      const id = turnId(params);
      removeTurnProgress(id);
      if (id === activeTurnId) activeTurnId = null;
      continue;
    }

    if (event.kind === 'error' || event.method === 'chat/error') {
      removeTurnProgress(resolveTurnId(params));
      const message = errorMessage(event.params);
      if (message) messages.push({ role: 'system', message, timestamp: event.timestamp });
    }
  }

  return messages;
}
