import { useCallback, useEffect, useRef, useState } from 'react';
import { storageGetSafely, storageSetSafely } from '../utils/safeChrome';

interface UseLocalStorageOptions {
  sync?: boolean;
  persist?: boolean;
}

const areStorageValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }

  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

/**
 * 自动同步到 chrome.storage.local 的 state hook
 * 使用 chrome.storage.local 替代 localStorage 以确保数据在 DevTools 关闭后仍然保留
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  options: UseLocalStorageOptions = {},
): [T, (value: T | ((prev: T) => T)) => void, boolean] {
  const { sync = false, persist = true } = options;

  // 读取初始值
  const [storedValue, setStoredValue] = useState<T>(initialValue);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const isInitialized = loadedKey === key;
  const currentKeyRef = useRef(key);
  currentKeyRef.current = key;
  const storedKeyRef = useRef(key);
  const initialValueRef = useRef(initialValue);
  initialValueRef.current = initialValue;
  const changeRevision = useRef(0);
  const storedValueRef = useRef(storedValue);
  const skipNextPersistRef = useRef(false);

  // 检查是否支持 chrome.storage API
  const isChromeStorageAvailable = typeof chrome !== 'undefined' && !!chrome.storage?.local;
  const isStorageChangeAvailable = typeof chrome !== 'undefined' && !!chrome.storage?.onChanged;

  useEffect(() => {
    storedValueRef.current = storedValue;
  }, [storedValue]);

  // Key changes cannot persist or accept reads from the previous storage scope.
  useEffect(() => {
    let disposed = false;
    const readingRevision = changeRevision.current;
    skipNextPersistRef.current = false;
    const initialize = (result?: Record<string, T> | null) => {
      if (disposed) return;
      if (readingRevision === changeRevision.current) {
        const present = !!result && Object.hasOwn(result, key);
        if (present || storedKeyRef.current !== key) {
          storedKeyRef.current = key;
          skipNextPersistRef.current = present;
          setStoredValue(present ? result![key] : initialValueRef.current);
        }
      }
      setLoadedKey(key);
    };
    if (!isChromeStorageAvailable) {
      console.warn('chrome.storage is not available, using in-memory storage');
      initialize();
    } else {
      storageGetSafely<T>([key]).then(initialize).catch(error => {
        if (disposed) return;
        console.error(`Error loading ${key} from chrome.storage:`, error);
        initialize();
      });
    }
    return () => { disposed = true; };
  }, [key, isChromeStorageAvailable]);

  useEffect(() => {
    if (!sync || !isChromeStorageAvailable || !isStorageChangeAvailable) return;

    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (currentKeyRef.current !== key || areaName !== 'local' || !(key in changes)) return;
      changeRevision.current++;
      storedKeyRef.current = key;
      skipNextPersistRef.current = true;

      const nextValue = (changes[key].newValue ?? initialValue) as T;
      if (areStorageValuesEqual(storedValueRef.current, nextValue)) {
        return;
      }

      skipNextPersistRef.current = true;
      setStoredValue(nextValue);
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [key, initialValue, sync, isChromeStorageAvailable, isStorageChangeAvailable]);

  // 自动保存到 chrome.storage.local
  useEffect(() => {
    // 等待初始化完成后再保存，避免覆盖已有数据
    if (!persist || !isInitialized || !isChromeStorageAvailable) return;

    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }

    storageSetSafely({ [key]: storedValue }).catch(error => {
      console.error(`Error saving ${key} to chrome.storage:`, error);
    });
  }, [key, storedValue, isInitialized, isChromeStorageAvailable, persist]);

  const updateValue = useCallback((value: T | ((previous: T) => T)) => {
    if (currentKeyRef.current !== key) return;
    const sameScope = storedKeyRef.current === key;
    const initial = initialValueRef.current;
    changeRevision.current++;
    storedKeyRef.current = key;
    skipNextPersistRef.current = false;
    setStoredValue(previous => typeof value === 'function'
      ? (value as (previous: T) => T)(sameScope ? previous : initial)
      : value);
  }, [key]);

  return [storedKeyRef.current === key ? storedValue : initialValue, updateValue, isInitialized];
}

/**
 * 布尔值专用的 localStorage hook
 */
export function useLocalStorageBoolean(
  key: string,
  initialValue: boolean,
  options?: UseLocalStorageOptions,
): [boolean, () => void] {
  const [value, setValue] = useLocalStorage(key, initialValue, options);

  const toggle = () => setValue(prev => !prev);

  return [value, toggle];
}
