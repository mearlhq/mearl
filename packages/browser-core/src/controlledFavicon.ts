export type ControlSource = 'local' | 'remote';
export type ControlSourceWireValue = 'local' | 'cloud';

export function normalizeControlSource(source: unknown): ControlSource {
  return source === 'remote' || source === 'cloud' ? 'remote' : 'local';
}

/** Mixed package versions share this boundary, so remote control uses the stable wire value. */
export function toControlSourceWireValue(source: ControlSource): ControlSourceWireValue {
  return source === 'remote' ? 'cloud' : 'local';
}

/** Mirrors packages/extension/public/icons/icon.svg. */
const BASE_ICON = `
  <rect width="128" height="128" rx="28" fill="#3273E8"/>
  <path d="M36 90V40L64 68L92 40V90" stroke="#FFFFFF" stroke-width="14"
    stroke-linecap="round" stroke-linejoin="round" fill="none"/>
`;

const SOURCE_BADGES: Record<ControlSource, string> = {
  local: `
    <circle cx="104" cy="104" r="21" fill="#16A34A" stroke="#FFFFFF" stroke-width="6"/>
  `,
  remote: `
    <circle cx="104" cy="104" r="21" fill="#FF7A00" stroke="#FFFFFF" stroke-width="6"/>
  `,
};

/**
 * 生成受控页面 favicon：保留 Mearl 主图形，仅用右下角高对比角标区分控制来源。
 * SVG 在浏览器和 Node.js 中都能直接生成，扩展与 CDP 因而共享完全一致的图标。
 */
export function createControlledFaviconDataUrl(source: ControlSource): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" data-control-source="${source}">
${BASE_ICON}
${SOURCE_BADGES[source]}
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function isControlledFaviconDataUrl(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value === createControlledFaviconDataUrl('local') ||
      value === createControlledFaviconDataUrl('remote'))
  );
}
