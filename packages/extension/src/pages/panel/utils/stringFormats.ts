import { parseQueryString } from '@mearl/browser-core';
export { parseQueryString };
/**
 * 字符串格式解析模块
 *
 * 提供统一的字符串格式检测、解析和序列化能力
 * 支持的格式：JSON、URL 编码 JSON、带前缀 JSON、Query String、FPT、URL
 */

import { stripQueryPrefix } from '../../../shared/dataPreprocessor';
import { t } from './i18n';

// ====================== 类型定义 ======================

/**
 * 统一的字符串格式接口
 * 每种可识别的特殊字符串格式（JSON、Query String、FPT、URL 等）都实现此接口
 * 新增格式只需定义一个 StringFormat 对象并注册到 formatRegistry 即可
 */
export interface StringFormat {
  id: string;
  badge: {
    text: string;
    variant: 'orange' | 'amber' | 'blue' | 'green';
    tooltipKey: StringFormatTooltipKey;
  };
  detect: (str: string, depth?: number) => boolean | { match: true; prefix?: string };
  parse: (str: string, prefix?: string) => any;
  serialize: (obj: any) => string;
  priority: number; // 越小越先匹配
}

export type StringFormatTooltipKey =
  | 'parsedFromString'
  | 'parsedFromQuery'
  | 'parsedFromFpt'
  | 'parsedFromUrl';

export const getStringFormatTooltipText = (key: StringFormatTooltipKey): string => {
  switch (key) {
    case 'parsedFromString':
      return t('parsedFromString');
    case 'parsedFromQuery':
      return t('parsedFromQuery');
    case 'parsedFromFpt':
      return t('parsedFromFpt');
    case 'parsedFromUrl':
      return t('parsedFromUrl');
  }
};

export interface ParseResult {
  parsed: any;
  format?: StringFormat;
  prefix?: string;
}

// ====================== FPT 格式 ======================

/**
 * 检查字符串是否是 fpt 格式（如 soid(C12h952)ftuid(pvO8J6su024811.7)）
 * 格式特征：多个 key(value) 连续组合，无分隔符
 */
export const isFptString = (str: string): boolean => {
  if (typeof str !== 'string') return false;
  const trimmed = str.trim();
  // 必须以字母开头，包含至少两个 key(value) 对（如 a(b)c(d)）
  // 匹配模式：两个或以上 word(content) 组合，整个字符串必须完全匹配
  return /^[a-zA-Z][\w.]*\([^)]*\)(?:[a-zA-Z][\w.]*\([^)]*\))+$/.test(trimmed);
};

/**
 * 解析 fpt 格式字符串为对象
 * 如 soid(C12h952)ftuid(pvO8J6su024811.7) => { soid: 'C12h952', ftuid: 'pvO8J6su024811.7' }
 */
export const parseFptString = (fptString: string): Record<string, string> => {
  const params: Record<string, string> = {};
  if (!fptString) return params;

  const trimmed = fptString.trim();
  // 匹配所有 key(value) 对
  const regex = /([a-zA-Z][\w.]*)\(([^)]*)\)/g;
  let match;
  while ((match = regex.exec(trimmed)) !== null) {
    params[match[1]] = match[2];
  }

  return params;
};

/**
 * 将对象序列化为 fpt 格式字符串
 * 如 { soid: 'C12h952', ftuid: 'pvO8J6su024811.7' } => soid(C12h952)ftuid(pvO8J6su024811.7)
 */
export const serializeFptString = (obj: Record<string, any>): string => {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return String(obj);
  }

  return Object.entries(obj)
    .map(([key, value]) => {
      const strValue =
        typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
      return `${key}(${strValue})`;
    })
    .join('');
};

// ====================== Query String 格式 ======================

/**
 * 将对象序列化为 query string
 */
export const serializeToQueryString = (obj: Record<string, any>): string => {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return String(obj);
  }

  return Object.entries(obj)
    .map(([key, value]) => {
      const strValue =
        typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
      return `${key}=${encodeURIComponent(strValue)}`;
    })
    .join('&');
};

// ====================== URL 解析 ======================

/**
 * 解析 hash 内部的查询参数（SPA hash 模式路由常见格式）
 * 例如: /path?foo=bar&baz=qux -> { hashPath: '/path', hashQuery: 'foo=bar&baz=qux' }
 */
const parseHashQuery = (hash: string): { hashPath: string; hashQuery: string | null } => {
  const questionIndex = hash.indexOf('?');
  if (questionIndex === -1) {
    return { hashPath: hash, hashQuery: null };
  }

  const hashPath = hash.slice(0, questionIndex);
  const queryString = hash.slice(questionIndex + 1);

  return {
    hashPath,
    hashQuery: queryString || null,
  };
};

