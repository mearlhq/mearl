import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeQrCodeFromImage } from '../qrCodeDecoder';

afterEach(() => vi.unstubAllGlobals());

describe('decodeQrCodeFromImage', () => {
  it('decodes and joins QR values locally', async () => {
    const close = vi.fn();
    const detect = vi.fn(async () => [{ rawValue: 'https://example.com' }, { rawValue: 'second' }]);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ close })),
    );
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        detect = detect;
      },
    );

    await expect(decodeQrCodeFromImage(new Blob(['image']))).resolves.toEqual({
      success: true,
      text: 'https://example.com\nsecond',
    });
    expect(detect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('supports the injected data URL path and preserves right-click copy behavior', async () => {
    const image = new Blob(['image'], { type: 'image/png' });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(image)),
    );
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ close: vi.fn() })),
    );
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        detect = vi.fn(async () => [{ rawValue: 'copied-content' }]);
      },
    );

    await expect(decodeQrCodeFromImage('data:image/png;base64,aW1hZ2U=', true)).resolves.toEqual({
      success: true,
      text: 'copied-content',
    });
    expect(writeText).toHaveBeenCalledWith('copied-content');
  });

  it('does not fail when the browser decoder is unavailable', async () => {
    vi.stubGlobal('BarcodeDetector', undefined);

    await expect(decodeQrCodeFromImage(new Blob(['image']))).resolves.toEqual({
      success: false,
      error: 'BarcodeDetector API not available',
    });
  });
});
