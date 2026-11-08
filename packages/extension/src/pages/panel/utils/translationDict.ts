/**
 * 翻译自定义词典
 *
 * 存储用户手动配置的翻译覆盖项，优先级高于 AI 翻译结果。
 * 数据持久化到 chrome.storage.local。
 */

export const TRANSLATION_DICT_STORAGE_KEY = 'mearl-translation-dict';

/**
 * 词典格式：原文 → { [targetLang]: 自定义译文 }
 * targetLang 与 translate.ts 中的 LANGUAGE_MAP value 一致：'en' | 'zh-Hant'
 */
export type TranslationDict = Record<string, Record<string, string>>;

// 模块级内存缓存，供 background worker 中同步查询
let _memCache: TranslationDict | null = null;
let _loadPromise: Promise<TranslationDict> | null = null;

/** 从 storage 加载词典（带内存缓存，多次调用只请求一次） */
export function loadTranslationDict(): Promise<TranslationDict> {
  if (_memCache !== null) return Promise.resolve(_memCache);
  if (_loadPromise) return _loadPromise;

  _loadPromise = new Promise(resolve => {
    chrome.storage.local.get([TRANSLATION_DICT_STORAGE_KEY], result => {
      const dict = (result[TRANSLATION_DICT_STORAGE_KEY] ?? {}) as TranslationDict;
      _memCache = dict;
      _loadPromise = null;
      resolve(dict);
    });
  });
  return _loadPromise;
}

/** 保存词典到 storage 并更新内存缓存 */
export function saveTranslationDict(dict: TranslationDict): Promise<void> {
  _memCache = dict;
  return new Promise(resolve => {
    chrome.storage.local.set({ [TRANSLATION_DICT_STORAGE_KEY]: dict }, resolve);
  });
}

/** 同步查询内存缓存中的自定义译文（内存缓存未加载时返回 undefined） */
export function getCustomTranslationSync(targetLanguage: string, text: string): string | undefined {
  return _memCache?.[text]?.[targetLanguage];
}

/** 异步查询自定义译文（确保词典已加载） */
export async function getCustomTranslation(
  targetLanguage: string,
  text: string,
): Promise<string | undefined> {
  const dict = await loadTranslationDict();
  return dict[text]?.[targetLanguage];
}

/** 设置/更新单条自定义译文 */
export async function setCustomTranslation(
  targetLanguage: string,
  originalText: string,
  translatedText: string,
): Promise<void> {
  const dict = await loadTranslationDict();
  const entry = dict[originalText] ?? {};
  entry[targetLanguage] = translatedText;
  dict[originalText] = entry;
  await saveTranslationDict(dict);
}

/** 删除某条原文的全部语言译文（整行删除） */
export async function deleteTranslationEntry(originalText: string): Promise<void> {
  const dict = await loadTranslationDict();
  delete dict[originalText];
  await saveTranslationDict(dict);
}

/** 删除某条原文某语言的译文 */
export async function deleteCustomTranslation(
  targetLanguage: string,
  originalText: string,
): Promise<void> {
  const dict = await loadTranslationDict();
  if (dict[originalText]) {
    delete dict[originalText][targetLanguage];
    if (Object.keys(dict[originalText]).length === 0) {
      delete dict[originalText];
    }
    await saveTranslationDict(dict);
  }
}

/** 监听 storage 变化，保持内存缓存同步（在 background worker 中注册一次） */
export function listenTranslationDictChanges(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && TRANSLATION_DICT_STORAGE_KEY in changes) {
      _memCache = (changes[TRANSLATION_DICT_STORAGE_KEY].newValue ?? {}) as TranslationDict;
    }
  });
}

/** 导出词典为 JSON 字符串 */
export function exportTranslationDict(dict: TranslationDict): string {
  return JSON.stringify(dict, null, 2);
}

/** 从 JSON 字符串导入词典（合并模式：导入项覆盖同名条目，其他保留） */
export async function importTranslationDict(
  jsonStr: string,
  mode: 'merge' | 'replace' = 'merge',
): Promise<{ success: boolean; count: number; error?: string }> {
  let imported: TranslationDict;
  try {
    imported = JSON.parse(jsonStr);
    if (typeof imported !== 'object' || Array.isArray(imported)) {
      throw new Error('Invalid format');
    }
  } catch {
    return { success: false, count: 0, error: 'invalidJson' };
  }

  const base = mode === 'merge' ? await loadTranslationDict() : {};
  const merged: TranslationDict = { ...base };

  let count = 0;
  for (const [orig, langs] of Object.entries(imported)) {
    if (typeof langs !== 'object' || Array.isArray(langs)) continue;
    merged[orig] = { ...(merged[orig] ?? {}), ...langs };
    count++;
  }

  await saveTranslationDict(merged);
  return { success: true, count };
}
