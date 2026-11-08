export type QrCodeDecodeResult =
  | { success: true; text: string }
  | { success: false; error: string };

interface DetectedBarcode {
  rawValue?: string;
}

interface BarcodeDetectorInstance {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options: { formats: string[] }): BarcodeDetectorInstance;
}

/**
 * 使用浏览器原生能力识别二维码。函数保持无外部运行时依赖，以便直接注入目标页面执行。
 */
export async function decodeQrCodeFromImage(
  image: Blob | string,
  copyToClipboard = false,
): Promise<QrCodeDecodeResult> {
  const Detector = (
    globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }
  ).BarcodeDetector;
  if (!Detector || typeof createImageBitmap !== 'function') {
    return { success: false, error: 'BarcodeDetector API not available' };
  }

  let bitmap: ImageBitmap | undefined;
  try {
    const blob =
      typeof image === 'string' ? await fetch(image).then(response => response.blob()) : image;
    bitmap = await createImageBitmap(blob);
    const detector = new Detector({ formats: ['qr_code'] });
    const text = (await detector.detect(bitmap))
      .map(code => code.rawValue?.trim() ?? '')
      .filter(Boolean)
      .join('\n');
    if (!text) return { success: false, error: 'not_found' };

    if (copyToClipboard) await navigator.clipboard.writeText(text);
    return { success: true, text };
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { success: false, error: reason };
  } finally {
    bitmap?.close();
  }
}
