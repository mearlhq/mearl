import type { NavigationDivider } from '../types';

/** 追加导航分隔记录，并保证同一毫秒内生成的 ID 仍然唯一。 */
export function appendNavigationDivider(
  current: NavigationDivider[],
  url: string,
  timestampMs: number,
): NavigationDivider[] {
  const previous = current.at(-1);

  return [
    ...current,
    {
      type: 'navigation-divider',
      id: Math.max(timestampMs, (previous?.id ?? 0) + 1),
      timestampMs,
      url,
    },
  ];
}
