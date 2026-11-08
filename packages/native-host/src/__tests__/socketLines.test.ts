import { describe, expect, it } from 'vitest';
import { Utf8LineBuffer } from '../socketLines.js';

describe('Utf8LineBuffer', () => {
  it('preserves a multibyte character split across socket chunks', () => {
    const input = Buffer.from('{"text":"边界首字符"}\n');
    const characterStart = input.indexOf(Buffer.from('首'));
    const buffer = new Utf8LineBuffer(1024);

    expect(buffer.push(input.subarray(0, characterStart + 1))).toEqual({
      lines: [],
      overflow: false,
    });
    expect(buffer.push(input.subarray(characterStart + 1))).toEqual({
      lines: ['{"text":"边界首字符"}'],
      overflow: false,
    });
  });

  it('returns all complete lines and keeps the unfinished suffix', () => {
    const buffer = new Utf8LineBuffer(1024);

    expect(buffer.push(Buffer.from('一\n二\n三'))).toEqual({
      lines: ['一', '二'],
      overflow: false,
    });
    expect(buffer.push(Buffer.from('四\n'))).toEqual({
      lines: ['三四'],
      overflow: false,
    });
  });

  it('rejects an unfinished message above the byte limit', () => {
    const buffer = new Utf8LineBuffer(5);

    expect(buffer.push(Buffer.from('中文'))).toEqual({ lines: [], overflow: true });
  });
});
