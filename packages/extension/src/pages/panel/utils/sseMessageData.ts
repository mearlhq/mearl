import { SSEMessage } from '../types';

const MAX_JSON_LAYERS = 5;

export const normalizeSseMessageData = (value: any): any => {
  if (typeof value !== 'string') return value;

  let candidate = value.trim();
  if (!candidate) return value;

  for (let depth = 0; depth < MAX_JSON_LAYERS; depth++) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object') return parsed;
      if (typeof parsed !== 'string') return value;
      candidate = parsed.trim();
      if (!candidate) return value;
    } catch {
      return value;
    }
  }

  return value;
};

const unwrapSseMessageData = (value: any): any => {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'event' in value &&
    'data' in value
  ) {
    return value.data;
  }
  return value;
};

export const serializeSseMessageData = (value: any): string => {
  const unwrapped = unwrapSseMessageData(value);
  const normalized = normalizeSseMessageData(unwrapped);

  if (normalized !== unwrapped) return JSON.stringify(normalized);
  if (typeof unwrapped === 'string') return unwrapped;

  return JSON.stringify(unwrapped) ?? '';
};

export const buildSseOverrideMessages = (
  messages: SSEMessage[],
  modifiedData: any[],
): SSEMessage[] =>
  messages.map((message, index) => ({
    event: message.event,
    data: serializeSseMessageData(modifiedData[index] ?? message.data),
    eventId: message.eventId,
    timestamp: message.timestamp,
    duration: message.duration,
  }));
