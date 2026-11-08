import type { ToolboxPluginToolLocale } from '@mearl/browser-core';
import { getCurrentLanguage } from '../pages/panel/utils/i18n';

interface LocalizableToolboxMetadata {
  title: string;
  description?: string;
  locales?: Record<string, ToolboxPluginToolLocale>;
}

function localizedMetadata(
  locales: Record<string, ToolboxPluginToolLocale>,
): ToolboxPluginToolLocale | undefined {
  const locale = getCurrentLanguage().replaceAll('-', '_');
  const language = locale.split('_')[0];
  return locales[locale] ?? locales[locale.toLowerCase()] ?? locales[language];
}

export function localizeToolboxMetadata<T extends LocalizableToolboxMetadata>(metadata: T): T {
  if (!metadata.locales) return metadata;
  const localized = localizedMetadata(metadata.locales);
  if (!localized) return metadata;
  return {
    ...metadata,
    title: localized.title ?? metadata.title,
    description: localized.description ?? metadata.description,
  };
}
