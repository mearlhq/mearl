/**
 * 翻译工具模块
 * 使用浏览器原生 Translation API 进行文本翻译
 */

/// <reference types="@types/dom-chromium-ai" />

import { tryParseJsonString, setValueByPathInParsedData } from './helpers';
import {
  loadTranslationDict,
  getCustomTranslationSync,
  listenTranslationDictChanges,
} from './translationDict';

// 预热加载持久化词典（模块加载时异步触发，后续调用 getCustomTranslationSync 可同步命中）
loadTranslationDict();
listenTranslationDictChanges();

export type TargetLanguage = 'zh' | 'en' | 'zh-Hant';

// 语言代码映射
const LANGUAGE_MAP: Record<string, string> = {
  en: 'en',
  'zh-TW': 'zh-Hant',
};

// 固定源语言为中文
const SOURCE_LANGUAGE = 'zh';

export interface TranslateProgress {
  current: number;
  total: number;
  phase?: 'downloading' | 'translating'; // 阶段标识
  downloadProgress?: number; // 0-1，模型下载进度
}

export interface TranslateResult {
  success: boolean;
  translatedData?: any;
  error?: string;
  needsDownload?: boolean;
  availabilityStatus?: string;
}

/**
 * 检查浏览器是否支持翻译 API
 * @returns 返回 availability 状态:
 * - 'unavailable': 设备不支持或资源不足
 * - 'downloadable': 需要下载模型，可调用 create() 触发下载
 * - 'downloading': 模型下载中，必须等待完成
 * - 'available': 可以立即使用
 */
export async function checkTranslateAvailability(
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string | null> {
  if (!Translator?.availability) {
    return null;
  }

  try {
    const availability = await Translator.availability({
      sourceLanguage,
      targetLanguage,
    });
    return availability;
  } catch (error) {
    console.error('检查翻译支持失败:', error);
    return null;
  }
}

/**
 * 检查浏览器是否支持翻译 API（简化版，只返回布尔值）
 */
export async function checkTranslateSupport(
  sourceLanguage: string,
  targetLanguage: string,
): Promise<boolean> {
  const availability = await checkTranslateAvailability(sourceLanguage, targetLanguage);
  // 'available', 'downloadable', 'downloading' 都表示功能可用（虽然可能需要等待）
  return (
    availability === 'available' ||
    availability === 'downloadable' ||
    availability === 'downloading'
  );
}

/**
 * 检测字符串是否包含中文
 */
function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text);
}

/**
 * 检测字符串是否为 URL（含带中文参数的 URL）
 * 有中文但整体是 URL 时不需要翻译
 */
function isUrl(text: string): boolean {
  const trimmed = text.trim();
  return /^https?:\/\/\S+$/i.test(trimmed) || /^\/\/\S+$/.test(trimmed);
}

/**
 * 检测字符串是否为 HTML 富文本
 */
function isHtmlText(text: string): boolean {
  // 检测是否包含 HTML 标签（简单的标签检测）
  return /<[^>]+>/.test(text);
}

/**
 * 从 HTML 中提取需要翻译的文本片段
 * 返回文本片段数组和占位符映射
 */
interface HtmlTextExtraction {
  /** 包含占位符的 HTML 模板 */
  template: string;
  /** 提取的文本片段列表 */
  textFragments: string[];
}

