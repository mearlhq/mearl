import { describe, expect, it, vi } from 'vitest';
import register, { toolbox } from '../../format-converter/scripts/main.mjs';

const codec = globalThis.mearlFormatCodec;
const convert = (format, direction, value, options = {}) => codec.convert({ format, direction, value, ...options });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

describe('local format converter', () => {
  it('roundtrips UTF-8 including Chinese, emoji, BOM and null characters', () => {
    for (const value of ['你好，世界 🚀', '\uFEFFtext\u0000\n', '', 'plain text']) {
      const encoded = convert('base64', 'encode', value).value;
      expect(convert('base64', 'decode', encoded).value).toBe(value);
    }
    expect(convert('base64', 'encode', '你好').value).toBe('5L2g5aW9');
    expect(convert('base64', 'decode', '8J-agA').value).toBe('🚀');
    expect(convert('base64', 'decode', '5L2g\n5aW9').value).toBe('你好');
  });

  it('rejects malformed Base64 and binary content that is not UTF-8 text', () => {
    for (const value of ['a', '???', 'ab=c', 'Zg=', 'Zh==']) expect(() => convert('base64', 'decode', value)).toThrow('INVALID_BASE64');
    expect(() => convert('base64', 'decode', '/w==')).toThrow('INVALID_UTF8');
  });

  it('encodes plain text as a component without treating plus as a form-space', () => {
    const value = '你好 + /?&=#';
    const encoded = convert('url', 'encode', value).value;
    expect(encoded).toBe('%E4%BD%A0%E5%A5%BD%20%2B%20%2F%3F%26%3D%23');
    expect(convert('url', 'decode', encoded).value).toBe(value);
    expect(convert('url', 'decode', 'a+b').value).toBe('a+b');
    expect(() => convert('url', 'decode', '%E0%A4%A')).toThrow('INVALID_URL');
  });

  it('preserves complete URL structure and existing escapes', () => {
    const plain = 'https://docs.example.com/features/encoding';
    expect(convert('url', 'encode', plain).value).toBe(plain);
    const value = 'https://example.com/路径/a b?q=你好&x=+#片段';
    const encoded = 'https://example.com/%E8%B7%AF%E5%BE%84/a%20b?q=%E4%BD%A0%E5%A5%BD&x=+#%E7%89%87%E6%AE%B5';
    expect(convert('url', 'encode', value).value).toBe(encoded);
    expect(convert('url', 'decode', encoded).value).toBe(value);
    expect(convert('url', 'encode', encoded).value).toBe(encoded);
    for (const url of ['https://example.com/a%2Fb?q=a%26b%3Dc%23d&next=https%3A%2F%2Fexample.com', '//example.com/a%20b', 'myapp://open/path?x=1&y=2', 'https://[::1]:8080/path']) {
      expect(convert('url', 'encode', url).value).toBe(url);
    }
    const escaped = 'https://example.com/a%2Fb?q=a%26b%3Dc%23d';
    expect(convert('url', 'decode', escaped).value).toBe(escaped);
    expect(convert('url', 'decode', encodeURIComponent(plain)).value).toBe(plain);
    expect(convert('url', 'encode', 'https://example.com/100%').value).toBe('https://example.com/100%25');
    expect(codec.analyze({ value: plain })).toMatchObject({ kind: 'text', fields: [{ id: 'base64' }, { id: 'url', value: plain }] });
    expect(codec.analyze({ value: encoded })).toMatchObject({ kind: 'url', fields: [{ id: 'text', value }] });
    expect(codec.reverse({ kind: 'url', field: 'text', value }).input).toBe(encoded);
    expect(codec.reverse({ kind: 'text', field: 'url', value: encoded }).input).toBe(value);
  });

  it('recognizes seconds and milliseconds and preserves fractional and negative epochs', () => {
    expect(convert('timestamp', 'decode', '1700000000', { zone: 'utc' })).toMatchObject({ value: '2023-11-14 22:13:20.000', unit: 'seconds', milliseconds: 1700000000000 });
    expect(convert('timestamp', 'decode', '1700000000123', { zone: 'utc' })).toMatchObject({ value: '2023-11-14 22:13:20.123', unit: 'milliseconds' });
    expect(convert('timestamp', 'decode', '1.001', { zone: 'utc' }).value).toBe('1970-01-01 00:00:01.001');
    expect(convert('timestamp', 'decode', '-0.001', { zone: 'utc' }).value).toBe('1969-12-31 23:59:59.999');
    expect(convert('timestamp', 'decode', '0', { zone: 'utc' }).value).toBe('1970-01-01 00:00:00.000');
    expect(() => convert('timestamp', 'decode', '1000.123', { unit: 'milliseconds' })).toThrow('INVALID_TIMESTAMP');
  });

  it('encodes dates with explicit offsets and checks calendar validity', () => {
    expect(convert('timestamp', 'encode', '2023-11-15 06:13:20+08:00', { unit: 'seconds' }).value).toBe('1700000000');
    expect(convert('timestamp', 'encode', '2023-11-14T22:13:20.123Z').value).toBe('1700000000123');
    expect(convert('timestamp', 'encode', '2024-02-29', { zone: 'utc' }).iso).toBe('2024-02-29T00:00:00.000Z');
    for (const value of ['2023-02-29', '2024-02-31', '2024-13-01', '2024-01-01 24:00:00', '2024-01-01T00:00:00+25:00', '10/16/2026']) expect(() => convert('timestamp', 'encode', value)).toThrow('INVALID_DATE');
    const local = convert('timestamp', 'decode', '1700000000123', { zone: 'local' });
    expect(convert('timestamp', 'encode', local.value, { zone: 'local' }).value).toBe('1700000000123');
    expect(local.offset).toBe(-new Date(1700000000123).getTimezoneOffset());
  });

  it('normalizes bare image Base64 and Data URLs using actual image bytes', () => {
    const result = convert('image', 'decode', png);
    expect(result).toMatchObject({ value: `data:image/png;base64,${png}`, image: { mime: 'image/png', base64: png } });
    expect(convert('image', 'encode', `data:application/octet-stream;base64,${png}`).value).toBe(result.value);
    expect(codec.imageFromBytes(Uint8Array.from(Buffer.from(png, 'base64')))).toEqual(result);
    expect(() => convert('image', 'decode', btoa('<svg onload="alert(1)"></svg>'))).toThrow('INVALID_IMAGE');
    expect(() => convert('image', 'decode', 'data:image/png,not-base64')).toThrow('INVALID_IMAGE');
  });

  it('detects formats without requiring a type and leaves empty results blank', () => {
    expect(codec.analyze({ value: '' })).toEqual({ kind: 'text', fields: [] });
    expect(codec.analyze({ value: '你好' })).toEqual({ kind: 'text', fields: [{ id: 'base64', value: '5L2g5aW9' }, { id: 'url', value: '%E4%BD%A0%E5%A5%BD' }] });
    expect(codec.analyze({ value: 'aGVsbG8=' })).toMatchObject({ kind: 'base64', fields: [{ id: 'text', value: 'hello' }] });
    expect(codec.analyze({ value: 'a+b%20c' })).toMatchObject({ kind: 'url', fields: [{ id: 'text', value: 'a+b c' }] });
    expect(codec.analyze({ value: png })).toMatchObject({ kind: 'image', image: `data:image/png;base64,${png}` });
    expect(codec.analyze({ value: '1700000000', zone: 'utc' })).toMatchObject({ kind: 'timestamp', fields: [{ id: 'date', value: '2023-11-14 22:13:20.000' }] });
    expect(codec.analyze({ value: '2023-11-14T22:13:20.123Z' })).toMatchObject({ kind: 'date', fields: [{ id: 'seconds', value: '1700000000.123' }, { id: 'milliseconds', value: '1700000000123' }] });
    for (const value of ['hello', '123', '正常文字']) expect(codec.analyze({ value }).kind).toBe('text');
    expect(() => codec.analyze({ value: '2023-02-29' })).toThrow('INVALID_DATE');
    expect(() => codec.analyze({ value: '%E0%A4%A' })).toThrow('INVALID_URL');
    expect(() => codec.analyze({ value: '/w==' })).toThrow('INVALID_UTF8');
  });

  it('reverses each detected result without reinterpreting editable plain text', () => {
    expect(codec.reverse({ kind: 'text', field: 'base64', value: 'aGVsbG8=' })).toMatchObject({ input: 'hello', analysis: { kind: 'text' } });
    expect(codec.reverse({ kind: 'base64', field: 'text', value: '1700000000' })).toMatchObject({ input: btoa('1700000000'), analysis: { kind: 'base64' } });
    expect(codec.reverse({ kind: 'timestamp', field: 'date', value: '2023-11-14T22:13:20Z', unit: 'seconds' }).input).toBe('1700000000');
    expect(codec.reverse({ kind: 'date', field: 'seconds', value: '1700000000.123', zone: 'utc' })).toMatchObject({ input: '2023-11-14 22:13:20.123', analysis: { fields: [{ id: 'seconds', value: '1700000000.123' }, { id: 'milliseconds', value: '1700000000123' }] } });
  });

  it('bounds content and exposes a stateless plugin without host calls', async () => {
    expect(() => codec.imageFromBytes(new Uint8Array(codec.MAX_BYTES + 1))).toThrow('TOO_LARGE');
    expect(() => convert('base64', 'encode', 'a'.repeat(codec.MAX_BYTES + 1))).toThrow('TOO_LARGE');
    expect(() => convert('unknown', 'decode', 'data')).toThrow('INVALID_OPTIONS');
    const commands = new Map(), invoke = vi.fn();
    register({ command(name, handler) { commands.set(name, handler); }, invoke });
    expect(await commands.get('convert')({ format: 'base64', direction: 'encode', value: '你好' })).toEqual({ value: '5L2g5aW9' });
    const bytes = Buffer.from(png, 'base64').length;
    expect(commands.get('convert')({ value: png })).toEqual({ kind: 'image', fields: [], image: `data:image/png;base64,${png}`, meta: { mime: 'image/png', bytes } });
    expect(commands.get('convert')({ format: 'image', direction: 'decode', value: png })).toEqual({ value: `data:image/png;base64,${png}`, image: { mime: 'image/png', bytes } });
    expect(invoke).not.toHaveBeenCalled(); expect(toolbox.icon).toBe('wrench');
  });
});
