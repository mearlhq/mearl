import { describe, expect, it } from 'vitest';
import {
  buildSseOverrideMessages,
  normalizeSseMessageData,
  serializeSseMessageData,
} from '../utils/sseMessageData';

describe('SSE message data', () => {
  it('应将多层 JSON 字符串还原为对象用于展示', () => {
    const value = JSON.stringify(JSON.stringify(JSON.stringify({ api: 'mtop.test' })));

    expect(normalizeSseMessageData(value)).toEqual({ api: 'mtop.test' });
  });

  it('普通文本和 JSON 字符串值应保持原样', () => {
    expect(normalizeSseMessageData('plain text')).toBe('plain text');
    expect(normalizeSseMessageData('"plain text"')).toBe('"plain text"');
  });

  it('生成 mock 流时不应重复序列化已有 JSON 字符串', () => {
    const encoded = JSON.stringify(JSON.stringify({ api: 'mtop.test' }));

    expect(serializeSseMessageData(encoded)).toBe('{"api":"mtop.test"}');
    expect(serializeSseMessageData({ api: 'mtop.test' })).toBe('{"api":"mtop.test"}');
  });

  it('应支持消息包装和 falsey 修改值', () => {
    const messages = [
      { event: 'resp', data: '{"value":1}' },
      { event: 'resp', data: '{"value":2}' },
      { event: 'resp', data: '{"value":3}' },
    ];
    const result = buildSseOverrideMessages(messages, [
      { event: 'resp', data: { value: 4 } },
      '',
      false,
    ]);

    expect(result.map(message => message.data)).toEqual(['{"value":4}', '', 'false']);
  });
});
