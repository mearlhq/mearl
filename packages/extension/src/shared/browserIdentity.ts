/** Storage key for the per-installation ID sent in the Native Host handshake. */
export const BROWSER_ID_STORAGE_KEY = 'mearl_browser_id';

export async function readStoredBrowserId(): Promise<string | undefined> {
  const { [BROWSER_ID_STORAGE_KEY]: id } = await chrome.storage.local.get([BROWSER_ID_STORAGE_KEY]);
  return typeof id === 'string' && id ? id : undefined;
}
