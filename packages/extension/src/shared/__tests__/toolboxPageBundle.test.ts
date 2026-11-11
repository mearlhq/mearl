import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  loadToolboxPageBundle,
  readCachedToolboxTool,
  sameToolboxToolMetadata,
} from '../toolboxPageBundle';

const mocks = vi.hoisted(() => ({ requestToolbox: vi.fn() }));

vi.mock('../../pages/popup/toolboxRequest', () => ({ requestToolbox: mocks.requestToolbox }));

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(new TextEncoder().encode(value)).buffer,
  );
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('toolbox page bundle', () => {
  it('ignores reordered storage metadata but detects changed resources', () => {
    const tool = {
      title: 'Notes',
      page: { type: 'sandbox' as const, hash: 'a'.repeat(64), size: 1, chunks: 1 },
    };
    const reordered = {
      page: { chunks: 1, size: 1, hash: tool.page.hash, type: 'sandbox' as const },
      title: 'Notes',
    };
    expect(sameToolboxToolMetadata(tool, reordered)).toBe(true);
    expect(
      sameToolboxToolMetadata(tool, {
        ...reordered,
        page: { ...reordered.page, hash: 'b'.repeat(64) },
      }),
    ).toBe(false);
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reassembles, verifies, and caches native-host page chunks', async () => {
    const html = '<!doctype html><html><body>Notebook</body></html>';
    const bytes = new TextEncoder().encode(html);
    const hash = await sha256(html);
    (chrome.storage.local.get as Mock).mockResolvedValue({});
    mocks.requestToolbox
      .mockResolvedValueOnce({
        data: btoa(String.fromCharCode(...bytes.slice(0, 20))),
        hash,
        index: 0,
        total: 2,
      })
      .mockResolvedValueOnce({
        data: btoa(String.fromCharCode(...bytes.slice(20))),
        hash,
        index: 1,
        total: 2,
      });

    await expect(
      loadToolboxPageBundle('plugin:notebook', {
        type: 'sandbox',
        hash,
        size: bytes.byteLength,
        chunks: 2,
      }),
    ).resolves.toBe(html);
    expect(mocks.requestToolbox).toHaveBeenCalledTimes(2);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      'toolbox-page:plugin:notebook': { hash, html },
    });
  });

  it('uses a matching cached page without contacting native-host', async () => {
    const html = '<!doctype html><html></html>';
    const hash = await sha256(html);
    (chrome.storage.local.get as Mock).mockResolvedValue({
      'toolbox-page:plugin:notebook': { hash, html },
    });

    await expect(
      loadToolboxPageBundle('plugin:notebook', {
        type: 'sandbox',
        hash,
        size: new TextEncoder().encode(html).byteLength,
        chunks: 1,
      }),
    ).resolves.toBe(html);
    expect(mocks.requestToolbox).not.toHaveBeenCalled();
  });

  it('restores metadata only when its complete page bundle is cached', async () => {
    const tool = {
      title: 'Notes',
      page: { type: 'sandbox', hash: 'a'.repeat(64), size: 1, chunks: 1 },
    };
    const metadata = { 'toolbox-open:plugin:notebook': tool };
    (chrome.storage.local.get as Mock).mockResolvedValue(metadata);
    expect(await readCachedToolboxTool('plugin:notebook')).toBeNull();
    (chrome.storage.local.get as Mock).mockResolvedValue({
      ...metadata,
      'toolbox-page:plugin:notebook': { hash: tool.page.hash, html: 'x' },
    });
    expect(await readCachedToolboxTool('plugin:notebook')).toEqual({ tool, html: 'x' });
    (chrome.storage.local.get as Mock).mockResolvedValue({
      ...metadata,
      'toolbox-page:plugin:notebook': { hash: 'b'.repeat(64), html: 'x' },
    });
    expect(await readCachedToolboxTool('plugin:notebook')).toBeNull();
  });
});
