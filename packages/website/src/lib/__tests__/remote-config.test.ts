import { afterEach, expect, it, vi } from 'vitest';
import { GET } from '../../pages/config.json';
import { latestExtensionDownload } from '../extension-download';

vi.mock('../extension-download', () => ({ latestExtensionDownload: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it('publishes the resolved release version and immutable download URL', async () => {
  const url = 'https://github.com/mearlhq/mearl/releases/download/v3.0.8/mearl-chrome-v3.0.8.zip';
  vi.mocked(latestExtensionDownload).mockResolvedValue({ version: '3.0.8', url });
  expect(await (await GET()).json()).toEqual({ latestVersion: '3.0.8', downloadUrl: url });
});

it('fails deployment instead of publishing an empty update configuration', async () => {
  vi.mocked(latestExtensionDownload).mockResolvedValue(undefined);
  await expect(GET()).rejects.toThrow('without a release');
});
