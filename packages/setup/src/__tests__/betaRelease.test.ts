import { afterEach, expect, it, vi } from 'vitest';
import { fetchBrowserExtensionRelease } from '../browserExtension';

vi.mock('../setupVersion.js', () => ({ SETUP_VERSION: '3.0.9-beta.2' }));
afterEach(() => vi.unstubAllEnvs());

it('pins beta installation to its own archive without a release config request', async () => {
  vi.stubEnv('MEARL_EXTENSION_CONFIG_URL', '');
  const fetcher = vi.fn<typeof fetch>();
  await expect(fetchBrowserExtensionRelease(fetcher)).resolves.toEqual({
    version: '3.0.9-beta.2',
    archiveUrl:
      'https://github.com/mearlhq/mearl/releases/download/v3.0.9-beta.2/mearl-chrome-v3.0.9-beta.2.zip',
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it('honors an explicit configuration source for beta installations', async () => {
  vi.stubEnv('MEARL_EXTENSION_CONFIG_URL', 'https://updates.example.com/config.json');
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      latestVersion: '3.0.9-beta.3',
      downloadUrl: 'https://updates.example.com/mearl-chrome-v3.0.9-beta.3.zip',
    }),
  );
  await expect(fetchBrowserExtensionRelease(fetcher)).resolves.toMatchObject({
    version: '3.0.9-beta.3',
  });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://updates.example.com/config.json', {
    cache: 'no-store',
  });
});
