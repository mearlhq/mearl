import { DEFAULT_CONFIG } from '../panel/utils/config';
import { loadMessages } from '../panel/utils/i18n';
import {
  DEVICE_PREVIEW_TOOLBAR_MESSAGE_KEYS,
  type QuickDeviceToolbarLabels,
} from '../../shared/quickDeviceToolbar';

export async function getDevicePreviewLocale() {
  const stored = await chrome.storage.sync.get('language').catch(() => ({}));
  const language =
    'language' in stored && stored.language === 'en' ? 'en' : DEFAULT_CONFIG.language;
  const messages = await loadMessages(language);
  const message = (key: string) => messages[key]?.message || chrome.i18n.getMessage(key);
  const labels = Object.fromEntries(
    DEVICE_PREVIEW_TOOLBAR_MESSAGE_KEYS.map(key => [key, message(key)]),
  ) as QuickDeviceToolbarLabels;
  return { language, message, labels };
}
