import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copySvgImageToClipboard } from '../clipboard';

describe('copySvgImageToClipboard', () => {
  type MockClipboardItemData = Record<string, Blob | Promise<Blob>>;

  const pngBlob = new Blob(['png'], { type: 'image/png' });
  const context = {
    imageSmoothingEnabled: true,
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback) => callback(pngBlob)),
  };

  beforeEach(() => {
    vi.spyOn(document, 'createElement').mockImplementation(
      () => canvas as unknown as HTMLCanvasElement,
    );
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:qr-code'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('writes PNG and plain text representations to the clipboard', async () => {
    const clipboardWrite = vi.fn(async (items: Array<{ data: MockClipboardItemData }>) => {
      await Promise.all(Object.values(items[0].data));
    });

    vi.stubGlobal(
      'ClipboardItem',
      class {
        data: MockClipboardItemData;

        constructor(data: MockClipboardItemData) {
          this.data = data;
        }
      },
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: clipboardWrite },
    });

    await expect(
      copySvgImageToClipboard('<svg viewBox="0 0 21 21"></svg>', 'https://example.com'),
    ).resolves.toBe(true);

    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(600);
    expect(context.imageSmoothingEnabled).toBe(false);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 600, 600);
    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 600, 600);
    expect(clipboardWrite).toHaveBeenCalledOnce();

    const clipboardItem = clipboardWrite.mock.calls[0][0][0];
    expect(await Promise.resolve(clipboardItem.data['image/png'])).toBe(pngBlob);
    const plainTextBlob = await Promise.resolve(clipboardItem.data['text/plain']);
    expect(plainTextBlob).toMatchObject({
      type: 'text/plain',
    });
    expect(await plainTextBlob.text()).toBe('https://example.com');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:qr-code');
  });

  it('returns false when image clipboard writes are unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn() },
    });
    vi.stubGlobal('ClipboardItem', undefined);

    await expect(
      copySvgImageToClipboard('<svg viewBox="0 0 21 21"></svg>', 'https://example.com'),
    ).resolves.toBe(false);
  });
});
