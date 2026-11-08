import site from '@mearl/preset/installation-site.json';

export const INSTALL_PAGE_URL = new URL('installed.html', site.url).href;

export async function openInstallPage(reason: `${chrome.runtime.InstalledDetails['reason']}`): Promise<void> {
  if (reason !== 'install') return;
  try { await chrome.tabs.create({ url: INSTALL_PAGE_URL }); }
  catch { /* Closing the browser must not interrupt extension installation. */ }
}
