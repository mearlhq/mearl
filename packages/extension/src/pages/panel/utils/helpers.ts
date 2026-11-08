import { fixMessedUpUTF8 } from './utf8Helper';
import {
  preprocessData as sharedPreprocessData,
  tryParseJSON,
  tryDecodeURIComponent,
  deepDecodeURIComponent,
} from '../../../shared/dataPreprocessor';
import { serializeWithFormat, tryParseJsonString } from './stringFormats';
import type { CapturedRequest, PinnedField } from '../types';

// 重新导出字符串格式解析模块的所有内容
export type { StringFormat, ParseResult } from './stringFormats';
export {
  isFptString,
  parseFptString,
  serializeFptString,
  parseQueryString,
  serializeToQueryString,
  parseUrl,
  rebuildUrl,
  formatRegistry,
  getStringFormatTooltipText,
  tryParseJsonString,
  serializeWithFormat,
} from './stringFormats';

/**
 * Mearl - 工具函数集合
 *
 * 主要功能：
 * - 响应格式解析（JSONP, SSE）
 * - 数据预处理（URL 解码、key=value 格式）
 * - Cookie 解析
 * - 字节大小计算与格式化
 * - 嵌套数据路径访问与修改
 */

/**
 * 从 headers 数组中获取指定 header 的值
 * @param headers headers 数组
 * @param name header 名称（不区分大小写）
 * @returns header 值（小写），未找到返回空字符串
 */
/**
 * 解码 queryString 数组中的值
 * @param queryString 查询参数数组
 * @returns 解码后的查询参数数组
 */
export const decodeQueryString = (
  queryString: Array<{ name: string; value: string }>,
): Array<{ name: string; value: string }> => {
  return queryString.map(item => ({
    name: item.name,
    value: tryDecodeURIComponent(item.value),
  }));
};

// 导出别名，保持语义清晰
export { tryDecodeURIComponent as safeDecodeURIComponent };

export const getHeaderValue = (
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string => {
  const header = headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
  return header?.value?.toLowerCase() || '';
};

/**
 * 根据文本过滤请求列表（支持正则表达式）
 * @param requests 请求列表
 * @param filterText 过滤文本
 * @param searchFields 要搜索的字段数组，默认为 ['apiName']
 * @returns 过滤后的请求列表
 */
export const filterRequestsByText = <T extends { apiName: string; url?: string }>(
  requests: T[],
  filterText: string,
  searchFields: Array<'apiName' | 'url'> = ['apiName'],
): T[] => {
  if (!filterText.trim()) return requests;

  try {
    const regex = new RegExp(filterText, 'i');
    return requests.filter(req => searchFields.some(field => regex.test(req[field] || '')));
  } catch {
    // 如果不是有效的正则表达式，则作为普通字符串匹配
    const lower = filterText.toLowerCase();
    return requests.filter(req =>
      searchFields.some(field => (req[field] || '').toLowerCase().includes(lower)),
    );
  }
};

/**
 * 为非 mtop 请求生成 apiName
 * @param url 请求 URL
 * @param resourceType 资源类型
 * @returns apiName
 */
export const generateNonProtocolApiName = (url: string, resourceType?: string): string => {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const isApiType =
      resourceType === 'xhr' || resourceType === 'fetch' || resourceType === 'jsonp';

    if (isApiType) {
      // XHR/fetch/JSONP：直接用 pathname 作为 API 名称
      return pathname;
    } else {
      // 静态资源：优先取文件名，CDN combo URL（含 ??）取 ?? 后首个文件名
      const comboMatch = url.match(/\?\?(.+?)(?:[,?]|$)/);
      if (comboMatch) {
        // cdn.example.com/??/path/a.js,/path/b.js → 取第一个文件名
        const firstFile = comboMatch[1].split(',')[0];
        return firstFile.split('/').pop() || firstFile;
      } else {
        // 取 pathname 最后一段（文件名），如果不存在则取最后两段路径
        const parts = pathname.split('/').filter(Boolean);
        return parts.length > 0 ? '/' + parts.slice(-2).join('/') : pathname;
      }
    }
  } catch {
    return url;
  }
};

