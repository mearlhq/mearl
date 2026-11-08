import { describe, it, expect } from 'vitest';
import {
  isFptString,
  parseFptString,
  serializeFptString,
  parseQueryString,
  serializeToQueryString,
  detectFormat,
  tryParseJsonString,
  serializeWithFormat,
  formatRegistry,
} from '../stringFormats';

describe('stringFormats.ts', () => {
  // ==================== FPT ====================
  describe('isFptString', () => {
    it('应该识别标准 FPT 格式', () => {
      expect(isFptString('soid(C12h952)ftuid(pvO8J6su024811.7)')).toBe(true);
      expect(isFptString('a(1)b(2)c(3)')).toBe(true);
    });

    it('只有一个 key(value) 对时应该返回 false', () => {
      expect(isFptString('soid(C12h952)')).toBe(false);
    });

    it('非 FPT 格式应该返回 false', () => {
      expect(isFptString('')).toBe(false);
      expect(isFptString('hello world')).toBe(false);
      expect(isFptString('{"a":1}')).toBe(false);
      expect(isFptString('a=1&b=2')).toBe(false);
    });

    it('非字符串应该返回 false', () => {
      expect(isFptString(null as any)).toBe(false);
      expect(isFptString(123 as any)).toBe(false);
    });

    it('value 可以为空', () => {
      expect(isFptString('a()b()')).toBe(true);
    });
  });

  describe('parseFptString', () => {
    it('应该正确解析标准 FPT 字符串', () => {
      const result = parseFptString('soid(C12h952)ftuid(pvO8J6su024811.7)');
      expect(result).toEqual({ soid: 'C12h952', ftuid: 'pvO8J6su024811.7' });
    });

    it('应该解析带点号 key 的 FPT 字符串', () => {
      const result = parseFptString('a.b(val1)c.d(val2)');
      expect(result).toEqual({ 'a.b': 'val1', 'c.d': 'val2' });
    });

    it('空字符串应该返回空对象', () => {
      expect(parseFptString('')).toEqual({});
    });

    it('空 value 应该解析为空字符串', () => {
      const result = parseFptString('a()b()');
      expect(result).toEqual({ a: '', b: '' });
    });
  });

  describe('serializeFptString', () => {
    it('应该将对象序列化为 FPT 格式', () => {
      const result = serializeFptString({ soid: 'C12h952', ftuid: 'pvO8J6su024811.7' });
      expect(result).toBe('soid(C12h952)ftuid(pvO8J6su024811.7)');
    });

    it('对象 value 应该被 JSON 序列化', () => {
      const result = serializeFptString({ a: { b: 1 } });
      expect(result).toBe('a({"b":1})');
    });

    it('null/undefined value 应该变为空字符串', () => {
      const result = serializeFptString({ a: null, b: undefined });
      expect(result).toBe('a()b()');
    });

    it('非对象输入应该直接转字符串', () => {
      expect(serializeFptString(null as any)).toBe('null');
      expect(serializeFptString('raw' as any)).toBe('raw');
    });
  });

  // ==================== Query String ====================
  describe('parseQueryString', () => {
    it('应该解析标准 query string', () => {
      expect(parseQueryString('a=1&b=2')).toEqual({ a: '1', b: '2' });
    });

    it('应该 URL 解码 value', () => {
      expect(parseQueryString('name=%E5%BC%A0%E4%B8%89')).toEqual({ name: '张三' });
    });

    it('无 value 的 key 应该赋值空字符串', () => {
      expect(parseQueryString('a=1&flag&b=2')).toEqual({ a: '1', flag: '', b: '2' });
    });

    it('空字符串应该返回空对象', () => {
      expect(parseQueryString('')).toEqual({});
    });

    it('value 包含等号时应该保留', () => {
      expect(parseQueryString('token=abc=def')).toEqual({ token: 'abc=def' });
    });

    it('已经是 JSON 的 value 不应提前解码内部字段', () => {
      const bizArgs = encodeURIComponent(JSON.stringify({ order_id: '6612345678901008' }));
      const expdata = JSON.stringify([{ exargs: { bizArgs } }]);
      const result = parseQueryString(`expdata=${expdata}&tlver=2.11.48`);

      expect(JSON.parse(result.expdata)).toEqual([{ exargs: { bizArgs } }]);
    });
  });

  describe('serializeToQueryString', () => {
    it('应该将对象序列化为 query string', () => {
      const result = serializeToQueryString({ a: '1', b: '2' });
      expect(result).toBe('a=1&b=2');
    });

    it('对象 value 应该被 JSON 序列化再 encode', () => {
      const result = serializeToQueryString({ data: { x: 1 } });
      expect(result).toBe('data=%7B%22x%22%3A1%7D');
    });

    it('非对象输入应该直接转字符串', () => {
      expect(serializeToQueryString(null as any)).toBe('null');
    });
  });

  // ==================== detectFormat ====================
  describe('detectFormat', () => {
    it('应该识别 JSON 格式', () => {
      const format = detectFormat('{"a":1}');
      expect(format?.id).toBe('json');
    });

    it('应该识别 URL 编码 JSON 格式', () => {
      const format = detectFormat('%7B%22a%22%3A1%7D');
      expect(format?.id).toBe('encodedJson');
    });

    it('应该识别 query string 格式', () => {
      const format = detectFormat('a=1&b=2');
      expect(format?.id).toBe('queryString');
    });

    it('value 解码后含空格时仍应该识别为 query string', () => {
      const format = detectFormat(
        'expdata=[{"exargs":{"log_time":"2026-08-26 12:43:28.047"}}]&tlver=2.11.48',
      );
      expect(format?.id).toBe('queryString');
    });

    it('含换行的长文本不应误判为 query（即使内部嵌了 a=1&b=2 链接）', () => {
      const markdown =
        '7月初正值盛夏，为你精选了6个目的地。\n\n' +
        '[贵阳](https://gw.alicdn.com/x.png?height=24&width=24&inline=true&mode=inline)' +
        '(#readerActionType=custom&readerActionName=common_start_chat)\n' +
        '夏季均温23℃的避暑之都。';
      expect(detectFormat(markdown)?.id).not.toBe('queryString');
    });

    it('key 含非 URL 安全字符（括号/CJK 等）不应判为 query', () => {
      expect(detectFormat('[贵阳](https://x?height=24&width=24)')?.id).not.toBe('queryString');
    });

    it('应该识别 FPT 格式', () => {
      const format = detectFormat('soid(C12h952)ftuid(pvO8J6su024811.7)');
      expect(format?.id).toBe('fpt');
    });

    it('应该识别 URL 格式', () => {
      const format = detectFormat('https://example.com/path?q=1');
      expect(format?.id).toBe('url');
    });

    it('普通字符串应该返回 undefined', () => {
      expect(detectFormat('hello')).toBeUndefined();
    });

    it('非字符串应该返回 undefined', () => {
      expect(detectFormat(123)).toBeUndefined();
      expect(detectFormat(null)).toBeUndefined();
    });

    it('空字符串应该返回 undefined', () => {
      expect(detectFormat('')).toBeUndefined();
    });
  });

  // ==================== tryParseJsonString ====================
  describe('tryParseJsonString', () => {
    it('应该解析 JSON 字符串', () => {
      const result = tryParseJsonString('{"a":1,"b":"hello"}');
      expect(result.parsed).toEqual({ a: 1, b: 'hello' });
      expect(result.format?.id).toBe('json');
    });

    it('应该解析 URL 编码 JSON', () => {
      const result = tryParseJsonString('%7B%22a%22%3A1%7D');
      expect(result.parsed).toEqual({ a: 1 });
      expect(result.format?.id).toBe('encodedJson');
    });

    it('应该解析 query string', () => {
      const result = tryParseJsonString('foo=bar&baz=qux');
      expect(result.parsed).toEqual({ foo: 'bar', baz: 'qux' });
      expect(result.format?.id).toBe('queryString');
    });

    it('应该解析 FPT 字符串', () => {
      const result = tryParseJsonString('a(1)b(2)');
      expect(result.parsed).toEqual({ a: '1', b: '2' });
      expect(result.format?.id).toBe('fpt');
    });

    it('普通字符串应该原样返回', () => {
      const result = tryParseJsonString('hello world');
      expect(result.parsed).toBe('hello world');
      expect(result.format).toBeUndefined();
    });

    it('非字符串应该原样返回', () => {
      const obj = { x: 1 };
      expect(tryParseJsonString(obj).parsed).toBe(obj);
    });

    it('空字符串应该原样返回', () => {
      const result = tryParseJsonString('  ');
      expect(result.parsed).toBe('  ');
    });

    it('应该解析带前缀的 JSON', () => {
      const result = tryParseJsonString('callback{"a":1}');
      expect(result.parsed).toEqual({ a: 1 });
      expect(result.format?.id).toBe('prefixedJson');
      expect(result.prefix).toBe('callback');
    });

    it('encodedJson 优先于 json 格式（priority 更低）', () => {
      // encodedJson priority=10 < json priority=20
      const encodedJsonFormats = formatRegistry.filter(f => f.id === 'encodedJson');
      const jsonFormats = formatRegistry.filter(f => f.id === 'json');
      expect(encodedJsonFormats[0].priority).toBeLessThan(jsonFormats[0].priority);
    });
  });

  // ==================== serializeWithFormat ====================
  describe('serializeWithFormat', () => {
    it('有 format 时应该使用 format 序列化', () => {
      const jsonFmt = formatRegistry.find(f => f.id === 'json')!;
      const result = serializeWithFormat({ a: 1 }, jsonFmt);
      expect(result).toBe('{"a":1}');
    });

    it('有 prefix 时应该拼接前缀', () => {
      const jsonFmt = formatRegistry.find(f => f.id === 'json')!;
      const result = serializeWithFormat({ a: 1 }, jsonFmt, 'cb');
      expect(result).toBe('cb{"a":1}');
    });

    it('无 format 时字符串应该原样返回', () => {
      expect(serializeWithFormat('raw')).toBe('raw');
    });

    it('无 format 时对象应该被 JSON.stringify', () => {
      expect(serializeWithFormat({ a: 1 })).toBe('{"a":1}');
    });
  });
});
