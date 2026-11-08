import { useLocalStorage } from './useLocalStorage';

/**
 * 快筛区域折叠状态，持久化到 chrome.storage.local
 * 所有列表共享同一个 key，以保持跨模式的折叠状态一致
 */
export function useFilterBarCollapsed(): [boolean, () => void, boolean] {
  const [collapsed, setCollapsed, isInitialized] = useLocalStorage<boolean>(
    'filter-bar-collapsed',
    false,
  );
  const toggle = () => setCollapsed(v => !v);
  return [collapsed, toggle, isInitialized];
}
