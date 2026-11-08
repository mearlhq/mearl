import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClipboardContent } from '../clipboard';

afterEach(() => vi.restoreAllMocks());

describe('readClipboardContent', () => {
  it('keeps text and image data from the same clipboard snapshot', async () => {
    const image = new Blob(['image'], { type: 'image/png' });
    const text = new Blob(['https://example.com'], { type: 'text/plain' });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        read: vi.fn(async () => [
          {
            types: ['text/plain', 'image/png'],
            getType: vi.fn(async (type: string) => (type === 'text/plain' ? text : image)),
          },
        ]),
      },
    });

    await expect(readClipboardContent()).resolves.toEqual({
      text: 'https://example.com',
      image,
    });
  });
});
