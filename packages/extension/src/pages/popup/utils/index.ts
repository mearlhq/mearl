import { tryParseJsonString } from '../../panel/utils/helpers';

/**
 * 检测字符串是否为 URL
 * @param str 待检测的字符串
 * @returns 是否为 URL（以 http:// 或 https:// 开头）
 */
export const isUrl = (str: string): boolean => {
  if (typeof str !== 'string') return false;
  const trimmed = str.trim();
  return /^https?:\/\/.+/.test(trimmed);
};

/**
 * 深度递归解析 JSON 字符串
 * 自动识别并解析所有嵌套的特殊格式字符串（JSON、URL、Query String、FPT 等）
 * @param obj 待解析的对象
 * @param depth 当前递归深度
 * @param maxDepth 最大递归深度，防止无限递归
 * @returns 完全解析后的对象
 */
export const deepParseJson = (obj: any, depth = 0, maxDepth = 5): any => {
  if (depth >= maxDepth) {
    return obj;
  }

  if (typeof obj === 'string') {
    // 统一使用 tryParseJsonString 处理所有格式（JSON、URL、Query String、FPT 等）
    const { parsed, format } = tryParseJsonString(obj);

    if (format && typeof parsed === 'object') {
      return deepParseJson(parsed, depth + 1, maxDepth);
    }

    return obj;
  } else if (Array.isArray(obj)) {
    return obj.map(item => deepParseJson(item, depth + 1, maxDepth));
  } else if (obj !== null && typeof obj === 'object') {
    // 普通对象，递归处理所有字段
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deepParseJson(value, depth + 1, maxDepth);
    }
    return result;
  }

  return obj;
};
