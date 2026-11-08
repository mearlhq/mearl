import { useState, useEffect } from 'react';

/**
 * 自动同步到 sessionStorage 的 state hook
 * 数据在标签页会话期间保留，关闭标签页后会清除
 */
export function useSessionStorage<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  // 读取初始值
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = sessionStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(`Error loading ${key} from sessionStorage:`, error);
      return initialValue;
    }
  });

  // 自动保存到 sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(storedValue));
    } catch (error) {
      console.error(`Error saving ${key} to sessionStorage:`, error);
    }
  }, [key, storedValue]);

  return [storedValue, setStoredValue];
}

/**
 * 布尔值专用的 sessionStorage hook
 */
export function useSessionStorageBoolean(
  key: string,
  initialValue: boolean,
): [boolean, () => void] {
  const [value, setValue] = useSessionStorage(key, initialValue);

  const toggle = () => setValue(prev => !prev);

  return [value, toggle];
}