const SCRIPT_CONTENT_TYPE_RE = /javascript|ecmascript/i;
const STYLESHEET_CONTENT_TYPE_RE = /text\/css/i;
const IMAGE_CONTENT_TYPE_RE = /^image\//i;
const FONT_CONTENT_TYPE_RE = /^font\//i;
const FONT_FALLBACK_CONTENT_TYPE_RE = /woff2?|ttf|otf|font/i;
const MEDIA_CONTENT_TYPE_RE = /^(video|audio)\//i;
const DOCUMENT_CONTENT_TYPE_RE = /(text\/html|application\/xhtml\+xml)/i;

// 覆盖前端常见源码后缀：dev server（Vite/Webpack）会以 application/javascript 返回 .ts/.tsx/.vue 等编译产物，
// 若仅识别 .js/.mjs，会把这些源码请求误判为 JSONP（参见 normalizeNonProtocolResourceType）
const SCRIPT_FILE_URL_RE = /\.(?:m?js|cjs|tsx?|jsx|vue|svelte)(?:[?#,&]|$)/i;

// 前端 dev server 注入的虚拟路径前缀（Vite/Webpack/Next 等）：这些请求虽是 script 类型且无 .js 后缀，
// 但内容是模块脚本而非 JSONP 响应，应跳过 JSONP 判定
const DEV_SERVER_PATH_RE =
  /(?:^|\/)(?:@vite\/|@id\/|@fs\/|@react-refresh|node_modules\/\.vite\/|__vite_ping|sockjs-node\/|webpack-internal:\/\/|_next\/static\/|_next\/webpack-hmr|hot-update\.|src\/)/i;

const isDevServerScript = (url: string): boolean => {
  try {
    const { pathname } = new URL(url);
    return DEV_SERVER_PATH_RE.test(pathname);
  } catch {
    return DEV_SERVER_PATH_RE.test(url);
  }
};
const STYLESHEET_FILE_URL_RE = /\.css(?:[?#,&]|$)/i;
const IMAGE_FILE_URL_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)(?:[?#,&]|$)/i;
const FONT_FILE_URL_RE = /\.(woff2?|ttf|otf|eot)(?:[?#,&]|$)/i;
const MEDIA_FILE_URL_RE = /\.(mp4|webm|ogg|mp3|wav|m4a|aac|flac)(?:[?#,&]|$)/i;
const DOCUMENT_FILE_URL_RE = /\.html?(?:[?#,&]|$)/i;

export function inferResourceTypeFromContentType(contentType: string): string | null {
  if (!contentType) return null;
  if (SCRIPT_CONTENT_TYPE_RE.test(contentType)) return 'script';
  if (STYLESHEET_CONTENT_TYPE_RE.test(contentType)) return 'stylesheet';
  if (IMAGE_CONTENT_TYPE_RE.test(contentType)) return 'image';
  if (FONT_CONTENT_TYPE_RE.test(contentType) || FONT_FALLBACK_CONTENT_TYPE_RE.test(contentType))
    return 'font';
  if (MEDIA_CONTENT_TYPE_RE.test(contentType)) return 'media';
  if (DOCUMENT_CONTENT_TYPE_RE.test(contentType)) return 'document';
  return null;
}

export function inferResourceTypeFromUrl(url: string): string | null {
  if (SCRIPT_FILE_URL_RE.test(url)) return 'script';
  if (STYLESHEET_FILE_URL_RE.test(url)) return 'stylesheet';
  if (IMAGE_FILE_URL_RE.test(url)) return 'image';
  if (FONT_FILE_URL_RE.test(url)) return 'font';
  if (MEDIA_FILE_URL_RE.test(url)) return 'media';
  if (DOCUMENT_FILE_URL_RE.test(url)) return 'document';
  return null;
}

export function normalizeNonProtocolResourceType(
  rawType: string,
  url: string,
  responseHeaders: Array<{ name: string; value: string }> | undefined,
): string {
  // 对于 script 类型，检查是否是 JSONP 请求（通过 URL callback 参数或 content-type）
  if (rawType === 'script') {
    // 1. URL 中有 callback/jsonp 参数 —— 强信号，最优先
    if (isJsonpRequest(url)) {
      return 'jsonp';
    }
    // 2. Content-Type 是 JavaScript 且 URL 看起来像 API 请求（不是 JS/TS/JSX 等源码文件，且不是 dev server 虚拟路径）
    const contentType = getHeaderValue(responseHeaders, 'content-type');
    if (
      SCRIPT_CONTENT_TYPE_RE.test(contentType) &&
      !SCRIPT_FILE_URL_RE.test(url) &&
      !isDevServerScript(url)
    ) {
      return 'jsonp';
    }
  }

  if (rawType !== 'xhr' && rawType !== 'fetch') return rawType;

  const contentType = getHeaderValue(responseHeaders, 'content-type');
  const inferredByContentType = inferResourceTypeFromContentType(contentType);

  // 如果推断为 script 类型，进一步检查是否是 JSONP
  if (inferredByContentType === 'script') {
    // 1. URL 中有 callback/jsonp 参数
    if (isJsonpRequest(url)) {
      return 'jsonp';
    }
    // 2. URL 不像静态 JS/TS/JSX 等源码文件，且不是 dev server 虚拟路径，才可能是 JSONP API
    if (!SCRIPT_FILE_URL_RE.test(url) && !isDevServerScript(url)) {
      return 'jsonp';
    }
  }

  if (inferredByContentType) return inferredByContentType;

  const inferredByUrl = inferResourceTypeFromUrl(url);
  if (inferredByUrl) return inferredByUrl;

  return rawType;
}

export function detectCodeLanguage(
  resourceType: string | undefined,
  responseHeaders: Array<{ name: string; value: string }> | undefined,
): 'html' | 'css' | 'js' | null {
  if (resourceType === 'document') return 'html';
  if (resourceType === 'stylesheet') return 'css';
  if (resourceType === 'script') return 'js';

  const contentType = getHeaderValue(responseHeaders, 'content-type');
  if (contentType.includes('html')) return 'html';
  if (contentType.includes('css')) return 'css';
  if (SCRIPT_CONTENT_TYPE_RE.test(contentType)) return 'js';
  return null;
}

export const formatJson = (obj: any): string => {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
};

/**
 * 检测响应内容是否为 JSONP 格式
 * JSONP 格式: functionName({...}) 或 functionName([...])
 * 支持格式:
 *   - callback({...})
 *   - /\*\*\/ callback({...})
 *   - /\*\*\/ typeof callback === 'function' && callback({...});
 *   - try{callback({...})}catch(e){}
 *   - var xxx={...};someCall();
 * @param content 响应内容
 * @returns 是否为 JSONP 格式
 */
export const isJsonpResponse = (content: string): boolean => {
  if (typeof content !== 'string') return false;
  const trimmed = content.trim();

  // 1. 标准 JSONP: callback({...}) 或 /**/ callback({...})
  if (
    /^(?:\/\*\*\/\s*)?(?:typeof\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*===\s*['"]function['"]\s*&&\s*)?[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*\)\s*;?$/.test(
      trimmed,
    )
  ) {
    return true;
  }

  // 2. try-catch 包装: try{callback({...})}catch(e){}
  if (
    /^try\s*\{\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*\)\s*\}\s*catch\s*\([^)]*\)\s*\{\s*\}\s*;?$/.test(
      trimmed,
    )
  ) {
    return true;
  }

  // 3. 变量赋值 + 函数调用: var xxx={...};someCall();
  // 检查是否包含对象赋值和函数调用
  if (
    /var\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*\{[\s\S]*\}/.test(trimmed) &&
    /[a-zA-Z_$][a-zA-Z0-9_$]*\s*\([^)]*\)/.test(trimmed)
  ) {
    return true;
  }

  return false;
};

/**
 * 检测 URL 是否为 JSONP 请求
 * JSONP 请求特征: URL 中包含 callback 参数
 * @param url 请求 URL
 * @returns 是否为 JSONP 请求
 */
export const isJsonpRequest = (url: string): boolean => {
  try {
    const urlObj = new URL(url);
    // 检查是否有 callback 或 jsonp 相关参数
    const callbackParam = urlObj.searchParams.get('callback');
    const jsonpParam = urlObj.searchParams.get('jsonp');
    return !!(callbackParam || jsonpParam);
  } catch {
    return false;
  }
};

/**
 * 解析 JSONP 响应，剥离外层的函数调用
 * 例如：mtopjsonp3({...}) => {...}
 * 支持格式:
 *   - callback({...})
 *   - /\*\*\/ callback({...})
 *   - /\*\*\/ typeof callback === 'function' && callback({...});
 *   - try{callback({...})}catch(e){}
 *   - var xxx={...};someCall();
 */
export const parseJsonpResponse = (content: string): any => {
  if (typeof content !== 'string') return content;

  const trimmed = content.trim();
  let parsed: any = null;

  // 1. 标准 JSONP 格式：callback({...}) 或 /**/ callback({...}) 或 typeof check
  const standardMatch = trimmed.match(
    /^(?:\/\*\*\/\s*)?(?:typeof\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*===\s*['"]function['"]\s*&&\s*)?[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*\)\s*;?$/,
  );
  if (standardMatch) {
    parsed = tryParseJSON(standardMatch[1]);
  }

  // 2. try-catch 包装：try{callback({...})}catch(e){}
  if (!parsed) {
    const tryCatchMatch = trimmed.match(
      /^try\s*\{\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*\)\s*\}\s*catch\s*\([^)]*\)\s*\{\s*\}\s*;?$/,
    );
    if (tryCatchMatch) {
      parsed = tryParseJSON(tryCatchMatch[1]);
    }
  }

  // 3. 变量赋值 + 函数调用：var xxx={...};someCall();
  if (!parsed) {
    const varMatch = trimmed.match(/var\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(\{[\s\S]*\})/);
    if (varMatch) {
      parsed = tryParseJSON(varMatch[2]);
    }
  }

  // 4. 不是 JSONP 格式，尝试直接解析 JSON
  if (!parsed) {
    parsed = tryParseJSON(content);
  }

  // 递归解码对象中所有 URL 编码的字符串值
  return deepDecodeURIComponent(parsed);
};

/**
 * 解析 SSE (Server-Sent Events) 响应
 * SSE 格式示例：
 * id: 1
 * event: resp
 * data: {"key":"value"}
 * \n\n
 *
 * @param content SSE 响应内容
 * @returns 解析后的数据（单个对象或对象数组）
 */
/**
 * 将 SSE 响应文本解析为消息数组（始终返回数组）
 * 供 EventStream Tab 展示使用；解析历史数据，不生成 timestamp/duration
 * （实时数据的时间戳由 injected fetch 劫持生成）
 */
export const parseSseMessages = (
  content: string,
): Array<{ event: string; data: any; eventId?: string }> => {
  if (typeof content !== 'string') return [];

  // 解析完整的 SSE 消息结构
  const lines = content.split('\n').map(line => line.trim());
  const messages: Array<{ event: string; data: any; eventId?: string }> = [];
  let currentMessage: any = {};

  for (const line of lines) {
    if (line.startsWith('event:')) {
      currentMessage.event = line.substring(6).trim();
    } else if (line.startsWith('data:')) {
      currentMessage.data = line.substring(5).trim();
    } else if (line.startsWith('id:')) {
      currentMessage.eventId = line.substring(3).trim();
    } else if (line === '' && currentMessage.data) {
      // 空行表示消息结束
      // 修复 UTF-8 编码并解析 data
      const fixed = fixMessedUpUTF8(currentMessage.data);
      const parsedData = tryParseJSON(fixed);

      messages.push({
        event: currentMessage.event || 'message',
        data: parsedData,
        eventId: currentMessage.eventId,
      });

      currentMessage = {};
    }
  }

  return messages;
};

export const parseSseResponse = (content: string): any => {
  if (typeof content !== 'string') return content;

  const messages = parseSseMessages(content);

  // 如果没有解析到任何消息，返回原始内容
  if (messages.length === 0) return content;

  // 如果只有一条消息
  if (messages.length === 1) {
    return messages[0];
  }

  // 多条消息
  return messages;
};

/**
 * 提取请求数据（统一处理 POST 和 GET 请求）
 * POST 请求：返回 proxyData 或 postData
 * GET 请求：从查询参数的 data 字段提取 JSON，并包装成 { data: ... } 结构
 *
 * @param request 请求对象（包含 proxyData, postData, queryString）
 * @returns 请求数据，如果没有返回 null
 */
export const extractRequestData = (request: {
  proxyData?: any;
  postData?: any;
  queryString?: Array<{ name: string; value: string }>;
}): any => {
  // 优先使用 POST 数据
  const postData = request.proxyData || request.postData;
  if (postData) {
    return postData;
  }

  // 如果没有 POST 数据，尝试从查询参数的 data 字段中提取
  if (request.queryString) {
    const dataParam = request.queryString.find(q => q.name === 'data');
    if (dataParam) {
      try {
        let decodedValue = dataParam.value;
        if (decodedValue.includes('%')) {
          decodedValue = decodeURIComponent(decodedValue);
        }
        const parsed = JSON.parse(decodedValue);
        // 包装成 { data: ... } 结构，与 POST 请求保持一致
        return { data: parsed };
      } catch {
        // 解析失败，返回 null
        return null;
      }
    }
  }

  return null;
};

/**
 * 预处理请求/响应数据
 * 只处理顶层的 URL 编码和 key=value 格式，不递归解析嵌套的 JSON 字符串
 * 这样可以保留 JsonTree 中的 "String" 标签显示
 */
export const preprocessData = sharedPreprocessData;

/**
 * 解析 Cookie 字符串为键值对数组
 * @param cookieString Cookie 字符串，如 "name1=value1; name2=value2"
 * @returns Cookie 键值对数组
 */
export const parseCookies = (cookieString: string): Array<{ name: string; value: string }> => {
  if (!cookieString?.trim()) return [];

  return cookieString
    .split(';')
    .map(cookie => {
      const [name, ...valueParts] = cookie.trim().split('=');
      return {
        name: name.trim(),
        value: valueParts.join('=').trim(),
      };
    })
    .filter(c => c.name);
};

// 根据路径从对象中获取值
// 支持处理路径中包含 JSON 字符串的情况
export const getValueByPath = (obj: any, path: string): any => {
  if (!path) return obj;
  const keys = path.split('.');
  let value = obj;

  for (const key of keys) {
    if (value === null || value === undefined) return undefined;

    // 复用 tryParseJsonString 来解析 JSON 字符串
    const { parsed, format } = tryParseJsonString(value);
    if (format) {
      value = parsed;
    } else if (typeof value === 'string') {
      // 不是 JSON 格式的字符串，无法继续深入路径
      return undefined;
    }

    // 访问下一个 key
    value = value[key];
  }

  return value;
};

/** 按请求当前数据（含 responseOverride）计算关注字段的实际值 */
export const computePinnedFieldsForRequest = (
  req: CapturedRequest,
  fields: PinnedField[],
): PinnedField[] => {
  return fields.map(field => {
    const sourceData =
      field.type === 'response'
        ? req.responseOverride?.modifiedData || req.responseBody
        : extractRequestData(req);

    if (sourceData === undefined || sourceData === null) {
      return { ...field, value: undefined };
    }

    const processedData = preprocessData(sourceData);
    let currentValue = getValueByPath(processedData, field.path);
    currentValue = tryParseJsonString(currentValue).parsed;

    return { ...field, value: currentValue };
  });
};

/** 为请求列表构建「请求 id → 带实际值的关注字段」映射（与 Panel 一致，响应字段走 mock 数据） */
export const buildPinnedFieldsWithValuesByRequestId = (
  requests: CapturedRequest[],
  pinnedFields: PinnedField[],
): Map<number, PinnedField[]> => {
  if (pinnedFields.length === 0) return new Map();

  const fieldsByApi = new Map<string, PinnedField[]>();
  pinnedFields.forEach(field => {
    const list = fieldsByApi.get(field.apiName);
    if (list) list.push(field);
    else fieldsByApi.set(field.apiName, [field]);
  });

  const result = new Map<number, PinnedField[]>();
  requests.forEach(req => {
    const apiFields = fieldsByApi.get(req.apiName);
    if (!apiFields?.length) return;
    result.set(req.id, computePinnedFieldsForRequest(req, apiFields));
  });
  return result;
};

// 计算数据的字节大小
export const calculateByteSize = (data: any): number => {
  try {
    if (data === undefined) return 0;

    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (str === undefined) return 0;

    // 使用 Blob 来计算准确的 UTF-8 字节大小
    return new Blob([str]).size;
  } catch {
    return 0;
  }
};

// 计算 HTTP 头部大小（字节）
export const calculateHeadersSize = (headers: Array<{ name: string; value: string }>): number => {
  if (!headers || headers.length === 0) return 0;

  // HTTP 头部格式: "Name: Value\r\n"
  let totalSize = 0;
  for (const header of headers) {
    // 头部名称 + ": " + 头部值 + "\r\n"
    totalSize += header.name.length + 2 + header.value.length + 2;
  }

  return totalSize;
};

export const parseContentLength = (
  headers: Array<{ name: string; value: string }> | undefined,
): number | undefined => {
  const contentLength = getHeaderValue(headers, 'content-length');
  if (!contentLength) return undefined;

  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

export const getContentEncoding = (
  headers: Array<{ name: string; value: string }> | undefined,
): string | undefined => {
  const contentEncoding = getHeaderValue(headers, 'content-encoding');
  if (!contentEncoding) return undefined;

  const normalized = contentEncoding
    .split(',')
    .map(encoding => encoding.trim())
    .filter(Boolean)
    .join(', ');

  if (!normalized || normalized === 'identity') {
    return undefined;
  }

  return normalized;
};

// 格式化字节大小为人类可读格式
export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

/**
 * 在原始数据中根据路径设置值
 * 该函数会处理嵌套的 JSON 字符串，确保修改能正确应用到原始数据结构中
 *
 * @param originalData 原始数据（可能包含字符串格式的 JSON）
 * @param parsedData 保留参数，保持 API 一致性（未使用）
 * @param path 要修改的路径（基于解析后的数据结构）
 * @param newValue 新值
 * @returns 修改后的原始数据
 */
export const setValueByPathInParsedData = (
  originalData: any,
  parsedData: any,
  path: string[],
  newValue: any,
): any => {
  if (path.length === 0) return newValue;

  // 深拷贝原始数据
  const result = JSON.parse(JSON.stringify(originalData));

  // 使用辅助函数递归设置值
  return setValueInObjectWithJsonString(result, path, newValue, 0);
};

/**
 * 在对象中根据路径设置值，支持处理 JSON 字符串和 Query String
 * 复用现有的 tryParseJsonString 函数来检测和解析 JSON/Query String
 */
function setValueInObjectWithJsonString(obj: any, path: string[], value: any, index: number): any {
  if (index >= path.length) return value;

  const key = path[index];
  const isLastKey = index === path.length - 1;

  if (isLastKey) {
    // 到达最后一个键，根据 value 是否为 undefined 决定是设置还是删除
    if (value === undefined) {
      // 删除操作
      if (Array.isArray(obj)) {
        // 数组：通过 splice 删除元素
        obj.splice(Number(key), 1);
      } else {
        // 对象：使用 delete 删除属性
        delete obj[key];
      }
    } else {
      // 设置值
      obj[key] = value;
    }
    return obj;
  }

  // 还有更深的路径，需要继续递归
  const currentValue = obj[key];

  // 复用 tryParseJsonString 检查是否是特殊格式
  const { parsed, format, prefix } = tryParseJsonString(currentValue);

  if (format) {
    // 当前值是特殊格式字符串，需要递归处理后再序列化回字符串
    const updatedParsed = setValueInObjectWithJsonString(parsed, path, value, index + 1);
    obj[key] = serializeWithFormat(updatedParsed, format, prefix);
  } else {
    // 不是 JSON 字符串，直接递归处理
    if (currentValue === undefined || currentValue === null) {
      // 路径不存在，创建空对象
      obj[key] = {};
    }
    setValueInObjectWithJsonString(obj[key], path, value, index + 1);
  }

  return obj;
}

/**
 * 解析请求的完整信息（queryString, postData, proxyData）
 * 统一处理 GET 和 POST 请求的数据提取逻辑
 *
 * @param url 请求 URL
 * @param requestBody 请求体（字符串或对象）
 * @param extraction API 名称提取结果（用于判断是否是代理请求）
 * @returns 解析后的请求信息
 */
export const parseRequestInfo = (
  url: string,
  requestBody?: string | any,
  extraction?: { isProxy: boolean },
): {
  queryString: Array<{ name: string; value: string }>;
  postData: any;
  proxyData: any;
} => {
  const result = {
    queryString: [] as Array<{ name: string; value: string }>,
    postData: null as any,
    proxyData: null as any,
  };

  // 1. 解析 URL 查询参数
  try {
    const urlObj = new URL(url);
    urlObj.searchParams.forEach((value, name) => {
      result.queryString.push({ name, value });
    });
  } catch {
    // URL 解析失败，忽略
  }

  // 2. 解析请求体
  if (requestBody) {
    if (typeof requestBody === 'string') {
      try {
        result.postData = JSON.parse(requestBody);
      } catch {
        result.postData = requestBody;
      }
    } else {
      result.postData = requestBody;
    }
  }

  // 3. 如果是代理请求，提取 proxyData
  if (extraction?.isProxy) {
    let dataStr: string | null = null;

    // 先尝试从 POST body 中的 data 或 requestBody 字段提取
    if (result.postData && typeof result.postData === 'object') {
      if (result.postData.requestBody) {
        dataStr = result.postData.requestBody;
      } else if (result.postData.data) {
        dataStr =
          typeof result.postData.data === 'string'
            ? result.postData.data
            : JSON.stringify(result.postData.data);
      }
    } else if (typeof requestBody === 'string') {
      // 从 URL 编码格式解析 data 参数
      const dataMatch = requestBody.match(/data=([^&]+)/);
      if (dataMatch) {
        dataStr = dataMatch[1];
      }
    }

    // 如果 POST body 没有，尝试从 queryString 的 data 参数提取（GET 请求）
    if (!dataStr && result.queryString.length > 0) {
      const dataParam = result.queryString.find(q => q.name === 'data');
      if (dataParam) {
        dataStr = dataParam.value;
      }
    }

    // 解析 dataStr
    if (dataStr) {
      try {
        const decodedData = decodeURIComponent(dataStr);
        result.proxyData = JSON.parse(decodedData);
      } catch {
        // JSON 解析失败，尝试保存原始数据
        try {
          result.proxyData = decodeURIComponent(dataStr);
        } catch {
          result.proxyData = dataStr;
        }
      }
    }
  }

  return result;
};

/**
 * 将时间戳（ms）格式化
 * @param ms 毫秒时间戳
 * @param format 格式：'full' = YYYY/MM/DD HH:mm:ss, 'short' = HH:mm:ss
 */
export const formatTimestamp = (ms: number, format: 'full' | 'short' = 'full'): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');

  if (format === 'short') {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/**
 * 生成事件子类型标识，用于埋点事件字段关注的维度 key。
 * 格式：`${source}/${event_type}` 或 `${source}/${event_type}:${type}`（有子类型时）
 */
export const getEventSubType = (event: {
  source: string;
  event_type: string;
  type?: string;
}): string => {
  const base = `${event.source}/${event.event_type}`;
  return event.type ? `${base}:${event.type}` : base;
};

/**
 * 将完整字段路径缩短为适合列表展示的短路径。
 * 规则：取最后两段；若最后两段以数字开头（数组索引），则取最后三段。
 */
export const shortenFieldPath = (path: string): string => {
  const segments = path.split('.');
  const lastTwo = segments.slice(-2).join('.');
  if (segments.length >= 3 && /^\d/.test(lastTwo)) {
    return segments.slice(-3).join('.');
  }
  return lastTwo;
};

/**
 * 将 PinnedEventField 适配为 PinnedField 结构，以复用 PinnedFieldsDisplay 组件。
 */
export const eventFieldToPinnedField = (field: {
  path: string;
  value: any;
  eventSubType: string;
}): { path: string; value: any; type: 'response'; apiName: string; requestId: number } => ({
  path: field.path,
  value: field.value,
  type: 'response' as const,
  apiName: field.eventSubType,
  requestId: 0,
});

export const getRetStatus = (responseBody: any): 'error' | 'warning' | null => {
  try {
    const ret = responseBody?.ret;
    if (!Array.isArray(ret)) return null;

    // 检查是否有包含 ERROR 的元素
    const hasError = ret.some((item: any) => String(item).includes('ERROR'));
    if (hasError) return 'error';

    // 检查是否有不包含 SUCCESS 的元素
    const hasNonSuccess = ret.some((item: any) => !String(item).includes('SUCCESS'));
    if (hasNonSuccess) return 'warning';

    return null;
  } catch {
    return null;
  }
};