function extractHtmlTexts(html: string): HtmlTextExtraction {
  const textFragments: string[] = [];
  let placeholderIndex = 0;

  // 将 HTML 分割成标签和文本节点
  // 匹配所有 HTML 标签（包括自闭合标签）
  const tagRegex = /<[^>]+>/g;
  const parts: Array<{ type: 'tag' | 'text'; content: string }> = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    // 添加标签前的文本
    if (match.index > lastIndex) {
      const text = html.substring(lastIndex, match.index);
      parts.push({ type: 'text', content: text });
    }
    // 添加标签
    parts.push({ type: 'tag', content: match[0] });
    lastIndex = tagRegex.lastIndex;
  }

  // 添加最后一个标签后的文本
  if (lastIndex < html.length) {
    const text = html.substring(lastIndex);
    parts.push({ type: 'text', content: text });
  }

  // 处理每个部分
  const processedParts = parts.map(part => {
    if (part.type === 'text') {
      // 文本节点：如果包含中文，替换为占位符
      const trimmedText = part.content.trim();
      if (trimmedText && containsChinese(trimmedText)) {
        const placeholder = `__TEXT_${placeholderIndex}__`;
        textFragments.push(trimmedText);
        placeholderIndex++;
        // 保留原始文本的前后空格
        const leadingSpaces = part.content.match(/^\s*/)?.[0] || '';
        const trailingSpaces = part.content.match(/\s*$/)?.[0] || '';
        return `${leadingSpaces}${placeholder}${trailingSpaces}`;
      }
      return part.content;
    } else {
      // 标签节点：处理属性中的中文
      let tagContent = part.content;
      const translatableAttrs = ['title', 'alt', 'placeholder', 'aria-label'];

      translatableAttrs.forEach(attr => {
        const attrRegex = new RegExp(`(${attr}\\s*=\\s*["'])([^"']+)(["'])`, 'gi');
        tagContent = tagContent.replace(attrRegex, (match, prefix, attrValue, suffix) => {
          if (containsChinese(attrValue)) {
            const placeholder = `__TEXT_${placeholderIndex}__`;
            textFragments.push(attrValue);
            placeholderIndex++;
            return `${prefix}${placeholder}${suffix}`;
          }
          return match;
        });
      });

      return tagContent;
    }
  });

  const template = processedParts.join('');

  return {
    template,
    textFragments,
  };
}

/**
 * 将翻译后的文本片段回填到 HTML 模板中
 */
function reconstructHtml(template: string, translatedFragments: string[]): string {
  let result = template;
  translatedFragments.forEach((fragment, index) => {
    const placeholder = `__TEXT_${index}__`;
    result = result.replace(placeholder, fragment);
  });
  return result;
}

/**
 * 翻译富文本内容
 * 如果是 HTML，会提取其中的文本节点进行翻译，然后回填
 */
async function translateRichText(text: string, translator: any): Promise<string> {
  // 检测是否为 HTML 富文本
  if (!isHtmlText(text)) {
    // 不是 HTML，直接翻译
    return await translator.translate(text);
  }

  // 是 HTML 富文本，提取文本节点
  const { template, textFragments } = extractHtmlTexts(text);

  // 如果没有提取到需要翻译的文本，返回原文
  if (textFragments.length === 0) {
    return text;
  }

  // 翻译所有文本片段
  const translatedFragments = await Promise.all(
    textFragments.map(fragment => translator.translate(fragment)),
  );

  // 重建 HTML
  return reconstructHtml(template, translatedFragments);
}

/**
 * 收集 JSON 中所有需要翻译的字段
 */
interface TranslateField {
  path: string[];
  value: string;
  isJsonString?: boolean; // 标记该字段是否来自 JSON 字符串
}

function collectTranslatableFields(data: any, currentPath: string[] = []): TranslateField[] {
  const fields: TranslateField[] = [];

  if (typeof data === 'string') {
    if (data.trim().length === 0) {
      return fields;
    }

    // 尝试解析字符串是否为嵌套的 JSON
    const { parsed, format } = tryParseJsonString(data);

    if (format) {
      // 如果是 JSON 字符串，递归收集其中的字段
      // 这些字段需要标记为来自 JSON 字符串，以便在设置时正确处理
      const nestedFields = collectTranslatableFields(parsed, currentPath);
      nestedFields.forEach(field => {
        field.isJsonString = true;
      });
      fields.push(...nestedFields);
    } else if (containsChinese(data) && !isUrl(data)) {
      // 不是 JSON 字符串、不是 URL 但包含中文，直接收集
      fields.push({ path: [...currentPath], value: data });
    }
  } else if (Array.isArray(data)) {
    data.forEach((item, index) => {
      fields.push(...collectTranslatableFields(item, [...currentPath, String(index)]));
    });
  } else if (data && typeof data === 'object') {
    Object.entries(data).forEach(([key, value]) => {
      // 跳过最外层的 ret 字段
      if (currentPath.length === 0 && key === 'ret') {
        return;
      }
      fields.push(...collectTranslatableFields(value, [...currentPath, key]));
    });
  }

  return fields;
}

