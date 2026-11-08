/**
 * UTF-8 编码修复工具
 *
 * 用于修复被错误解释为 Windows-1252 的 UTF-8 字节序列
 */

/**
 * 修复乱码的 UTF-8 编码
 * 将被错误解释为 Windows-1252 的 UTF-8 字节序列还原为正确的 UTF-8
 * @param input 输入字符串
 * @returns 修复后的字符串
 */
export const fixMessedUpUTF8 = (input: string): string => {
  if (typeof input !== 'string') return input;

  // Windows-1252 特殊字符映射
  const win1252: Record<string, number> = {
    '\u20AC': 0x80,
    '\u201A': 0x82,
    '\u0192': 0x83,
    '\u201E': 0x84,
    '\u2026': 0x85,
    '\u2020': 0x86,
    '\u2021': 0x87,
    '\u02C6': 0x88,
    '\u2030': 0x89,
    '\u0160': 0x8a,
    '\u2039': 0x8b,
    '\u0152': 0x8c,
    '\u017D': 0x8e,
    '\u2018': 0x91,
    '\u2019': 0x92,
    '\u201C': 0x93,
    '\u201D': 0x94,
    '\u2022': 0x95,
    '\u2013': 0x96,
    '\u2014': 0x97,
    '\u02DC': 0x98,
    '\u2122': 0x99,
    '\u0161': 0x9a,
    '\u203A': 0x9b,
    '\u0153': 0x9c,
    '\u017E': 0x9e,
    '\u0178': 0x9f,
  };

  const bytes: number[] = [];

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const code = char.charCodeAt(0);

    // 1. Windows-1252 特殊字符
    if (win1252[char] !== undefined) {
      bytes.push(win1252[char]);
    }
    // 2. Latin-1 范围 (0x00-0xFF)
    else if (code <= 0xff) {
      bytes.push(code);
    }
    // 3. 超出范围 - 可能已经是正确的 Unicode，保持原样
    else {
      return input;
    }
  }

  try {
    // 使用 TextDecoder 解码 UTF-8
    const uint8Array = new Uint8Array(bytes);
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(uint8Array);
  } catch (e) {
    console.warn('UTF-8 解码失败:', e);
    return input;
  }
};
