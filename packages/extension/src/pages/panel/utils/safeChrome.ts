/**
 * Extension Context 管理工具
 * 处理扩展上下文失效的情况，自动刷新页面
 */

import { toError } from './errors';

/**
 * 检查扩展上下文是否有效
 */
const isExtensionContextValid = (): boolean => {
  try {
    return !!chrome?.runtime?.id;
  } catch {
    return false;
  }
};

// sessionStorage key 用于刷新后显示提示
const RELOAD_TOAST_KEY = 'mearl-extension-reloaded';

/**
 * 处理 Extension Context 失效（情况 B）
 * 自动刷新 Panel 页面恢复
 */
const handleExtensionContextInvalidated = () => {
  console.warn('[Mearl] Extension context invalidated, reloading panel...');
  // 设置标记，刷新后显示 toast 提示
  try {
    sessionStorage.setItem(RELOAD_TOAST_KEY, '1');
  } catch {
    // ignore
  }
  window.location.reload();
};

/**
 * 检查是否需要显示刷新提示（刷新后调用一次）
 */
export const checkAndConsumeReloadToast = (): boolean => {
  try {
    if (sessionStorage.getItem(RELOAD_TOAST_KEY) === '1') {
      sessionStorage.removeItem(RELOAD_TOAST_KEY);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
};

/**
 * 包装 chrome.runtime.sendMessage
 *
 * 异常情况处理：Extension Context 失效 → 自动刷新 Panel 页面恢复
 */
export const sendMessageSafely = async <T = any>(
  message: any,
  options?: chrome.runtime.MessageOptions,
): Promise<T | null> => {
  // Extension Context 已失效，自动刷新
  if (!isExtensionContextValid()) {
    handleExtensionContextInvalidated();
    return null;
  }

  try {
    const response = await new Promise<T>((resolve, reject) => {
      chrome.runtime.sendMessage(message, options, response => {
        if (chrome.runtime.lastError) {
          const error = chrome.runtime.lastError;
          // Extension Context 失效错误
          if (error.message?.includes('Extension context invalidated')) {
            handleExtensionContextInvalidated();
          }
          reject(toError(error));
        } else {
          resolve(response);
        }
      });
    });

    return response;
  } catch (error: any) {
    // Extension Context 失效
    if (error?.message?.includes('Extension context invalidated')) {
      handleExtensionContextInvalidated();
    }
    throw error;
  }
};

/**
 * 包装 chrome.storage 操作，自动处理上下文失效
 */
export const storageGetSafely = async <T = any>(
  keys: string | string[] | { [key: string]: any } | null,
): Promise<{ [key: string]: T } | null> => {
  // 情况 B：Extension Context 已失效，自动刷新
  if (!isExtensionContextValid()) {
    handleExtensionContextInvalidated();
    return null;
  }

  return await new Promise<{ [key: string]: T }>((resolve, reject) => {
    chrome.storage.local.get(keys, result => {
      if (chrome.runtime.lastError) {
        reject(toError(chrome.runtime.lastError));
      } else {
        resolve(result as { [key: string]: T });
      }
    });
  });
};

/**
 * 包装 chrome.storage.set 操作，自动处理上下文失效
 */
export const storageSetSafely = async (items: { [key: string]: any }): Promise<void | null> => {
  // 情况 B：Extension Context 已失效，自动刷新
  if (!isExtensionContextValid()) {
    handleExtensionContextInvalidated();
    return null;
  }

  return await new Promise<void>((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(toError(chrome.runtime.lastError));
      } else {
        resolve();
      }
    });
  });
};

/**
 * 全局错误处理，捕获未处理的上下文失效错误
 */
export const setupGlobalErrorHandler = (): void => {
  window.addEventListener('error', event => {
    if (
      event.error?.message?.includes('Extension context invalidated') ||
      event.message?.includes('Extension context invalidated')
    ) {
      event.preventDefault();
      console.warn('Extension context invalidated detected, reloading page...');
      window.location.reload();
    }
  });

  window.addEventListener('unhandledrejection', event => {
    if (
      event.reason?.message?.includes('Extension context invalidated') ||
      String(event.reason)?.includes('Extension context invalidated')
    ) {
      event.preventDefault();
      console.warn('Extension context invalidated detected in promise, reloading page...');
      window.location.reload();
    }
  });
};
