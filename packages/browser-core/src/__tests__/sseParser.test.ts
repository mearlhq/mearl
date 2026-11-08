import { describe, expect, it } from 'vitest';
import { createSseEventParser, parseSseDataValue } from '../sseParser.js';

describe('SSE parser', () => {
  it('parses split CRLF frames, multiline data, ids, and JSON values', () => {
    const parser = createSseEventParser();

    expect(parser.push('id: evt-1\r')).toEqual([]);
    expect(parser.push('\nevent: update\r\ndata: {"part":1}\r\n\r')).toEqual([]);
    expect(parser.push('\ndata: first\ndata: second\n\n')).toEqual([
      { event: 'update', eventId: 'evt-1', data: { part: 1 } },
      { event: 'message', eventId: 'evt-1', data: 'first\nsecond' },
    ]);
  });

  it('ignores comments and done sentinels, then flushes a final unterminated frame', () => {
    const parser = createSseEventParser();

    expect(parser.push(': heartbeat\n\ndata: [DONE]\n\ndata: tail')).toEqual([]);
    expect(parser.finish()).toEqual([{ event: 'message', data: 'tail' }]);
  });

  it('keeps non-JSON values unchanged', () => {
    expect(parseSseDataValue('plain text')).toBe('plain text');
    expect(parseSseDataValue('null')).toBeNull();
  });
});
