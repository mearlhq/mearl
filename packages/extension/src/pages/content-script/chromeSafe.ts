export function isExtensionContextValid(): boolean {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

export function safeSendMessage<T = any>(message: any): Promise<T | null> {
  if (!isExtensionContextValid()) {
    return Promise.resolve(null);
  }
  try {
    return chrome.runtime.sendMessage(message).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

export function safeStorageSyncGet<T extends Record<string, any>>(
  defaults: T,
  callback: (result: T) => void,
) {
  if (!isExtensionContextValid()) {
    callback(defaults);
    return;
  }
  try {
    chrome.storage.sync.get(defaults, result => {
      if (chrome.runtime.lastError) {
        callback(defaults);
        return;
      }
      callback((result as T) ?? defaults);
    });
  } catch {
    callback(defaults);
  }
}

export function i18nMessage(name: string, substitutions?: string): string {
  if (!isExtensionContextValid()) {
    return '';
  }
  try {
    return chrome.i18n.getMessage(name, substitutions) || '';
  } catch {
    return '';
  }
}
