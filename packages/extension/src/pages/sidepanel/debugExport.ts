import {
  AGENT_CHAT_STREAM_FIELDS,
  sanitizeBrowserAgentPageUrl,
  type AgentChatEvent,
  type AgentChatEventRetention,
  type AgentChatModelInfo,
  type AgentChatProviderDescriptor,
} from '@mearl/browser-core';
import { toCompactChatCards } from './compactMessages';

const REDACTED_VALUE = '[REDACTED]';
const MAX_STRING_CHARS = 500_000;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 200;
const MAX_DEPTH = 12;
const MAX_URL_QUERY_VALUE_CHARS = 128;
const STREAM_EVENT_METHODS = new Set<string>(Object.keys(AGENT_CHAT_STREAM_FIELDS));
const JSON_TOOL_FIELDS = new Set(['rawInput', 'rawOutput']);

interface BrowserTabDebugContext {
  id: number;
  url?: string;
  title?: string;
}

export interface AgentChatDebugMetadata {
  sessionId?: string;
  providerId: string;
  providerName: string;
  sessionStatus?: string;
  providerSessionId?: string;
  model?: AgentChatModelInfo;
  activeModel?: AgentChatModelInfo;
  workspaceDirectory?: string;
  ephemeral?: boolean;
  tabId?: number;
  initialPageUrl?: string;
  initialPageTitle?: string;
  developerInstructions?: string;
  developerInstructionsSource?: 'session' | 'reconstructed';
  provider?: AgentChatProviderDescriptor;
  extensionVersion?: string;
  nativeHostVersion?: string | null;
  browserTab?: BrowserTabDebugContext;
  clientSettings?: {
    autoApprove: boolean;
    saveToCodexHistory: boolean;
  };
  liveEventCount?: number;
  liveEventLimit?: number;
  replayEventCount?: number;
  replayRetention?: AgentChatEventRetention;
  replayError?: string;
  generatedAt?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizedKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(value: string): boolean {
  const key = normalizedKey(value);
  return (
    key === 'authorization' ||
    key === 'cookie' ||
    key === 'setcookie' ||
    key === 'password' ||
    key === 'secret' ||
    key === 'apikey' ||
    key === 'accesstoken' ||
    key === 'refreshtoken' ||
    key === 'idtoken' ||
    key === 'email' ||
    key === 'phone' ||
    key === 'mobile' ||
    key === 'telephone' ||
    key === 'idcard' ||
    key === 'identitynumber' ||
    key === 'passportnumber' ||
    key.endsWith('token')
  );
}

function sanitizeDebugUrl(value: string): string {
  const sanitized = sanitizeBrowserAgentPageUrl(value);
  try {
    const url = new URL(sanitized);
    const entries = [...url.searchParams.entries()];
    for (const [key, nestedValue] of entries) {
      if (nestedValue.length > MAX_URL_QUERY_VALUE_CHARS) {
        url.searchParams.set(key, `[omitted long query value: ${nestedValue.length} chars]`);
      }
    }
    return url.toString();
  } catch {
    return sanitized;
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED_VALUE)
    .replace(/(?<!\d)(?:\d[\s-]*){12,18}[\dXx](?![\dXx])/g, REDACTED_VALUE)
    .replace(/(?<![\dA-Za-z])(?:\+?\d[\s().-]*){9,14}\d(?![\dA-Za-z])/g, REDACTED_VALUE);
}

function sanitizeEmbeddedUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, url => sanitizeDebugUrl(url));
}

