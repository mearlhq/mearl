export interface ParsedSseEvent {
  event: string;
  data: unknown;
  eventId?: string;
}

export interface SseEventParser {
  push(chunk: string): ParsedSseEvent[];
  finish(): ParsedSseEvent[];
}

export function parseSseDataValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Incrementally parses UTF-8-decoded Server-Sent Events without retaining the raw stream. */
export function createSseEventParser(): SseEventParser {
  let buffer = '';
  let eventName = '';
  let lastEventId: string | undefined;
  let dataLines: string[] = [];
  let hasData = false;

  const dispatch = (): ParsedSseEvent[] => {
    if (!hasData) {
      eventName = '';
      dataLines = [];
      return [];
    }

    const rawData = dataLines.join('\n');
    eventName = eventName || 'message';
    dataLines = [];
    hasData = false;
    if (rawData === '[DONE]') {
      eventName = '';
      return [];
    }
    const event: ParsedSseEvent = {
      event: eventName,
      data: parseSseDataValue(rawData),
      ...(lastEventId !== undefined ? { eventId: lastEventId } : {}),
    };
    eventName = '';
    return [event];
  };

  const consumeLine = (line: string): ParsedSseEvent[] => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return [];

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') {
      dataLines.push(value);
      hasData = true;
    } else if (field === 'event') {
      eventName = value;
    } else if (field === 'id' && !value.includes('\0')) {
      lastEventId = value;
    }
    return [];
  };

  const drain = (final: boolean): ParsedSseEvent[] => {
    const events: ParsedSseEvent[] = [];
    while (buffer.length > 0) {
      let newlineIndex = -1;
      for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] === '\n' || buffer[index] === '\r') {
          newlineIndex = index;
          break;
        }
      }
      if (newlineIndex === -1) {
        if (final) {
          events.push(...consumeLine(buffer));
          buffer = '';
        }
        break;
      }
      if (buffer[newlineIndex] === '\r' && newlineIndex === buffer.length - 1 && !final) break;

      const line = buffer.slice(0, newlineIndex);
      const separatorLength =
        buffer[newlineIndex] === '\r' && buffer[newlineIndex + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(newlineIndex + separatorLength);
      events.push(...consumeLine(line));
    }
    if (final) events.push(...dispatch());
    return events;
  };

  return {
    push(chunk: string): ParsedSseEvent[] {
      buffer += chunk;
      return drain(false);
    },
    finish(): ParsedSseEvent[] {
      return drain(true);
    },
  };
}
