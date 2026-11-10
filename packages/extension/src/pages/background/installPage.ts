import site from '@mearl/preset/installation-site.json';

declare const __MEARL_WEBSITE_URL__: string;

export const INSTALL_PAGE_URL = new URL('installed.html', site.url).href;
export const CUSTOM_INSTALL_PAGE_URL =
  typeof __MEARL_WEBSITE_URL__ !== 'undefined' && __MEARL_WEBSITE_URL__
    ? new URL('installed.html', __MEARL_WEBSITE_URL__).href
    : undefined;

export async function openInstallPage(
  reason: `${chrome.runtime.InstalledDetails['reason']}`,
): Promise<void> {
  if (reason !== 'install') return;
  const reachable =
    CUSTOM_INSTALL_PAGE_URL &&
    (await fetch(CUSTOM_INSTALL_PAGE_URL, {
      method: 'HEAD',
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(5_000),
    }).then(
      () => true,
      () => false,
    ));
  try {
    await chrome.tabs.create({ url: reachable ? CUSTOM_INSTALL_PAGE_URL : INSTALL_PAGE_URL });
  } catch {
    // Closing the browser must not interrupt extension installation.
  }
}
