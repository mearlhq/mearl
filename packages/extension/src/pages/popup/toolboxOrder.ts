export const TOOLBOX_ORDER_STORAGE_KEY = 'mearl.popup.toolbox.order';
export const TOOLBOX_PINNED_COUNT_STORAGE_KEY = 'mearl.popup.toolbox.pinnedCount';
export const DEFAULT_PINNED_TOOL_COUNT = 3;

export function readPinnedToolCount(): number {
  try {
    const stored = window.localStorage.getItem(TOOLBOX_PINNED_COUNT_STORAGE_KEY);
    const count = stored === null ? NaN : Number(stored);
    return Number.isSafeInteger(count) && count >= 0 ? count : DEFAULT_PINNED_TOOL_COUNT;
  } catch {
    return DEFAULT_PINNED_TOOL_COUNT;
  }
}

export const BUILT_IN_TOOL_IDS = [
  'builtin:formatter',
  'builtin:chat',
  'builtin:rules',
  'builtin:browsers',
  'builtin:capture',
] as const;

export function readToolOrder(): string[] {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(TOOLBOX_ORDER_STORAGE_KEY) || '[]',
    );
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function sortToolsByOrder<T extends { id: string }>(tools: T[], order: string[]): T[] {
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  return [...tools].sort(
    (left, right) =>
      (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
}
