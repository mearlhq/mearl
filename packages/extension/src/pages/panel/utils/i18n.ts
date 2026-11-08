import browser from 'webextension-polyfill';
import { ensureBrowserUiSettings, getBrowserUiSettings } from './browserUiSettings';

// 当前使用的语言，默认为浏览器 UI 语言
let currentLanguage: string | null = null;

// messages 缓存
let messagesCache: Record<string, any> = {};

/**
 * 设置当前语言
 */
export function setLanguage(language: string): void {
  currentLanguage = language;
  messagesCache = {}; // 清空缓存
}

/**
 * 获取当前使用的语言
 */
export function getCurrentLanguage(): string {
  return currentLanguage || browser.i18n.getUILanguage();
}

/**
 * 加载指定语言的 messages.json
 */
async function loadMessages(locale: string): Promise<Record<string, any>> {
  if (messagesCache[locale]) {
    return messagesCache[locale];
  }

  try {
    const url = browser.runtime.getURL(`/_locales/${locale}/messages.json`);
    const response = await fetch(url);
    const messages = await response.json();
    messagesCache[locale] = messages;
    return messages;
  } catch (error) {
    console.error(`Failed to load messages for locale ${locale}:`, error);
    return {};
  }
}

/**
 * 获取国际化文案
 * 支持用户手动设置语言，否则使用浏览器 UI 语言
 * @param key 文案 key
 * @param substitutions 替换参数
 */
export function t(key: string, substitutions?: string | string[]): string {
  const entry = getBrowserUiSettings().messages?.[key];
  const language = getCurrentLanguage().replace('-', '_');
  const override = entry && (language.startsWith('zh') ? entry.zh_CN ?? entry.en : entry.en);
  if (override !== undefined) {
    const values = Array.isArray(substitutions) ? substitutions : substitutions === undefined ? [] : [substitutions];
    return override.replace(/\$(\d+)/g, (token, index: string) => values[Number(index) - 1] ?? token);
  }
  // 如果用户设置了语言，从对应的 messages.json 中读取
  if (currentLanguage) {
    const messages = messagesCache[currentLanguage];
    if (messages && messages[key]) {
      let message = messages[key].message || key;

      // 处理占位符
      if (substitutions) {
        const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
        message = message.replace(/\$(\d+)/g, (token: string, index: string) => subs[Number(index) - 1] ?? token);
      }

      return message;
    }
  }

  // 否则使用浏览器默认的国际化机制
  return browser.i18n.getMessage(key, substitutions) || key;
}

/**
 * 获取当前浏览器 UI 语言
 */
export function getCurrentLocale(): string {
  return browser.i18n.getUILanguage();
}

/**
 * 初始化国际化，加载用户配置的语言
 */
export async function initI18n(language?: string, options: { localOnly?: boolean } = {}): Promise<void> {
  if (!options.localOnly) await ensureBrowserUiSettings().catch(() => {});
  if (language) {
    currentLanguage = language;
    await loadMessages(language);
  }
}
