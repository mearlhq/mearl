import { describe, expect, it } from 'vitest';
import { translationStream } from '../../immersive-translate/scripts/stream.mjs';

describe('incremental translation JSON framing', () => {
  const translations = [{ id: '1', text: '引号 "、反斜线 \\、换行\n和 } ], { 😀' }, { text: '第二段', id: '2' }];
  const json = JSON.stringify({ translations });
  it('handles every possible chunk boundary, escapes and property order', () => {
    for (let boundary = 0; boundary <= json.length; boundary++) {
      const parse = translationStream();
      expect([...parse(json.slice(0, boundary)), ...parse(json.slice(boundary))]).toEqual(translations);
    }
    const parse = translationStream();
    expect([...json].flatMap(char => parse(char))).toEqual(translations);
  });
  it('yields only complete objects before the enclosing array ends', () => {
    const parse = translationStream();
    expect(parse('{"translations":[{"id":"1","text":"半段')).toEqual([]);
    expect(parse('译文"}')).toEqual([{ id: '1', text: '半段译文' }]);
    expect(parse(',{"id":"2","text":"完整"}]}')).toEqual([{ id: '2', text: '完整' }]);
  });
  it.each(['{"other":[', '{"translations":[1', '{"translations":[{"id":"1"},]}', '{"translations":[]} trailing'])('rejects invalid framing: %s', text => {
    expect(() => translationStream()(text)).toThrow();
  });
  it('bounds buffered prefixes and incomplete objects', () => {
    expect(() => translationStream()(' '.repeat(257))).toThrow();
    const parse = translationStream();
    parse('{"translations":[{"text":"');
    expect(() => parse('a'.repeat(128 * 1024))).toThrow('limit');
  });
});
