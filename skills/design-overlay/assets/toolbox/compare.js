// Generated from scripts/compare.mjs.
window.designOverlayCompare = async function comparePixels(screenshot, croppedDesign, content, settings, viewport, imageDiff) {
  const loadImage = src => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode comparison image'));
    image.src = src;
  });
  const source = content.trim().startsWith('data:')
    ? content : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
  const [screen, design] = await Promise.all([loadImage(screenshot), loadImage(croppedDesign || source)]);
  const { overlayRect: rect, innerWidth, innerHeight, devicePixelRatio } = viewport;
  const scale = innerWidth ? screen.naturalWidth / innerWidth : devicePixelRatio || 1;
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const w = Math.min(innerWidth, rect.x + rect.w) - x;
  const h = Math.min(innerHeight, rect.y + rect.h) - y;
  if (w <= 0 || h <= 0) throw new Error('Design is outside the visible viewport');
  const width = Math.max(1, Math.round(w * scale)), height = Math.max(1, Math.round(h * scale));
  if (width * height > 16_000_000) throw new Error('Comparison exceeds 16 million pixels');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is unavailable');
  ctx.drawImage(screen, x * scale, y * scale, w * scale, h * scale, 0, 0, width, height);
  const screenData = ctx.getImageData(0, 0, width, height);
  ctx.clearRect(0, 0, width, height);
  const ratioX = design.naturalWidth / (rect.w + (settings.cropLeft + settings.cropRight) * settings.scale);
  const ratioY = design.naturalHeight / (rect.h + (settings.cropTop + settings.cropBottom) * settings.scale);
  const sx = croppedDesign ? 0 : settings.cropLeft * settings.scale * ratioX;
  const sy = croppedDesign ? 0 : settings.cropTop * settings.scale * ratioY;
  const sw = croppedDesign ? design.naturalWidth : rect.w * ratioX;
  const sh = croppedDesign ? design.naturalHeight : rect.h * ratioY;
  ctx.drawImage(design, sx + (x - rect.x) / rect.w * sw, sy + (y - rect.y) / rect.h * sh,
    w / rect.w * sw, h / rect.h * sh, 0, 0, width, height);
  const designData = ctx.getImageData(0, 0, width, height);
  const output = new Uint8ClampedArray(width * height * 4);
  const count = imageDiff(screenData.data, designData.data, output, width, height);
  ctx.putImageData(new ImageData(output, width, height), 0, 0);
  return { image: canvas.toDataURL('image/png'), count, percentage: count / (width * height) * 100, width, height };
};
