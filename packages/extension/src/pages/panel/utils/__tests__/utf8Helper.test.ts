import { describe, it, expect } from 'vitest';
import { fixMessedUpUTF8 } from '../utf8Helper';

describe('utf8Helper.ts - fixMessedUpUTF8', () => {
  it('正常 ASCII 字符串应该原样返回', () => {
    expect(fixMessedUpUTF8('hello world')).toBe('hello world');
  });

  it('已经正确的 UTF-8 中文字符串应该原样返回', () => {
    // 中文字符的 charCode > 0xFF，直接触发提前返回
    expect(fixMessedUpUTF8('你好世界')).toBe('你好世界');
  });

  it('已经正确的 UTF-8 中文应该原样返回（混合 ASCII）', () => {
    expect(fixMessedUpUTF8('hello 你好')).toBe('hello 你好');
  });

  it('应该修复被错误解释为 Latin-1 的 UTF-8 中文', () => {
    // "您好" 的 UTF-8 字节序列被错误解释为 Latin-1 后的字符串
    // UTF-8: E6 82 A8 E5 A5 BD
    // Latin-1 解释: \u00E6\u0082\u00A8\u00E5\u00A5\u00BD
    const mangled = '\u00E6\u0082\u00A8\u00E5\u00A5\u00BD';
    const fixed = fixMessedUpUTF8(mangled);
    expect(fixed).toBe('您好');
  });

  it('应该修复被错误解释为 Latin-1 的 UTF-8 英文特殊字符', () => {
    // "é" 的 UTF-8 字节 C3 A9 被错误解释为 Latin-1: \u00C3\u00A9
    const mangled = '\u00C3\u00A9';
    const fixed = fixMessedUpUTF8(mangled);
    expect(fixed).toBe('é');
  });

  it('应该修复 Windows-1252 特殊字符', () => {
    // Windows-1252 中的欧元符号 € 对应 0x80，被错误解释为 \u20AC
    // UTF-8 中 0x80 不是合法起始字节，decode 可能失败，此时返回原值
    // 主要测试：函数不会抛出异常
    expect(() => fixMessedUpUTF8('\u20AC')).not.toThrow();
  });

  it('空字符串应该返回空字符串', () => {
    expect(fixMessedUpUTF8('')).toBe('');
  });

  it('非字符串应该原样返回', () => {
    expect(fixMessedUpUTF8(null as any)).toBe(null);
    expect(fixMessedUpUTF8(123 as any)).toBe(123);
    expect(fixMessedUpUTF8(undefined as any)).toBe(undefined);
  });

  it('纯 ASCII 数字和符号应该原样返回', () => {
    const input = '1234567890!@#$%^&*()';
    expect(fixMessedUpUTF8(input)).toBe(input);
  });

  it('超出 Latin-1 范围的 Unicode 字符（非中文）直接返回原值', () => {
    // emoji 的 code > 0xFF，直接触发提前返回
    const input = 'hello 🎉';
    expect(fixMessedUpUTF8(input)).toBe(input);
  });
});
