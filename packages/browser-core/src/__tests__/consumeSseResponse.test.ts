import { expect, it } from 'vitest';
import { consumeSseResponse, UnexpectedSseResponseError } from '../consumeSseResponse.js';
import { parseJsonResponseText } from '../responseText.js';
it('preserves JSON, JSONP and plain-text responses without executing wrappers', () => {
  expect(parseJsonResponseText('{"text":"中文"}')).toEqual({ text: '中文' });
  expect(parseJsonResponseText('callback({"text":"中文"});')).toEqual({ text: '中文' });
  expect(parseJsonResponseText('callback(not_json);')).toBe('callback(not_json);');
  expect(parseJsonResponseText('plain text')).toBe('plain text');
});
it('decodes split UTF-8, retains event IDs and awaits each callback before the next', async () => {
  const bytes = new TextEncoder().encode('id: next\ndata: {"text":"中文"}\n\ndata: 0\n\ndata: [DONE]\n\n');
  const order: string[] = [];
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const value = await consumeSseResponse(response, async event => {
    order.push('start:' + JSON.stringify(event.data));
    expect(event.eventId).toBe('next');
    await Promise.resolve();
    order.push('end:' + JSON.stringify(event.data));
  });
  expect(value).toBe(0);
  expect(order).toEqual(['start:{"text":"中文"}', 'end:{"text":"中文"}', 'start:0', 'end:0']);
  expect(response.body?.locked).toBe(false);
});
it('flushes a final event without a terminating line and preserves an empty stream result', async () => {
  const values: unknown[] = [];
  expect(await consumeSseResponse(new Response('data: false', { headers: { 'Content-Type': 'text/event-stream' } }), event => { values.push(event.data); })).toBe(false);
  expect(values).toEqual([false]);
  expect(await consumeSseResponse(new Response(': heartbeat\n\n', { headers: { 'Content-Type': 'text/event-stream' } }), () => {})).toBeNull();
});
it('reports a non-stream response to the protocol layer with the original body', async () => {
  const response = new Response('callback({"message":"expired"});', { status: 403 });
  await expect(consumeSseResponse(response, () => {})).rejects.toMatchObject({ name: 'UnexpectedSseResponseError', status: 403, body: 'callback({"message":"expired"});' });
  expect(new UnexpectedSseResponseError('body', 400)).toBeInstanceOf(Error);
});
it('cancels and releases the reader if the receiving controller fails', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: 1\n\n')); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  await expect(consumeSseResponse(response, () => { throw new Error('owner closed'); })).rejects.toThrow('owner closed');
  expect(cancelled).toBe(true); expect(response.body?.locked).toBe(false);
});