/**
 * 解析 URL，返回结构化数据
 * 支持 SPA hash 模式路由
 */
export const parseUrl = (urlString: string): Record<string, any> | null => {
  try {
    const url = new URL(urlString);

    const result: Record<string, any> = {
      protocol: url.protocol,
      host: url.host,
      pathname: url.pathname,
    };

    if (url.search) {
      // 保留原始编码格式，交给 JsonTree 按需解码
      result.query = url.search.slice(1);
    }

    if (url.hash) {
      const rawHash = url.hash.slice(1);
      const { hashPath, hashQuery } = parseHashQuery(rawHash);

      try {
        result.hash = decodeURIComponent(hashPath);
      } catch {
        result.hash = hashPath;
      }
      if (hashQuery) {
        result.hashQuery = hashQuery;
      }
    }

    return result;
  } catch {
    return null;
  }
};

/**
 * 从解析后的 URL 对象重建完整的 URL 字符串
 */
export const rebuildUrl = (parsed: Record<string, any>): string => {
  let fullUrl = `${parsed.protocol || 'https:'}//${parsed.host || ''}${parsed.pathname || ''}`;

  if (parsed.query && typeof parsed.query === 'string') {
    fullUrl += '?' + parsed.query;
  }

  if (parsed.hash) {
    fullUrl += '#' + encodeURIComponent(parsed.hash).replace(/%2F/gi, '/');

    if (parsed.hashQuery) {
      fullUrl += '?' + parsed.hashQuery;
    }
  }

  return fullUrl;
};

// ====================== 格式注册表实例 ======================

const encodedJsonFormat: StringFormat = {
  id: 'encodedJson',
  badge: { text: 'Encoded', variant: 'orange', tooltipKey: 'parsedFromString' },
  detect: str => str.startsWith('%7B') || str.startsWith('%5B'),
  parse: str => {
    const decoded = decodeURIComponent(str);
    if (
      (decoded.startsWith('{') && decoded.endsWith('}')) ||
      (decoded.startsWith('[') && decoded.endsWith(']'))
    ) {
      const parsed = JSON.parse(decoded);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    }
    throw new Error('not encoded json');
  },
  serialize: obj => encodeURIComponent(JSON.stringify(obj)),
  priority: 10,
};

const jsonFormat: StringFormat = {
  id: 'json',
  badge: { text: 'String', variant: 'amber', tooltipKey: 'parsedFromString' },
  detect: str => {
    if (!((str.startsWith('{') && str.endsWith('}')) || (str.startsWith('[') && str.endsWith(']'))))
      return false;
    try {
      const parsed = JSON.parse(str);
      return typeof parsed === 'object' && parsed !== null;
    } catch {
      return false;
    }
  },
  parse: str => JSON.parse(str),
  serialize: obj => JSON.stringify(obj),
  priority: 20,
};

const prefixedJsonFormat: StringFormat = {
  id: 'prefixedJson',
  badge: { text: 'Encoded', variant: 'orange', tooltipKey: 'parsedFromString' },
  detect: str => {
    // 从后往前查找 { 或 [，尝试最多 5 次
    const maxAttempts = 5;
    let attempts = 0;
    let searchStart = str.length - 2;

    while (searchStart > 0 && attempts < maxAttempts) {
      let pos = -1;
      for (let i = searchStart; i >= 0; i--) {
        if (str[i] === '{' || str[i] === '[') {
          pos = i;
          break;
        }
      }

      if (pos === -1 || pos === 0) break;

      const jsonPart = str.substring(pos);
      if (
        (jsonPart[0] === '{' && str.endsWith('}')) ||
        (jsonPart[0] === '[' && str.endsWith(']'))
      ) {
        try {
          const parsed = JSON.parse(jsonPart);
          if (typeof parsed === 'object' && parsed !== null) {
            return { match: true, prefix: str.substring(0, pos) };
          }
        } catch {
          // 继续
        }
      }

      searchStart = pos - 1;
      attempts++;
    }
    return false;
  },
  parse: (str, prefix) => {
    const jsonPart = str.substring(prefix!.length);
    return JSON.parse(jsonPart);
  },
  serialize: obj => JSON.stringify(obj),
  priority: 30,
};

/**
 * 判断字符串整体是否是 query string 形态。
 * query 参数是 URL 编码的单行 token：含至少一个 `&` 和 `=`，
 * 且每个 `&` 段都是 `key=value`（或裸 key），key 仅含 URL 安全字符。
 * value 解码后可以包含空格；含换行、或 key 里出现 markdown、括号、CJK 等字符的长文本据此排除，
 * 不会因正文里嵌了一段 `?a=1&b=2` 链接就被整体误判为 query。
 */
