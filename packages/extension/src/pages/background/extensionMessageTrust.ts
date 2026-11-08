export function isExtensionUiSender(
  sender: Pick<chrome.runtime.MessageSender, 'id' | 'url'>,
  extensionId: string,
): boolean {
  // Content scripts share the extension ID; only extension pages may invoke local services.
  return (
    Boolean(extensionId) &&
    sender.id === extensionId &&
    sender.url?.startsWith(`chrome-extension://${extensionId}/`) === true
  );
}
