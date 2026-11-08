/**
 * 数据预处理工具
 * 用于处理请求/响应数据的 URL 编码和 JSON 解析
 * 供 Panel 和 Background 共用
 */

/**
 * 检查字符串是否是 query string 格式
 * 支持以 ? 开头的格式（如 ?buyParam=1&bizType=flight）
 * 条件：包含 & 和 =，且不是 JSON 或完整 URL
 */
export const isQueryString = (str: string): boolean => {
  if (typeof str !== 'string') return false;
  let s = str.trim();
  if (s.startsWith('?')) s = s.slice(1);
  return (
    s.includes('&') &&
    s.includes('=') &&
    !s.startsWith('{') &&
    !s.startsWith('[') &&
    !s.startsWith('http://') &&
    !s.startsWith('https://')
  );
};

/**
 * 去掉字符串开头的 ? （用于 query string 处理）
 */
export const stripQueryPrefix = (str: string): string => {
  const trimmed = str.trim();
  return trimmed.startsWith('?') ? trimmed.slice(1) : trimmed;
};

/**
 * 预处理请求/响应数据
 * 只处理顶层的 URL 编码和 key=value 格式，不递归解析嵌套的 JSON 字符串
 * 这样可以保留 JsonTree 中的 "String" 标签显示
 */
export const preprocessData = (data: any): any => {
  if (typeof data !== 'string') return data;

  const trimmed = stripQueryPrefix(data.trim());

  // 优先匹配 "key=<JSON 对象/数组>" 形式（PROTOCOL 风格 body，如 data={"foo":"...","html":"a&nbsp;b"}）
  // 即使 JSON value 内部包含 &（HTML 实体、URL 等），也应作为对象解析，不能误判为 query string
  const jsonWrapperMatch = trimmed.match(/^(\w+)=(.+)$/s);
  if (jsonWrapperMatch) {
    const [, key, rawValue] = jsonWrapperMatch;
    const decodedValue = tryDecodeURIComponent(rawValue);
    const looksLikeJson =
      (decodedValue.startsWith('{') && decodedValue.endsWith('}')) ||
      (decodedValue.startsWith('[') && decodedValue.endsWith(']'));
    if (looksLikeJson) {
      const parsedValue = tryParseJSON(decodedValue);
      if (parsedValue !== decodedValue) {
        return { [key]: parsedValue };
      }
    }
  }

  // query string：保持原始字符串，交由 JsonTree 的 parseQueryString 逐个 value decode
  if (isQueryString(trimmed)) {
    return trimmed;
  }

  // 处理单个 key=value 格式 (如 "data=hello" 或 "data=%7B...")
  // 注意：不匹配包含 & 的字符串，那是 query string
  const keyValueMatch = trimmed.match(/^(\w+)=([^&]+)$/);
  if (keyValueMatch) {
    const [, key, value] = keyValueMatch;

    // URL 解码
    const decodedValue = tryDecodeURIComponent(value);

    // 尝试解析为 JSON（只解析一层，不递归）
    const parsedValue = tryParseJSON(decodedValue);
    return { [key]: parsedValue };
  }

  // 尝试 URL 解码整个字符串
  const decoded = tryDecodeURIComponent(trimmed);
  if (decoded !== trimmed) {
    // 解码后尝试解析为 JSON（只解析一层）
    return tryParseJSON(decoded);
  }

  // 尝试直接解析为 JSON（只解析一层）
  return tryParseJSON(trimmed);
};

/**
 * 安全的 URL 解码，失败时返回原值
 */
export const tryDecodeURIComponent = (str: string): string => {
  if (!str.includes('%')) return str;

  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
};

/**
 * 安全的 JSON 解析，失败时返回原值
 */
export const tryParseJSON = (str: string): any => {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
};

/**
 * 解码 Unicode 转义序列（如 \u4e2d\u6587 -> 中文）
 * @param str 包含 Unicode 转义的字符串
 * @returns 解码后的字符串
 */
export const decodeUnicodeEscapes = (str: string): string => {
  if (!str.includes('\\u')) return str;

  try {
    // 使用 JSON.parse 来解码 Unicode 转义
    // 需要将 \u 转换为 \u 以便 JSON.parse 正确处理
    return JSON.parse('"' + str.replace(/"/g, '\\"') + '"');
  } catch {
    return str;
  }
};

/**
 * 递归解码对象中所有 URL 编码和 Unicode 转义的字符串值
 * 用于处理 JSONP 响应中嵌套的编码数据
 *
 * @param data 任意数据类型
 * @returns 解码后的数据
 */
export const deepDecodeURIComponent = (data: any): any => {
  if (typeof data === 'string') {
    // 1. 先解码 URL 编码
    const urlDecoded = tryDecodeURIComponent(data);

    // 2. 解码 Unicode 转义序列
    const unicodeDecoded = decodeUnicodeEscapes(urlDecoded);

    // 3. 只有实际发生了解码，才尝试解析 JSON
    // 这样可以避免把普通的 JSON 字符串如 "2" 解析为数字
    if (unicodeDecoded !== data) {
      const parsed = tryParseJSON(unicodeDecoded);
      if (parsed !== unicodeDecoded) {
        return deepDecodeURIComponent(parsed);
      }
    }

    // 如果 URL 解码和 Unicode 解码结果不同，返回解码后的结果
    if (unicodeDecoded !== urlDecoded) {
      return unicodeDecoded;
    }

    return urlDecoded;
  }

  if (Array.isArray(data)) {
    return data.map(item => deepDecodeURIComponent(item));
  }

  if (data !== null && typeof data === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = deepDecodeURIComponent(value);
    }
    return result;
  }

  return data;
};