function sanitizeString(value: string): string {
  const dataUrl = /^data:([^;,]+)(?:;[^,]*)?,/i.exec(value);
  if (dataUrl) {
    return `[omitted data URL: ${dataUrl[1] || 'unknown'}, ${value.length} chars]`;
  }
  if (value.length > 2_048 && /^[a-z0-9+/]+={0,2}$/i.test(value)) {
    return `[omitted base64: ${value.length} chars]`;
  }

  value = sanitizeEmbeddedUrls(value);
  value = redactSensitiveText(value);

  if (value.length <= MAX_STRING_CHARS) return value;
  const edgeChars = Math.floor(MAX_STRING_CHARS / 2);
  const omittedChars = value.length - edgeChars * 2;
  return `${value.slice(0, edgeChars)}\n… [truncated ${omittedChars} middle chars] …\n${value.slice(
    -edgeChars,
  )}`;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return String(value);
  if (depth >= MAX_DEPTH) return '[omitted: max depth]';
  if (seen.has(value)) return '[circular]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length === 2 && typeof value[0] === 'string' && isSensitiveKey(value[0])) {
        return [value[0], REDACTED_VALUE];
      }
      if (value.length <= MAX_ARRAY_ITEMS) {
        return value.map(item => sanitizeValue(item, seen, depth + 1));
      }
      const edgeItems = Math.floor(MAX_ARRAY_ITEMS / 2);
      return [
        ...value.slice(0, edgeItems).map(item => sanitizeValue(item, seen, depth + 1)),
        `[omitted ${value.length - edgeItems * 2} middle array items]`,
        ...value.slice(-edgeItems).map(item => sanitizeValue(item, seen, depth + 1)),
      ];
    }

    const values = value as Record<string, unknown>;
    const namedSensitiveValue = typeof values.name === 'string' && isSensitiveKey(values.name);
    const entries = Object.entries(values).slice(0, MAX_OBJECT_KEYS);
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of entries) {
      result[key] =
        isSensitiveKey(key) || (namedSensitiveValue && normalizedKey(key) === 'value')
          ? REDACTED_VALUE
          : sanitizeValue(nestedValue, seen, depth + 1);
    }
    if (Object.keys(values).length > MAX_OBJECT_KEYS) {
      result.__omittedKeys = Object.keys(values).length - MAX_OBJECT_KEYS;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function isoTimestamp(timestamp: number): string {
  const value = new Date(timestamp);
  return Number.isNaN(value.getTime()) ? String(timestamp) : value.toISOString();
}

function conversationMessages(events: AgentChatEvent[], sanitizeMessages: boolean) {
  return toCompactChatCards(events)
    .filter(message => ['user', 'assistant', 'system'].includes(message.role))
    .map(message => ({
      timestamp: isoTimestamp(message.timestamp),
      role: message.role,
      message: sanitizeMessages ? sanitizeString(message.message) : message.message,
    }));
}

function publicInsights(events: AgentChatEvent[]) {
  return events.flatMap(event => {
    const params = record(event.params);
    const item = record(params?.item);
    const turnId = typeof params?.turnId === 'string' ? params.turnId : undefined;
    if (event.method === 'item/reasoning/summaryTextDelta') {
      const text = typeof params?.delta === 'string' ? params.delta : '';
      const itemId = typeof params?.itemId === 'string' ? params.itemId : undefined;
      return text
        ? [
            {
              timestamp: isoTimestamp(event.timestamp),
              type: 'reasoning-summary',
              ...(turnId ? { turnId } : {}),
              ...(itemId ? { itemId } : {}),
              text: sanitizeString(text),
            },
          ]
        : [];
    }
    if (event.method === 'item/plan/delta') {
      const text = typeof params?.delta === 'string' ? params.delta : '';
      const itemId = typeof params?.itemId === 'string' ? params.itemId : undefined;
      return text
        ? [
            {
              timestamp: isoTimestamp(event.timestamp),
              type: 'plan',
              ...(turnId ? { turnId } : {}),
              ...(itemId ? { itemId } : {}),
              text: sanitizeString(text),
            },
          ]
        : [];
    }
    if (event.method !== 'item/completed' || !item) return [];
    const itemId = typeof item.id === 'string' ? item.id : undefined;
    if (item.type === 'reasoning') {
      const text = Array.isArray(item.summary)
        ? item.summary.filter(value => typeof value === 'string').join('\n')
        : '';
      return text
        ? [
            {
              timestamp: isoTimestamp(event.timestamp),
              type: 'reasoning-summary',
              ...(turnId ? { turnId } : {}),
              ...(itemId ? { itemId } : {}),
              text: sanitizeString(text),
            },
          ]
        : [];
    }
    if (item.type === 'plan' && typeof item.text === 'string' && item.text) {
      return [
        {
          timestamp: isoTimestamp(event.timestamp),
          type: 'plan',
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          text: sanitizeString(item.text),
        },
      ];
    }
    return [];
  });
}

function latestTokenUsage(events: AgentChatEvent[]) {
  const usageByTurn = new Map<string, AgentChatEvent>();
  for (const event of events) {
    if (event.method !== 'thread/tokenUsage/updated') continue;
    const params = record(event.params);
    const turnId = typeof params?.turnId === 'string' ? params.turnId : 'thread';
    usageByTurn.set(turnId, event);
  }
  return [...usageByTurn.entries()].map(([scope, event]) => ({
    scope,
    timestamp: isoTimestamp(event.timestamp),
    usage: sanitizeValue(event.params, new WeakSet()),
  }));
}

function turnSummaries(events: AgentChatEvent[]) {
  const turns = new Map<
    string,
    {
      turnId: string;
      startedAt?: string;
      completedAt?: string;
      durationMs?: number;
      status?: unknown;
      startedTimestamp?: number;
    }
  >();
  for (const event of events) {
    if (event.method !== 'turn/started' && event.method !== 'turn/completed') continue;
    const params = record(event.params);
    const turn = record(params?.turn);
    const turnId =
      typeof turn?.id === 'string'
        ? turn.id
        : typeof params?.turnId === 'string'
          ? params.turnId
          : null;
    if (!turnId) continue;
    const summary = turns.get(turnId) || { turnId };
    if (event.method === 'turn/started') {
      summary.startedAt = isoTimestamp(event.timestamp);
      summary.startedTimestamp = event.timestamp;
    } else {
      summary.completedAt = isoTimestamp(event.timestamp);
      summary.status = turn?.status;
      if (summary.startedTimestamp !== undefined) {
        summary.durationMs = Math.max(0, event.timestamp - summary.startedTimestamp);
      }
    }
    turns.set(turnId, summary);
  }
  return [...turns.values()].map(({ startedTimestamp: _startedTimestamp, ...summary }) => summary);
}

function sanitizedFields(values: Record<string, unknown>, fields: string[]): unknown | undefined {
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(values, field) && values[field] !== undefined) {
      selected[field] = values[field];
    }
  }
  return Object.keys(selected).length > 0 ? sanitizeValue(selected, new WeakSet()) : undefined;
}

