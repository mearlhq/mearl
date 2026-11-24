const storageKey = (tabId: number) => `deviceShellDirectNavigation:${tabId}`;

export async function recordDeviceShellNavigation(
  details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
): Promise<void> {
  const url = new URL(details.url);
  if (
    !/^https?:$/.test(url.protocol) ||
    !url.search ||
    url.hash ||
    details.documentLifecycle !== 'active' ||
    !details.documentId ||
    !['link', 'typed', 'auto_bookmark'].includes(details.transitionType) ||
    details.transitionQualifiers.some(qualifier => qualifier !== 'from_address_bar')
  ) {
    await clearDeviceShellNavigation(details.tabId);
    return;
  }

  await chrome.storage.session.set({
    [storageKey(details.tabId)]: { documentId: details.documentId, url: url.href },
  });
}

export async function getDirectDeviceShellNavigationUrl(
  tabId: number,
): Promise<string | undefined> {
  const key = storageKey(tabId);
  const record = (await chrome.storage.session.get(key))[key];
  if (!record) return;

  // The URL can change within the same document after an SPA navigation.
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  if (frame && frame.documentId === record.documentId && frame.url === record.url)
    return record.url;
}

export function clearDeviceShellNavigation(tabId: number): Promise<void> {
  return chrome.storage.session.remove(storageKey(tabId));
}