const isQueryStringShape = (queryStr: string): boolean => {
  if (!queryStr || /[\r\n]/.test(queryStr)) return false;
  if (!queryStr.includes('&') || !queryStr.includes('=')) return false;
  const keyPattern = /^[A-Za-z0-9_.\-[\]%+]+$/;
  let validPairs = 0;
  for (const seg of queryStr.split('&')) {
    if (!seg) continue;
    const eqIndex = seg.indexOf('=');
    const key = eqIndex === -1 ? seg : seg.slice(0, eqIndex);
    if (!key || !keyPattern.test(key)) return false;
    if (eqIndex !== -1) validPairs++;
  }
  return validPairs > 0;
};

const queryStringFormat: StringFormat = {
  id: 'queryString',
  badge: { text: 'Query', variant: 'blue', tooltipKey: 'parsedFromQuery' },
  detect: str => {
    const queryStr = stripQueryPrefix(str);
    if (
      str.startsWith('/') ||
      queryStr.startsWith('{') ||
      queryStr.startsWith('[') ||
      queryStr.startsWith('http://') ||
      queryStr.startsWith('https://')
    ) {
      return false;
    }
    return isQueryStringShape(queryStr);
  },
  parse: str => parseQueryString(stripQueryPrefix(str)),
  serialize: obj => serializeToQueryString(obj),
  priority: 40,
};

const fptFormat: StringFormat = {
  id: 'fpt',
  badge: { text: 'FPT', variant: 'blue', tooltipKey: 'parsedFromFpt' },
  detect: str => isFptString(str),
  parse: str => {
    const parsed = parseFptString(str);
    if (Object.keys(parsed).length > 0) return parsed;
    throw new Error('empty fpt');
  },
  serialize: obj => serializeFptString(obj),
  priority: 50,
};

const urlFormat: StringFormat = {
  id: 'url',
  badge: { text: 'URL', variant: 'green', tooltipKey: 'parsedFromUrl' },
  detect: (str, depth) => {
    if (depth != null && depth !== 0) return false;
    if (/^https?:\/\/.+/.test(str)) return true;
    if (str.startsWith('/') && str.includes('?')) return true;
    return false;
  },
  parse: str => {
    if (/^https?:\/\//.test(str)) {
      const parsed = parseUrl(str);
      if (parsed) return parsed;
      throw new Error('not url');
    }
    const qIdx = str.indexOf('?');
    const result: Record<string, any> = { pathname: str.slice(0, qIdx) };
    const queryStr = str.slice(qIdx + 1);
    if (queryStr) result.query = queryStr;
    return result;
  },
  serialize: obj => {
    if (obj.protocol || obj.host) return rebuildUrl(obj);
    let s = obj.pathname || '';
    if (obj.query) s += '?' + obj.query;
    return s;
  },
  priority: 60,
};

/**
 * 格式注册表，按 priority 排序
 * 新增格式只需在此数组中追加即可
 */
export const formatRegistry: StringFormat[] = [
  encodedJsonFormat,
  jsonFormat,
  prefixedJsonFormat,
  queryStringFormat,
  fptFormat,
  urlFormat,
];

// ====================== tryParseJsonString ======================

/**
 * 仅检测字符串匹配的格式，不执行解析
 * 适用于只需要判断"有无格式"或"是哪种格式"的场景
 */
export const detectFormat = (val: any, depth?: number): StringFormat | undefined => {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  for (const format of formatRegistry) {
    try {
      if (format.detect(trimmed, depth)) return format;
    } catch {
      // continue
    }
  }
  return undefined;
};

/**
 * 尝试解析字符串为已注册的格式，返回解析结果
 * 遍历 formatRegistry 按 priority 顺序调用 detect → parse
 * @param val 待解析的值
 * @returns ParseResult
 */
export const tryParseJsonString = (val: any, depth?: number): ParseResult => {
  if (typeof val !== 'string') return { parsed: val };

  const trimmed = val.trim();
  if (!trimmed) return { parsed: val };

  for (const format of formatRegistry) {
    try {
      const detectResult = format.detect(trimmed, depth);
      if (detectResult) {
        const prefix =
          typeof detectResult === 'object' && detectResult.prefix ? detectResult.prefix : undefined;
        const parsed = format.parse(trimmed, prefix);
        return { parsed, format, prefix };
      }
    } catch {
      // 当前格式解析失败，继续尝试下一个
    }
  }

  return { parsed: val };
};

/**
 * 根据格式将对象序列化回原始字符串格式
 * 用于编辑后还原、复制功能等场景
 */
export const serializeWithFormat = (obj: any, format?: StringFormat, prefix?: string): string => {
  if (!format) {
    return typeof obj === 'string' ? obj : JSON.stringify(obj);
  }
  const serialized = format.serialize(obj);
  return prefix ? prefix + serialized : serialized;
};