function sanitizeToolField(field: string, value: unknown): unknown {
  if (JSON_TOOL_FIELDS.has(field) && typeof value === 'string') {
    try {
      return JSON.stringify(sanitizeValue(JSON.parse(value), new WeakSet()));
    } catch {
      // Non-JSON raw values still use the regular string sanitizer.
    }
  }
  return sanitizeValue(value, new WeakSet());
}

function preferredSanitizedField(
  values: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> | undefined {
  for (const field of fields) {
    const value = values[field];
    if (value === undefined || value === null || value === '') continue;
    return { [field]: sanitizeToolField(field, value) };
  }
  return undefined;
}

function sanitizedToolOutput(values: Record<string, unknown>): unknown | undefined {
  const selected =
    preferredSanitizedField(values, [
      'result',
      'output',
      'rawOutput',
      'aggregatedOutput',
      'content',
      'changes',
    ]) || {};
  if (values.locations !== undefined && values.locations !== null) {
    selected.locations = sanitizeToolField('locations', values.locations);
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function parsedToolResult(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function commandFailure(value: unknown):
  | {
      success: false;
      exitCode: number;
      error: unknown;
    }
  | undefined {
  if (typeof value !== 'string') return undefined;
  const exitCodeMatch = /(?:^|\n)Exit Code:\s*(-?\d+)\s*(?:\n|$)/m.exec(value);
  if (!exitCodeMatch?.[1]) return undefined;
  const exitCode = Number(exitCodeMatch[1]);
  if (!Number.isInteger(exitCode) || exitCode === 0) return undefined;
  const outputMatch = /(?:^|\n)Output:\s*([\s\S]*?)\nExit Code:\s*-?\d+/m.exec(value);
  const detail = outputMatch?.[1]?.trim();
  return {
    success: false,
    exitCode,
    error: sanitizeValue(detail || `Command exited with code ${exitCode}`, new WeakSet()),
  };
}

function toolOperation(
  values: Record<string, unknown>,
): { success: boolean; exitCode?: number; error?: unknown } | undefined {
  for (const field of ['result', 'output', 'rawOutput']) {
    const failure = commandFailure(values[field]);
    if (failure) return failure;
    const root = record(parsedToolResult(values[field]));
    if (!root) continue;
    const action = record(root.action);
    const outcome = action || root;
    if (typeof outcome.success !== 'boolean') continue;
    const error = outcome.error ?? root.error;
    return {
      success: outcome.success,
      ...(error !== undefined && error !== null
        ? { error: sanitizeValue(error, new WeakSet()) }
        : {}),
    };
  }
  return undefined;
}

function toolExecutions(events: AgentChatEvent[]) {
  const executions = new Map<
    string,
    {
      itemId: string;
      type: string;
      server?: string;
      namespace?: string;
      tool?: string;
      command?: string;
      input?: unknown;
      output?: unknown;
      operation?: {
        success: boolean;
        exitCode?: number;
        error?: unknown;
      };
      error?: unknown;
      turnId?: string;
      startedAt?: string;
      completedAt?: string;
      durationMs?: number;
      status?: unknown;
      startedTimestamp?: number;
    }
  >();
  for (const event of events) {
    if (event.method !== 'item/started' && event.method !== 'item/completed') continue;
    const params = record(event.params);
    const item = record(params?.item);
    if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') continue;
    if (['agentMessage', 'reasoning', 'plan'].includes(item.type)) continue;
    const execution = executions.get(item.id) || {
      itemId: item.id,
      type: item.type,
    };
    if (typeof params?.turnId === 'string') execution.turnId = params.turnId;
    if (typeof item.server === 'string') execution.server = sanitizeString(item.server);
    if (typeof item.namespace === 'string') execution.namespace = sanitizeString(item.namespace);
    if (typeof item.tool === 'string') execution.tool = sanitizeString(item.tool);
    if (typeof item.command === 'string') execution.command = sanitizeString(item.command);
    execution.input =
      preferredSanitizedField(item, ['arguments', 'input', 'rawInput', 'query', 'path']) ??
      execution.input;
    execution.output = sanitizedToolOutput(item) ?? execution.output;
    execution.operation = toolOperation(item) ?? execution.operation;
    execution.error = sanitizedFields(item, ['error']) ?? execution.error;
    if (item.status !== undefined) {
      execution.status = sanitizeValue(item.status, new WeakSet());
    }
    if (event.method === 'item/started') {
      execution.startedAt = isoTimestamp(event.timestamp);
      execution.startedTimestamp = event.timestamp;
    } else {
      execution.completedAt = isoTimestamp(event.timestamp);
      if (execution.startedTimestamp !== undefined) {
        execution.durationMs = Math.max(0, event.timestamp - execution.startedTimestamp);
      }
    }
    executions.set(item.id, execution);
  }
  return [...executions.values()].map(
    ({ startedTimestamp: _startedTimestamp, ...execution }) => execution,
  );
}

function errorSummaries(events: AgentChatEvent[]) {
  return events.flatMap(event => {
    if (event.kind !== 'error' && event.method !== 'chat/error') return [];
    const params = record(event.params);
    const turnId = typeof params?.turnId === 'string' ? params.turnId : undefined;
    return [
      {
        timestamp: isoTimestamp(event.timestamp),
        method: event.method,
        ...(turnId ? { turnId } : {}),
        details: sanitizeValue(event.params, new WeakSet()),
      },
    ];
  });
}

function eventSummary(events: AgentChatEvent[]) {
  const kindCounts: Record<string, number> = {};
  const methodCounts: Record<string, number> = {};
  for (const event of events) {
    kindCounts[event.kind] = (kindCounts[event.kind] || 0) + 1;
    methodCounts[event.method] = (methodCounts[event.method] || 0) + 1;
  }
  return {
    total: events.length,
    kindCounts,
    methodCounts,
  };
}

function latestRuntimePermissions(events: AgentChatEvent[]): unknown | undefined {
  let latest: unknown | undefined;
  for (const event of events) {
    if (event.method !== 'thread/settings/updated') continue;
    const threadSettings = record(record(event.params)?.threadSettings);
    if (!threadSettings) continue;
    latest =
      sanitizedFields(threadSettings, [
        'approvalPolicy',
        'approvalsReviewer',
        'sandboxPolicy',
        'activePermissionProfile',
      ]) ?? latest;
  }
  return latest;
}

function hasUpstreamTruncation(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => hasUpstreamTruncation(item, seen));
  const values = value as Record<string, unknown>;
  if (values.__transportTruncated === true || values.truncated === true) return true;
  return Object.values(values).some(item => hasUpstreamTruncation(item, seen));
}

export function buildAgentChatConversationExport(events: AgentChatEvent[]): string {
  return JSON.stringify(
    {
      formatVersion: 1,
      type: 'agent-chat-conversation',
      messages: conversationMessages(events, false),
    },
    null,
    2,
  );
}

export function mergeAgentChatDebugEvents(...groups: AgentChatEvent[][]): AgentChatEvent[] {
  const eventsById = new Map<string, AgentChatEvent>();
  for (const event of groups.flat()) {
    const existing = eventsById.get(event.id);
    eventsById.set(
      event.id,
      existing ? { ...event, timestamp: Math.min(existing.timestamp, event.timestamp) } : event,
    );
  }
  const merged = [...eventsById.values()].sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  );
  const completedItemIds = new Set(
    merged.flatMap(event => {
      if (event.method !== 'item/completed') return [];
      const item = record(record(event.params)?.item);
      return typeof item?.id === 'string' ? [item.id] : [];
    }),
  );
  return merged.filter(event => {
    if (!STREAM_EVENT_METHODS.has(event.method)) return true;
    const itemId = record(event.params)?.itemId;
    return typeof itemId !== 'string' || !completedItemIds.has(itemId);
  });
}

export function buildAgentChatDebugExport(
  events: AgentChatEvent[],
  conversationEvents: AgentChatEvent[],
  metadata: AgentChatDebugMetadata,
): string {
  const runtimePermissions = latestRuntimePermissions(events);
  return JSON.stringify(
    {
      formatVersion: 1,
      type: 'agent-chat-debug',
      generatedAt: metadata.generatedAt || new Date().toISOString(),
      session: {
        ...(metadata.sessionId ? { localSessionId: metadata.sessionId } : {}),
        providerId: metadata.providerId,
        providerName: metadata.providerName,
        ...(metadata.sessionStatus ? { status: metadata.sessionStatus } : {}),
        ...(metadata.providerSessionId ? { providerSessionId: metadata.providerSessionId } : {}),
        ...(metadata.model ? { model: metadata.model } : {}),
        ...(metadata.activeModel ? { activeModel: metadata.activeModel } : {}),
        ...(metadata.workspaceDirectory ? { workspaceDirectory: metadata.workspaceDirectory } : {}),
        ...(metadata.ephemeral !== undefined ? { ephemeral: metadata.ephemeral } : {}),
        ...(metadata.tabId !== undefined ? { tabId: metadata.tabId } : {}),
        ...(metadata.initialPageUrl || metadata.initialPageTitle
          ? {
              initialPage: sanitizeValue(
                {
                  ...(metadata.initialPageUrl ? { url: metadata.initialPageUrl } : {}),
                  ...(metadata.initialPageTitle ? { title: metadata.initialPageTitle } : {}),
                },
                new WeakSet(),
              ),
            }
          : {}),
        ...(metadata.developerInstructions
          ? { developerInstructions: sanitizeString(metadata.developerInstructions) }
          : {}),
        ...(metadata.developerInstructionsSource
          ? { developerInstructionsSource: metadata.developerInstructionsSource }
          : {}),
        ...(runtimePermissions ? { runtimePermissions } : {}),
      },
      provider: metadata.provider
        ? sanitizeValue(metadata.provider, new WeakSet())
        : {
            id: metadata.providerId,
            name: metadata.providerName,
          },
      environment: {
        ...(metadata.extensionVersion ? { extensionVersion: metadata.extensionVersion } : {}),
        ...(metadata.nativeHostVersion !== undefined
          ? { nativeHostVersion: metadata.nativeHostVersion }
          : {}),
        ...(metadata.browserTab
          ? { browserTab: sanitizeValue(metadata.browserTab, new WeakSet()) }
          : {}),
        ...(metadata.clientSettings ? { clientSettings: metadata.clientSettings } : {}),
      },
      redaction: {
        sensitiveFields: true,
        contentPatterns: true,
        longQueryValues: true,
        dataUrlsAndBase64: true,
        maxStringChars: MAX_STRING_CHARS,
        privateReasoningIncluded: false,
      },
      retention: {
        exportedEventCount: events.length,
        liveEventCount: metadata.liveEventCount ?? events.length,
        ...(metadata.liveEventLimit
          ? {
              liveBuffer: {
                retainedEvents: metadata.liveEventCount ?? events.length,
                maxEvents: metadata.liveEventLimit,
                possiblyTruncated:
                  (metadata.liveEventCount ?? events.length) >= metadata.liveEventLimit,
              },
            }
          : {}),
        replayEventCount: metadata.replayEventCount ?? 0,
        ...(metadata.replayRetention
          ? { replayBuffer: sanitizeValue(metadata.replayRetention, new WeakSet()) }
          : {}),
        ...(metadata.replayError ? { replayError: sanitizeString(metadata.replayError) } : {}),
        firstEventAt: events[0] ? isoTimestamp(events[0].timestamp) : null,
        lastEventAt: events.at(-1) ? isoTimestamp(events.at(-1)!.timestamp) : null,
        upstreamTruncationDetected: events.some(event => hasUpstreamTruncation(event.params)),
        maxArrayItems: MAX_ARRAY_ITEMS,
        maxObjectKeys: MAX_OBJECT_KEYS,
      },
      eventSummary: eventSummary(events),
      conversation: conversationMessages(conversationEvents, true),
      publicInsights: publicInsights(conversationEvents),
      turns: turnSummaries(events),
      toolExecutions: toolExecutions(events),
      errors: errorSummaries(events),
      tokenUsage: latestTokenUsage(events),
    },
    null,
    2,
  );
}
