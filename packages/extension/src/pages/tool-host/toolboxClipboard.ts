import { t } from '../panel/utils/i18n';

const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024;
const MAX_CLIPBOARD_PIXELS = 16 * 1024 * 1024;

async function clipboardPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const image = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  try {
    // Clipboard image writes use PNG; bound the canvas allocation for other formats.
    if (image.width * image.height > MAX_CLIPBOARD_PIXELS) {
      throw new Error(t('toolboxClipboardImageDimensionsTooLarge'));
    }
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t('toolboxClipboardWriteFailed'));
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => {
        if (result) resolve(result);
        else reject(new Error(t('toolboxClipboardWriteFailed')));
      }, 'image/png');
    });
    if (png.size > MAX_CLIPBOARD_BYTES) throw new Error(t('toolboxClipboardImageTooLarge'));
    return png;
  } finally {
    image.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function writeToolboxClipboardImage(data: unknown): Promise<void> {
  if (typeof data !== 'string') throw new Error(t('toolboxClipboardImageInvalid'));
  if (data.length > MAX_CLIPBOARD_BYTES) throw new Error(t('toolboxClipboardImageTooLarge'));
  const match = data.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new Error(t('toolboxClipboardImageInvalid'));
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(match[2]);
    bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new Error(t('toolboxClipboardImageInvalid'));
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error(t('toolboxClipboardWriteFailed'));
  }
  const png = clipboardPng(new Blob([bytes], { type: match[1] }));
  // Permission may be rejected before the clipboard consumes the image promise.
  void png.catch(() => {});
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

export async function readToolboxClipboard(): Promise<
  { type: 'image'; data: string } | { type: 'text'; data: string }
> {
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const mime = item.types.find(
      type => type === 'image/png' || type === 'image/jpeg' || type === 'image/svg+xml',
    );
    if (!mime) continue;
    const blob = await item.getType(mime);
    if (blob.size > MAX_CLIPBOARD_BYTES) throw new Error(t('toolboxClipboardImageTooLarge'));
    if (mime === 'image/svg+xml') return { type: 'text', data: await blob.text() };
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error(t('toolboxClipboardReadFailed')));
      reader.readAsDataURL(blob);
    });
    if (data.length > MAX_CLIPBOARD_BYTES) throw new Error(t('toolboxClipboardImageTooLarge'));
    return { type: 'image', data };
  }
  const data = await navigator.clipboard.readText();
  if (new TextEncoder().encode(data).byteLength > MAX_CLIPBOARD_BYTES) {
    throw new Error(t('toolboxClipboardTextTooLarge'));
  }
  return { type: 'text', data };
}
