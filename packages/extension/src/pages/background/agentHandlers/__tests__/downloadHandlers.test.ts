import { afterEach, describe, expect, it, vi } from 'vitest';
import { capturePageDownload } from '../downloadHandlers';

function fixture() {
  const created = new Set<(item: any) => void>();
  const changed = new Set<(item: any) => void>();
  const search = vi.fn(async () => [
    { id: 1, filename: '/Downloads/result.csv', state: 'complete' },
  ]);
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(async () => ({ url: 'https://example.com/export' })) },
    downloads: {
      search,
      onCreated: {
        addListener: (listener: any) => created.add(listener),
        removeListener: (listener: any) => created.delete(listener),
      },
      onChanged: {
        addListener: (listener: any) => changed.add(listener),
        removeListener: (listener: any) => changed.delete(listener),
      },
    },
  });
  return {
    created,
    changed,
    search,
    emit: (item: any) => {
      for (const listener of created) listener(item);
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('browser download capture', () => {
  it('arms before dispatch and ignores unrelated user downloads', async () => {
    const f = fixture();
    const trigger = vi.fn(async () => {
      expect(f.created.size).toBe(1);
      f.emit({ id: 99, url: 'https://other.com/file', referrer: 'https://other.com/' });
      f.emit({ id: 1, url: 'https://example.com/file', referrer: 'https://example.com/export' });
      return { clicked: true };
    });
    expect(
      await capturePageDownload({ tabId: 1, trigger: { selector: '#export' } }, trigger),
    ).toMatchObject({
      filename: 'result.csv',
      filePath: '/Downloads/result.csv',
      action: { clicked: true },
    });
    expect(f.search).toHaveBeenCalledWith({ id: 1 });
    expect(f.created.size).toBe(0);
    expect(f.changed.size).toBe(0);
  });

  it('reports an uncertain result without claiming a download with no source', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const capture = capturePageDownload(
      { tabId: 1, trigger: { selector: '#export' }, timeout: 1000 },
      async () => {
        f.emit({ id: 99, url: 'https://example.com/file', referrer: '' });
        return { clicked: true };
      },
    );
    const rejected = expect(capture).rejects.toThrow('DOWNLOAD_CAPTURE_UNCERTAIN');
    await vi.advanceTimersByTimeAsync(1001);
    await rejected;
    expect(f.search).not.toHaveBeenCalled();
    expect(f.created.size).toBe(0);
  });

  it('rejects multiple matching downloads and cleans up listeners', async () => {
    const f = fixture();
    await expect(
      capturePageDownload({ tabId: 1, trigger: { selector: '#export' } }, async () => {
        f.emit({ id: 1, url: 'https://example.com/a', referrer: 'https://example.com/export' });
        f.emit({ id: 2, url: 'https://example.com/b', referrer: 'https://example.com/export' });
      }),
    ).rejects.toThrow('AMBIGUOUS');
    expect(f.created.size).toBe(0);
    expect(f.changed.size).toBe(0);
  });
});