// Translator 实例缓存，避免每次翻译都重新 create()
const translatorCache = new Map<string, any>();

// 翻译结果文本缓存：key 为 `${targetLanguage}:${text}`，跨请求复用翻译结果
const TRANSLATION_TEXT_CACHE_MAX = 2000;
const translationTextCache = new Map<string, string>();

function getCachedTranslation(targetLanguage: string, text: string): string | undefined {
  return translationTextCache.get(`${targetLanguage}:${text}`);
}

function setCachedTranslation(targetLanguage: string, text: string, translated: string): void {
  // 超出上限时淘汰最旧的 20% 条目（Map 按插入顺序迭代）
  if (translationTextCache.size >= TRANSLATION_TEXT_CACHE_MAX) {
    const deleteCount = Math.ceil(TRANSLATION_TEXT_CACHE_MAX * 0.2);
    const it = translationTextCache.keys();
    for (let i = 0; i < deleteCount; i++) {
      const { value, done } = it.next();
      if (done) break;
      translationTextCache.delete(value);
    }
  }
  translationTextCache.set(`${targetLanguage}:${text}`, translated);
}

export interface CachedTranslationEntry {
  text: string;
  targetLanguage: string;
  translated: string;
}

/**
 * 返回当前内存中所有翻译缓存条目（用于翻译词典从缓存选取功能）
 */
export function getTranslationCache(): CachedTranslationEntry[] {
  const result: CachedTranslationEntry[] = [];
  for (const [key, translated] of translationTextCache.entries()) {
    const colonIdx = key.indexOf(':');
    if (colonIdx !== -1) {
      const targetLanguage = key.slice(0, colonIdx);
      const text = key.slice(colonIdx + 1);
      result.push({ text, targetLanguage, translated });
    }
  }
  return result;
}

/**
 * 获取或创建 Translator 实例（带缓存）
 * @param onDownloadProgress 模型下载进度回调，参数为 0-1
 */
async function getOrCreateTranslator(
  sourceLanguage: string,
  targetLanguage: string,
  onDownloadProgress?: (progress: number) => void,
): Promise<any> {
  const cacheKey = `${sourceLanguage}→${targetLanguage}`;
  if (translatorCache.has(cacheKey)) {
    return translatorCache.get(cacheKey);
  }
  const translator = await Translator.create({
    sourceLanguage,
    targetLanguage,
    monitor: onDownloadProgress
      ? (monitor: any) => {
          monitor.addEventListener('downloadprogress', (event: any) => {
            const loaded = event.loaded ?? 0;
            const total = event.total ?? 0;
            if (total > 0) {
              onDownloadProgress(loaded / total);
            } else {
              // total 未知时，报告 -1 表示不确定
              onDownloadProgress(-1);
            }
          });
        }
      : undefined,
  });
  translatorCache.set(cacheKey, translator);
  return translator;
}

/**
 * 翻译 JSON 数据
 * @param data 原始 JSON 数据
 * @param targetLang 目标语言（'en' | 'zh-TW'）
 * @param onProgress 进度回调
 * @param concurrency 并发数，默认为 10
 */
