import type { ToolboxPluginToolLocale } from '@mearl/browser-core';
import { getCurrentLanguage } from './i18n';

interface LocalizableToolboxMetadata {
  title: string;
  description?: string;
  locales?: Record<string, ToolboxPluginToolLocale>;
}

function localizedMetadata(
  locales: Record<string, ToolboxPluginToolLocale>,
  uiLanguage: string,
): ToolboxPluginToolLocale | undefined {
  const locale = uiLanguage.replaceAll('-', '_');
  const language = locale.split('_')[0];
  return locales[locale] ?? locales[locale.toLowerCase()] ?? locales[language];
}

export function localizeToolboxMetadata<T extends LocalizableToolboxMetadata>(
  metadata: T,
  uiLanguage = getCurrentLanguage(),
): T {
  if (!metadata.locales) return metadata;
  const localized = localizedMetadata(metadata.locales, uiLanguage);
  if (!localized) return metadata;
  return {
    ...metadata,
    title: localized.title ?? metadata.title,
    description: localized.description ?? metadata.description,
  };
}
