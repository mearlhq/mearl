import { createSseEventParser, type ParsedSseEvent } from './sseParser.js';

export class UnexpectedSseResponseError extends Error {
  constructor(readonly body: string, readonly status: number) {
    super(`Unexpected SSE response (${status})`);
    this.name = 'UnexpectedSseResponseError';
  }
}

/** Streams decoded events in order without retaining the raw response. */
export async function consumeSseResponse(response: Response, receive: (event: ParsedSseEvent) => void | Promise<void>): Promise<unknown> {
  if (!response.ok || !response.body || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) throw new UnexpectedSseResponseError(await response.text(), response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseEventParser();
  let lastData: unknown = null;
  let complete = false;
  const emit = async (text: string, finished = false) => {
    for (const event of [...parser.push(text), ...(finished ? parser.finish() : [])]) {
      lastData = event.data;
      await receive(event);
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { await emit(decoder.decode(), true); complete = true; return lastData; }
      await emit(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