export async function translateJson(
  data: any,
  targetLang: 'en' | 'zh-TW',
  onProgress?: (progress: TranslateProgress) => void,
  concurrency: number = 10,
): Promise<TranslateResult> {
  if (!Translator?.create) {
    return {
      success: false,
      error: 'browserAiNotSupported',
    };
  }

  // 收集需要翻译的字段（只收集中文字段）
  const fields = collectTranslatableFields(data);

  if (fields.length === 0) {
    return {
      success: false,
      error: 'noChineseFields',
    };
  }

  try {
    // 转换语言代码
    const targetLanguageCode = LANGUAGE_MAP[targetLang];

    // 检查翻译可用性（源语言固定为中文）
    const availability = await checkTranslateAvailability(SOURCE_LANGUAGE, targetLanguageCode);

    // 'unavailable' 表示设备不支持或资源不足（如电量、磁盘空间）
    if (!availability || availability === 'unavailable') {
      return {
        success: false,
        error: 'browserAiNotSupported',
        availabilityStatus: availability || 'unavailable',
      };
    }

    // 获取或复用已缓存的翻译器（源语言固定为中文）
    const translator = await getOrCreateTranslator(
      SOURCE_LANGUAGE,
      targetLanguageCode,
      onProgress
        ? (downloadProgress: number) => {
            onProgress({
              current: 0,
              total: fields.length,
              phase: 'downloading',
              downloadProgress: downloadProgress >= 0 ? downloadProgress : undefined,
            });
          }
        : undefined,
    );

    let translatedData = JSON.parse(JSON.stringify(data));
    let completed = 0;

    // 发送初始进度
    if (onProgress) {
      onProgress({
        current: 0,
        total: fields.length,
        phase: 'translating',
      });
    }

    // 文本去重：相同字符串只翻译一次，结果复用
    const uniqueTexts = Array.from(new Set(fields.map(f => f.value)));
    const translationMap = new Map<string, string>();

    // 优先顺序：持久化用户词典 > 跨请求 AI 缓存 > 实际 AI 翻译
    const textsToTranslate = uniqueTexts.filter(text => {
      // 1. 用户自定义词典（最高优先级，同步查询内存缓存）
      const custom = getCustomTranslationSync(targetLanguageCode, text);
      if (custom !== undefined) {
        translationMap.set(text, custom);
        return false;
      }
      // 2. AI 翻译内存缓存
      const cached = getCachedTranslation(targetLanguageCode, text);
      if (cached !== undefined) {
        translationMap.set(text, cached);
        return false;
      }
      return true;
    });

    // 信号量：始终保持最多 concurrency 个翻译任务并行，
    // 一个完成立即补充下一个，比分批并发效率更高
    let activeCount = 0;
    let nextIndex = 0;

    await new Promise<void>(resolve => {
      function trySchedule() {
        while (activeCount < concurrency && nextIndex < textsToTranslate.length) {
          const text = textsToTranslate[nextIndex++];
          activeCount++;

          translateRichText(text, translator)
            .then(translated => {
              translationMap.set(text, translated);
              setCachedTranslation(targetLanguageCode, text, translated);
            })
            .catch(() => {
              translationMap.set(text, text); // 失败时保留原文
            })
            .finally(() => {
              activeCount--;
              // 进度按原始字段数上报（有去重时，completed 跟随唯一文本进度）
              completed = Math.min(
                Math.round((translationMap.size / uniqueTexts.length) * fields.length),
                fields.length,
              );
              if (onProgress) {
                onProgress({ current: completed, total: fields.length, phase: 'translating' });
              }
              if (nextIndex < textsToTranslate.length) {
                trySchedule();
              } else if (activeCount === 0) {
                resolve();
              }
            });
        }

        if (nextIndex >= textsToTranslate.length && activeCount === 0) {
          resolve();
        }
      }

      trySchedule();
    });

    // 用翻译结果回填所有字段
    fields.forEach(field => {
      const translated = translationMap.get(field.value) ?? field.value;
      translatedData = setValueByPathInParsedData(
        translatedData,
        translatedData,
        field.path,
        translated,
      );
    });

    return {
      success: true,
      translatedData,
    };
  } catch (error) {
    console.error('翻译过程出错:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'translateFailed',
    };
  }
}
