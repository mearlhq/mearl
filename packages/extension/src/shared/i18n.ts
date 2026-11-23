import { ensureBrowserUiSettings, getBrowserUiSettings } from './browserUiSettingsClient';

let currentLanguage: string | null = null;
let messagesCache: Record<string, Record<string, { message: string }>> = {};

export function setLanguage(language: string): void {
  currentLanguage = language;
  messagesCache = {};
}

export function getCurrentLanguage(): string {
  return currentLanguage || chrome.i18n.getUILanguage();
}

export async function loadMessages(locale: string): Promise<Record<string, { message: string }>> {
  if (messagesCache[locale]) return messagesCache[locale];

  try {
    const response = await fetch(chrome.runtime.getURL(`/_locales/${locale}/messages.json`));
    const messages = await response.json();
    messagesCache[locale] = messages;
    return messages;
  } catch (error) {
    console.error(`Failed to load messages for locale ${locale}:`, error);
    return {};
  }
}

export function t(key: string, substitutions?: string | string[]): string {
  const entry = getBrowserUiSettings().messages?.[key];
  const language = getCurrentLanguage().replace('-', '_');
  const override = entry && (language.startsWith('zh') ? (entry.zh_CN ?? entry.en) : entry.en);
  if (override !== undefined) {
    const values = Array.isArray(substitutions)
      ? substitutions
      : substitutions === undefined
        ? []
        : [substitutions];
    return override.replace(
      /\$(\d+)/g,
      (token, index: string) => values[Number(index) - 1] ?? token,
    );
  }
  if (currentLanguage) {
    const message = messagesCache[currentLanguage]?.[key]?.message;
    if (message) {
      const values = Array.isArray(substitutions)
        ? substitutions
        : substitutions === undefined
          ? []
          : [substitutions];
      return message.replace(
        /\$(\d+)/g,
        (token, index: string) => values[Number(index) - 1] ?? token,
      );
    }
  }
  return chrome.i18n.getMessage(key, substitutions) || key;
}

export function getCurrentLocale(): string {
  return chrome.i18n.getUILanguage();
}

export async function initI18n(
  language?: string,
  options: { localOnly?: boolean } = {},
): Promise<void> {
  if (!options.localOnly) await ensureBrowserUiSettings().catch(() => {});
  if (language) {
    currentLanguage = language;
    await loadMessages(language);
  }
}
