import site from '@mearl/preset/installation-site.json';

declare const __MEARL_WEBSITE_URL__: string;

export const INSTALL_PAGE_URL = new URL('installed.html', site.url).href;
const customPage =
  typeof __MEARL_WEBSITE_URL__ !== 'undefined' && __MEARL_WEBSITE_URL__
    ? new URL('installed.html', __MEARL_WEBSITE_URL__).href
    : undefined;

export async function openInstallPage(
  reason: `${chrome.runtime.InstalledDetails['reason']}`,
): Promise<void> {
  if (reason !== 'install') return;
  const reachable =
    customPage &&
    (await fetch(customPage, {
      method: 'HEAD',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    }).then(
      response => response.ok,
      () => false,
    ));
  try {
    await chrome.tabs.create({ url: reachable ? customPage : INSTALL_PAGE_URL });
  } catch {
    // Closing the browser must not interrupt extension installation.
  }
}
