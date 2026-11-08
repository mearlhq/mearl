import { afterEach, describe, expect, it, vi } from 'vitest';
import { readToolboxClipboard, writeToolboxClipboardImage } from '../toolboxClipboard';

vi.mock('../../panel/utils/i18n', () => ({
  t: (key: string) =>
    key === 'toolboxClipboardImageTooLarge' ? 'Clipboard image exceeds 16 MiB' : key,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('toolbox clipboard read', () => {
  const clipboard = (read: () => Promise<unknown[]>, text = '<svg />') => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { read, readText: vi.fn(async () => text) },
    });
  };

  it('returns SVG clipboard text when there is no image', async () => {
    clipboard(async () => [{ types: ['text/plain'] }]);
    await expect(readToolboxClipboard()).resolves.toEqual({ type: 'text', data: '<svg />' });
  });

  it('reads a PNG before a text representation', async () => {
    clipboard(async () => [
      {
        types: ['text/plain', 'image/png'],
        getType: async () => new Blob(['png'], { type: 'image/png' }),
      },
    ]);
    await expect(readToolboxClipboard()).resolves.toEqual({
      type: 'image',
      data: 'data:image/png;base64,cG5n',
    });
    expect(navigator.clipboard.readText).not.toHaveBeenCalled();
  });

  it('rejects oversized images before reading them into memory', async () => {
    clipboard(async () => [
      { types: ['image/png'], getType: async () => ({ size: 16 * 1024 * 1024 + 1 }) },
    ]);
    await expect(readToolboxClipboard()).rejects.toThrow('16 MiB');
  });

  it('preserves SVG content from an image clipboard item', async () => {
    clipboard(async () => [
      {
        types: ['image/svg+xml'],
        getType: async () => new Blob(['<svg />'], { type: 'image/svg+xml' }),
      },
    ]);
    await expect(readToolboxClipboard()).resolves.toEqual({ type: 'text', data: '<svg />' });
  });

  it('propagates clipboard permission failures', async () => {
    clipboard(async () => {
      throw new Error('permission denied');
    });
    await expect(readToolboxClipboard()).rejects.toThrow('permission denied');
  });
});

describe('toolbox clipboard image write', () => {
  function clipboard() {
    const write = vi.fn(async (items: { data: Record<string, Promise<Blob>> }[]) => {
      await items[0].data['image/png'];
    });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(public data: Record<string, Promise<Blob>>) {}
      },
    );
    return write;
  }

  it('writes PNG bytes without converting the image', async () => {
    const write = clipboard();
    const bitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', bitmap);
    await writeToolboxClipboardImage('data:image/png;base64,cG5n');
    const png = await write.mock.calls[0][0][0].data['image/png'];
    expect(png.type).toBe('image/png');
    expect(await png.text()).toBe('png');
    expect(bitmap).not.toHaveBeenCalled();
  });

  it.each(['image/jpeg', 'image/webp'])(
    'converts %s to PNG at its original dimensions',
    async type => {
      const write = clipboard();
      const image = { width: 120, height: 60, close: vi.fn() };
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(async () => image),
      );
      const draw = vi.fn();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        drawImage: draw,
      } as any);
      const dimensions: number[][] = [];
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
        this: HTMLCanvasElement,
        callback,
        mime,
      ) {
        dimensions.push([this.width, this.height]);
        callback(new Blob(['png'], { type: mime }));
      });
      await writeToolboxClipboardImage(`data:${type};base64,aW1hZ2U=`);
      expect(dimensions).toEqual([[120, 60]]);
      expect(draw).toHaveBeenCalledWith(image, 0, 0);
      expect((await write.mock.calls[0][0][0].data['image/png']).type).toBe('image/png');
      expect(image.close).toHaveBeenCalled();
    },
  );

  it('rejects external URLs, invalid Base64 and oversized inputs before clipboard writes', async () => {
    const write = clipboard();
    for (const data of [
      'https://example.test/image.png',
      'data:image/svg+xml;base64,c3Zn',
      'data:image/png;base64,a===',
    ]) {
      await expect(writeToolboxClipboardImage(data)).rejects.toThrow(
        'toolboxClipboardImageInvalid',
      );
    }
    await expect(
      writeToolboxClipboardImage('data:image/png;base64,' + 'a'.repeat(16 * 1024 * 1024)),
    ).rejects.toThrow('16 MiB');
    expect(write).not.toHaveBeenCalled();
  });

  it('bounds non-PNG canvas allocations and propagates clipboard permission failures', async () => {
    const write = clipboard();
    const image = { width: 20000, height: 20000, close: vi.fn() };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => image),
    );
    await expect(writeToolboxClipboardImage('data:image/jpeg;base64,aW1hZ2U=')).rejects.toThrow(
      'toolboxClipboardImageDimensionsTooLarge',
    );
    expect(image.close).toHaveBeenCalled();
    write.mockRejectedValueOnce(new Error('permission denied'));
    await expect(writeToolboxClipboardImage('data:image/png;base64,cG5n')).rejects.toThrow(
      'permission denied',
    );
  });
});
