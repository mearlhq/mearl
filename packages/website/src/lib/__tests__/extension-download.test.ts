import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it('finds a public prerelease ZIP when there is no stable release or GitHub CLI', async () => {
  const tag = 'v3.0.0-beta.3';
  const name = `mearl-chrome-${tag}.zip`;
  const url = `https://github.com/mearlhq/mearl/releases/download/${tag}/${name}`;
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json([
      { tag_name: tag, prerelease: true, assets: [{ name, browser_download_url: url }] },
    ]));
  vi.stubEnv('GH_TOKEN', undefined);
  vi.stubEnv('PATH', '');
  vi.stubGlobal('fetch', fetch);
  const { latestExtensionDownload } = await import('../extension-download');

  await expect(latestExtensionDownload()).resolves.toEqual({ version: '3.0.0-beta.3', url });
});

it('keeps the optional ZIP unavailable when GitHub cannot be reached', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { latestExtensionDownload } = await import('../extension-download');

  await expect(latestExtensionDownload()).resolves.toBeUndefined();
});
