export type ParsedToolboxIcon =
  | { kind: 'name'; name: string }
  | { kind: 'image'; src: string; monochrome?: true };

/** SVG is an image source so its markup never becomes executable extension DOM. */
export function parseToolboxIcon(value: unknown): ParsedToolboxIcon | undefined {
  if (typeof value !== 'string') return;
  const icon = value.trim();
  if (!icon || icon.length > 32 * 1024) return;
  if (/^[a-z][a-z0-9-]{0,39}$/.test(icon)) return { kind: 'name', name: icon };
  if (/^(?:<\?xml\s[^>]*\?>\s*)?<svg\b[^>]*(?:\/>|>[\s\S]*<\/svg\s*>)$/i.test(icon)) {
    const svg = /<svg\b[^>]*\sxmlns\s*=/i.test(icon)
      ? icon
      : icon.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    try {
      return {
        kind: 'image',
        src: `data:image/svg+xml,${encodeURIComponent(svg)}`,
        ...(/\bcurrentColor\b/i.test(svg) ? { monochrome: true as const } : {}),
      };
    } catch {
      return;
    }
  }
  const dataHeader =
    /^data:image\/(?:svg\+xml|png|jpeg|gif|webp|avif)(?:;charset=utf-8|;utf8)?(?:;base64)?,/i.exec(
      icon,
    );
  if (dataHeader && icon.length > dataHeader[0].length) return { kind: 'image', src: icon };
  try {
    const url = new URL(icon);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      return { kind: 'image', src: url.href };
    }
  } catch {
    /* Non-URL values cannot be image sources. */
  }
}
