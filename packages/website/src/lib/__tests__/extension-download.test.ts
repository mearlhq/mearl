import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.stubEnv('MEARL_EXTENSION_RELEASE_VERSION', ''));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it('reads and caches the published Pages configuration', async () => {
  const tag = 'v3.0.0-beta.3';
  const name = `mearl-chrome-${tag}.zip`;
  const url = `https://github.com/mearlhq/mearl/releases/download/${tag}/${name}`;
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ latestVersion: '3.0.0-beta.3', downloadUrl: url }));
  vi.stubGlobal('fetch', fetch);
  const { latestExtensionDownload } = await import('../extension-download');

  await expect(latestExtensionDownload()).resolves.toEqual({ version: '3.0.0-beta.3', url });
  await expect(latestExtensionDownload()).resolves.toEqual({ version: '3.0.0-beta.3', url });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0][0])).toBe('https://mearlhq.github.io/mearl/config.json');
});

it('uses the newly published version when refreshing Pages after a release', async () => {
  vi.stubEnv('MEARL_EXTENSION_RELEASE_VERSION', '3.0.11');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { latestExtensionDownload } = await import('../extension-download');
  await expect(latestExtensionDownload()).resolves.toEqual({
    version: '3.0.11',
    url: 'https://github.com/mearlhq/mearl/releases/download/v3.0.11/mearl-chrome-v3.0.11.zip',
  });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  { latestVersion: 'invalid', downloadUrl: 'https://example.com/download.zip' },
  { latestVersion: '3.0.10', downloadUrl: 'https://example.com/download.zip' },
  null,
])('rejects invalid Pages configuration: %j', async config => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(config)));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { latestExtensionDownload } = await import('../extension-download');
  await expect(latestExtensionDownload()).resolves.toBeUndefined();
});

it('handles a failed Pages response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { latestExtensionDownload } = await import('../extension-download');
  await expect(latestExtensionDownload()).resolves.toBeUndefined();
});

it('keeps the optional ZIP unavailable when GitHub cannot be reached', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { latestExtensionDownload } = await import('../extension-download');

  await expect(latestExtensionDownload()).resolves.toBeUndefined();
});
